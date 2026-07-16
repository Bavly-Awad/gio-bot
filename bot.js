// Gio Bot — presence + community features + growth tracker.
// Features degrade gracefully if privileged intents aren't enabled in the dev portal.
const path = require('node:path');
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch {}
const fs = require('node:fs');
const http = require('node:http');

// --- keep-alive web server (Render free tier requires an open port; self-ping prevents sleep) ---
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => res.end('Gio Bot alive 👑')).listen(PORT);
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => { fetch(SELF_URL).catch(() => {}); }, 5 * 60 * 1000);
}
const {
  Client, GatewayIntentBits, ActivityType, REST, Routes,
  SlashCommandBuilder, MessageFlags,
} = require('discord.js');

const GUILDS = [process.env.GUILD_ID, '1527114619829620736'];
const LOG = path.join(__dirname, 'bot.log');
const GROWTH = path.join(__dirname, 'growth.json');
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
};

// ---------- client with intent fallback ----------
const FULL_INTENTS = [
  GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent,
];
const BASIC_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];

let privileged = true;

async function start(intents) {
  const client = new Client({ intents });

  client.once('clientReady', async () => {
    log(`online as ${client.user.tag} (privileged intents: ${privileged})`);
    setPresence(client);
    setInterval(() => setPresence(client), 60 * 60 * 1000);
    await registerCommands(client);
    growthTick(client);
    setInterval(() => growthTick(client), 15 * 60 * 1000);
  });

  // ----- auto-react + auto-thread in ideas/clips channels -----
  client.on('messageCreate', async (msg) => {
    try {
      if (msg.author?.bot || !msg.inGuild() || msg.channel.isThread()) return;
      const name = msg.channel.name || '';
      if (name.includes('ideas')) {
        await msg.react('🔥');
        await msg.react('❌');
        if (!msg.hasThread) {
          const title = (msg.content || '').replace(/\s+/g, ' ').trim().slice(0, 80)
            || `${msg.author.username}'s idea`;
          await msg.startThread({ name: `💬 ${title}` });
        }
      } else if (name.includes('clips') || name.includes('fan-edits')) {
        await msg.react('🔥');
      }
    } catch (e) { log('messageCreate error: ' + e.message); }
  });

  // ----- welcome message (needs GuildMembers intent) -----
  client.on('guildMemberAdd', async (member) => {
    try {
      const ch = member.guild.channels.cache.find((c) => c.name === '👋-welcome');
      if (!ch) return;
      await ch.send({
        content: `👑 Yo <@${member.id}>, welcome to **${member.guild.name}**! Grab your ping roles in **Channels & Roles** and say what's up in chat. 🤝`,
        allowedMentions: { users: [member.id] },
      });
    } catch (e) { log('welcome error: ' + e.message); }
  });

  // ----- slash commands -----
  const EIGHTBALL = [
    'Yes, no cap. ✅', 'W question, and the answer is yes. 🔥', 'Certified yes. 👑',
    'Hmm... probably.', 'Ask again after Gio posts. 🎵', 'Not looking good chief. 📉',
    'Nah. 💀', 'Absolutely not, and delete this question. ❌', "It's a maybe from me.",
    'The afro says yes. 🦱', 'L question, L outcome. 🇱', 'Only if you follow @lightskin.gio first. 😤',
  ];
  client.on('interactionCreate', async (i) => {
    try {
      if (!i.isChatInputCommand()) return;
      if (i.commandName === 'suggest') {
        const idea = i.options.getString('idea', true);
        const platform = i.options.getString('platform') || 'general';
        const target = platform === 'general' ? '💡-ideas' : `${platform}-ideas`;
        const ch = i.guild.channels.cache.find((c) => c.name.includes(target));
        if (!ch) return i.reply({ content: "Couldn't find the ideas channel. 😬", flags: MessageFlags.Ephemeral });
        const posted = await ch.send({
          content: `💡 **Idea from ${i.user}:**\n> ${idea}`,
          allowedMentions: { parse: [] },
        });
        await posted.react('🔥'); await posted.react('❌');
        await posted.startThread({ name: `💬 ${idea.slice(0, 80)}` }).catch(() => {});
        await i.reply({ content: `Posted in ${ch}! 🔥`, flags: MessageFlags.Ephemeral });
      } else if (i.commandName === 'eightball') {
        const q = i.options.getString('question', true);
        const a = EIGHTBALL[Math.floor(Math.random() * EIGHTBALL.length)];
        await i.reply({ content: `🎱 **"${q}"**\n${a}`, allowedMentions: { parse: [] } });
      } else if (i.commandName === 'wl') {
        const thing = i.options.getString('thing', true);
        const msg = await i.reply({
          content: `⚖️ **W or L:** ${thing}`,
          allowedMentions: { parse: [] }, withResponse: true,
        });
        const m = msg.resource?.message;
        if (m) { await m.react('🇼'); await m.react('🇱'); }
      }
    } catch (e) { log('interaction error: ' + e.message); }
  });

  client.on('shardDisconnect', () => log('gateway dropped, reconnecting...'));
  client.on('shardResume', () => log('gateway resumed'));

  try {
    await client.login(process.env.BOT_TOKEN);
  } catch (e) {
    if (privileged && /disallowed intents/i.test(e.message)) {
      log('privileged intents not enabled in dev portal — falling back (no welcome messages, generic thread names)');
      privileged = false;
      return start(BASIC_INTENTS);
    }
    throw e;
  }
}

