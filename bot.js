// Gio Bot — presence, community features, XP/leveling, economy of engagement.
// Persistence: state.json attachment in a hidden #🗄️-bot-data channel (survives Render restarts).
const path = require('node:path');
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch {}
const fs = require('node:fs');
const http = require('node:http');
const {
  Client, GatewayIntentBits, ActivityType, REST, Routes,
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits, ChannelType,
} = require('discord.js');

const GUILDS = [process.env.GUILD_ID || '1521507809206997002', '1527114619829620736'];
const DATA_GUILD = '1527114619829620736';
const TIKTOK_USER = 'lightskin.gio';
const LOG = path.join(__dirname, 'bot.log');
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
};

// --- keep-alive web server (Render free tier) ---
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => res.end('Gio Bot alive 👑')).listen(PORT);
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => { fetch(process.env.RENDER_EXTERNAL_URL).catch(() => {}); }, 5 * 60 * 1000);
}

// ---------- persistent state (hidden data channel) ----------
let state = { xp: {}, qotd: {}, growth: { history: {} } };
let dirty = false;
let dataChannel = null;

async function loadState(client) {
  try {
    const guild = await client.guilds.fetch(DATA_GUILD);
    const chs = await guild.channels.fetch();
    dataChannel = chs.find((c) => c && c.name === '🗄️-bot-data');
    if (!dataChannel) {
      dataChannel = await guild.channels.create({
        name: '🗄️-bot-data',
        type: ChannelType.GuildText,
        topic: 'Gio Bot internal storage — do not delete.',
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
        reason: 'bot persistence',
      });
      log('created data channel');
      return;
    }
    const msgs = await dataChannel.messages.fetch({ limit: 10 });
    const withFile = msgs.find((m) => m.attachments.size > 0);
    if (withFile) {
      const url = withFile.attachments.first().url;
      state = { ...state, ...(await (await fetch(url)).json()) };
      log('state loaded from data channel');
    }
  } catch (e) { log('loadState error: ' + e.message); }
}

async function saveState() {
  if (!dirty || !dataChannel) return;
  try {
    const buf = Buffer.from(JSON.stringify(state));
    const newMsg = await dataChannel.send({ files: [{ attachment: buf, name: 'state.json' }] });
    const msgs = await dataChannel.messages.fetch({ limit: 20 });
    for (const m of msgs.values()) if (m.id !== newMsg.id && m.author.bot) await m.delete().catch(() => {});
    dirty = false;
  } catch (e) { log('saveState error: ' + e.message); }
}

// ---------- XP / leveling ----------
const xpToNext = (lvl) => 5 * lvl * lvl + 50 * lvl + 100;
const LEVEL_REWARDS = { 10: 'OG Fan' }; // level -> role name fragment

async function grantXp(msg) {
  const g = msg.guildId, u = msg.author.id;
  state.xp[g] = state.xp[g] || {};
  const rec = (state.xp[g][u] = state.xp[g][u] || { xp: 0, level: 0, last: 0, total: 0 });
  const now = Date.now();
  if (now - rec.last < 60 * 1000) return;
  rec.last = now;
  const gain = 15 + Math.floor(Math.random() * 11);
  rec.xp += gain; rec.total += gain; dirty = true;
  while (rec.xp >= xpToNext(rec.level)) {
    rec.xp -= xpToNext(rec.level);
    rec.level++;
    await msg.channel.send({
      content: `🎉 <@${u}> just hit **Level ${rec.level}**! 👑`,
      allowedMentions: { users: [u] },
    }).catch(() => {});
    const rewardName = LEVEL_REWARDS[rec.level];
    if (rewardName) {
      const role = msg.guild.roles.cache.find((r) => r.name.includes(rewardName));
      if (role) {
        await msg.member.roles.add(role).catch(() => {});
        await msg.channel.send({
          content: `⭐ <@${u}> earned the **${role.name}** role for reaching Level ${rec.level}!`,
          allowedMentions: { users: [u] },
        }).catch(() => {});
      }
    }
  }
}

