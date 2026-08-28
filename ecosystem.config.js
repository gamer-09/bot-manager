/**
 * PM2 Ecosystem Configuration
 * Optimized for Google Cloud Free Tier (1GB RAM)
 */

module.exports = {
  apps: [{
    name: 'discord-bot-manager',
    script: 'index.js',
    instances: 1,  // Single instance to save memory
    exec_mode: 'fork',
    
    // Memory management
    max_memory_restart: '700M',  // Restart if over 700MB
    
    // Node.js options
    node_args: '--max-old-space-size=512',
    
    // Environment
    env: {
      NODE_ENV: 'production',
    },
    
    // Restart settings
    autorestart: true,
    watch: false,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
    
    // Logging
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    
    // Graceful shutdown
    kill_timeout: 5000,
    listen_timeout: 10000,
    
    // Source map support
    source_map_support: false,
  }],
};
