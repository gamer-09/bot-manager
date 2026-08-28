# ═══════════════════════════════════════════════════════════════════════════════
# Discord Bot Manager - Optimized for Google Cloud Free Tier
# Memory limit: 800MB (leaves 200MB for OS)
# ═══════════════════════════════════════════════════════════════════════════════

FROM node:20-alpine

# Set memory limit
ENV NODE_OPTIONS="--max-old-space-size=512"

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy application files
COPY . .

# Create data directories
RUN mkdir -p data/just-bot data/tommyland data/discord-bot data/mc-status

# Expose health check port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start the bot manager
CMD ["node", "--max-old-space-size=512", "index.js"]
