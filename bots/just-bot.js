/**
 * Bot 1: Isekai Chronicles (just-bot)
 * RPG Discord bot with quests, factions, and combat
 */

const {
  Client, GatewayIntentBits, EmbedBuilder,
  REST, Routes, SlashCommandBuilder,
  ChannelType, PermissionFlagsBits,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

let client = null;
let db = null;
let DATA_FILE = null;

// ─── Data Layer ────────────────────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {}
  return {
    users: {}, factions: {},
    world: { lore: [], currentEvent: null, lastEventDate: null, warHistory: [] },
    config: { leaderboardChannelId: null, lastLeaderboard: [] },
  };
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

// ─── Definitions ───────────────────────────────────────────────────────────
const RACES = {
  demon: { name: "Demon", color: "#8B0000", emoji: "👿", hp: 120, atk: 25, def: 15, int: 20, spd: 10 },
  fallen_angel: { name: "Fallen Angel", color: "#4B0082", emoji: "🪽", hp: 90, atk: 10, def: 10, int: 40, spd: 25 },
  cursed_human: { name: "Cursed Human", color: "#2F4F4F", emoji: "💀", hp: 110, atk: 20, def: 20, int: 20, spd: 20 },
  vampire: { name: "Vampire", color: "#800020", emoji: "🧛", hp: 115, atk: 30, def: 10, int: 15, spd: 30 },
  witch: { name: "Witch", color: "#483D8B", emoji: "🧙", hp: 80, atk: 10, def: 10, int: 50, spd: 15 },
};

const CLASSES = {
  assassin: { name: "Assassin", emoji: "🗡️", atk: 20, def: 0, int: 0, spd: 20, hp: -10, crit: 0.25 },
  mage: { name: "Mage", emoji: "🔮", atk: 0, def: 0, int: 25, spd: 5, hp: -10, crit: 0.10 },
  knight: { name: "Knight", emoji: "🛡️", atk: 10, def: 25, int: 0, spd: -5, hp: 30, crit: 0.05 },
  oracle: { name: "Oracle", emoji: "👁️", atk: 0, def: 5, int: 20, spd: 15, hp: 0, crit: 0.15 },
  necromancer: { name: "Necromancer", emoji: "☠️", atk: 15, def: 0, int: 20, spd: 0, hp: 0, crit: 0.10 },
};

const QUEST_POOL = [
  { id: "shadow_catacombs", name: "The Shadow Catacombs", difficulty: "easy", xp: 50, coins: 30, durationMs: 3*60*1000, deathChance: 0 },
  { id: "cursed_forest", name: "The Ever-Weeping Forest", difficulty: "easy", xp: 60, coins: 40, durationMs: 3*60*1000, deathChance: 0 },
  { id: "void_fragment", name: "The Void Fragment", difficulty: "medium", xp: 120, coins: 80, durationMs: 5*60*1000, deathChance: 0.05 },
  { id: "blood_moon_hunt", name: "The Blood Moon Hunt", difficulty: "medium", xp: 140, coins: 90, durationMs: 5*60*1000, deathChance: 0.08 },
  { id: "demon_lord_trial", name: "The Demon Lord's Trial", difficulty: "hard", xp: 250, coins: 150, durationMs: 10*60*1000, deathChance: 0.15 },
  { id: "arcane_vault", name: "The Sealed Arcane Vault", difficulty: "hard", xp: 280, coins: 170, durationMs: 10*60*1000, deathChance: 0.20 },
  { id: "abyss_descent", name: "Descent into the Abyss", difficulty: "legendary", xp: 500, coins: 300, durationMs: 15*60*1000, deathChance: 0.30 },
  { id: "world_rift", name: "The World Rift Expedition", difficulty: "legendary", xp: 600, coins: 350, durationMs: 15*60*1000, deathChance: 0.35 },
];

const WORLD_EVENTS = [
  { name: "🐉 The Dragon's Descent", effect: "pvp_bonus" },
  { name: "🌀 The Veil Tears Open", effect: "quest_bonus" },
  { name: "⛈️ The Eternal Cursed Storm", effect: "hp_drain" },
  { name: "🌕 The Blood Moon Rises", effect: "vampire_boost" },
  { name: "✨ The Great Arcane Surge", effect: "magic_boost" },
  { name: "☣️ The Dark Plague", effect: "plague" },
  { name: "⚔️ The Grand Dark Tournament", effect: "tournament" },
  { name: "🏚️ The Tomb Beneath the Ruin", effect: "quest_bonus" },
  { name: "🖤 The Dark Miracle", effect: "heal_all" },
  { name: "🕳️ The Void Rift Yawns", effect: "void_rift" },
];

const SHOP_ITEMS = [
  { id: "health_potion", name: "Vial of Restored Life", price: 50, type: "consumable", hpRestore: 30 },
  { id: "greater_potion", name: "Elixir of the Undying", price: 120, type: "consumable", hpRestore: 99999 },
  { id: "void_shard", name: "Void Shard", price: 200, type: "permanent", statBoost: { atk: 15 } },
  { id: "shadow_cloak", name: "Cloak of the Shadowless", price: 180, type: "permanent", statBoost: { spd: 20 } },
  { id: "arcane_tome", name: "The Forbidden Tome", price: 220, type: "permanent", statBoost: { int: 20 } },
  { id: "iron_fortress", name: "Bastion of the Damned", price: 190, type: "permanent", statBoost: { def: 20 } },
  { id: "dark_elixir", name: "Ichor of the Ancient Dead", price: 300, type: "permanent", statBoost: { atk: 10, def: 10, int: 10, spd: 10 } },
  { id: "resurrection_stone", name: "The Resurrection Stone", price: 500, type: "special" },
  { id: "betrayal_dagger", name: "The Betrayer's Dagger", price: 350, type: "special" },
];

// ─── Helpers ───────────────────────────────────────────────────────────────
function createCharacter(userId, name, raceKey, classKey) {
  const race = RACES[raceKey], cls = CLASSES[classKey];
  const maxHp = race.hp + cls.hp;
  return {
    userId, name, race: raceKey, class: classKey,
    level: 1, xp: 0, xpToNext: 100,
    hp: maxHp, maxHp,
    atk: race.atk + cls.atk, def: race.def + cls.def,
    int: race.int + cls.int, spd: race.spd + cls.spd, crit: cls.crit,
    coins: 100, status: "alive",
    faction: null, inventory: [], achievements: ["first_breath"],
    currentQuest: null,
    questsCompleted: 0, battlesWon: 0, battlesLost: 0, killCount: 0, deaths: 0,
    lastActive: Date.now(), createdAt: Date.now(), lastDaily: 0, title: null,
  };
}

function giveXP(char, amount) {
  char.xp += amount;
  let leveled = false;
  while (char.xp >= char.xpToNext) {
    char.xp -= char.xpToNext;
    char.level++;
    char.xpToNext = Math.floor(100 * Math.pow(1.3, char.level - 1));
    char.maxHp += 5; char.hp = Math.min(char.hp + 5, char.maxHp);
    char.atk += 2; char.def += 1; char.int += 2; char.spd += 1;
    leveled = true;
  }
  return leveled;
}

function hpBar(hp, max, len = 10) {
  const f = Math.max(0, Math.round((hp / max) * len));
  return "█".repeat(f) + "░".repeat(len - f);
}

function xpBar(xp, next, len = 10) {
  const f = Math.max(0, Math.round((xp / next) * len));
  return "▓".repeat(f) + "░".repeat(len - f);
}

function powerScore(c) {
  return c.atk * 2 + c.def + c.int * 1.5 + c.spd + c.level * 10;
}

function dark(color = "#1a0a1e") {
  return new EmbedBuilder().setColor(color).setTimestamp()
    .setFooter({ text: "🌌 Isekai Chronicles  ·  The Chronicle of the Eternal Dark" });
}

function profileEmbed(char) {
  const race = RACES[char.race], cls = CLASSES[char.class];
  return dark(race.color)
    .setTitle(`${race.emoji} ${char.name}`)
    .addFields(
      { name: "⚔️ Class", value: `${cls.emoji} ${cls.name}`, inline: true },
      { name: "🧬 Race", value: `${race.emoji} ${race.name}`, inline: true },
      { name: "🏅 Level", value: `**${char.level}**`, inline: true },
      { name: "❤️ HP", value: `${hpBar(char.hp, char.maxHp)} **${char.hp}/${char.maxHp}**`, inline: false },
      { name: "✨ XP", value: `${xpBar(char.xp, char.xpToNext)} **${char.xp}/${char.xpToNext}**`, inline: false },
      { name: "⚔️ ATK", value: `**${char.atk}**`, inline: true },
      { name: "🛡️ DEF", value: `**${char.def}**`, inline: true },
      { name: "🔮 INT", value: `**${char.int}**`, inline: true },
      { name: "💨 SPD", value: `**${char.spd}**`, inline: true },
      { name: "💰 Coins", value: `**${char.coins}** 🔷`, inline: true },
    );
}

function leaderboardEmbed(chars) {
  const medals = ["🥇","🥈","🥉","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  return dark("#FFD700")
    .setTitle("📖 The Eternal Dark Ledger")
    .addFields({ name: "\u200b", value: chars.map((c, i) => {
      const r = RACES[c.race], cl = CLASSES[c.class];
      return `${medals[i]} **${c.name}** — ${r?.emoji} ${r?.name} ${cl?.emoji} ${cl?.name} · Level **${c.level}** · Power **${Math.round(powerScore(c))}**`;
    }).join("\n"), inline: false });
}

// ─── Combat ────────────────────────────────────────────────────────────────
function simulateCombat(a, d) {
  let aHp = a.hp, dHp = d.hp;
  const rounds = [];
  for (let i = 0; i < 8 && aHp > 0 && dHp > 0; i++) {
    let aDmg = Math.max(1, a.atk - Math.floor(d.def * 0.5) + Math.floor(Math.random() * 10));
    const aCrit = Math.random() < a.crit;
    if (aCrit) aDmg = Math.floor(aDmg * 1.8);
    dHp -= aDmg;
    let dDmg = 0, dCrit = false;
    if (dHp > 0) {
      dDmg = Math.max(1, d.atk - Math.floor(a.def * 0.5) + Math.floor(Math.random() * 10));
      dCrit = Math.random() < d.crit;
      if (dCrit) dDmg = Math.floor(dDmg * 1.8);
      aHp -= dDmg;
    }
    rounds.push({ aDmg, aCrit, dDmg, dCrit });
  }
  return { attackerWon: dHp <= 0 || aHp > dHp, rounds };
}

// ─── Commands ──────────────────────────────────────────────────────────────
async function handleCreate(ctx) {
  const uid = ctx.userId;
  if (db.users[uid]) {
    return ctx.reply({ embeds: [dark(RACES[db.users[uid].race].color)
      .setTitle("📖 Thine Soul Is Already Recorded")
      .setDescription("Use `/profile` to behold thy record.")] });
  }
  return ctx.reply({ embeds: [dark()
    .setTitle("🌌 Use `/create name: race: class:`")
    .setDescription("Provide all three options at once.")] });
}

async function cmdProfile(ctx, targetUserId) {
  const uid = targetUserId || ctx.userId;
  const char = db.users[uid];
  if (!char) return ctx.reply({ embeds: [dark().setTitle("📜 No Soul Record Found").setDescription("Use `/create` to enter this world.")] });
  return ctx.reply({ embeds: [profileEmbed(char)] });
}

async function cmdDaily(ctx) {
  const char = db.users[ctx.userId];
  if (!char) return ctx.reply({ embeds: [dark().setTitle("📜 No Soul Record Found").setDescription("Use `/create` to enter this world.")] });
  const now = Date.now();
  if (now - char.lastDaily < 24 * 60 * 60 * 1000) {
    return ctx.reply({ embeds: [dark().setTitle("⏰ Daily Already Claimed").setDescription("Come back tomorrow.")] });
  }
  char.lastDaily = now;
  const coins = 50 + Math.floor(Math.random() * 50);
  char.coins += coins;
  giveXP(char, 25);
  saveData();
  return ctx.reply({ embeds: [dark("#57F287").setTitle("💰 Daily Tithe Claimed").setDescription(`+${coins} 🔷 · +25 XP`)] });
}

async function cmdAttack(ctx, targetUserId) {
  const uid = ctx.userId;
  const char = db.users[uid];
  if (!char) return ctx.reply({ embeds: [dark().setTitle("📜 No Soul Record Found").setDescription("Use `/create` to enter this world.")] });
  if (char.status !== "alive") return ctx.reply({ embeds: [dark("#8B0000").setTitle("💀 The Dead Do Not Fight")] });
  if (!targetUserId) return ctx.reply("❌ *Thou must name a target.*");
  if (targetUserId === uid) return ctx.reply("❌ *Thou canst not raise a blade against thyself.*");
  const tchar = db.users[targetUserId];
  if (!tchar) return ctx.reply({ embeds: [dark().setTitle("📜 No Soul Record Found").setDescription("That wanderer has not yet entered this world.")] });

  const result = simulateCombat(char, tchar);
  const winnerId = result.attackerWon ? uid : targetUserId;
  const loserId = result.attackerWon ? targetUserId : uid;
  const winner = db.users[winnerId], loser = db.users[loserId];

  const xpGain = 40, coinGain = 25;
  giveXP(winner, xpGain);
  winner.coins += coinGain; winner.battlesWon++;
  loser.battlesLost++;

  saveData();
  return ctx.reply({ embeds: [dark(result.attackerWon ? "#57F287" : "#ED4245")
    .setTitle(`⚔️ ${char.name} versus ${tchar.name}`)
    .setDescription(`${result.attackerWon ? winner.name : loser.name} wins!`)
    .addFields(
      { name: "🏆 Winner", value: `**${winner.name}**`, inline: true },
      { name: "🏅 Spoils", value: `+${xpGain} XP · +${coinGain} 🔷`, inline: false },
    )] });
}

async function cmdShop(ctx, sub, itemId) {
  const char = db.users[ctx.userId];
  if (!char) return ctx.reply({ embeds: [dark().setTitle("📜 No Soul Record Found").setDescription("Use `/create` to enter this world.")] });
  if (!sub || sub === "list") {
    const embed = dark("#483D8B").setTitle("🏪 The Void Market").setDescription(`Thy purse: **${char.coins} 🔷**`);
    for (const item of SHOP_ITEMS) embed.addFields({ name: `${item.name} — ${item.price} 🔷`, value: `\`${item.id}\``, inline: true });
    return ctx.reply({ embeds: [embed] });
  }
  if (sub === "buy") {
    const item = SHOP_ITEMS.find(i => i.id === itemId);
    if (!item) return ctx.reply("❌ Item not found.");
    if (char.coins < item.price) return ctx.reply("❌ Insufficient coins.");
    char.coins -= item.price;
    if (item.type === "consumable") {
      char.hp = Math.min(char.maxHp, char.hp + item.hpRestore);
    } else if (item.type === "permanent") {
      for (const [stat, val] of Object.entries(item.statBoost)) char[stat] = (char[stat] ?? 0) + val;
    }
    saveData();
    return ctx.reply({ embeds: [dark("#57F287").setTitle(`✅ ${item.name} Purchased`)] });
  }
}

async function cmdWorld(ctx) {
  const factions = Object.values(db.factions);
  const ev = db.world.currentEvent;
  return ctx.reply({ embeds: [dark("#1a0a1e")
    .setTitle("🌍 The World of Eternal Night")
    .setDescription(ev ? `**🌀 Current Event:** ${ev.name}` : "*The realm breathes quietly.*")
    .addFields(
      { name: "⚔️ Factions", value: factions.length ? factions.map(f => `**${f.name}** — ${f.members.length} members`).join("\n") : "*No factions yet.*", inline: false },
      { name: "📜 Lore Entries", value: `${db.world.lore.length}`, inline: true },
      { name: "👥 Souls", value: `${Object.keys(db.users).length}`, inline: true },
    )] });
}

async function cmdEvent(ctx) {
  const ev = db.world.currentEvent;
  if (!ev) return ctx.reply({ embeds: [dark().setTitle("🌀 No Event Active").setDescription("The realm is quiet today.")] });
  return ctx.reply({ embeds: [dark("#4B0082").setTitle(`🌀 ${ev.name}`).setDescription(`**Effect:** ${ev.effect}`)] });
}

async function cmdQuest(ctx, action, questId) {
  const char = db.users[ctx.userId];
  if (!char) return ctx.reply({ embeds: [dark().setTitle("📜 No Soul Record Found").setDescription("Use `/create` to enter this world.")] });
  
  if (!action || action === "list") {
    const embed = dark("#2F4F4F").setTitle("📜 Available Quests").setDescription("*The dark roads await.*");
    for (const q of QUEST_POOL) embed.addFields({ name: `${q.name} (${q.difficulty})`, value: `XP: ${q.xp} · Coins: ${q.coins}`, inline: true });
    return ctx.reply({ embeds: [embed] });
  }
  
  if (action === "start") {
    if (char.currentQuest) return ctx.reply({ embeds: [dark().setTitle("⏳ Quest Already Active").setDescription("Complete your current quest first.")] });
    const quest = QUEST_POOL.find(q => q.id === questId);
    if (!quest) return ctx.reply("❌ Quest not found. Use `/quest list` to see options.");
    char.currentQuest = { questId: quest.id, startedAt: Date.now(), endAt: Date.now() + quest.durationMs };
    saveData();
    return ctx.reply({ embeds: [dark("#2F4F4F").setTitle(`📜 Quest Started: ${quest.name}`).setDescription(`Return with \`/quest return\` in ${Math.floor(quest.durationMs/60000)} minutes.`)] });
  }
  
  if (action === "return") {
    if (!char.currentQuest) return ctx.reply({ embeds: [dark().setTitle("📜 No Active Quest").Description("Start a quest first with `/quest start`")] });
    const quest = QUEST_POOL.find(q => q.id === char.currentQuest.questId);
    if (Date.now() < char.currentQuest.endAt) return ctx.reply({ embeds: [dark().setTitle("⏳ Quest Not Complete").setDescription(`Wait ${Math.floor((char.currentQuest.endAt - Date.now())/60000)} more minutes.`)] });
    const success = Math.random() > (quest?.deathChance || 0);
    if (success) {
      giveXP(char, quest.xp);
      char.coins += quest.coins;
      char.questsCompleted++;
    } else {
      char.status = "ghost";
      char.hp = 0;
      char.deaths++;
    }
    char.currentQuest = null;
    saveData();
    return ctx.reply({ embeds: [dark(success ? "#57F287" : "#8B0000")
      .setTitle(success ? "✅ Quest Complete!" : "💀 Quest Failed!")
      .setDescription(success ? `+${quest.xp} XP · +${quest.coins} 🔷` : "Thou hast fallen. Use `/resurrect` to return.")] });
  }
}

async function cmdFaction(ctx, action, name) {
  const uid = ctx.userId;
  const char = db.users[uid];
  if (!char) return ctx.reply({ embeds: [dark().setTitle("📜 No Soul Record Found").setDescription("Use `/create` to enter this world.")] });
  
  if (!action || action === "info") {
    const factions = Object.values(db.factions);
    if (!factions.length) return ctx.reply({ embeds: [dark().setTitle("⚔️ No Factions").Description("Be the first to create one with `/faction create`")] });
    const embed = dark("#8B0000").setTitle("⚔️ Factions of the Realm");
    for (const f of factions) embed.addFields({ name: f.name, value: `Leader: <@${f.leaderId}> · Members: ${f.members.length}`, inline: true });
    return ctx.reply({ embeds: [embed] });
  }
  
  if (action === "create") {
    if (!name) return ctx.reply("❌ Provide a faction name.");
    if (char.faction) return ctx.reply("❌ Thou art already in a faction.");
    if (db.factions[name.toLowerCase()]) return ctx.reply("❌ Faction already exists.");
    db.factions[name.toLowerCase()] = { id: name.toLowerCase(), name, leaderId: uid, members: [uid] };
    char.faction = name.toLowerCase();
    saveData();
    return ctx.reply({ embeds: [dark("#57F287").setTitle(`⚔️ Faction Created: ${name}`)] });
  }
  
  if (action === "join") {
    if (!name) return ctx.reply("❌ Provide a faction name.");
    if (char.faction) return ctx.reply("❌ Leave thy current faction first.");
    const faction = db.factions[name.toLowerCase()];
    if (!faction) return ctx.reply("❌ Faction not found.");
    faction.members.push(uid);
    char.faction = name.toLowerCase();
    saveData();
    return ctx.reply({ embeds: [dark("#57F287").setTitle(`⚔️ Joined ${faction.name}`)] });
  }
  
  if (action === "leave") {
    if (!char.faction) return ctx.reply("❌ Thou art not in a faction.");
    const faction = db.factions[char.faction];
    if (faction) faction.members = faction.members.filter(id => id !== uid);
    char.faction = null;
    saveData();
    return ctx.reply({ embeds: [dark("#FEE75C").setTitle("⚔️ Left Faction")] });
  }
}

async function cmdLore(ctx) {
  const entries = db.world.lore.slice(-10).reverse();
  if (!entries.length) return ctx.reply({ embeds: [dark().setTitle("📜 The Chronicle Is Blank").setDescription("No deeds recorded yet.")] });
  const embed = dark("#1a0a1e").setTitle("📜 World Chronicle");
  for (const e of entries) embed.addFields({ name: new Date(e.timestamp).toLocaleDateString(), value: e.text, inline: false });
  return ctx.reply({ embeds: [embed] });
}

async function cmdResurrect(ctx) {
  const char = db.users[ctx.userId];
  if (!char) return ctx.reply({ embeds: [dark().setTitle("📜 No Soul Record Found")] });
  if (char.status === "alive") return ctx.reply({ embeds: [dark().setTitle("💜 Thou Art Already Breathing")] });
  char.status = "alive";
  char.hp = Math.floor(char.maxHp * 0.5);
  saveData();
  return ctx.reply({ embeds: [dark("#4B0082").setTitle("💜 Resurrected").setDescription(`${char.hp}/${char.maxHp} HP`)] });
}

async function cmdDeleteCharacter(ctx, confirm) {
  const uid = ctx.userId;
  const char = db.users[uid];
  if (!char) return ctx.reply({ embeds: [dark().setTitle("📜 No Soul Record Found")] });
  if (confirm !== "CONFIRM") return ctx.reply({ embeds: [dark("#ED4245").setTitle("⚠️ Type `/deletecharacter confirm:CONFIRM` to delete.")] });
  delete db.users[uid];
  saveData();
  return ctx.reply({ embeds: [dark("#8B0000").setTitle("🗑️ Character Deleted")] });
}

async function cmdSetChannel(ctx, channelId) {
  if (!ctx.guild?.members?.cache.get(ctx.userId)?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return ctx.reply({ embeds: [dark("#ED4245").setTitle("🔒 Manage Server required.")] });
  }
  db.config.leaderboardChannelId = channelId;
  saveData();
  return ctx.reply({ embeds: [dark("#57F287").setTitle("✅ Channel Set").setDescription(`<#${channelId}> will receive updates.`)] });
}

async function cmdLeaderboard(ctx) {
  const chars = Object.values(db.users).sort((a, b) => powerScore(b) - powerScore(a)).slice(0, 10);
  if (!chars.length) return ctx.reply({ embeds: [dark().setTitle("📖 The Ledger Is Empty")] });
  return ctx.reply({ embeds: [leaderboardEmbed(chars)] });
}

async function cmdHelp(ctx) {
  return ctx.reply({ embeds: [dark()
    .setTitle("🌌 Isekai Chronicles — All Commands")
    .addFields(
      { name: "🎭 Character", value: "`/create` · `/profile` · `/daily` · `/resurrect` · `/deletecharacter`", inline: false },
      { name: "⚔️ Combat", value: "`/attack @user`", inline: false },
      { name: "📜 Quests", value: "`/quest list` · `/quest start <id>` · `/quest return`", inline: false },
      { name: "🏰 Factions", value: "`/faction info` · `/faction create <name>` · `/faction join <name>` · `/faction leave`", inline: false },
      { name: "🏪 Shop", value: "`/shop` · `/shop buy <id>`", inline: false },
      { name: "🌍 World", value: "`/world` · `/event` · `/lore` · `/leaderboard`", inline: false },
      { name: "⚙️ Admin", value: "`/setchannel`", inline: false },
      { name: "❓ Help", value: "`/help`", inline: false },
    )] });
}

// ─── Daily Event ───────────────────────────────────────────────────────────
function checkDailyEvent() {
  if (db.world.lastEventDate !== new Date().toDateString()) {
    const ev = WORLD_EVENTS[Math.floor(Math.random() * WORLD_EVENTS.length)];
    db.world.currentEvent = ev;
    db.world.lastEventDate = new Date().toDateString();
    db.world.lore.push({ text: `**World Omen:** ${ev.name}`, timestamp: Date.now() });
    saveData();
  }
}

// ─── Slash Commands ────────────────────────────────────────────────────────
const raceChoices = Object.entries(RACES).map(([v,r]) => ({ name: `${r.emoji} ${r.name}`, value: v }));
const classChoices = Object.entries(CLASSES).map(([v,c]) => ({ name: `${c.emoji} ${c.name}`, value: v }));
const questChoices = QUEST_POOL.map(q => ({ name: `${q.name} (${q.difficulty})`, value: q.id }));
const shopChoices = SHOP_ITEMS.map(i => ({ name: i.name, value: i.id }));

const SLASH_COMMANDS = [
  new SlashCommandBuilder().setName("create").setDescription("Cross the veil and enter this world")
    .addStringOption(o => o.setName("name").setDescription("Character name").setRequired(true))
    .addStringOption(o => o.setName("race").setDescription("Bloodline").setRequired(true).addChoices(...raceChoices))
    .addStringOption(o => o.setName("class").setDescription("Dark path").setRequired(true).addChoices(...classChoices)),
  new SlashCommandBuilder().setName("profile").setDescription("View a soul's chronicle")
    .addUserOption(o => o.setName("user").setDescription("The soul to view").setRequired(false)),
  new SlashCommandBuilder().setName("daily").setDescription("Claim daily tithe"),
  new SlashCommandBuilder().setName("attack").setDescription("Challenge to battle")
    .addUserOption(o => o.setName("target").setDescription("Target").setRequired(true)),
  new SlashCommandBuilder().setName("shop").setDescription("Browse or buy from Void Market")
    .addStringOption(o => o.setName("action").setDescription("list or buy").setRequired(true).addChoices({ name: "browse", value: "list" }, { name: "buy", value: "buy" }))
    .addStringOption(o => o.setName("item_id").setDescription("Item to buy").setRequired(false).addChoices(...shopChoices)),
  new SlashCommandBuilder().setName("world").setDescription("Look upon the world map"),
  new SlashCommandBuilder().setName("event").setDescription("Hear the omen of this day"),
  new SlashCommandBuilder().setName("quest").setDescription("Walk the dark questing roads")
    .addStringOption(o => o.setName("action").setDescription("list, start, or return").setRequired(true).addChoices({ name: "list", value: "list" }, { name: "start", value: "start" }, { name: "return", value: "return" }))
    .addStringOption(o => o.setName("quest_id").setDescription("Quest ID when starting").setRequired(false).addChoices(...questChoices)),
  new SlashCommandBuilder().setName("faction").setDescription("Manage faction allegiances")
    .addStringOption(o => o.setName("action").setDescription("What to do").setRequired(true).addChoices(
      { name: "info", value: "info" }, { name: "create", value: "create" }, { name: "join", value: "join" }, { name: "leave", value: "leave" }
    ))
    .addStringOption(o => o.setName("name").setDescription("Faction name").setRequired(false)),
  new SlashCommandBuilder().setName("lore").setDescription("Read the World Chronicle"),
  new SlashCommandBuilder().setName("resurrect").setDescription("Return from death"),
  new SlashCommandBuilder().setName("deletecharacter").setDescription("Permanently delete thy character")
    .addStringOption(o => o.setName("confirm").setDescription("Type CONFIRM to delete").setRequired(false)),
  new SlashCommandBuilder().setName("setchannel").setDescription("Bind leaderboard channel (Manage Server required)")
    .addChannelOption(o => o.setName("channel").setDescription("Channel for announcements").setRequired(true).addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder().setName("leaderboard").setDescription("View the most powerful souls"),
  new SlashCommandBuilder().setName("help").setDescription("Show all commands"),
].map(c => c.toJSON());

// ─── Register Slash Commands ───────────────────────────────────────────────
async function registerSlashCommands(token, guildId) {
  await new Promise(resolve => {
    if (client.user && client.user.id) return resolve();
    client.once('ready', resolve);
    if (client.isReady()) resolve();
  });
  
  await new Promise(r => setTimeout(r, 2000));
  
  if (!client.user || !client.user.id) {
    console.error('  ❌ just-bot: Client user not available');
    return;
  }
  
  const rest = new REST({ version: "10" }).setToken(token);
  
  if (guildId) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: SLASH_COMMANDS });
      console.log(`  ✅ just-bot: Registered ${SLASH_COMMANDS.length} slash commands`);
    } catch (err) {
      console.error(`  ⚠️ just-bot: Guild registration failed:`, err.message);
    }
  }
  
  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: SLASH_COMMANDS });
      console.log(`  ✅ just-bot: Registered to guild ${guild.name}`);
    } catch (err) {}
  }
}