// ---------- QOTD ----------
const QUESTIONS = [
  'What video should Gio make next? 🎥', 'Most underrated TikToker right now?',
  'W or L: pineapple on pizza? 🍕', 'What song is stuck in your head today? 🎵',
  "What's your controversial food take? 🍔", 'Best game to watch someone stream? 🎮',
  'If Gio hit 1M followers, what should the celebration video be? 🏆',
  "What's the hardest trend of this year so far?", 'Who would win: 100 kids vs 1 gorilla? 🦍',
  "What's your GOAT movie? 🎬", 'Describe your week in one emoji.',
  'Hot take: what game is overrated? 💀', "What's the best fast food chain? Wrong answers only.",
  'If you could collab with Gio on one video, what would it be? 🤝',
  "What's a skill you wish you had?", 'Console or PC? Defend yourself. ⚔️',
  "What's the funniest thing you've seen on TikTok this week?",
  'W or L: school uniforms?', "What's your 3am snack of choice? 🌙",
  'Who has the best fits in this server? 👔', 'One food you could eat forever?',
  "What's your most-used emoji? Be honest.", 'Messi or Ronaldo? Final answer. ⚽',
  'What superpower would ruin your life? 💥', 'Best season: summer, fall, winter, spring?',
  "What's a movie everyone loves but you don't get?", 'Rate your aim 1-10. Be honest. 🎯',
  'What should the next server emote be? 😤', 'W or L: cereal before milk?',
  'If this server had a theme song, what would it be? 🎶',
];

async function qotdTick(client) {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
    const hour = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }));
    if (state.qotd.lastPosted === today) return;
    if (state.qotd.lastPosted && hour < 12) return;
    const idx = (state.qotd.index || 0) % QUESTIONS.length;
    for (const gid of GUILDS) {
      const guild = await client.guilds.fetch(gid).catch(() => null);
      if (!guild) continue;
      const chs = await guild.channels.fetch();
      const chat = chs.find((c) => c && c.type === ChannelType.GuildText && /chat$/.test(c.name.replace(/-\d+$/, '')) && !c.name.includes('staff'))
        || chs.find((c) => c && c.type === ChannelType.GuildText && c.name.includes('chat') && !c.name.includes('staff'));
      if (chat) await chat.send(`💭 **Question of the Day:**\n# ${QUESTIONS[idx]}`).catch(() => {});
    }
    state.qotd = { lastPosted: today, index: idx + 1 };
    dirty = true;
    log(`qotd posted (#${idx})`);
  } catch (e) { log('qotd error: ' + e.message); }
}

// ---------- daily growth stats ----------
async function growthTick(client) {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
    const hour = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }));
    const g0 = state.growth;
    if (g0.lastPosted === today) return;
    if (g0.lastPosted && hour < 12) return;
    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    for (const gid of GUILDS) {
      const g = await rest.get(`/guilds/${gid}?with_counts=true`);
      const count = g.approximate_member_count;
      const dates = Object.keys(g0.history).sort();
      const prev = dates.length ? g0.history[dates[dates.length - 1]]?.[gid] : undefined;
      const delta = prev === undefined ? '' : ` (${count - prev >= 0 ? '+' : ''}${count - prev} since last)`;
      g0.history[today] = { ...(g0.history[today] || {}), [gid]: count };
      const chs = await rest.get(`/guilds/${gid}/channels`);
      const staff = chs.find((c) => c.name.includes('staff-chat'));
      if (staff) {
        await rest.post(`/channels/${staff.id}/messages`, {
          body: {
            content: `📈 **Daily stats — ${g.name}**\nMembers: **${count}**${delta} • Online: **${g.approximate_presence_count}**`,
            allowed_mentions: { parse: [] },
          },
        });
      }
    }
    g0.lastPosted = today; dirty = true;
    log('growth stats posted');
  } catch (e) { log('growth error: ' + e.message); }
}

