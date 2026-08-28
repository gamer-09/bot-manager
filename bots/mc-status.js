/**
 * Bot 5: Minecraft Status Bot
 * Server status checker with auto-polling and Falix fallback
 */

const {
  Client, GatewayIntentBits, EmbedBuilder,
  REST, Routes, SlashCommandBuilder,
} = require('discord.js');
const { status } = require('minecraft-server-util');
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

// ─── Helpers ───────────────────────────────────────────────────────────────
function latencyBar(ms) {
  if (ms <= 60) return "🟢 Excellent";
  if (ms <= 120) return "🟡 Good";
  if (ms <= 250) return "🟠 Moderate";
  return "🔴 High";
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  const h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  return `${m}m ${s % 60}s`;
}

// ─── Server Status (Fast Falix-aware checker) ─────────────────────────────
const dns = require('dns');
const net = require('net');

const srvCache = {};
async function resolveServer(serverAddress) {
  if (srvCache[serverAddress]) return srvCache[serverAddress];
  let host = serverAddress, port = 25565;
  try {
    const srv = await new Promise((res, rej) => dns.resolveSrv('_minecraft._tcp.' + serverAddress, (e, a) => e ? rej(e) : res(a)));
    host = srv[0].name;
    port = srv[0].port;
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

async function getServerStatus(serverAddress) {
  const { host, port } = await resolveServer(serverAddress);

  // 1. Direct status ping (best case: full info).
  //    Falix free servers answer the handshake with an "OFFLINE" motd/version
  //    when they are asleep, so we can reliably distinguish asleep vs online.
  try {
    const r = await Promise.race([
      status(host, port, { timeout: 4000 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
    ]);
    const motd = (typeof r.motd?.clean === 'string' ? r.motd.clean : '').toLowerCase();
    const version = (r.version?.name || '').toLowerCase();
    if (!motd.includes('offline') && !version.includes('offline')) {
      return { online: true, players: r.players?.online ?? 0, max: r.players?.max ?? 0, sample: r.players?.sample || [], version: r.version?.name || 'Unknown', latency: r.roundTripLatency };
    }
    // Server responded but says it is offline/paused (Falix idle server that
    // auto-starts when a player joins). It is not accepting players, so report
    // it as OFFLINE (with a paused hint).
    return { online: false, players: 0, max: 0, sample: [], version: 'Offline', latency: null, paused: true };
  } catch { /* no direct response -> keep checking */ }

  // 2. Fallback to the public mcsrvstat.us API so an online server is still
  //    reported correctly even when the direct ping is slow/unavailable.
  try {
    const data = await fetchJSON(`https://api.mcsrvstat.us/3/${host}:${port}`);
    if (data?.online) {
      return { online: true, players: data.players?.online ?? 0, max: data.players?.max ?? 0, sample: (data.players?.list || []).map(p => ({ name: p })), version: data.version || 'Unknown', latency: null };
    }
  } catch {}

  // 3. TCP reachability (server reachable but not speaking the ping protocol).
  const reachable = await tcpPing(host, port, 2500);
  if (reachable) {
    return { online: false, players: 0, max: 0, sample: [], version: 'Offline', latency: null, paused: true };
  }

  // 4. Not reachable at all -> offline.
  return { online: false, players: 0, max: 0, sample: [], version: 'Unknown', latency: null, paused: false };
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
    console.error('  ❌ mc-status: Client user not available');
    return;
  }
  
  const rest = new REST().setToken(token);
  const commands = [
    new SlashCommandBuilder().setName("status").setDescription("Check Minecraft server status").toJSON(),
    new SlashCommandBuilder().setName("ip").setDescription("Show server IP").toJSON(),
    new SlashCommandBuilder().setName("players").setDescription("See who is online").toJSON(),
    new SlashCommandBuilder().setName("setchannel").setDescription("Set channel for live updates (Admin only)").toJSON(),
    new SlashCommandBuilder().setName("stopchannel").setDescription("Stop live updates (Admin only)").toJSON(),
    new SlashCommandBuilder().setName("uptime").setDescription("Bot uptime info").toJSON(),
    new SlashCommandBuilder().setName("help").setDescription("Show commands").toJSON(),
  ];
  
  if (guildId) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
      console.log(`  ✅ mc-status: Registered ${commands.length} slash commands`);
    } catch (err) {
      console.error(`  ⚠️ mc-status: Registration failed:`, err.message);
    }
  }
}

// ─── Start Function ────────────────────────────────────────────────────────
async function start(token, options = {}) {
  const { prefix = '!', serverSubdomain, guildId, dataDir } = options;
  const SERVER_ADDRESS = `${serverSubdomain}.falixsrv.me`;
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
    ],
  });

  function ui({ color, title, description = null, fields = [] }) {
    return new EmbedBuilder()
      .setColor(color).setTitle(title).setTimestamp()
      .setAuthor({ name: "🎮 MC Status Bot" })
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
      await postUpdate(ui({ color: 0x57F287, title: "🟢 Server Just Came Online!", description: `**${SERVER_ADDRESS}** is back up.` }));
    }
    if (prevState.online === true && !r.online) {
      await postUpdate(ui({ color: 0xED4245, title: "🔴 Server Went Offline", description: `**${SERVER_ADDRESS}** is no longer reachable.` }));
      prevState.playerNames = new Set(); prevState.playerCount = 0;
    }
    if (r.online) {
      const currentNames = new Set(r.sample.map(p => p.name || p));
      const joined = [...currentNames].filter(n => !prevState.playerNames.has(n));
      const left = [...prevState.playerNames].filter(n => !currentNames.has(n));
      for (const name of joined) await postUpdate(ui({ color: 0x57F287, title: "👋 Player Joined", fields: [{ name: "Player", value: `\`${name}\``, inline: true }] }));
      for (const name of left) await postUpdate(ui({ color: 0xFEE75C, title: "🚪 Player Left", fields: [{ name: "Player", value: `\`${name}\``, inline: true }] }));
      prevState.playerNames = currentNames;
      prevState.playerCount = r.players;
    }
    prevState.online = r.online;
  }

  client.once('ready', async () => {
    const botTag = client.user?.tag ?? 'Unknown';
    console.log(`  🎮 MC Status Bot online as ${botTag}`);
    if (client.user) client.user.setActivity('Minecraft Server Status', { type: 3 });
    setInterval(pollServer, POLL_INTERVAL_MS);
    setTimeout(pollServer, 3000);
    await registerSlashCommands(token, guildId);
  });

  // Prefix commands
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith(prefix)) return;
    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args[0].toLowerCase();

    if (command === 'status' || command === 'ping') {
      const r = await getServerStatus(SERVER_ADDRESS);
      if (r.online) {
        await message.reply({ embeds: [ui({ color: 0x57F287, title: '✅ Server Online', fields: [
          { name: 'Address', value: `\`${SERVER_ADDRESS}\``, inline: true },
          { name: 'Players', value: `**${r.players}** / ${r.max}`, inline: true },
          { name: 'Version', value: r.version, inline: true },
          ...(r.latency ? [{ name: 'Latency', value: `${r.latency}ms ${latencyBar(r.latency)}`, inline: true }] : []),
        ] })] });
      } else {
        const desc = r.paused
          ? `**${SERVER_ADDRESS}** is currently offline/idle (0 players). It will auto-start when someone joins.`
          : `Could not reach **${SERVER_ADDRESS}**.`;
        await message.reply({ embeds: [ui({ color: 0xED4245, title: '🔴 Server Offline', description: desc })] });
      }
    } else if (command === 'ip') {
      await message.reply({ embeds: [ui({ color: 0x00CED1, title: '🌐 Server Address', description: `\`\`\`${SERVER_ADDRESS}\`\`\``, fields: [
        { name: 'Port', value: '25565', inline: true }, { name: 'Edition', value: 'Java', inline: true },
      ] })] });
    } else if (command === 'players') {
      const r = await getServerStatus(SERVER_ADDRESS);
      if (r.online) {
        const names = r.sample.map(p => `\`${p.name || p}\``).join('\n') || 'Nobody online';
        await message.reply({ embeds: [ui({ color: 0x5865F2, title: `👥 Players — ${r.players}/${r.max}`, description: names })] });
      } else {
        await message.reply({ embeds: [ui({ color: 0xED4245, title: '🔴 Server Offline' })] });
      }
    } else if (command === 'setchannel') {
      if (!message.member?.permissions.has('Administrator')) {
        return message.reply({ embeds: [ui({ color: 0xED4245, title: '🔒 Access Denied', description: 'Only admins can set the activity channel.' })] });
      }
      botData.activityChannelId = message.channel.id;
      saveData(botData);
      prevState = { online: null, playerNames: new Set(), playerCount: 0 };
      await message.reply({ embeds: [ui({ color: 0x57F287, title: '✅ Activity Channel Set', description: `<#${message.channel.id}> will receive live updates.` })] });
    } else if (command === 'stopchannel') {
      if (!message.member?.permissions.has('Administrator')) {
        return message.reply({ embeds: [ui({ color: 0xED4245, title: '🔒 Access Denied' })] });
      }
      botData.activityChannelId = null;
      saveData(botData);
      await message.reply({ embeds: [ui({ color: 0xED4245, title: '🔕 Activity Updates Disabled' })] });
    } else if (command === 'uptime') {
      await message.reply({ embeds: [ui({ color: 0x9B59B6, title: '⏱ Bot Uptime', fields: [
        { name: 'Running for', value: `**${formatUptime(Date.now() - BOT_START_TIME)}**`, inline: true },
        { name: 'Activity Channel', value: botData.activityChannelId ? `<#${botData.activityChannelId}>` : '*Not set*', inline: true },
      ] })] });
    } else if (command === 'help') {
      await message.reply({ embeds: [ui({ color: 0x5865F2, title: '📖 MC Status Commands', description: `\`${prefix}status\` · \`${prefix}ip\` · \`${prefix}players\` · \`${prefix}setchannel\` · \`${prefix}stopchannel\` · \`${prefix}uptime\` · \`${prefix}help\`` })] });
    }
  });

  // Slash commands
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'status') {
      await interaction.deferReply();
      const r = await getServerStatus(SERVER_ADDRESS);
      if (r.online) {
        await interaction.editReply({ embeds: [ui({ color: 0x57F287, title: '✅ Server Online', fields: [
          { name: 'Address', value: `\`${SERVER_ADDRESS}\``, inline: true },
          { name: 'Players', value: `**${r.players}** / ${r.max}`, inline: true },
          { name: 'Version', value: r.version, inline: true },
          ...(r.latency ? [{ name: 'Latency', value: `${r.latency}ms ${latencyBar(r.latency)}`, inline: true }] : []),
        ] })] });
      } else {
        const desc = r.paused
          ? `**${SERVER_ADDRESS}** is currently offline/idle (0 players). It will auto-start when someone joins.`
          : `Could not reach **${SERVER_ADDRESS}**.`;
        await interaction.editReply({ embeds: [ui({ color: 0xED4245, title: '🔴 Server Offline', description: desc })] });
      }
    } else if (interaction.commandName === 'ip') {
      await interaction.reply({ embeds: [ui({ color: 0x00CED1, title: '🌐 Server Address', description: `\`\`\`${SERVER_ADDRESS}\`\`\`` })] });
    } else if (interaction.commandName === 'players') {
      await interaction.deferReply();
      const r = await getServerStatus(SERVER_ADDRESS);
      if (r.online) {
        const names = r.sample.map(p => `\`${p.name || p}\``).join('\n') || 'Nobody online';
        await interaction.editReply({ embeds: [ui({ color: 0x5865F2, title: `👥 Players — ${r.players}/${r.max}`, description: names })] });
      } else {
        await interaction.editReply({ embeds: [ui({ color: 0xED4245, title: '🔴 Server Offline' })] });
      }
    } else if (interaction.commandName === 'setchannel') {
      if (!interaction.member?.permissions.has('Administrator')) {
        return interaction.reply({ embeds: [ui({ color: 0xED4245, title: '🔒 Access Denied', description: 'Only admins can set the activity channel.' })], ephemeral: true });
      }
      botData.activityChannelId = interaction.channelId;
      saveData(botData);
      prevState = { online: null, playerNames: new Set(), playerCount: 0 };
      await interaction.reply({ embeds: [ui({ color: 0x57F287, title: '✅ Activity Channel Set', description: `<#${interaction.channelId}> will receive live updates.` })] });
    } else if (interaction.commandName === 'stopchannel') {
      if (!interaction.member?.permissions.has('Administrator')) {
        return interaction.reply({ embeds: [ui({ color: 0xED4245, title: '🔒 Access Denied' })], ephemeral: true });
      }
      botData.activityChannelId = null;
      saveData(botData);
      await interaction.reply({ embeds: [ui({ color: 0xED4245, title: '🔕 Activity Updates Disabled' })] });
    } else if (interaction.commandName === 'uptime') {
      await interaction.reply({ embeds: [ui({ color: 0x9B59B6, title: '⏱ Bot Uptime', fields: [
        { name: 'Running for', value: `**${formatUptime(Date.now() - BOT_START_TIME)}**`, inline: true },
        { name: 'Activity Channel', value: botData.activityChannelId ? `<#${botData.activityChannelId}>` : '*Not set*', inline: true },
      ] })] });
    } else if (interaction.commandName === 'help') {
      await interaction.reply({ embeds: [ui({ color: 0x5865F2, title: '📖 Commands', description: '`/status` · `/ip` · `/players` · `/setchannel` · `/stopchannel` · `/uptime` · `/help`' })] });
    }
  });

  await client.login(token);
  return client;
}

module.exports = { start };