function setPresence(client) {
  if (!client.user) return;
  client.user.setPresence({
    status: 'online',
    activities: [{ name: 'lightskin.gio 👑', type: ActivityType.Watching }],
  });
}

async function registerCommands(client) {
  const commands = [
    new SlashCommandBuilder().setName('suggest').setDescription('Drop an idea for Gio')
      .addStringOption((o) => o.setName('idea').setDescription('Your idea').setRequired(true).setMaxLength(500))
      .addStringOption((o) => o.setName('platform').setDescription('Which platform is it for?')
        .addChoices(
          { name: 'General', value: 'general' }, { name: 'TikTok', value: 'tiktok' },
          { name: 'YouTube', value: 'youtube' }, { name: 'Twitch', value: 'twitch' },
        )),
    new SlashCommandBuilder().setName('eightball').setDescription('Ask the magic 8-ball')
      .addStringOption((o) => o.setName('question').setDescription('Your question').setRequired(true).setMaxLength(200)),
    new SlashCommandBuilder().setName('wl').setDescription('Put something up for a W or L vote')
      .addStringOption((o) => o.setName('thing').setDescription('What are we rating?').setRequired(true).setMaxLength(200)),
  ].map((c) => c.toJSON());
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  for (const gid of GUILDS) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, gid), { body: commands });
      log(`slash commands registered in ${gid}`);
    } catch (e) { log(`command registration failed in ${gid}: ${e.message}`); }
  }
}

// ---------- daily growth tracker ----------
async function growthTick(client) {
  try {
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local
    let db = {};
    try { db = JSON.parse(fs.readFileSync(GROWTH, 'utf8')); } catch {}
    if (db.lastPosted === today) return;
    if (db.lastPosted && new Date().getHours() < 12) return; // post after noon (first ever run posts immediately)

    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    const lines = [];
    db.history = db.history || {};
    for (const gid of GUILDS) {
      const g = await rest.get(`/guilds/${gid}?with_counts=true`);
      const count = g.approximate_member_count;
      const online = g.approximate_presence_count;
      const dates = Object.keys(db.history).sort();
      const prev = dates.length ? db.history[dates[dates.length - 1]]?.[gid] : undefined;
      const delta = prev === undefined ? '' : ` (${count - prev >= 0 ? '+' : ''}${count - prev} since last)`;
      lines.push({ gid, text: `📈 **Daily stats — ${g.name}**\nMembers: **${count}**${delta} • Online: **${online}**` });
      db.history[today] = { ...(db.history[today] || {}), [gid]: count };
    }
    for (const { gid, text } of lines) {
      const chs = await rest.get(`/guilds/${gid}/channels`);
      const staff = chs.find((c) => c.name.includes('staff-chat'));
      if (staff) {
        await rest.post(`/channels/${staff.id}/messages`, {
          body: { content: text, allowed_mentions: { parse: [] } },
        });
      }
    }
    db.lastPosted = today;
    fs.writeFileSync(GROWTH, JSON.stringify(db, null, 2));
    log(`growth stats posted for ${today}`);
  } catch (e) { log('growth tick error: ' + e.message); }
}

start(FULL_INTENTS);
