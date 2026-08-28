/**
 * Bot 3 & 4: Tommyland / Discord Bot (Falix Minecraft Manager)
 * Minecraft server management bot with status polling
 *
 * FIXES:
 *  - Removed duplicate `const https = require('https')` (was a SyntaxError that
 *    prevented this module from loading at all).
 *  - All mutable state (client, botData, DATA_FILE, srvCache, lastKnownStatus) is
 *    now created inside `start()`, so the module is instance-safe. This lets Bot 3
 *    (tommyland) and Bot 4 (discord-bot, which reuses this module) run independently
 *    in the same process without clobbering each other's state.
 *  - Fixed server status detection: an asleep/offline Falix server (which still
 *    answers the TCP port on the Falix proxy) is now correctly reported as
 *    "sleeping"/offline instead of falsely "online with 0 players".
 *  - Fixed the mcsrvstat.us fallback so an online server is still detected even
 *    when `players.max` is 0, and removed the fragile global DNS override.
 */

const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  REST, Routes, SlashCommandBuilder,
} = require('discord.js');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const https = require('https');

// ─── Colour Palette ────────────────────────────────────────────────────────
const C = {
  green: "#57F287", red: "#ED4245", yellow: "#FEE75C",
  blue: "#5865F2", pink: "#EB459E", purple: "#9B59B6", cyan: "#00CED1",
};

// ─── Pure Helpers (stateless, safe to share) ──────────────────────────────
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
    https.get({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: { 'User-Agent': 'DiscordBot/1.0' },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', () => resolve(null)).on('timeout', function () { this.destroy(); resolve(null); });
  });
}

// ─── Robust raw Minecraft status query ─────────────────────────────────────
// minecraft-server-util crashes on modern Falix servers (e.g. Minecraft 26.2 /
// protocol 776) whose status JSON has NO `description`/MOTD field, throwing
// "Unexpected server MOTD type: undefined". This queries the raw server-list
// ping and parses the JSON manually, so the bot can read these servers.
function _vint(n) { const b = []; while (true) { let x = n & 0x7F; n >>>= 7; if (n !== 0) x |= 0x80; b.push(x); if (n === 0) break; } return Buffer.from(b); }
function _vstr(s) { const b = Buffer.from(s, "utf8"); return Buffer.concat([_vint(b.length), b]); }
function _u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function _stripColor(s) { return String(s).replace(/\u00a7[0-9a-fk-or]/gi, "").replace(/§[0-9a-fk-or]/gi, ""); }
function _parseStatusResponse(buf) {
  let i = 0;
  while (i < buf.length && (buf[i] & 0x80)) i++; i++;
  if (i >= buf.length) return null;
  while (i < buf.length && (buf[i] & 0x80)) i++; i++;
  if (i >= buf.length) return null;
  let slen = 0, shift = 0;
  while (i < buf.length) { const b = buf[i++]; slen |= (b & 0x7F) << shift; if (!(b & 0x80)) break; shift += 7; }
  if (i + slen > buf.length) return null;
  return JSON.parse(buf.slice(i, i + slen).toString("utf8"));
}

// Returns { host, port, sendHost } following the Falix SRV record (the real
// server node port, e.g. 25537) instead of the shared proxy port 25565.
async function resolveMinecraftTarget(serverAddress) {
  const ip = process.env.SERVER_IP;
  const mcPort = parseInt(process.env.MINECRAFT_PORT || process.env.MC_PORT, 10);
  if (ip && Number.isInteger(mcPort) && mcPort > 0) return { host: ip, port: mcPort, sendHost: serverAddress };
  try {
    const srv = await dns.promises.resolveSrv('_minecraft._tcp.' + serverAddress);
    if (srv && srv[0]) return { host: serverAddress, port: srv[0].port, sendHost: serverAddress };
  } catch {}
  return { host: serverAddress, port: 25565, sendHost: serverAddress };
}

// Resolves the correct host/port, performs a raw server-list ping, and returns a
// normalized result shaped like the old minecraft-server-util result. Throws if
// unreachable. A Falix "OFFLINE / join to auto-start" reply is still returned so
// isActuallyOffline() can decide online vs offline.
async function rawMinecraftStatus(serverAddress) {
  const { host, port, sendHost } = await resolveMinecraftTarget(serverAddress);
  const t0 = Date.now();
  const data = await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const sock = net.connect(port, host, () => {
      try {
        const hs = Buffer.concat([_vint(0), _vint(47), _vstr(sendHost), _u16(port), _vint(1)]);
        sock.write(Buffer.concat([_vint(hs.length), hs]));
        sock.write(Buffer.concat([_vint(1), _vint(0)]));
      } catch (e) { fail(e); }
    });
    const timer = setTimeout(() => fail(new Error("Server is offline or unreachable")), 6000);
    function fail(e) { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch {} reject(e); }
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      let parsed;
      try { parsed = _parseStatusResponse(buf); } catch { return; }
      if (!parsed) return;
      settled = true; clearTimeout(timer); try { sock.destroy(); } catch {}
      resolve(parsed);
    });
    sock.on("error", () => fail(new Error("Server is offline or unreachable")));
  });
  const players = data.players || {};
  const sample = Array.isArray(players.sample) ? players.sample : null;
  let cleanDesc = "";
  const desc = data.description;
  if (typeof desc === "string") cleanDesc = _stripColor(desc);
  else if (desc && typeof desc === "object") {
    try { cleanDesc = _stripColor((Array.isArray(desc) ? desc.map(c => c.text || "").join("") : desc.text) || ""); } catch { cleanDesc = ""; }
  }
  return {
    online: true,
    players: { online: players.online ?? 0, max: players.max ?? 0, sample },
    version: { name: data.version?.name || "Unknown", protocol: data.version?.protocol },
    motd: { clean: cleanDesc, raw: cleanDesc, html: "" },
    roundTripLatency: Date.now() - t0,
    sample,
  };
}

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