// ─── Start Function ────────────────────────────────────────────────────────
async function start(token, options = {}) {
  const { prefix = '!', dataDir, guildId } = options;
  
  if (dataDir && !fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  DATA_FILE = path.join(dataDir || '.', 'world.json');
  db = loadData();
  if (!db.config) db.config = { leaderboardChannelId: null, lastLeaderboard: [] };

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once('ready', async () => {
    const botTag = client.user?.tag ?? 'Unknown';
    console.log(`  🌌 Isekai Chronicles awoken as ${botTag}`);
    if (client.user) client.user.setActivity('/create — Cross the Veil 🌌', { type: 0 });
    checkDailyEvent();
    setInterval(checkDailyEvent, 60 * 60 * 1000);
    await registerSlashCommands(token, guildId);
  });

  // Slash command handler
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const ctx = {
      userId: interaction.user.id,
      guild: interaction.guild,
      reply: async (opts) => {
        const payload = typeof opts === 'string' ? { content: opts, ephemeral: true } : { ...opts, ephemeral: true };
        if (interaction.deferred) return interaction.editReply(payload);
        return interaction.reply(payload);
      },
    };

    try {
      switch (interaction.commandName) {
        case 'create': await handleCreate(ctx); break;
        case 'profile': await cmdProfile(ctx, interaction.options.getUser("user")?.id); break;
        case 'daily': await cmdDaily(ctx); break;
        case 'attack': await cmdAttack(ctx, interaction.options.getUser("target")?.id); break;
        case 'shop': await cmdShop(ctx, interaction.options.getString("action"), interaction.options.getString("item_id")); break;
        case 'world': await cmdWorld(ctx); break;
        case 'event': await cmdEvent(ctx); break;
        case 'quest': await cmdQuest(ctx, interaction.options.getString("action"), interaction.options.getString("quest_id")); break;
        case 'faction': await cmdFaction(ctx, interaction.options.getString("action"), interaction.options.getString("name")); break;
        case 'lore': await cmdLore(ctx); break;
        case 'resurrect': await cmdResurrect(ctx); break;
        case 'deletecharacter': await cmdDeleteCharacter(ctx, interaction.options.getString("confirm")); break;
        case 'setchannel': await cmdSetChannel(ctx, interaction.options.getChannel("channel")?.id); break;
        case 'leaderboard': await cmdLeaderboard(ctx); break;
        case 'help': await cmdHelp(ctx); break;
      }
    } catch (err) {
      console.error(`[just-bot:${interaction.commandName}]`, err);
    }
  });

  // Prefix commands
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith(prefix)) return;
    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args[0]?.toLowerCase();
    const ctx = {
      userId: message.author.id,
      guild: message.guild,
      reply: async (opts) => message.reply(opts),
    };

    try {
      switch (command) {
        case 'create': await handleCreate(ctx); break;
        case 'profile': await cmdProfile(ctx, message.mentions.users.first()?.id); break;
        case 'daily': await cmdDaily(ctx); break;
        case 'attack': await cmdAttack(ctx, message.mentions.users.first()?.id); break;
        case 'shop': await cmdShop(ctx, args[1]?.toLowerCase(), args[2]); break;
        case 'world': await cmdWorld(ctx); break;
        case 'event': await cmdEvent(ctx); break;
        case 'quest': await cmdQuest(ctx, args[1]?.toLowerCase(), args[2]); break;
        case 'faction': await cmdFaction(ctx, args[1]?.toLowerCase(), args.slice(2).join(" ")); break;
        case 'lore': await cmdLore(ctx); break;
        case 'resurrect': await cmdResurrect(ctx); break;
        case 'deletecharacter': await cmdDeleteCharacter(ctx, args[1]); break;
        case 'setchannel': await cmdSetChannel(ctx, message.mentions.channels.first()?.id); break;
        case 'leaderboard': await cmdLeaderboard(ctx); break;
        case 'help': await cmdHelp(ctx); break;
      }
    } catch (err) {
      console.error(`[just-bot:${command}]`, err);
    }
  });

  await client.login(token);
  return client;
}

module.exports = { start };
