/**
 * Bot 4: Discord Bot (Falix Minecraft Manager #2)
 * Minecraft server management bot - same as tommyland but separate instance
 */

// Reuse tommyland module with different config
const tommyland = require('./tommyland');

module.exports = { start: tommyland.start };
