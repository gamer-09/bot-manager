# Discord Bot Manager

Run all 5 Discord bots in a single Node.js process, optimized for Google Cloud Free Tier.

## 🤖 Bots Included

| # | Bot | Type | Token Env Var |
|---|-----|------|---------------|
| 1 | **just-bot** | Isekai Chronicles RPG | `BOT1_TOKEN` |
| 2 | **admin-bot** | Discord Moderation | `BOT2_TOKEN` |
| 3 | **tommyland** | Falix MC Manager | `BOT3_TOKEN` |
| 4 | **discord-bot** | Falix MC Manager #2 | `BOT4_TOKEN` |
| 5 | **mc-status** | Minecraft Status | `BOT5_TOKEN` |

## 📊 Resource Usage

- **RAM:** ~200-300MB (fits in 1GB free tier)
- **CPU:** Minimal (mostly idle)
- **Single process:** Shares Node.js runtime across all bots

## 🚀 Quick Start

### 1. Clone & Setup

```bash
git clone <your-repo>
cd bot-manager
cp .env.example .env
# Edit .env with your tokens
```

### 2. Run Locally

```bash
npm install
npm start
```

### 3. Deploy to Google Cloud

```bash
# On your Google Cloud VM:
chmod +x deploy.sh
./deploy.sh
```

## 📁 Project Structure

```
bot-manager/
├── index.js              # Main entry point
├── bots/
│   ├── just-bot.js       # Isekai Chronicles
│   ├── admin-bot.js      # Moderation
│   ├── tommyland.js      # Falix MC Manager
│   ├── discord-bot.js    # Falix MC Manager #2
│   └── mc-status.js      # Minecraft Status
├── data/                 # Bot data (auto-created)
├── .env.example          # Environment template
├── package.json          # Dependencies
├── Dockerfile            # Docker support
├── ecosystem.config.js   # PM2 config
└── deploy.sh             # Google Cloud deploy script
```

## 🔧 Configuration

Copy `.env.example` to `.env` and fill in:

```env
BOT1_TOKEN=your_isekai_chronicles_token
BOT2_TOKEN=your_admin_bot_token
BOT2_GUILD_ID=your_server_id
BOT3_TOKEN=your_tommyland_token
BOT3_SERVER_SUBDOMAIN=your_mc_server
BOT3_MGMT_SECRET=your_mgmt_secret
BOT3_OWNER_ID=your_discord_id
BOT3_GUILD_ID=your_guild_id
# ... etc for BOT4, BOT5
```

## 📊 Monitoring

### Health Check
```bash
curl http://localhost:8080/health
```

### PM2 Commands
```bash
pm2 status          # View all bots
pm2 logs            # View logs
pm2 monit           # Monitor resources
pm2 restart all     # Restart all bots
pm2 stop all        # Stop all bots
```

## 🐳 Docker

```bash
docker build -t discord-bot-manager .
docker run -d --name bots --env-file .env -p 8080:8080 discord-bot-manager
```

## ⚡ Memory Optimization

This setup runs all 5 bots in **one process** instead of 5 separate processes:

| Approach | RAM Usage |
|----------|-----------|
| 5 separate processes | ~350-500MB |
| **1 combined process** | **~200-300MB** |
| Savings | **~50% less RAM** |

Key optimizations:
- Single Node.js runtime shared across all bots
- `--max-old-space-size=512` limits heap to 512MB
- PM2 auto-restarts if memory exceeds 700MB
- Alpine Docker image (smallest possible)

## 🔒 Security

- Never commit `.env` file
- Use Google Cloud VM firewall rules
- Restrict SSH access
- Use strong bot tokens

## 📝 License

MIT
