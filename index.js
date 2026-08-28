/**
 * Discord Bot Manager
 * Runs all 5 Discord bots in a single Node.js process
 * Optimized for low memory usage on Google Cloud Free Tier
 */

require('dotenv').config();
const http = require('http');
const path = require('path');

// ─── Memory Optimization ───────────────────────────────────────────────────
// Limit Node.js heap to 512MB to prevent OOM on free tier
if (!process.env.NODE_OPTIONS?.includes('--max-old-space-size')) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --max-old-space-size=512`;
}

// ─── Bot Registry ──────────────────────────────────────────────────────────
const bots = [];
const botStatus = {};

// ─── Health Check Server ───────────────────────────────────────────────────
const HEALTH_PORT = process.env.HEALTH_PORT || 8080;
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    const status = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      bots: botStatus,
      timestamp: new Date().toISOString()
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Discord Bot Manager is running.\n');
  }
});

server.listen(HEALTH_PORT, () => {
  console.log(`✅ Health check server on port ${HEALTH_PORT}`);
});

// ─── Graceful Shutdown ─────────────────────────────────────────────────────
function shutdown() {
  console.log('\n🛑 Shutting down all bots...');
  bots.forEach(bot => {
    try {
      if (bot.client && bot.client.isReady()) {
        bot.client.destroy();
        console.log(`  ✅ ${bot.name} destroyed`);
      }
    } catch (err) {
      console.error(`  ❌ Error destroying ${bot.name}:`, err.message);
    }
  });
  server.close(() => {
    console.log('👋 All bots stopped. Goodbye!');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Load Bots ─────────────────────────────────────────────────────────────
async function loadBots() {
  console.log('🚀 Loading bots...\n');

  // Bot 1: Isekai Chronicles
  if (process.env.BOT1_TOKEN) {
    try {
      const justBot = require('./bots/just-bot');
      const client = await justBot.start(process.env.BOT1_TOKEN, {
        prefix: process.env.BOT1_PREFIX || '!',
        dataDir: path.join(__dirname, 'data', 'just-bot')
      });
      bots.push({ name: 'just-bot', client, module: justBot });
      botStatus['just-bot'] = 'online';
      console.log('  ✅ just-bot (Isekai Chronicles) loaded');
    } catch (err) {
      console.error('  ❌ Failed to load just-bot:', err.message);
      botStatus['just-bot'] = 'error';
    }
  }

  // Bot 2: Admin Help Bot
  if (process.env.BOT2_TOKEN) {
    try {
      const adminBot = require('./bots/admin-bot');
      const client = await adminBot.start(process.env.BOT2_TOKEN, {
        guildId: process.env.BOT2_GUILD_ID,
        welcomeChannel: process.env.BOT2_WELCOME_CHANNEL || 'welcome'
      });
      bots.push({ name: 'admin-bot', client, module: adminBot });
      botStatus['admin-bot'] = 'online';
      console.log('  ✅ admin-bot (Moderation) loaded');
    } catch (err) {
      console.error('  ❌ Failed to load admin-bot:', err.message);
      botStatus['admin-bot'] = 'error';
    }
  }

  // Bot 3: Tommyland (Falix Minecraft Manager)
  if (process.env.BOT3_TOKEN) {
    try {
      const tommyland = require('./bots/tommyland');
      const client = await tommyland.start(process.env.BOT3_TOKEN, {
        prefix: process.env.BOT3_PREFIX || '!',
        serverSubdomain: process.env.BOT3_SERVER_SUBDOMAIN,
        mgmtHost: process.env.BOT3_MGMT_HOST || '167.235.93.185',
        mgmtPort: process.env.BOT3_MGMT_PORT || '25580',
        mgmtSecret: process.env.BOT3_MGMT_SECRET,
        ownerId: process.env.BOT3_OWNER_ID,
        guildId: process.env.BOT3_GUILD_ID,
        dataDir: path.join(__dirname, 'data', 'tommyland')
      });
      bots.push({ name: 'tommyland', client, module: tommyland });
      botStatus['tommyland'] = 'online';
      console.log('  ✅ tommyland (Falix MC Manager) loaded');
    } catch (err) {
      console.error('  ❌ Failed to load tommyland:', err.message);
      botStatus['tommyland'] = 'error';
    }
  }

  // Bot 4: Discord Bot (Falix Minecraft Manager #2)
  if (process.env.BOT4_TOKEN) {
    try {
      const discordBot = require('./bots/discord-bot');
      const client = await discordBot.start(process.env.BOT4_TOKEN, {
        prefix: process.env.BOT4_PREFIX || '!',
        serverSubdomain: process.env.BOT4_SERVER_SUBDOMAIN,
        mgmtHost: process.env.BOT4_MGMT_HOST || '167.235.93.185',
        mgmtPort: process.env.BOT4_MGMT_PORT || '25580',
        mgmtSecret: process.env.BOT4_MGMT_SECRET,
        ownerId: process.env.BOT4_OWNER_ID,
        guildId: process.env.BOT4_GUILD_ID,
        dataDir: path.join(__dirname, 'data', 'discord-bot')
      });
      bots.push({ name: 'discord-bot', client, module: discordBot });
      botStatus['discord-bot'] = 'online';
      console.log('  ✅ discord-bot (Falix MC Manager #2) loaded');
    } catch (err) {
      console.error('  ❌ Failed to load discord-bot:', err.message);
      botStatus['discord-bot'] = 'error';
    }
  }

  // Bot 5: Minecraft Status Bot
  if (process.env.BOT5_TOKEN) {
    try {
      const mcStatus = require('./bots/mc-status');
      const client = await mcStatus.start(process.env.BOT5_TOKEN, {
        prefix: process.env.BOT5_PREFIX || '!',
        serverSubdomain: process.env.BOT5_SERVER_SUBDOMAIN,
        dataDir: path.join(__dirname, 'data', 'mc-status')
      });
      bots.push({ name: 'mc-status', client, module: mcStatus });
      botStatus['mc-status'] = 'online';
      console.log('  ✅ mc-status (Minecraft Status) loaded');
    } catch (err) {
      console.error('  ❌ Failed to load mc-status:', err.message);
      botStatus['mc-status'] = 'error';
    }
  }

  console.log(`\n📊 Summary: ${bots.length} bot(s) loaded`);
  console.log('🔄 All bots running in single process (memory-optimized)');
}

// ─── Start ─────────────────────────────────────────────────────────────────
loadBots().catch(err => {
  console.error('💥 Fatal error loading bots:', err);
  process.exit(1);
});
