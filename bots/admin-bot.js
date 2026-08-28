/**
 * Bot 2: Admin Help Bot
 * Discord moderation bot with auto-welcome and discipline system
 */

const {
  Client, GatewayIntentBits, Events, ActivityType,
  REST, Routes, TextChannel, Partials, MessageFlags,
  SlashCommandBuilder,
} = require('discord.js');

let client = null;

// ─── Simple Welcome Embed ──────────────────────────────────────────────────
function welcomeEmbed(member) {
  return {
    color: 0x57F287,
    title: `Welcome to ${member.guild.name}!`,
    description: `Hey ${member}, welcome to the server!`,
    thumbnail: { url: member.user.displayAvatarURL() },
    timestamp: new Date().toISOString(),
  };
}

// ─── Auto-Mod (simplified) ────────────────────────────────────────────────
async function handleAutoMod(message) {
  if (message.author.bot) return;
  if (message.mentions.users.size >= 5) {
    await message.delete().catch(() => {});
    await message.channel.send(`${message.author}, please don't spam mentions!`).catch(() => {});
  }
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
    console.error('  ❌ admin-bot: Client user not available');
    return;
  }
  
  const rest = new REST({ version: "10" }).setToken(token);
  const commands = [
    new SlashCommandBuilder().setName("help").setDescription("Show all commands").toJSON(),
    new SlashCommandBuilder().setName("ping").setDescription("Check bot latency").toJSON(),
    new SlashCommandBuilder().setName("serverinfo").setDescription("Show server info").toJSON(),
    new SlashCommandBuilder().setName("userinfo").setDescription("Show user info")
      .addUserOption(opt => opt.setName("user").setDescription("Target user").setRequired(false)).toJSON(),
  ];
  
  if (guildId) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
      console.log(`  ✅ admin-bot: Registered ${commands.length} slash commands`);
    } catch (err) {
      console.error(`  ⚠️ admin-bot: Registration failed:`, err.message);
    }
  }
}

