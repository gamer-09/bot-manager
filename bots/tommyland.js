/**
 * Bot 3 & 4: Tommyland / Discord Bot (Falix Minecraft Manager)
 * Minecraft server management bot with status polling
 */

const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  REST, Routes, SlashCommandBuilder,
} = require('discord.js');
const { status } = require('minecraft-server-util');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const https = require('https');

let client = null;
let botData = {};
let DATA_FILE = null;

// ─── Data Persistence ──────────────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── Colour Palette ────────────────────────────────────────────────────────
const C = {
  green: "#57F287", red: "#ED4245", yellow: "#FEE75C",
  blue: "#5865F2", pink: "#EB459E", purple: "#9B59B6", cyan: "#00CED1",
};

// ─── Helpers ───────────────────────────────────────────────────────────────
function formatUptime(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  const h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function latencyBar(ms) {
  if (ms <= 60) return "🟢 Excellent";
  if (ms <= 120) return "🟡 Good";
  if (ms <= 250) return "🟠 Moderate";
  return "🔴 High";
}

function isAdmin(member, config) {
  return member.id === config.ownerId || member.permissions.has("Administrator");
}

// ─── Server Status (Fast Falix-aware checker) ─────────────────────────────
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const net = require('net');
const https = require('https');

// Cache DNS SRV + last known status
const srvCache = {};
let lastKnownStatus = null;

async function resolveServer(serverAddress) {
  if (srvCache[serverAddress]) return srvCache[serverAddress];
  let host = serverAddress, port = 25565;
  try {
    const srv = await new Promise((res, rej) => dns.resolveSrv('_minecraft._tcp.' + serverAddress, (e, a) => e ? rej(e) : res(a)));
    host = srv[0].name; port = srv[0].port;
  } catch {}
  srvCache[serverAddress] = { host, port };
  return { host, port };
}

function tcpPing(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const sock = net.createConnection(port, host, () => { sock.end(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(timeout, () => { sock.destroy(); resolve(false); });
  });
}

function fetchJSON(url) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    https.get({ hostname: urlObj.hostname, path: urlObj.pathname, headers: { 'User-Agent': 'DiscordBot/1.0' }, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
  });
}

async function getServerStatus(serverAddress) {
  const { host, port } = await resolveServer(serverAddress);

  // 1. Try minecraft-server-util (best case: full info)
  try {
    const r = await Promise.race([
      status(host, port, { timeout: 3000 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))
    ]);
    const motd = (typeof r.motd?.clean === 'string' ? r.motd.clean : '').toLowerCase();
    const ver = (r.version?.name || '').toLowerCase();
    if (!motd.includes('offline') && !ver.includes('offline')) {
      const result = { online: true, players: r.players?.online ?? 0, max: r.players?.max ?? 0, sample: r.players?.sample || [], version: r.version?.name || 'Unknown', latency: r.roundTripLatency };
      lastKnownStatus = result;
      return result;
    }
  } catch {}

  // 2. Try mcsrvstat.us API (may have cached data from when server was awake)
  try {
    const data = await fetchJSON(`https://api.mcsrvstat.us/3/${host}:${port}`);
    if (data?.online && data?.players?.max > 0) {
      const result = { online: true, players: data.players.online ?? 0, max: data.players.max ?? 0, sample: (data.players?.list || []).map(p => ({ name: p })), version: data.version || 'Unknown', latency: null };
      lastKnownStatus = result;
      return result;
    }
  } catch {}

  // 3. TCP ping (server is listening but may be paused — use cached info)
  const reachable = await tcpPing(host, port, 2000);
  if (reachable) {
    if (lastKnownStatus) return { ...lastKnownStatus, online: true, latency: null };
    return { online: true, players: 0, max: 0, sample: [], version: 'Unknown', latency: null };
  }

  // 4. Server is sleeping/paused (Falix free server empty >60s)
  return { online: false, players: 0, max: 0, sample: [], version: '💤 Sleeping', latency: null, sleeping: true };
}

// ─── WebSocket Management ──────────────────────────────────────────────────
function sendMgmtCommand(method, params = {}, config) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${config.mgmtHost}:${config.mgmtPort}`, {
      headers: { Authorization: `Bearer ${config.mgmtSecret}`, "x-auth-token": config.mgmtSecret },
      rejectUnauthorized: false,
      handshakeTimeout: 10000,
    });
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error("Connection timed out")); }, 10000);
    ws.once("open", () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "auth", params: { secret: config.mgmtSecret } }));
      setTimeout(() => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })), 500);
    });
    ws.once("message", (data) => {
      clearTimeout(timeout); ws.close();
      try { resolve(JSON.parse(data.toString())); } catch { resolve(data.toString()); }
    });
    ws.once("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

// ─── Register Slash Commands ───────────────────────────────────────────────
async function registerSlashCommands(token, guildId) {
  await new Promise(resolve => {
    if (client.user && client.user.id) return resolve();
    client.once('ready', resolve);
    if (client.isReady()) resolve();
  });
  
  await new Promise(r => setTimeout(r, 2000));
  
  if (!client.user || !client.user.id) {
    console.error('  ❌ tommyland: Client user not available');
    return;
  }
  
  const rest = new REST().setToken(token);
  const commands = [
    new SlashCommandBuilder().setName("start").setDescription("Get a button to start the server").toJSON(),
    new SlashCommandBuilder().setName("ip").setDescription("Show the server IP").toJSON(),
    new SlashCommandBuilder().setName("status").setDescription("Full server status").toJSON(),
    new SlashCommandBuilder().setName("players").setDescription("See who is online").toJSON(),
    new SlashCommandBuilder().setName("uptime").setDescription("Bot uptime info").toJSON(),
    new SlashCommandBuilder().setName("poll").setDescription("Create a community poll")
      .addStringOption(o => o.setName("question").setDescription("The poll question").setRequired(true))
      .addStringOption(o => o.setName("options").setDescription("Pipe-separated: Yes | No | Maybe").setRequired(false)).toJSON(),
    new SlashCommandBuilder().setName("setchannel").setDescription("Set activity channel (Admin only)").toJSON(),
    new SlashCommandBuilder().setName("stopchannel").setDescription("Stop activity updates (Admin only)").toJSON(),
    new SlashCommandBuilder().setName("shutdown").setDescription("Stop the Minecraft server (Admin only)").toJSON(),
    new SlashCommandBuilder().setName("help").setDescription("Show all commands").toJSON(),
  ];
  
  if (guildId) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
      console.log(`  ✅ tommyland: Registered ${commands.length} slash commands`);
    } catch (err) {
      console.error(`  ⚠️ tommyland: Registration failed:`, err.message);
    }
  }
}

// ─── Start Function ────────────────────────────────────────────────────────
async function start(token, options = {}) {
  const { prefix = '!', serverSubdomain, mgmtHost, mgmtPort, mgmtSecret, ownerId, guildId, dataDir } = options;
  
  const SERVER_ADDRESS = `${serverSubdomain}.falixsrv.me`;
  const START_URL = `https://falixnodes.net/startserver?ip=${SERVER_ADDRESS}`;
  const BOT_START_TIME = Date.now();
  const POLL_INTERVAL_MS = 30_000;
  let prevState = { online: null, playerNames: new Set(), playerCount: 0 };

  if (dataDir && !fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  DATA_FILE = path.join(dataDir || '.', 'data.json');
  botData = loadData();

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
  });

  function ui({ color, title, description = null, fields = [] }) {
    return new EmbedBuilder()
      .setColor(color).setTitle(title).setTimestamp()
      .setAuthor({ name: "⛏ Falix MC Manager" })
      .setFooter({ text: `${SERVER_ADDRESS} • ${prefix}help` })
      .setDescription(description)
      .addFields(fields);
  }

  async function getActivityChannel() {
    if (!botData.activityChannelId) return null;
    try { return await client.channels.fetch(botData.activityChannelId); } catch { return null; }
  }

  async function postUpdate(embedData) {
    const ch = await getActivityChannel();
    if (ch) await ch.send({ embeds: [embedData] }).catch(console.error);
  }

  async function pollServer() {
    if (!botData.activityChannelId) return;
    const r = await getServerStatus(SERVER_ADDRESS);

    if (prevState.online === false && r.online) {
      await postUpdate(ui({ color: C.green, title: "🟢 Server Just Came Online!", description: `**${SERVER_ADDRESS}** is back up.` }));
    }
    if (prevState.online === true && !r.online) {
      await postUpdate(ui({ color: C.red, title: "🔴 Server Went Offline", description: `**${SERVER_ADDRESS}** is no longer reachable.` }));
      prevState.playerNames = new Set(); prevState.playerCount = 0;
    }
    if (r.online) {
      const currentNames = new Set(r.sample.map(p => p.name || p));
      const joined = [...currentNames].filter(n => !prevState.playerNames.has(n));
      const left = [...prevState.playerNames].filter(n => !currentNames.has(n));
      for (const name of joined) await postUpdate(ui({ color: C.green, title: "👋 Player Joined", fields: [{ name: "Player", value: `\`${name}\``, inline: true }] }));
      for (const name of left) await postUpdate(ui({ color: C.yellow, title: "🚪 Player Left", fields: [{ name: "Player", value: `\`${name}\``, inline: true }] }));
      prevState.playerNames = currentNames;
      prevState.playerCount = r.players;
    }
    prevState.online = r.online;
  }

  client.once("ready", async () => {
    const botTag = client.user?.tag ?? 'Unknown';
    console.log(`  ⛏️ Tommyland online as ${botTag}`);
    if (client.user) client.user.setActivity("Falix MC Manager 🎮", { type: 3 });
    setInterval(pollServer, POLL_INTERVAL_MS);
    setTimeout(pollServer, 3000);
    await registerSlashCommands(token, guildId);
  });

  // Prefix commands
  client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.content.startsWith(prefix)) return;
    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args[0].toLowerCase();

    if (command === "start") {
      const btn = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("▶ Start Server").setStyle(ButtonStyle.Link).setURL(START_URL)
      );
      await message.reply({ embeds: [ui({ color: C.green, title: "🟢 Start Your Server", description: `Click below to wake up **${SERVER_ADDRESS}**.` })], components: [btn] });
    } else if (command === "ip") {
      await message.reply({ embeds: [ui({ color: C.cyan, title: "🌐 Server Address", description: `\`\`\`${SERVER_ADDRESS}\`\`\`` })] });
    } else if (command === "status") {
      const r = await getServerStatus(SERVER_ADDRESS);
      if (r.sleeping) {
        const btn = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel("▶ Wake Up Server").setStyle(ButtonStyle.Link).setURL(START_URL)
        );
        await message.reply({ embeds: [ui({ color: C.yellow, title: "💤 Server Sleeping", description: `**${SERVER_ADDRESS}** is paused (no players for 60s).\nClick the button to wake it up.`, fields: [
          ...(lastKnownStatus ? [
            { name: "Last Known Players", value: `**${lastKnownStatus.players}** / ${lastKnownStatus.max}`, inline: true },
            { name: "Last Known Version", value: lastKnownStatus.version, inline: true },
          ] : []),
        ] }), components: [btn] });
      } else if (r.online) {
        await message.reply({ embeds: [ui({ color: C.green, title: "✅ Server Online", fields: [
          { name: "Players", value: `**${r.players}** / ${r.max}`, inline: true },
          { name: "Version", value: r.version, inline: true },
          ...(r.latency ? [{ name: "Latency", value: `${r.latency}ms ${latencyBar(r.latency)}`, inline: true }] : []),
        ] })] });
      } else {
        const btn = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel("▶ Start Server").setStyle(ButtonStyle.Link).setURL(START_URL)
        );
        await message.reply({ embeds: [ui({ color: C.red, title: "🔴 Server Offline", description: `**${SERVER_ADDRESS}** is not reachable.` }), components: [btn] });
      }
    } else if (command === "players") {
      const r = await getServerStatus(SERVER_ADDRESS);
      if (r.online) {
        const names = r.sample.map(p => `\`${p.name || p}\``).join("\n") || "Nobody online";
        await message.reply({ embeds: [ui({ color: C.blue, title: `👥 Players — ${r.players}/${r.max}`, description: names })] });
      } else {
        await message.reply({ embeds: [ui({ color: C.red, title: "🔴 Server Offline" })] });
      }
    } else if (command === "uptime") {
      await message.reply({ embeds: [ui({ color: C.purple, title: "⏱ Bot Uptime", fields: [{ name: "Running for", value: `**${formatUptime(Date.now() - BOT_START_TIME)}**`, inline: true }] })] });
    } else if (command === "poll") {
      const fullText = args.slice(1).join(" ");
      const parts = fullText.split("|").map(s => s.trim()).filter(Boolean);
      const question = parts[0];
      if (!question) return message.reply({ embeds: [ui({ color: C.red, title: "❌ Missing Question", description: `\`${prefix}poll Question | Option1 | Option2\`` })] });
      const NUMBER_EMOJIS = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
      const customOptions = parts.slice(1);
      if (customOptions.length > 0) {
        const options = customOptions.slice(0, 10);
        const pollMsg = await message.channel.send({ embeds: [ui({ color: C.pink, title: "📊 Community Poll", description: `### ${question}`, fields: [
          ...options.map((opt, i) => ({ name: `${NUMBER_EMOJIS[i]} Option ${i + 1}`, value: opt, inline: true })),
          { name: "Asked by", value: `${message.author}`, inline: false },
        ] })] });
        for (let i = 0; i < options.length; i++) await pollMsg.react(NUMBER_EMOJIS[i]).catch(() => null);
      } else {
        const pollMsg = await message.channel.send({ embeds: [ui({ color: C.pink, title: "📊 Community Poll", description: `### ${question}`, fields: [
          { name: "✅ Yes", value: "React with ✅", inline: true },
          { name: "❌ No", value: "React with ❌", inline: true },
          { name: "Asked by", value: `${message.author}`, inline: false },
        ] })] });
        await pollMsg.react("✅").catch(() => null);
        await pollMsg.react("❌").catch(() => null);
      }
      await message.delete().catch(() => {});
    } else if (command === "setchannel") {
      if (!isAdmin(message.member, { ownerId })) return message.reply({ embeds: [ui({ color: C.red, title: "🔒 Access Denied" })] });
      botData.activityChannelId = message.channel.id;
      saveData(botData);
      prevState = { online: null, playerNames: new Set(), playerCount: 0 };
      await message.reply({ embeds: [ui({ color: C.green, title: "✅ Activity Channel Set", description: `<#${message.channel.id}> will receive live updates.` })] });
    } else if (command === "stopchannel") {
      if (!isAdmin(message.member, { ownerId })) return message.reply({ embeds: [ui({ color: C.red, title: "🔒 Access Denied" })] });
      botData.activityChannelId = null;
      saveData(botData);
      await message.reply({ embeds: [ui({ color: C.red, title: "🔕 Activity Updates Disabled" })] });
    } else if (command === "shutdown") {
      if (!isAdmin(message.member, { ownerId })) return message.reply({ embeds: [ui({ color: C.red, title: "🔒 Access Denied" })] });
      try {
        await sendMgmtCommand("minecraft:server/stop", {}, { mgmtHost, mgmtPort, mgmtSecret });
        await message.reply({ embeds: [ui({ color: C.red, title: "🔴 Server Stopped", description: `**${SERVER_ADDRESS}** shut down.` })] });
      } catch (err) {
        await message.reply({ embeds: [ui({ color: C.red, title: "❌ Shutdown Failed", description: err.message })] });
      }
    } else if (command === "help") {
      await message.reply({ embeds: [ui({ color: C.blue, title: "📖 Commands", description: `\`${prefix}start\` · \`${prefix}ip\` · \`${prefix}status\` · \`${prefix}players\` · \`${prefix}uptime\` · \`${prefix}poll\` · \`${prefix}setchannel\` · \`${prefix}stopchannel\` · \`${prefix}shutdown\` · \`${prefix}help\`` })] });
    }
  });

  // Slash command handler
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction.commandName;

    if (cmd === "start") {
      const btn = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("▶ Start Server").setStyle(ButtonStyle.Link).setURL(START_URL)
      );
      await interaction.reply({ embeds: [ui({ color: C.green, title: "🟢 Start Your Server", description: `Click below to wake up **${SERVER_ADDRESS}**.` })], components: [btn] });
    } else if (cmd === "ip") {
      await interaction.reply({ embeds: [ui({ color: C.cyan, title: "🌐 Server Address", description: `\`\`\`${SERVER_ADDRESS}\`\`\`` })] });
    } else if (cmd === "status") {
      await interaction.deferReply();
      const r = await getServerStatus(SERVER_ADDRESS);
      if (r.sleeping) {
        const btn = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel("▶ Wake Up Server").setStyle(ButtonStyle.Link).setURL(START_URL)
        );
        await interaction.editReply({ embeds: [ui({ color: C.yellow, title: "💤 Server Sleeping", description: `**${SERVER_ADDRESS}** is paused (no players for 60s).\nClick the button to wake it up.`, fields: [
          ...(lastKnownStatus ? [
            { name: "Last Known Players", value: `**${lastKnownStatus.players}** / ${lastKnownStatus.max}`, inline: true },
            { name: "Last Known Version", value: lastKnownStatus.version, inline: true },
          ] : []),
        ] }), components: [btn] });
      } else if (r.online) {
        await interaction.editReply({ embeds: [ui({ color: C.green, title: "✅ Server Online", fields: [
          { name: "Players", value: `**${r.players}** / ${r.max}`, inline: true },
          { name: "Version", value: r.version, inline: true },
          ...(r.latency ? [{ name: "Latency", value: `${r.latency}ms`, inline: true }] : []),
        ] })] });
      } else {
        const btn = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel("▶ Start Server").setStyle(ButtonStyle.Link).setURL(START_URL)
        );
        await interaction.editReply({ embeds: [ui({ color: C.red, title: "🔴 Server Offline", description: `**${SERVER_ADDRESS}** is not reachable.` }), components: [btn] });
      }
    } else if (cmd === "players") {
      await interaction.deferReply();
      const r = await getServerStatus(SERVER_ADDRESS);
      if (r.online) {
        const names = r.sample.map(p => `\`${p.name || p}\``).join("\n") || "Nobody online";
        await interaction.editReply({ embeds: [ui({ color: C.blue, title: `👥 Players — ${r.players}/${r.max}`, description: names })] });
      } else {
        await interaction.editReply({ embeds: [ui({ color: C.red, title: "🔴 Server Offline" })] });
      }
    } else if (cmd === "uptime") {
      await interaction.reply({ embeds: [ui({ color: C.purple, title: "⏱ Bot Uptime", fields: [{ name: "Running for", value: `**${formatUptime(Date.now() - BOT_START_TIME)}**`, inline: true }] })] });
    } else if (cmd === "poll") {
      const question = interaction.options.getString("question");
      const optionsStr = interaction.options.getString("options");
      const NUMBER_EMOJIS = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
      if (optionsStr) {
        const options = optionsStr.split("|").map(s => s.trim()).filter(Boolean).slice(0, 10);
        await interaction.reply({ embeds: [ui({ color: C.pink, title: "📊 Community Poll", description: `### ${question}`, fields: [
          ...options.map((opt, i) => ({ name: `${NUMBER_EMOJIS[i]} Option ${i + 1}`, value: opt, inline: true })),
          { name: "Asked by", value: `${interaction.user}`, inline: false },
        ] })] });
        const pollMsg = await interaction.fetchReply();
        for (let i = 0; i < options.length; i++) await pollMsg.react(NUMBER_EMOJIS[i]).catch(() => null);
      } else {
        await interaction.reply({ embeds: [ui({ color: C.pink, title: "📊 Community Poll", description: `### ${question}`, fields: [
          { name: "✅ Yes", value: "React with ✅", inline: true },
          { name: "❌ No", value: "React with ❌", inline: true },
          { name: "Asked by", value: `${interaction.user}`, inline: false },
        ] })] });
        const pollMsg = await interaction.fetchReply();
        await pollMsg.react("✅").catch(() => null);
        await pollMsg.react("❌").catch(() => null);
      }
    } else if (cmd === "setchannel") {
      if (!isAdmin(interaction.member, { ownerId })) {
        return interaction.reply({ embeds: [ui({ color: C.red, title: "🔒 Access Denied" })], ephemeral: true });
      }
      botData.activityChannelId = interaction.channelId;
      saveData(botData);
      prevState = { online: null, playerNames: new Set(), playerCount: 0 };
      await interaction.reply({ embeds: [ui({ color: C.green, title: "✅ Activity Channel Set", description: `<#${interaction.channelId}> will receive live updates.` })] });
    } else if (cmd === "stopchannel") {
      if (!isAdmin(interaction.member, { ownerId })) {
        return interaction.reply({ embeds: [ui({ color: C.red, title: "🔒 Access Denied" })], ephemeral: true });
      }
      botData.activityChannelId = null;
      saveData(botData);
      await interaction.reply({ embeds: [ui({ color: C.red, title: "🔕 Activity Updates Disabled" })] });
    } else if (cmd === "shutdown") {
      if (!isAdmin(interaction.member, { ownerId })) {
        return interaction.reply({ embeds: [ui({ color: C.red, title: "🔒 Access Denied" })], ephemeral: true });
      }
      await interaction.deferReply();
      try {
        await sendMgmtCommand("minecraft:server/stop", {}, { mgmtHost, mgmtPort, mgmtSecret });
        await interaction.editReply({ embeds: [ui({ color: C.red, title: "🔴 Server Stopped", description: `**${SERVER_ADDRESS}** shut down.` })] });
      } catch (err) {
        await interaction.editReply({ embeds: [ui({ color: C.red, title: "❌ Shutdown Failed", description: err.message })] });
      }
    } else if (cmd === "help") {
      await interaction.reply({ embeds: [ui({ color: C.blue, title: "📖 Commands", description: "`/start` · `/ip` · `/status` · `/players` · `/uptime` · `/poll` · `/setchannel` · `/stopchannel` · `/shutdown` · `/help`" })] });
    }
  });

  await client.login(token);
  return client;
}

module.exports = { start };
