#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# Discord Bot Manager - Google Cloud Deployment Script
# Run this on your Google Cloud VM
# ═══════════════════════════════════════════════════════════════════════════════

set -e

echo "🚀 Discord Bot Manager - Google Cloud Deployment"
echo "=================================================="

# ─── System Update ──────────────────────────────────────────────────────────
echo "📦 Updating system..."
sudo apt-get update -qq
sudo apt-get upgrade -y -qq

# ─── Install Node.js 20 ────────────────────────────────────────────────────
echo "📦 Installing Node.js 20..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "  Node.js $(node -v) installed"

# ─── Install PM2 ───────────────────────────────────────────────────────────
echo "📦 Installing PM2..."
if ! command -v pm2 &> /dev/null; then
  sudo npm install -g pm2
fi
echo "  PM2 $(pm2 -v) installed"

# ─── Create App Directory ──────────────────────────────────────────────────
echo "📁 Setting up app directory..."
APP_DIR="/opt/discord-bot-manager"
sudo mkdir -p $APP_DIR
sudo chown $USER:$USER $APP_DIR

# ─── Copy Files ────────────────────────────────────────────────────────────
echo "📋 Copying files..."
cp -r . $APP_DIR/
cd $APP_DIR

# ─── Install Dependencies ──────────────────────────────────────────────────
echo "📦 Installing dependencies..."
npm install --omit=dev

# ─── Create Data Directories ───────────────────────────────────────────────
echo "📁 Creating data directories..."
mkdir -p data/just-bot data/tommyland data/discord-bot data/mc-status logs

# ─── Create .env if not exists ─────────────────────────────────────────────
if [ ! -f .env ]; then
  echo "⚠️  No .env file found!"
  echo "   Copy .env.example to .env and fill in your tokens:"
  echo "   cp .env.example .env"
  echo "   nano .env"
  echo ""
  echo "   Then run this script again."
  exit 1
fi

# ─── Stop existing PM2 process ─────────────────────────────────────────────
echo "🛑 Stopping existing processes..."
pm2 delete discord-bot-manager 2>/dev/null || true

# ─── Start with PM2 ────────────────────────────────────────────────────────
echo "🚀 Starting Discord Bot Manager..."
pm2 start ecosystem.config.js

# ─── Save PM2 Configuration ────────────────────────────────────────────────
echo "💾 Saving PM2 configuration..."
pm2 save

# ─── Setup PM2 to Start on Boot ────────────────────────────────────────────
echo "🔄 Setting up auto-start on boot..."
pm2 startup systemd -u $USER --hp /home/$USER

# ─── Setup Firewall ────────────────────────────────────────────────────────
echo "🔥 Configuring firewall..."
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 8080/tcp  # Health check
sudo ufw --force enable

# ─── Status ────────────────────────────────────────────────────────────────
echo ""
echo "✅ Deployment complete!"
echo ""
echo "📊 Status:"
pm2 status
echo ""
echo "📝 Useful commands:"
echo "   pm2 logs                    # View logs"
echo "   pm2 monit                   # Monitor resources"
echo "   pm2 restart all             # Restart all bots"
echo "   pm2 stop all                # Stop all bots"
echo "   curl http://localhost:8080/health  # Check health"
echo ""
echo "🌐 Your bots are now running 24/7!"
echo "   Health check: http://YOUR_VM_IP:8080/health"
echo ""