// ---------- tiktok stats ----------
async function tiktokStats() {
  const info = await (await fetch(
    `https://www.tikwm.com/api/user/info?unique_id=${TIKTOK_USER}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  )).json();
  const u = info?.data?.user, s = info?.data?.stats;
  if (!s) throw new Error('tiktok api unavailable');
  const posts = await (await fetch(
    `https://www.tikwm.com/api/user/posts?unique_id=${TIKTOK_USER}&count=1`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  )).json().catch(() => null);
  const latest = posts?.data?.videos?.[0];
  return {
    followers: s.followerCount, hearts: s.heartCount, videos: s.videoCount,
    bio: u?.signature || '',
    latest: latest ? `https://www.tiktok.com/@${TIKTOK_USER}/video/${latest.video_id}` : null,
    latestTitle: latest?.title || '',
  };
}

// ---------- client ----------
const FULL_INTENTS = [
  GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent,
];
const BASIC_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
let privileged = true;

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);

async function start(intents) {
  const client = new Client({ intents });

  client.once('clientReady', async () => {
    log(`online as ${client.user.tag} (privileged intents: ${privileged})`);
    const setP = () => client.user.setPresence({
      status: 'online',
      activities: [{ name: 'lightskin.gio 👑', type: ActivityType.Watching }],
    });
    setP(); setInterval(setP, 60 * 60 * 1000);
    await loadState(client);
    await registerCommands(client);
    const tick = () => { growthTick(client); qotdTick(client); saveState(); };
    tick(); setInterval(tick, 5 * 60 * 1000);
  });

  client.on('messageCreate', async (msg) => {
    try {
      if (msg.author?.bot || !msg.inGuild()) return;
      if (!msg.channel.isThread()) {
        const name = msg.channel.name || '';
        if (name.includes('ideas')) {
          await msg.react('🔥'); await msg.react('❌');
          if (!msg.hasThread) {
            const title = (msg.content || '').replace(/\s+/g, ' ').trim().slice(0, 80) || `${msg.author.username}'s idea`;
            await msg.startThread({ name: `💬 ${title}` });
          }
        } else if (name.includes('clips') || name.includes('fan-edits')) {
          await msg.react('🔥');
        }
      }
      await grantXp(msg);
    } catch (e) { log('messageCreate error: ' + e.message); }
  });

  client.on('guildMemberAdd', async (member) => {
    try {
      const ch = member.guild.channels.cache.find((c) => c.name === '👋-welcome');
      if (ch) await ch.send({
        content: `👑 Yo <@${member.id}>, welcome to **${member.guild.name}**! Grab your ping roles in **Channels & Roles** and say what's up in chat. 🤝`,
        allowedMentions: { users: [member.id] },
      });
    } catch (e) { log('welcome error: ' + e.message); }
  });

  const EIGHTBALL = [
    'Yes, no cap. ✅', 'W question, and the answer is yes. 🔥', 'Certified yes. 👑',
    'Hmm... probably.', 'Ask again after Gio posts. 🎵', 'Not looking good chief. 📉',
    'Nah. 💀', 'Absolutely not, and delete this question. ❌', "It's a maybe from me.",
    'The afro says yes. 🦱', 'L question, L outcome. 🇱', 'Only if you follow @lightskin.gio first. 😤',
  ];

  client.on('interactionCreate', async (i) => {
    try {
      if (!i.isChatInputCommand()) return;
      const cmd = i.commandName;

      if (cmd === 'suggest') {
        const idea = i.options.getString('idea', true);
        const platform = i.options.getString('platform') || 'general';
        const target = platform === 'general' ? '💡-ideas' : `${platform}-ideas`;
        const ch = i.guild.channels.cache.find((c) => c.name.includes(target));
        if (!ch) return i.reply({ content: "Couldn't find the ideas channel. 😬", flags: MessageFlags.Ephemeral });
        const posted = await ch.send({ content: `💡 **Idea from ${i.user}:**\n> ${idea}`, allowedMentions: { parse: [] } });
        await posted.react('🔥'); await posted.react('❌');
        await posted.startThread({ name: `💬 ${idea.slice(0, 80)}` }).catch(() => {});
        await i.reply({ content: `Posted in ${ch}! 🔥`, flags: MessageFlags.Ephemeral });

      } else if (cmd === 'eightball') {
        const q = i.options.getString('question', true);
        await i.reply({ content: `🎱 **"${q}"**\n${EIGHTBALL[Math.floor(Math.random() * EIGHTBALL.length)]}`, allowedMentions: { parse: [] } });

      } else if (cmd === 'wl') {
        const thing = i.options.getString('thing', true);
        const msg = await i.reply({ content: `⚖️ **W or L:** ${thing}`, allowedMentions: { parse: [] }, withResponse: true });
        const m = msg.resource?.message;
        if (m) { await m.react('🇼'); await m.react('🇱'); }

      } else if (cmd === 'rank') {
        const target = i.options.getUser('user') || i.user;
        const rec = state.xp[i.guildId]?.[target.id];
        if (!rec) return i.reply({ content: `${target} hasn't earned any XP yet. Start chatting! 💬`, allowedMentions: { parse: [] } });
        const all = Object.entries(state.xp[i.guildId]).sort((a, b) => b[1].total - a[1].total);
        const pos = all.findIndex(([id]) => id === target.id) + 1;
        await i.reply({
          content: `📊 **${target.username}** — Level **${rec.level}** • ${rec.xp}/${xpToNext(rec.level)} XP to next • Rank **#${pos}** of ${all.length}`,
          allowedMentions: { parse: [] },
        });

      } else if (cmd === 'levels') {
        const all = Object.entries(state.xp[i.guildId] || {}).sort((a, b) => b[1].total - a[1].total).slice(0, 10);
        if (!all.length) return i.reply('Nobody has XP yet. Get chatting! 💬');
        const medals = ['🥇', '🥈', '🥉'];
        const lines = all.map(([id, r], n) => `${medals[n] || `**${n + 1}.**`} <@${id}> — Level **${r.level}** (${r.total} XP)`);
        await i.reply({ content: `👑 **Server Leaderboard**\n${lines.join('\n')}`, allowedMentions: { parse: [] } });

      } else if (cmd === 'gio') {
        await i.deferReply();
        try {
          const s = await tiktokStats();
          await i.editReply({
            content: `👑 **@${TIKTOK_USER} on TikTok**\n` +
              `Followers: **${fmt(s.followers)}** • Likes: **${fmt(s.hearts)}** • Videos: **${s.videos}**\n` +
              (s.latest ? `\n🆕 Latest: ${s.latestTitle ? `*${s.latestTitle.slice(0, 100)}*\n` : ''}${s.latest}` : ''),
            allowedMentions: { parse: [] },
          });
        } catch {
          await i.editReply('TikTok stats are unavailable right now — try again in a bit. 😬');
        }

      } else if (cmd === 'purge') {
        const amount = i.options.getInteger('amount', true);
        const deleted = await i.channel.bulkDelete(amount, true);
        await i.reply({ content: `🧹 Deleted **${deleted.size}** messages.`, flags: MessageFlags.Ephemeral });
        log(`purge: ${deleted.size} messages by ${i.user.tag} in #${i.channel.name}`);
      }
    } catch (e) {
      log('interaction error: ' + e.message);
      if (i.isRepliable()) i.reply({ content: 'Something broke. 💀 Try again.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  client.on('shardDisconnect', () => log('gateway dropped, reconnecting...'));
  client.on('shardResume', () => log('gateway resumed'));
  process.on('SIGTERM', async () => { await saveState(); process.exit(0); });

  try {
    await client.login(process.env.BOT_TOKEN);
  } catch (e) {
    if (privileged && /disallowed intents/i.test(e.message)) {
      log('privileged intents unavailable — falling back');
      privileged = false;
      return start(BASIC_INTENTS);
    }
    throw e;
  }
}

async function registerCommands(client) {
  const commands = [
    new SlashCommandBuilder().setName('suggest').setDescription('Drop an idea for Gio')
      .addStringOption((o) => o.setName('idea').setDescription('Your idea').setRequired(true).setMaxLength(500))
      .addStringOption((o) => o.setName('platform').setDescription('Which platform?')
        .addChoices(
          { name: 'General', value: 'general' }, { name: 'TikTok', value: 'tiktok' },
          { name: 'YouTube', value: 'youtube' }, { name: 'Twitch', value: 'twitch' },
        )),
    new SlashCommandBuilder().setName('eightball').setDescription('Ask the magic 8-ball')
      .addStringOption((o) => o.setName('question').setDescription('Your question').setRequired(true).setMaxLength(200)),
    new SlashCommandBuilder().setName('wl').setDescription('Put something up for a W or L vote')
      .addStringOption((o) => o.setName('thing').setDescription('What are we rating?').setRequired(true).setMaxLength(200)),
    new SlashCommandBuilder().setName('rank').setDescription('Check your level and XP')
      .addUserOption((o) => o.setName('user').setDescription('Check someone else')),
    new SlashCommandBuilder().setName('levels').setDescription('Server XP leaderboard'),
    new SlashCommandBuilder().setName('gio').setDescription("Gio's live TikTok stats"),
    new SlashCommandBuilder().setName('purge').setDescription('Delete recent messages (mods only)')
      .addIntegerOption((o) => o.setName('amount').setDescription('How many (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  ].map((c) => c.toJSON());
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  for (const gid of GUILDS) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, gid), { body: commands });
      log(`slash commands registered in ${gid}`);
    } catch (e) { log(`command registration failed in ${gid}: ${e.message}`); }
  }
}

start(FULL_INTENTS);