// ─── Start Function (instance-safe) ───────────────────────────────────────
async function start(token, options = {}) {
  const { prefix = '!', serverSubdomain, mgmtHost, mgmtPort, mgmtSecret, ownerId, guildId, dataDir } = options;

  const SERVER_ADDRESS = `${serverSubdomain}.falixsrv.me`;
  const START_URL = `https://falixnodes.net/startserver?ip=${SERVER_ADDRESS}`;
  const BOT_START_TIME = Date.now();
  const POLL_INTERVAL_MS = 30_000;
  let prevState = { online: null, playerNames: new Set(), playerCount: 0 };

  // All per-instance state lives here (never module-level), so multiple bots can
  // share this module without interfering with each other.
  let client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
  });
  let botData = {};
  const DATA_FILE = path.join(dataDir || '.', 'data.json');

  if (dataDir && !fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  try { if (fs.existsSync(DATA_FILE)) botData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}

  function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  }

  // Cache DNS SRV + last known status (per instance)
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

  // ─── Server Status (Falix-aware) ─────────────────────────────────────────
  async function getServerStatus(serverAddress) {
    // Robust raw status query: follows the Falix SRV record to the real server
    // node port and tolerates the modern (MOTD-less) status JSON that makes
    // minecraft-server-util crash. It returns the full server info, or a Falix
    // "OFFLINE / join to auto-start" reply which is classified as paused below.
    // The Falix proxy can also transiently reply "Proxy busy — retry shortly"
    // (version shows that, 0/0 players) when overloaded; we retry a few times.
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await rawMinecraftStatus(serverAddress);
        const motd = (typeof r.motd?.clean === 'string' ? r.motd.clean : '').toLowerCase();
        const ver = (r.version?.name || '').toLowerCase();
        const busy = motd.includes('busy') || ver.includes('busy');
        if (busy) {
          lastErr = new Error('busy');
          await new Promise(r2 => setTimeout(r2, 600)); // brief backoff before retry
          continue;
        }
        if (!motd.includes('offline') && !ver.includes('offline')) {
          const result = {
            online: true,
            players: r.players?.online ?? 0,
            max: r.players?.max ?? 0,
            sample: r.players?.sample || [],
            version: r.version?.name || 'Unknown',
            latency: r.roundTripLatency,
          };
          lastKnownStatus = result;
          return result;
        }
        // Server responded but says it is offline/paused (Falix idle server that
        // auto-starts when a player joins). It is not accepting players, so report
        // it as OFFLINE (with a paused hint).
        return { online: false, players: 0, max: 0, sample: [], version: 'Offline', latency: null, paused: true };
      } catch (e) { lastErr = e; }
    }
    // If we only ever got "busy", fall back to the last known good status.
    if (lastErr && lastErr.message === 'busy' && lastKnownStatus) {
      return { ...lastKnownStatus, online: true, latency: null };
    }
    // Server unreachable -> offline.
    return { online: false, players: 0, max: 0, sample: [], version: 'Unknown', latency: null, paused: false };
  }

  // ─── Register Slash Commands ─────────────────────────────────────────────
  async function registerSlashCommands(token, guildId) {
    await new Promise(resolve => {
      if (client.user && client.user.id) return resolve();
      client.once('ready', resolve);
      if (client.isReady()) resolve();
    });

    await new Promise(r => setTimeout(r, 2000));

    if (!client.user || !client.user.id) {
      console.error('  ❌ Falix MC manager: Client user not available');
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
        console.log(`  ✅ Falix MC manager: Registered ${commands.length} slash commands`);
      } catch (err) {
        console.error(`  ⚠️ Falix MC manager: Registration failed:`, err.message);
      }
    }
  }

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
    console.log(`  ⛏️ Falix MC manager online as ${botTag} (server ${SERVER_ADDRESS})`);
    if (client.user) client.user.setActivity("Falix MC Manager 🎮", { type: 3 });
    setInterval(pollServer, POLL_INTERVAL_MS);
    setTimeout(pollServer, 3000);
    await registerSlashCommands(token, guildId);
  });

  function onlineEmbed(r) {
    return { embeds: [ui({ color: C.green, title: "✅ Server Online", fields: [
      { name: "Players", value: `**${r.players}** / ${r.max}`, inline: true },
      { name: "Version", value: r.version, inline: true },
      ...(r.latency ? [{ name: "Latency", value: `${r.latency}ms ${latencyBar(r.latency)}`, inline: true }] : []),
    ] })] };
  }

  function offlineEmbed(r = {}) {
    const btn = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("▶ Start Server").setStyle(ButtonStyle.Link).setURL(START_URL)
    );
    const desc = r.paused
      ? `**${SERVER_ADDRESS}** is currently offline/idle (0 players). It will auto-start when someone joins.`
      : `**${SERVER_ADDRESS}** is not reachable.`;
    return { embeds: [ui({ color: C.red, title: "🔴 Server Offline", description: desc })], components: [btn] };
  }

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
      if (r.online) return message.reply(onlineEmbed(r));
      return message.reply(offlineEmbed(r));
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
      if (r.online) return interaction.editReply(onlineEmbed(r));
      return interaction.editReply(offlineEmbed(r));
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