// ─── Start Function ────────────────────────────────────────────────────────
async function start(token, options = {}) {
  const { guildId, welcomeChannel = 'welcome' } = options;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.GuildMember],
  });

  client.on(Events.Error, (err) => {
    console.error('  ⚠️ Admin bot error:', err);
  });

  client.once(Events.ClientReady, async (readyClient) => {
    const botTag = readyClient.user?.tag ?? 'Unknown';
    console.log(`  🛡️ Admin Help Bot online as ${botTag}`);
    if (readyClient.user) readyClient.user.setActivity('the server', { type: ActivityType.Watching });
    await registerSlashCommands(token, guildId);
  });

  client.on(Events.MessageCreate, async (message) => {
    await handleAutoMod(message).catch(err => console.error('  ⚠️ Auto-mod error:', err));
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      const channel = member.guild.channels.cache.find(c => c.name === welcomeChannel) || 
                      member.guild.channels.cache.get(guildId);
      if (channel) {
        await channel.send({ embeds: [welcomeEmbed(member)] });
        console.log(`  👋 Welcome sent for ${member.user.tag}`);
      }
    } catch (err) {
      console.error('  ⚠️ Welcome error:', err);
    }
  });

  // Slash commands
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    try {
      if (commandName === 'help') {
        await interaction.reply({
          embeds: [{
            color: 0x5865F2,
            title: '🛡️ Admin Bot Commands',
            fields: [
              { name: 'Info', value: '`/ping` · `/serverinfo` · `/userinfo` · `/help`', inline: false },
              { name: 'Moderation', value: 'Prefix commands: `!warn` · `!kick` · `!ban` · `!mute` · `!unmute` · `!clearwarnings`', inline: false },
            ],
          }],
          flags: MessageFlags.Ephemeral,
        });
      } else if (commandName === 'ping') {
        const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
        const latency = sent.createdTimestamp - interaction.createdTimestamp;
        await interaction.editReply({
          content: null,
          embeds: [{
            color: 0x57F287,
            title: '🏓 Pong!',
            fields: [
              { name: 'Latency', value: `**${latency}ms**`, inline: true },
              { name: 'API', value: `**${client.ws.ping}ms**`, inline: true },
            ],
          }],
        });
      } else if (commandName === 'serverinfo') {
        const guild = interaction.guild;
        await interaction.reply({
          embeds: [{
            color: 0x5865F2,
            title: `📊 ${guild.name}`,
            fields: [
              { name: 'Members', value: `${guild.memberCount}`, inline: true },
              { name: 'Channels', value: `${guild.channels.cache.size}`, inline: true },
              { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
              { name: 'Owner', value: guild.ownerId ? `<@${guild.ownerId}>` : 'Unknown', inline: true },
              { name: 'Boost Level', value: `${guild.premiumTier}`, inline: true },
              { name: 'Boosts', value: `${guild.premiumSubscriptionCount || 0}`, inline: true },
            ],
          }],
          flags: MessageFlags.Ephemeral,
        });
      } else if (commandName === 'userinfo') {
        const user = interaction.options.getUser('user') || interaction.user;
        const member = interaction.guild?.members.cache.get(user.id);
        await interaction.reply({
          embeds: [{
            color: 0x5865F2,
            title: `👤 ${user.tag}`,
            fields: [
              { name: 'ID', value: user.id, inline: true },
              { name: 'Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
              { name: 'Joined', value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Unknown', inline: true },
              { name: 'Roles', value: member ? `${member.roles.cache.size}` : 'Unknown', inline: true },
            ],
            thumbnail: { url: user.displayAvatarURL() },
          }],
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (err) {
      console.error(`[admin-bot:${commandName}]`, err);
      try {
        const errMsg = { content: "An error occurred.", flags: MessageFlags.Ephemeral };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(errMsg);
        } else {
          await interaction.reply(errMsg);
        }
      } catch {}
    }
  });

  // Prefix commands
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    const prefix = '!';
    if (!message.content.startsWith(prefix)) return;
    
    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args[0].toLowerCase();
    
    if (command === 'ping') {
      const sent = await message.reply('Pinging...');
      const latency = sent.createdTimestamp - message.createdTimestamp;
      await sent.edit(`🏓 Pong! Latency: **${latency}ms** | API: **${client.ws.ping}ms**`);
    } else if (command === 'help') {
      await message.reply({
        embeds: [{
          color: 0x5865F2,
          title: '🛡️ Admin Bot Commands',
          fields: [
            { name: 'Info', value: '`!ping` · `!serverinfo` · `!userinfo` · `!help`', inline: false },
            { name: 'Moderation', value: '`!warn @user` · `!kick @user` · `!ban @user` · `!unban @user`', inline: false },
          ],
        }],
      });
    } else if (command === 'serverinfo') {
      const guild = message.guild;
      await message.reply({
        embeds: [{
          color: 0x5865F2,
          title: `📊 ${guild.name}`,
          fields: [
            { name: 'Members', value: `${guild.memberCount}`, inline: true },
            { name: 'Channels', value: `${guild.channels.cache.size}`, inline: true },
            { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
          ],
        }],
      });
    } else if (command === 'userinfo') {
      const user = message.mentions.users.first() || message.author;
      const member = message.guild?.members.cache.get(user.id);
      await message.reply({
        embeds: [{
          color: 0x5865F2,
          title: `👤 ${user.tag}`,
          fields: [
            { name: 'ID', value: user.id, inline: true },
            { name: 'Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
            { name: 'Joined', value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Unknown', inline: true },
          ],
          thumbnail: { url: user.displayAvatarURL() },
        }],
      });
    } else if (command === 'warn') {
      const target = message.mentions.users.first();
      if (!target) return message.reply('❌ Mention a user to warn.');
      await message.reply(`⚠️ ${target.tag} has been warned.`);
    } else if (command === 'kick') {
      const target = message.mentions.members.first();
      if (!target) return message.reply('❌ Mention a user to kick.');
      if (!message.member.permissions.has('KickMembers')) return message.reply('❌ You need Kick Members permission.');
      try {
        await target.kick();
        await message.reply(`👢 ${target.user.tag} has been kicked.`);
      } catch {
        await message.reply('❌ Failed to kick user.');
      }
    } else if (command === 'ban') {
      const target = message.mentions.members.first();
      if (!target) return message.reply('❌ Mention a user to ban.');
      if (!message.member.permissions.has('BanMembers')) return message.reply('❌ You need Ban Members permission.');
      try {
        await target.ban();
        await message.reply(`🔨 ${target.user.tag} has been banned.`);
      } catch {
        await message.reply('❌ Failed to ban user.');
      }
    } else if (command === 'unban') {
      const userId = args[1];
      if (!userId) return message.reply('❌ Provide a user ID to unban.');
      if (!message.member.permissions.has('BanMembers')) return message.reply('❌ You need Ban Members permission.');
      try {
        await message.guild.members.unban(userId);
        await message.reply(`✅ User ${userId} has been unbanned.`);
      } catch {
        await message.reply('❌ Failed to unban user.');
      }
    }
  });

  await client.login(token);
  return client;
}

module.exports = { start };
