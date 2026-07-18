// Gio Bot — presence, community features, XP/leveling, economy of engagement.
// Persistence: state.json attachment in a hidden #🗄️-bot-data channel (survives Render restarts).
const path = require('node:path');
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch {}
const fs = require('node:fs');
const http = require('node:http');
const {
  Client, GatewayIntentBits, ActivityType, REST, Routes,
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits, ChannelType,
  Events, AuditLogEvent, Partials,
} = require('discord.js');

const GUILDS = ['1527114619829620736']; // main server only
const DATA_GUILD = '1527114619829620736';
const AUTO_ROLE = 'lightskin'; // granted to every new member
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
let lastSavedMsgId = null;

// Instance identity: Render's zero-downtime deploys briefly run old+new processes.
// The lease inside the state file lets the old instance detect a newer owner and
// retire itself instead of clobbering the new instance's writes.
const INSTANCE = Math.random().toString(36).slice(2, 10);
const BOOT_AT = Date.now();

// Union/max merge so concurrent instances can never erase each other's progress.
function mergeState(f) {
  if (!f || typeof f !== 'object') return;
  for (const g of Object.keys(f.xp || {})) {
    state.xp[g] = state.xp[g] || {};
    for (const [u, rec] of Object.entries(f.xp[g])) {
      const mine = state.xp[g][u];
      if (!mine || (rec.total || 0) > (mine.total || 0)) state.xp[g][u] = rec;
    }
  }
  state.welcomed = state.welcomed || {};
  for (const g of Object.keys(f.welcomed || {})) state.welcomed[g] = { ...f.welcomed[g], ...(state.welcomed[g] || {}) };
  state.starred = { ...(f.starred || {}), ...(state.starred || {}) };
  state.invites = state.invites || {};
  for (const g of Object.keys(f.invites || {})) {
    state.invites[g] = state.invites[g] || {};
    for (const [u, n] of Object.entries(f.invites[g])) state.invites[g][u] = Math.max(state.invites[g][u] || 0, n);
  }
  for (const k of ['socials', 'qotd', 'growth', 'inviteContest', 'nuke', 'dashMsgId', 'adminRestyled', 'gioOnTop', 'secret', 'bet', 'memeContest'])
    if (state[k] === undefined && f[k] !== undefined) state[k] = f[k];
}

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
      lastSavedMsgId = withFile.id;
      log('state loaded from data channel');
    }
  } catch (e) { log('loadState error: ' + e.message); }
}

async function saveState() {
  if (!dirty || !dataChannel) return;
  try {
    // fence + merge: if another instance wrote state since our last save, absorb its
    // progress — and if it's a NEWER instance, this process is the stale one: retire.
    const existing = await dataChannel.messages.fetch({ limit: 5 });
    const latest = existing.find((m) => m.attachments.size > 0);
    if (latest && latest.id !== lastSavedMsgId) {
      try {
        const foreign = await (await fetch(latest.attachments.first().url)).json();
        if (foreign.lease && foreign.lease.id !== INSTANCE && foreign.lease.at > BOOT_AT) {
          log('newer instance owns the state — retiring this process');
          process.exit(0);
        }
        mergeState(foreign);
      } catch {}
    }
    state.lease = { id: INSTANCE, at: BOOT_AT };
    const buf = Buffer.from(JSON.stringify(state));
    const newMsg = await dataChannel.send({ files: [{ attachment: buf, name: 'state.json' }] });
    lastSavedMsgId = newMsg.id;
    const msgs = await dataChannel.messages.fetch({ limit: 20 });
    for (const m of msgs.values()) if (m.id !== newMsg.id && m.author.bot) await m.delete().catch(() => {});
    dirty = false;
  } catch (e) { log('saveState error: ' + e.message); }
}

// ---------- crash safety + gateway watchdog ----------
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e?.message || e)));
process.on('uncaughtException', (e) => {
  log('uncaughtException: ' + (e?.stack || e?.message || e));
  Promise.resolve(saveState()).finally(() => process.exit(1)); // Render restarts us clean
});
process.on('SIGINT', () => { Promise.resolve(saveState()).finally(() => process.exit(0)); });

function armWatchdog(client) {
  let lastHealthy = Date.now();
  setInterval(() => {
    if (client.ws.status === 0) { lastHealthy = Date.now(); return; } // 0 = Ready
    if (Date.now() - lastHealthy > 5 * 60 * 1000) {
      log('gateway unhealthy for 5+ minutes — forcing restart');
      Promise.resolve(saveState()).finally(() => process.exit(1));
    }
  }, 30 * 1000);
}

// ---------- XP / leveling ----------
const xpToNext = (lvl) => 5 * lvl * lvl + 50 * lvl + 100;
const LEVEL_REWARDS = { 5: 'Regular', 10: 'OG Fan', 25: 'Legend', 50: 'Day One' }; // level -> role name fragment

async function grantXp(msg) {
  const g = msg.guildId, u = msg.author.id;
  state.xp[g] = state.xp[g] || {};
  const rec = (state.xp[g][u] = state.xp[g][u] || { xp: 0, level: 0, last: 0, total: 0 });
  const now = Date.now();
  if (now - rec.last < 60 * 1000) return;
  rec.last = now;
  const gain = 15 + Math.floor(Math.random() * 11);
  rec.xp += gain; rec.total += gain;
  rec.coins = (rec.coins == null ? 100 : rec.coins) + 3 + Math.floor(Math.random() * 5);
  dirty = true;
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

// ---------- social alerts ----------
// Lives in the bot, not GitHub Actions: Actions throttles */5 crons to roughly hourly
// on free repos, which made "he posted!" alerts up to an hour late. The bot is already
// online 24/7, so a plain interval here is both more reliable and more accurate.
const SOCIAL = {
  tiktok: 'lightskin.gio',
  twitch: 'thelightskingio',
  youtubeChannelId: 'UCzbtrAs2ckrEqhftiiyhVsg',
  ch: { tiktok: '1527114620974792752', youtube: '1527114620974792753', live: '1527114621247291504' },
  role: { video: '1527114619829620741', live: '1527114619829620739' },
};
const SOCIAL_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36' };

async function grab(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: SOCIAL_UA, signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.text();
    } catch {}
    if (i < tries - 1) await new Promise((res) => setTimeout(res, 2000));
  }
  return null;
}
const grabJson = async (url, tries = 2) => { const t = await grab(url, tries); try { return t && JSON.parse(t); } catch { return null; } };

// Post to a channel. Returns true only if Discord accepted it — callers must not
// advance state on false, or the alert is lost forever.
async function announce(client, channelId, content, roleId) {
  try {
    const ch = await client.channels.fetch(channelId);
    await ch.send({ content, allowedMentions: { roles: [roleId], users: [], parse: [] } });
    return true;
  } catch (e) { log(`announce failed (${channelId}): ${e.message}`); return false; }
}

async function tiktokFeed() {
  const feed = await grabJson(`https://rss-bridge.org/bridge01/?action=display&bridge=TikTokBridge&context=By+user&username=${SOCIAL.tiktok}&format=Json`);
  const items = feed?.items;
  if (Array.isArray(items) && items.length) {
    const list = items.map((it) => ({ id: it.url?.match(/\/video\/(\d+)/)?.[1], url: it.url, title: (it.title || '').trim() })).filter((v) => v.id);
    if (list.length) return list;
  }
  const posts = await grabJson(`https://www.tikwm.com/api/user/posts?unique_id=${SOCIAL.tiktok}&count=10`, 1);
  const vids = posts?.data?.videos;
  if (Array.isArray(vids) && vids.length) {
    return vids.map((v) => ({ id: v.video_id, url: `https://www.tiktok.com/@${SOCIAL.tiktok}/video/${v.video_id}`, title: (v.title || '').trim() }));
  }
  return null;
}

async function checkTikTok(client) {
  const s = state.socials;
  const info = await grabJson(`https://www.tikwm.com/api/user/info?unique_id=${SOCIAL.tiktok}`);
  const count = info?.data?.stats?.videoCount;
  const haveCount = typeof count === 'number';
  noteSource(client, 'tiktok', haveCount);
  if (haveCount && s.tiktokCount == null) { s.tiktokCount = count; dirty = true; }
  if (haveCount && count <= s.tiktokCount) {
    if (count < s.tiktokCount) { s.tiktokCount = count; dirty = true; }
    return;
  }

  const list = await tiktokFeed();
  const ping = `<@&${SOCIAL.role.video}>`;

  // Announce-first policy: the moment videoCount rises, ping with the profile link
  // (the new video is the top of his page anyway). When a feed finally serves the
  // exact URL, the post is edited in place. Fans get speed AND the exact link.
  const instantAnnounce = async () => {
    const n = haveCount ? count - s.tiktokCount : 1;
    try {
      const ch = await client.channels.fetch(SOCIAL.ch.tiktok);
      const msg = await ch.send({
        content: `${ping} 🎵 **Gio just dropped ${n > 1 ? `${n} new TikToks` : 'a new TikTok'}!**\nhttps://www.tiktok.com/@${SOCIAL.tiktok}`,
        allowedMentions: { roles: [SOCIAL.role.video], users: [], parse: [] },
      });
      if (haveCount) s.tiktokCount = count;
      s.fallbackMsgIds = [...(s.fallbackMsgIds || []), msg.id];
      dirty = true;
      log(`tiktok: instant announce (count ${count}), exact-link upgrade pending`);
    } catch (e) { log('tiktok: announce failed — will retry: ' + e.message); }
  };

  // migration from the wait-based design
  if (s.fallbackMsgIds === undefined) {
    s.fallbackMsgIds = s.fallbackMsgId ? [s.fallbackMsgId] : [];
    delete s.fallbackMsgId;
    delete s.tiktokWaitSince;
    dirty = true;
  }

  if (!list) {
    if (haveCount && count > s.tiktokCount) await instantAnnounce();
    return;
  }

  const idx = s.tiktokLast ? list.findIndex((v) => v.id === s.tiktokLast) : -1;
  if (!s.tiktokLast) { s.tiktokLast = list[0].id; if (haveCount) s.tiktokCount = count; dirty = true; return; }

  if (idx === 0) {
    // Feed is lagging behind the count — announce NOW, upgrade later.
    if (haveCount && count > s.tiktokCount) await instantAnnounce();
    return;
  }

  const fresh = (idx === -1 ? [list[0]] : list.slice(0, idx)).reverse();
  for (const v of fresh) {
    const content = `${ping} 🎵 **Gio just dropped a new TikTok!**\n${v.title ? `> ${v.title}\n` : ''}${v.url}`;
    // If a profile-link fallback went out for this upload, upgrade that post in
    // place instead of announcing the same video twice.
    if (s.fallbackMsgIds?.length) {
      const msgId = s.fallbackMsgIds.shift();
      dirty = true;
      try {
        const ch = await client.channels.fetch(SOCIAL.ch.tiktok);
        const old = await ch.messages.fetch(msgId);
        await old.edit({ content, allowedMentions: { roles: [], users: [], parse: [] } });
        log(`tiktok: upgraded announce post to exact link ${v.id}`);
        s.tiktokLast = v.id;
        continue;
      } catch { /* message gone — fall through and post normally */ }
    }
    const ok = await announce(client, SOCIAL.ch.tiktok, content, SOCIAL.role.video);
    if (!ok) return; // retry next tick, state untouched
    log(`tiktok: posted ${v.id}`);
    s.tiktokLast = v.id;
    dirty = true;
  }
  s.tiktokWaitSince = null;
  if (haveCount) s.tiktokCount = count;
  dirty = true;
  // open view betting on the newest exact-linked video
  if (fresh.length) {
    const newest = fresh[fresh.length - 1];
    await openBet(client, newest.id, newest.url).catch((e) => log('openBet error: ' + e.message));
  }
}

async function checkTwitch(client) {
  const s = state.socials;
  let live = null;
  try {
    const r = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json', ...SOCIAL_UA },
      body: JSON.stringify([{ operationName: 'UseLive', variables: { channelLogin: SOCIAL.twitch }, extensions: { persistedQuery: { version: 1, sha256Hash: '639d5f11bfb8bf3053b424d9ef650d04c4ebb7d94711d644afb08fe9a0fad5d9' } } }]),
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) { const d = (await r.json())?.[0]?.data; if (d && 'user' in d) live = d.user === null ? null : !!d.user.stream; }
  } catch {}
  if (live === null) {
    const t = await grab(`https://decapi.me/twitch/uptime/${SOCIAL.twitch}`);
    const v = (t || '').trim();
    if (/^\d+\s+(second|minute|hour|day)/i.test(v)) live = true;
    else if (/is offline/i.test(v)) live = false;
    else { noteSource(client, 'twitch', false); return; } // unknown — never guess a live ping
  }
  noteSource(client, 'twitch', true);
  if (live && !s.twitchLive) {
    const ok = await announce(client, SOCIAL.ch.live,
      `<@&${SOCIAL.role.live}> 🔴 **GIO IS LIVE ON TWITCH!** Get in here 👇\nhttps://twitch.tv/${SOCIAL.twitch}`,
      SOCIAL.role.live);
    if (!ok) return;
    log('twitch: went live, posted');
    s.twitchLive = true; dirty = true;
    const guild = await client.guilds.fetch(GUILDS[0]).catch(() => null);
    if (guild) await guild.scheduledEvents.create({
      name: '🔴 Gio is LIVE on Twitch',
      scheduledStartTime: new Date(Date.now() + 2 * 60 * 1000),
      scheduledEndTime: new Date(Date.now() + 4 * 60 * 60 * 1000),
      privacyLevel: 2, entityType: 3,
      entityMetadata: { location: `https://twitch.tv/${SOCIAL.twitch}` },
      description: 'Stream is up — pull up!',
    }).catch(() => {});
  } else if (!live && s.twitchLive) { s.twitchLive = false; dirty = true; log('twitch: stream ended'); }
}

async function checkYouTube(client) {
  const s = state.socials;
  const xml = await grab(`https://www.youtube.com/feeds/videos.xml?channel_id=${SOCIAL.youtubeChannelId}`);
  if (!xml || !xml.includes('<feed')) { noteSource(client, 'youtube', false); return; }
  noteSource(client, 'youtube', true);
  const entries = [...xml.matchAll(/<entry>[\s\S]*?<yt:videoId>(.*?)<\/yt:videoId>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<\/entry>/g)];
  if (!entries.length) return;
  const newest = entries[0][1];
  if (!s.youtubeLast) { s.youtubeLast = newest; dirty = true; return; }
  if (newest === s.youtubeLast) return;
  const idx = entries.findIndex(([, id]) => id === s.youtubeLast);
  const fresh = (idx === -1 ? [entries[0]] : entries.slice(0, idx)).reverse();
  const dec = (t) => t.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const [, id, raw] of fresh) {
    const ok = await announce(client, SOCIAL.ch.youtube,
      `<@&${SOCIAL.role.video}> ▶️ **New Gio video on YouTube!**\n> ${dec(raw).trim()}\nhttps://youtu.be/${id}`,
      SOCIAL.role.video);
    if (!ok) return;
    log(`youtube: posted ${id}`);
    s.youtubeLast = id; dirty = true;
  }
}

// A data source that dies quietly = missed alerts nobody notices. Track consecutive
// failures per source; warn staff once after ~1h dark, confirm recovery.
async function noteSource(client, name, ok) {
  const s = state.socials;
  s.health = s.health || {};
  const h = (s.health[name] = s.health[name] || { fails: 0, alerted: false });
  if (ok) {
    if (h.alerted) {
      const guild = await client.guilds.fetch(GUILDS[0]).catch(() => null);
      const staff = guild?.channels.cache.find((c) => c.name.includes('staff-chat'));
      if (staff) staff.send(`✅ **${name}** source recovered after ${h.fails} failed checks — alerts back to normal.`).catch(() => {});
      log(`source recovered: ${name}`);
    }
    s.health[name] = { fails: 0, alerted: false };
    dirty = true;
    return;
  }
  h.fails++; dirty = true;
  if (h.fails >= 20 && !h.alerted) {
    h.alerted = true;
    const guild = await client.guilds.fetch(GUILDS[0]).catch(() => null);
    const staff = guild?.channels.cache.find((c) => c.name.includes('staff-chat'));
    if (staff) staff.send(`⚠️ **Notifier warning:** the **${name}** source has failed ${h.fails} checks (~1h). Alerts may be delayed — it keeps retrying automatically, nothing is lost.`).catch(() => {});
    log(`source dark: ${name} (${h.fails} fails)`);
  }
}

async function socialTick(client) {
  // First-boot seed = where the retired GitHub notifier left off, so the handover
  // neither re-announces old posts nor drops the one pending upload (count 174 -> 175).
  state.socials = state.socials || {
    tiktokLast: '7663232041340636437',
    tiktokCount: 174,
    tiktokWaitSince: null,
    youtubeLast: 'y_x-MsvyS3Q',
    twitchLive: false,
  };
  const r = await Promise.allSettled([checkTikTok(client), checkTwitch(client), checkYouTube(client)]);
  r.forEach((x, i) => { if (x.status === 'rejected') log(`social check ${['tiktok', 'twitch', 'youtube'][i]} failed: ${x.reason}`); });
}

// ---------- live stats dashboard ----------
// The sidebar member-count channel is capped by Discord at 2 renames/10 min, so it
// lags during join waves. This is the truly-live surface: a single message in
// #📊-stats, edited the INSTANT members join/leave (2s coalescing for bursts) plus
// a 10s heartbeat. Message edits aren't rename-capped (~1/s is allowed).
let dashLastEdit = 0;
let dashPending = null;
function dashRefresh(client) {
  const since = Date.now() - dashLastEdit;
  if (since >= 2000) { dashLastEdit = Date.now(); dashboardTick(client); }
  else if (!dashPending) {
    dashPending = setTimeout(() => { dashPending = null; dashLastEdit = Date.now(); dashboardTick(client); }, 2000 - since);
  }
}

async function dashboardTick(client) {
  try {
    const guild = await client.guilds.fetch(GUILDS[0]);
    const chs = await guild.channels.fetch();
    let ch = chs.find((c) => c && c.name === '📊-stats');
    if (!ch) {
      ch = await guild.channels.create({
        name: '📊-stats',
        type: ChannelType.GuildText,
        position: 1,
        topic: 'Live server stats — updates every 30 seconds.',
        permissionOverwrites: [{ id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] }],
        reason: 'live stats dashboard',
      });
      log('created #📊-stats');
    }
    const members = guild.members.cache;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const joinedToday = members.filter((m) => m.joinedTimestamp > dayAgo).size;
    const online = guild.approximatePresenceCount ?? members.filter((m) => m.presence && m.presence.status !== 'offline').size;
    const content =
      `# 📊 LIVE SERVER STATS\n` +
      `👥 Members: **${guild.memberCount}**\n` +
      `📈 Joined in the last 24h: **+${joinedToday}**\n` +
      `🚀 Boosts: **${guild.premiumSubscriptionCount || 0}**\n\n` +
      `-# Updated <t:${Math.floor(Date.now() / 1000)}:R> — live (updates the moment someone joins)`;
    if (state.dashMsgId) {
      try {
        const msg = await ch.messages.fetch(state.dashMsgId);
        await msg.edit({ content });
        return;
      } catch { state.dashMsgId = null; }
    }
    const msg = await ch.send({ content });
    state.dashMsgId = msg.id;
    dirty = true;
  } catch (e) { log('dashboard error: ' + e.message); }
}

// ---------- starboard / hall of fame ----------
const STAR_EMOJI = '🔥';
const STAR_THRESHOLD = 3;

// Shared induction: used by both the live reaction event and the periodic sweep.
async function inductToHall(msg, count) {
  if (!msg.author || msg.author.bot) return false;
  if (msg.channel.name?.includes('hall-of-fame')) return false;
  state.starred = state.starred || {};
  if (state.starred[msg.id]) return false;
  state.starred[msg.id] = Date.now();
  dirty = true;

  const guild = msg.guild;
  let hall = guild.channels.cache.find((c) => c.name.includes('hall-of-fame'));
  if (!hall) {
    hall = await guild.channels.create({
      name: '🏆-hall-of-fame',
      type: ChannelType.GuildText,
      position: 2,
      topic: 'Legendary messages — 3+ 🔥 reactions gets you in here forever.',
      permissionOverwrites: [{ id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.AddReactions], deny: [PermissionFlagsBits.SendMessages] }],
      reason: 'starboard',
    });
    log('created #🏆-hall-of-fame');
  }
  const img = msg.attachments.find((a) => a.contentType?.startsWith('image/'));
  await hall.send({
    content: `🔥 **${count}** • ${msg.channel} • <@${msg.author.id}>\n` +
      (msg.content ? `>>> ${msg.content.slice(0, 900)}\n` : '') +
      (img ? `${img.url}\n` : '') +
      `[jump to message](${msg.url})`,
    allowedMentions: { parse: [] },
  });
  log(`starboard: immortalized ${msg.id} (${count} 🔥)`);
  return true;
}

async function onReaction(reaction, client) {
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.emoji.name !== STAR_EMOJI) return;
    const msg = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    if (!msg.inGuild() || !GUILDS.includes(msg.guildId)) return;
    if ((reaction.count || 0) < STAR_THRESHOLD) return;
    await inductToHall(msg, reaction.count);
  } catch (e) { log('starboard error: ' + e.message); }
}

// Periodic sweep: catches messages that crossed the threshold while the bot was
// down/deploying, or that had their 🔥 before the starboard existed.
async function starboardSweep(client) {
  try {
    const guild = await client.guilds.fetch(GUILDS[0]);
    const chs = await guild.channels.fetch();
    const targets = [...chs.values()].filter((c) =>
      c && c.type === ChannelType.GuildText &&
      !c.name.includes('hall-of-fame') && !c.name.includes('staff') &&
      !c.name.includes('mod-logs') && !c.name.includes('bot-data') &&
      c.viewable
    );
    let inducted = 0;
    for (const ch of targets) {
      const msgs = await ch.messages.fetch({ limit: 50 }).catch(() => null);
      if (!msgs) continue;
      for (const msg of msgs.values()) {
        const fire = msg.reactions.cache.get(STAR_EMOJI);
        if (fire && fire.count >= STAR_THRESHOLD && !state.starred?.[msg.id]) {
          if (await inductToHall(msg, fire.count)) inducted++;
        }
      }
    }
    if (inducted) log(`starboard sweep: inducted ${inducted} message(s)`);
  } catch (e) { log('starboard sweep error: ' + e.message); }
}

// ---------- booster perks ----------
async function onBoost(before, after) {
  try {
    if (!GUILDS.includes(after.guild.id)) return;
    if (before.premiumSince || !after.premiumSince) return; // only new boosts
    let role = after.guild.roles.cache.find((r) => r.name === '💖 BOOSTER');
    if (!role) {
      role = await after.guild.roles.create({
        name: '💖 BOOSTER', color: 0xF47FFF, hoist: true, mentionable: false,
        reason: 'booster perks',
      });
      log('created 💖 BOOSTER role');
    }
    await after.roles.add(role).catch(() => {});
    const chat = after.guild.channels.cache.find((c) => c.name.includes('┆chat'));
    if (chat) await chat.send({
      content: `💖 **HUGE!** <@${after.id}> just BOOSTED the server! Shiny 💖 BOOSTER role granted — absolute legend. 🚀`,
      allowedMentions: { users: [after.id] },
    });
  } catch (e) { log('booster error: ' + e.message); }
}

// Boot sweep: anyone boosting while the bot was down/deploying still gets the role
// (silently — the hype message is only for live boost events).
async function boosterCatchUp(client) {
  try {
    const guild = await client.guilds.fetch(GUILDS[0]);
    const members = await guild.members.fetch();
    const boosters = members.filter((m) => m.premiumSince);
    if (!boosters.size) return;
    let role = guild.roles.cache.find((r) => r.name === '💖 BOOSTER');
    if (!role) role = await guild.roles.create({ name: '💖 BOOSTER', color: 0xF47FFF, hoist: true, mentionable: false, reason: 'booster perks' });
    for (const m of boosters.values()) {
      if (!m.roles.cache.has(role.id)) {
        await m.roles.add(role).catch(() => {});
        log(`booster catch-up: role -> ${m.user.username}`);
      }
    }
  } catch (e) { log('booster catch-up error: ' + e.message); }
}

// ---------- weekly invite contest ----------
// Sundays after noon (Toronto): top 3 inviters since the last reset win 🏆 Legend
// plus a shoutout in announcements; the baseline then resets for the new week.
async function inviteContestTick(client) {
  try {
    const s = (state.inviteContest = state.inviteContest || {});
    const gid = GUILDS[0];
    const totals = state.invites?.[gid] || {};
    if (!s.baseline) { s.baseline = { ...totals }; dirty = true; return; }

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
    const dow = new Date().toLocaleDateString('en-US', { timeZone: 'America/Toronto', weekday: 'short' });
    const hour = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }));
    if (dow !== 'Sun' || hour < 12 || s.lastResolved === today) return;

    const deltas = Object.entries(totals)
      .map(([id, n]) => [id, n - (s.baseline[id] || 0)])
      .filter(([, d]) => d > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    const guild = await client.guilds.fetch(gid);
    const ann = guild.channels.cache.find((c) => c.name.includes('「📢」announcements'))
      || guild.channels.cache.find((c) => c.name.includes('announcements'));
    if (deltas.length && ann) {
      const legend = guild.roles.cache.find((r) => r.name.includes('Legend'));
      const medals = ['🥇', '🥈', '🥉'];
      const lines = [];
      for (let i = 0; i < deltas.length; i++) {
        const [id, d] = deltas[i];
        lines.push(`${medals[i]} <@${id}> — **${d}** invite${d === 1 ? '' : 's'}`);
        if (legend) await guild.members.fetch(id).then((m) => m.roles.add(legend)).catch(() => {});
      }
      await ann.send({
        content: `# 🏆 INVITE CONTEST — weekly winners!\n${lines.join('\n')}\n\nAll three earn the **🏆 Legend** role. New week starts NOW — bring your friends and check \`/invites\` for live standings. 📨`,
        allowedMentions: { users: deltas.map(([id]) => id) },
      });
      log(`invite contest resolved: ${deltas.length} winner(s)`);
    }
    s.baseline = { ...totals };
    s.lastResolved = today;
    dirty = true;
  } catch (e) { log('invite contest error: ' + e.message); }
}

// ---------- Gio Coins economy ----------
function coinRec(g, u) {
  state.xp[g] = state.xp[g] || {};
  const r = (state.xp[g][u] = state.xp[g][u] || { xp: 0, level: 0, last: 0, total: 0 });
  if (r.coins == null) r.coins = 100; // starter balance
  return r;
}
const fmtC = (n) => `**${n.toLocaleString()}** 🪙`;

const SLOT_REELS = ['🍒', '🍋', '💎', '🎵', '🔥', '👑'];
function spinSlots(bet) {
  const r = () => SLOT_REELS[Math.floor(Math.random() * SLOT_REELS.length)];
  const s = [r(), r(), r()];
  let mult = 0;
  if (s[0] === s[1] && s[1] === s[2]) mult = s[0] === '👑' ? 15 : 8;
  else if (s[0] === s[1] || s[1] === s[2] || s[0] === s[2]) mult = 2;
  return { s, win: bet * mult };
}

const ROASTS = [
  "you type like your wifi is buffering. 💀",
  "your /rank is public and yet you're still talking. 📉",
  "Gio has 175 videos and you're the blooper reel.",
  "you'd lose a W/L vote against a wall. 🇱",
  "the QOTD is easier than whatever you're doing rn.",
  "your best clip got 0 🔥 and honestly? accurate.",
  "even the AutoMod feels bad blocking you.",
  "you joined for the pings and stayed to embarrass yourself. 🤝",
  "level 0 behavior with level 100 confidence.",
  "you're the reason slowmode exists.",
  "the Hall of Fame has restraining orders for less.",
  "somewhere in Toronto, Gio just cringed and doesn't know why.",
];
const shipScore = (a, b) => {
  const key = [a, b].sort().join('');
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % 101;
};

// ---------- view-count betting ----------
const BET_LINE = 100000, BET_OPEN_MS = 6 * 60 * 60 * 1000, BET_RESOLVE_MS = 24 * 60 * 60 * 1000;

async function openBet(client, videoId, url) {
  if (state.bet && state.bet.status === 'open') return;
  state.bet = {
    videoId, url, line: BET_LINE,
    closesAt: Date.now() + BET_OPEN_MS,
    resolvesAt: Date.now() + BET_RESOLVE_MS,
    wagers: {}, status: 'open',
  };
  dirty = true;
  const ch = await client.channels.fetch(SOCIAL.ch.tiktok).catch(() => null);
  if (ch) await ch.send({
    content: `📈 **BETTING IS OPEN on this video!**\nWill it hit **${BET_LINE.toLocaleString()} views in 24h**?\n` +
      `> \`/bet\` **over** or **under** with your 🪙 — win pays **2x**\n` +
      `> Betting closes <t:${Math.floor(state.bet.closesAt / 1000)}:R> • resolves <t:${Math.floor(state.bet.resolvesAt / 1000)}:R>`,
    allowedMentions: { parse: [] },
  });
  log(`bet opened on ${videoId}`);
}

async function resolveBetTick(client) {
  try {
    const b = state.bet;
    if (!b || b.status !== 'open' || Date.now() < b.resolvesAt) return;
    const j = await grabJson(`https://www.tikwm.com/api/?url=${encodeURIComponent(b.url)}`, 2);
    const views = j?.data?.play_count;
    const ch = await client.channels.fetch(SOCIAL.ch.tiktok).catch(() => null);
    if (typeof views !== 'number') {
      if (Date.now() > b.resolvesAt + 12 * 60 * 60 * 1000) { // give up after 12h of retries: refund
        for (const [uid, w] of Object.entries(b.wagers)) coinRec(GUILDS[0], uid).coins += w.amt;
        b.status = 'refunded'; dirty = true;
        if (ch) await ch.send('📈 Betting refunded — view data was unavailable. Your 🪙 are back.');
        log('bet refunded (no view data)');
      }
      return;
    }
    const result = views >= b.line ? 'over' : 'under';
    const winners = Object.entries(b.wagers).filter(([, w]) => w.side === result);
    for (const [uid, w] of winners) coinRec(GUILDS[0], uid).coins += w.amt * 2;
    b.status = 'resolved'; b.views = views; dirty = true;
    if (ch) await ch.send({
      content: `📈 **BET RESOLVED:** the video hit **${views.toLocaleString()} views** — **${result.toUpperCase()}** wins! 🎉\n` +
        (winners.length ? `Paid 2x to: ${winners.map(([uid]) => `<@${uid}>`).join(' ')}` : 'Nobody called it. House keeps the bag. 💰'),
      allowedMentions: { users: winners.map(([uid]) => uid) },
    });
    log(`bet resolved: ${views} views, ${result}, ${winners.length} winners`);
  } catch (e) { log('bet resolve error: ' + e.message); }
}

// ---------- secret code vault ----------
async function checkSecretCode(msg) {
  const sec = state.secret;
  if (!sec || !sec.code) return;
  if ((msg.content || '').toLowerCase().trim() !== sec.code) return;
  if (sec.claimed.includes(msg.author.id)) return;
  await msg.delete().catch(() => {}); // keep the code off the screen
  const guild = msg.guild;
  let role = guild.roles.cache.find((r) => r.name === '🗝️ CODEBREAKER');
  if (!role) role = await guild.roles.create({ name: '🗝️ CODEBREAKER', color: 0x9B59B6, hoist: false, mentionable: false, reason: 'secret code vault' });
  let vault = guild.channels.cache.find((c) => c.name.includes('the-vault'));
  if (!vault) {
    const community = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name.includes('COMMUNITY'));
    vault = await guild.channels.create({
      name: '🗝️-the-vault', type: ChannelType.GuildText, parent: community?.id,
      topic: 'You found the code. Welcome to the vault.',
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: role.id, allow: [PermissionFlagsBits.ViewChannel] },
      ],
      reason: 'secret code vault',
    });
    await vault.send('# 🗝️ THE VAULT\nOnly codebreakers see this. You caught the code — that makes you certified locked in. 🤫');
  }
  await msg.member.roles.add(role).catch(() => {});
  sec.claimed.push(msg.author.id);
  coinRec(guild.id, msg.author.id).coins += 500;
  dirty = true;
  await msg.author.send(`🗝️ **You cracked the code!** The hidden **${vault.name}** channel just unlocked for you, plus **500 🪙**. Don't spill it. 🤫`).catch(() => {});
  if (sec.claimed.length >= sec.max) { state.secret = null; log('secret code fully claimed'); }
  log(`code claimed by ${msg.author.username} (${sec.claimed.length}/${sec.max})`);
}

// ---------- 3-day meme challenge (one-shot, self-running) ----------
const MEME_CONTEST = {
  start: Date.parse('2026-07-18T00:00:00Z'),
  end: Date.parse('2026-07-21T00:00:00Z'), // 3 days
};

async function memeContestTick(client) {
  try {
    const s = (state.memeContest = state.memeContest || {});
    const guild = await client.guilds.fetch(GUILDS[0]);
    const memes = guild.channels.cache.find((c) => c.name.includes('new-memes'));
    if (!memes) return;

    if (!s.announced) {
      const ann = guild.channels.cache.find((c) => c.name.includes('「📢」announcements'));
      const endTs = Math.floor(MEME_CONTEST.end / 1000);
      if (ann) await ann.send({
        content: `@everyone\n# 😂 MEME CHALLENGE — 3 DAYS. BEST MEME WINS.\n\nDrop your best Gio meme in ${memes} before <t:${endTs}:F> (<t:${endTs}:R>).\n\n> 🔥 React to the ones that cook you\n> 🏆 Most reactions wins the **🏆 Legend** role + a shoutout\n> 😤 Original memes only\n\nCook. That's the whole announcement.`,
        allowedMentions: { parse: ['everyone'] },
      });
      await memes.send({ content: `# 😂 THE MEME CHALLENGE IS LIVE — this is the arena. <t:${Math.floor(MEME_CONTEST.end / 1000)}:R> the winner is crowned. 🏆`, allowedMentions: { parse: [] } });
      s.announced = true; dirty = true;
      log('meme contest announced');
      return;
    }

    if (s.resolved || Date.now() < MEME_CONTEST.end) return;

    // resolve: highest-reacted qualifying meme posted during the window
    let entries = [], before;
    for (let page = 0; page < 4; page++) {
      const batch = await memes.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (!batch.size) break;
      for (const m of batch.values()) {
        const t = m.createdTimestamp;
        if (t < MEME_CONTEST.start) { page = 99; break; }
        if (t <= MEME_CONTEST.end && !m.author.bot &&
            (m.attachments.size > 0 || m.embeds.length > 0)) entries.push(m);
      }
      before = batch.last()?.id;
    }
    const score = (m) => [...m.reactions.cache.values()].reduce((s2, r) => s2 + r.count, 0);
    const ann = guild.channels.cache.find((c) => c.name.includes('「📢」announcements'));
    if (!entries.length) {
      if (ann) await ann.send('😂 The meme challenge ended with no entries... embarrassing, honestly. Next time. 💀');
    } else {
      const winner = entries.reduce((a, b) => (score(b) > score(a) ? b : a));
      const legend = guild.roles.cache.find((r) => r.name.includes('Legend'));
      if (legend) await guild.members.fetch(winner.author.id).then((m) => m.roles.add(legend)).catch(() => {});
      if (ann) await ann.send({
        content: `# 😂 MEME CHALLENGE — WE HAVE A WINNER\n\n🏆 <@${winner.author.id}> takes it with **${score(winner)} reactions**!\n${winner.url}\n\nThey now hold the **🏆 Legend** role. Bow down. 👑`,
        allowedMentions: { users: [winner.author.id] },
      });
      log(`meme contest won by ${winner.author.username} (${score(winner)})`);
    }
    s.resolved = true; dirty = true;
  } catch (e) { log('meme contest error: ' + e.message); }
}

// ---------- welcome bookkeeping ----------
// One welcome per member, ever. Backed by state so it survives restarts and the
// brief old+new instance overlap during Render deploys.
function claimWelcome(guildId, userId) {
  state.welcomed = state.welcomed || {};
  const w = (state.welcomed[guildId] = state.welcomed[guildId] || {});
  if (w[userId]) return false;
  w[userId] = Date.now();
  dirty = true;
  return true;
}

// On boot: seed the ledger from channel history (covers everyone welcomed before
// the ledger existed), then greet anyone who joined while the bot was deploying.
async function welcomeCatchUp(client) {
  for (const gid of GUILDS) {
    try {
      const guild = await client.guilds.fetch(gid);
      const ch = (await guild.channels.fetch()).find((c) => c && c.name === '👋-welcome');
      if (!ch) continue;

      state.welcomed = state.welcomed || {};
      const w = (state.welcomed[gid] = state.welcomed[gid] || {});
      const msgs = await ch.messages.fetch({ limit: 100 });
      for (const m of msgs.values()) {
        if (m.author.id !== client.user.id) continue;
        for (const [, id] of m.content.matchAll(/<@!?(\d+)>/g)) if (!w[id]) { w[id] = m.createdTimestamp; dirty = true; }
      }

      const members = await guild.members.fetch();
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const missed = [...members.values()].filter((m) =>
        !m.user.bot && m.joinedTimestamp > dayAgo && !w[m.id]
      );
      if (!missed.length) continue;
      for (const m of missed) { w[m.id] = Date.now(); }
      dirty = true;
      // one combined message, not a spam burst
      const mentions = missed.slice(0, 30).map((m) => `<@${m.id}>`).join(' ');
      await ch.send({
        content: `👑 Yo ${mentions} — welcome to **${guild.name}**! Grab your ping roles in **Channels & Roles** and say what's up in chat. 🤝`,
        allowedMentions: { users: missed.slice(0, 30).map((m) => m.id) },
      });
      log(`welcome catch-up: greeted ${missed.length} member(s) missed during downtime`);
    } catch (e) { log('welcome catch-up error: ' + e.message); }
  }
}

// ---------- live member-count channel ----------
// Event-driven: joins/leaves trigger an immediate rename while Discord's hard cap
// (2 renames per channel per 10 minutes) has budget; past the cap, one pending
// rename is scheduled for the moment budget frees and always writes the LATEST count.
const RENAME_WINDOW = 10 * 60 * 1000;
const renameBudget = {}; // guildId -> { times: [ts, ts], pending: Timeout|null }

async function statsUpdate(guild) {
  try {
    const b = (renameBudget[guild.id] = renameBudget[guild.id] || { times: [], pending: null });
    const chs = await guild.channels.fetch();
    let ch = chs.find((c) => c && c.name.startsWith('👥 Members:'));
    if (!ch) {
      // self-heal: someone deleted the counter channel — rebuild it
      ch = await guild.channels.create({
        name: `👥 Members: ${guild.memberCount}`,
        type: ChannelType.GuildVoice,
        position: 0,
        permissionOverwrites: [{ id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] }],
        reason: 'member counter (recreated)',
      });
      log('stats: counter channel was missing — recreated');
      return;
    }
    const want = `👥 Members: ${guild.memberCount}`;
    if (ch.name === want) return;

    const now = Date.now();
    b.times = b.times.filter((t) => now - t < RENAME_WINDOW);
    if (b.times.length < 2) {
      b.times.push(now);
      await ch.setName(want, 'live member count');
      log(`stats: member count -> ${guild.memberCount}`);
    } else if (!b.pending) {
      const waitMs = b.times[0] + RENAME_WINDOW - now + 1000;
      b.pending = setTimeout(() => { b.pending = null; statsUpdate(guild); }, waitMs);
      log(`stats: rename budget spent, next update in ${Math.ceil(waitMs / 1000)}s (will use latest count)`);
    }
  } catch (e) { log('stats error: ' + e.message); }
}

// Safety net for missed gateway events / drift.
async function statsTick(client) {
  for (const gid of GUILDS) {
    const guild = await client.guilds.fetch(gid).catch(() => null);
    if (guild) await statsUpdate(guild);
  }
  hierarchyUpgrades(client).catch((e) => log('hierarchy upgrade error: ' + e.message));
}

// Queued cosmetic upgrades that need the bot to outrank ADMIN/Owner. They run
// automatically the moment the owner drags the bot's role up — no follow-up needed.
async function hierarchyUpgrades(client) {
  const guild = await client.guilds.fetch(GUILDS[0]);
  const me = await guild.members.fetchMe();
  const myPos = me.roles.highest.position;
  const admin = guild.roles.cache.find((r) => r.name === 'ADMIN');
  const ownerRole = guild.roles.cache.find((r) => r.name === 'Owner');
  const gioRole = guild.roles.cache.find((r) => r.name === '👑 GIO');

  if (admin && admin.position < myPos && !state.adminRestyled) {
    await admin.edit({ color: 0xED4245, hoist: true }, 'admin visibility: crimson');
    state.adminRestyled = true; dirty = true;
    log('hierarchy: ADMIN restyled to crimson');
    const staff = guild.channels.cache.find((c) => c.name.includes('staff-chat'));
    if (staff) staff.send('🎨 Role hierarchy unlocked — **ADMIN is now crimson** and 👑 GIO is being moved to the top. Anti-nuke now covers rogue admins too.').catch(() => {});
  }
  if (gioRole && admin && ownerRole && gioRole.position < myPos - 1
      && admin.position < myPos && ownerRole.position < myPos && !state.gioOnTop) {
    await gioRole.setPosition(myPos - 1, { reason: 'GIO above everyone' });
    state.gioOnTop = true; dirty = true;
    log('hierarchy: 👑 GIO moved above ADMIN/Owner');
  }
}

// ---------- anti-nuke ----------
// Catches a compromised admin / rogue mod destroying the server: mass channel or
// role deletion, mass bans/kicks, webhook spam. AutoMod covers spam, not destruction.
//
// Response is quarantine (strip every role), not ban: it stops the damage instantly,
// it's reversible if it ever misfires, and it works even when the account is stolen
// rather than malicious. Hard limits worth knowing:
//   - Discord never lets a bot act on the server OWNER -> owner actions alert only.
//   - The bot can only strip roles BELOW its own role.
const ANTINUKE = {
  [AuditLogEvent.ChannelDelete]: { label: 'channel deletions', max: 3, windowMs: 30_000 },
  [AuditLogEvent.RoleDelete]: { label: 'role deletions', max: 3, windowMs: 30_000 },
  [AuditLogEvent.MemberBanAdd]: { label: 'bans', max: 5, windowMs: 60_000 },
  [AuditLogEvent.MemberKick]: { label: 'kicks', max: 5, windowMs: 60_000 },
  [AuditLogEvent.WebhookCreate]: { label: 'webhook creations', max: 5, windowMs: 30_000 },
  [AuditLogEvent.ChannelCreate]: { label: 'channel creations', max: 8, windowMs: 30_000 },
};
// Accounts exempt from anti-nuke. Keep this SMALL — every id here is a key to the server.
const FOUNDER = '925895258598953031'; // m8ssi
const NUKE_WHITELIST = [FOUNDER, ...(process.env.ANTINUKE_WHITELIST || '').split(',').map((s) => s.trim()).filter(Boolean)];
const nukeHits = new Map(); // `${userId}:${action}` -> [timestamps]

async function onAuditEntry(entry, guild, client) {
  try {
    const rule = ANTINUKE[entry.action];
    if (!rule) return;
    const uid = entry.executorId;
    if (!uid) return;
    if (uid === client.user.id) return;      // our own automation
    if (NUKE_WHITELIST.includes(uid)) return;

    const isOwner = uid === guild.ownerId;
    const key = `${uid}:${entry.action}`;
    const now = Date.now();
    const hits = (nukeHits.get(key) || []).filter((t) => now - t < rule.windowMs);
    hits.push(now);
    nukeHits.set(key, hits);
    if (hits.length < rule.max) return;

    nukeHits.set(key, []); // reset so one incident doesn't alert repeatedly
    const secs = Math.round(rule.windowMs / 1000);
    log(`ANTI-NUKE: ${uid} hit ${hits.length} ${rule.label} in ${secs}s (owner=${isOwner})`);

    let outcome;
    if (isOwner) {
      outcome = '⚠️ This is the **server owner** — Discord does not allow a bot to act on them. Manual review required.';
    } else {
      const member = await guild.members.fetch(uid).catch(() => null);
      if (!member) outcome = '⚠️ Could not fetch the member to quarantine them.';
      else if (!member.manageable) outcome = '⚠️ Could not quarantine — their role sits above mine. Move **Gio Bot** higher in Server Settings → Roles.';
      else {
        const had = [...member.roles.cache.filter((r) => r.id !== guild.id).values()];
        await member.roles.set([], `anti-nuke: ${hits.length} ${rule.label} in ${secs}s`);
        outcome = `🔒 **Quarantined** — stripped ${had.length} role(s): ${had.map((r) => r.name).join(', ') || 'none'}`;
        state.nuke = state.nuke || [];
        state.nuke.push({ at: new Date().toISOString(), user: uid, action: rule.label, count: hits.length, roles: had.map((r) => r.id) });
        dirty = true;
      }
    }

    const chs = await guild.channels.fetch();
    const alertCh = chs.find((c) => c && c.name.includes('mod-logs')) || chs.find((c) => c && c.name.includes('staff-chat'));
    const adminRole = guild.roles.cache.find((r) => r.name === 'ADMIN');
    if (alertCh) {
      await alertCh.send({
        content: `${adminRole ? `<@&${adminRole.id}> ` : ''}🚨 **ANTI-NUKE TRIGGERED**\n` +
          `**Who:** <@${uid}> (\`${uid}\`)\n` +
          `**What:** ${hits.length} ${rule.label} in ${secs}s\n` +
          `**Action:** ${outcome}\n\n` +
          `If this was legitimate, restore their roles manually — and consider whitelisting them.`,
        allowedMentions: { roles: adminRole ? [adminRole.id] : [], users: [] },
      }).catch((e) => log('anti-nuke alert failed: ' + e.message));
    }
  } catch (e) { log('anti-nuke error: ' + e.message); }
}

// ---------- invite tracking ----------
const inviteCache = {}; // guildId -> Map(code -> {uses, inviterId})

async function cacheInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    inviteCache[guild.id] = new Map(invites.map((i) => [i.code, { uses: i.uses, inviterId: i.inviter?.id }]));
  } catch (e) { log(`invite cache failed for ${guild.id}: ${e.message}`); }
}

async function attributeJoin(member) {
  try {
    const before = inviteCache[member.guild.id];
    const invites = await member.guild.invites.fetch();
    let used = null;
    for (const inv of invites.values()) {
      const prev = before?.get(inv.code);
      if (prev && inv.uses > prev.uses) { used = inv; break; }
      if (!prev && inv.uses > 0) used = used || inv;
    }
    inviteCache[member.guild.id] = new Map(invites.map((i) => [i.code, { uses: i.uses, inviterId: i.inviter?.id }]));
    if (!used?.inviter) return null;
    state.invites = state.invites || {};
    state.invites[member.guild.id] = state.invites[member.guild.id] || {};
    const n = (state.invites[member.guild.id][used.inviter.id] || 0) + 1;
    state.invites[member.guild.id][used.inviter.id] = n;
    dirty = true;
    const staff = member.guild.channels.cache.find((c) => c.name.includes('staff-chat'));
    if (staff) await staff.send({
      content: `📨 <@${member.id}> joined via \`${used.code}\` from <@${used.inviter.id}> (their **${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}** invite)`,
      allowedMentions: { parse: [] },
    }).catch(() => {});
    return used.inviter.id;
  } catch (e) { log('attributeJoin error: ' + e.message); return null; }
}

// ---------- weekly community hangout event ----------
function nextFriday7pmToronto() {
  for (let d = 0; d <= 7; d++) {
    const cand = new Date(Date.now() + d * 86400000);
    if (cand.toLocaleDateString('en-US', { timeZone: 'America/Toronto', weekday: 'short' }) !== 'Fri') continue;
    const ymd = cand.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
    let dt = new Date(`${ymd}T19:00:00-04:00`);
    const h = Number(dt.toLocaleString('en-US', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }));
    if (h !== 19) dt = new Date(`${ymd}T19:00:00-05:00`);
    if (dt.getTime() > Date.now() + 60 * 60 * 1000) return dt;
  }
  return null;
}

let lastEventCheck = 0;
async function hangoutTick(client) {
  if (Date.now() - lastEventCheck < 6 * 60 * 60 * 1000) return; // check every 6h
  lastEventCheck = Date.now();
  for (const gid of GUILDS) {
    try {
      const guild = await client.guilds.fetch(gid).catch(() => null);
      if (!guild) continue;
      const events = await guild.scheduledEvents.fetch();
      if (events.some((e) => e.name.includes('Community Hangout') && e.status !== 3)) continue;
      const start = nextFriday7pmToronto();
      if (!start) continue;
      const chs = await guild.channels.fetch();
      const vc = chs.find((c) => c && c.type === ChannelType.GuildVoice && (c.name.includes('LOUNGE') || c.name.includes('Lounge')))
        || chs.find((c) => c && c.type === ChannelType.GuildVoice);
      if (!vc) continue;
      await guild.scheduledEvents.create({
        name: '🎉 Community Hangout',
        scheduledStartTime: start,
        scheduledEndTime: new Date(start.getTime() + 2 * 60 * 60 * 1000),
        privacyLevel: 2,
        entityType: 2,
        channel: vc.id,
        description: 'Weekly hangout — pull up, chat, game, chill. Everyone welcome. 👑',
      });
      log(`hangout event created in ${gid} for ${start.toISOString()}`);
    } catch (e) { log('hangout error: ' + e.message); }
  }
}

// ---------- tiktok stats ----------
async function tiktokStats() {
  const info = await (await fetch(
    `https://www.tikwm.com/api/user/info?unique_id=${TIKTOK_USER}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  )).json();
  const u = info?.data?.user, s = info?.data?.stats;
  if (!s) throw new Error('tiktok api unavailable');
  // tikwm's user/posts is usually Cloudflare-challenged; rss-bridge serves the real feed.
  let latest = null;
  try {
    const feed = await (await fetch(
      `https://rss-bridge.org/bridge01/?action=display&bridge=TikTokBridge&context=By+user&username=${TIKTOK_USER}&format=Json`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) }
    )).json();
    const it = feed?.items?.[0];
    if (it?.url) latest = { url: it.url, title: (it.title || '').trim() };
  } catch {}
  return {
    followers: s.followerCount, hearts: s.heartCount, videos: s.videoCount,
    bio: u?.signature || '',
    latest: latest?.url || null,
    latestTitle: latest?.title || '',
  };
}

// ---------- client ----------
const FULL_INTENTS = [
  GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions, // starboard
  GatewayIntentBits.GuildModeration, // required for audit-log events (anti-nuke)
  GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildInvites,
];
const BASIC_INTENTS = [
  GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.GuildInvites, GatewayIntentBits.GuildModeration,
];
let privileged = true;

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);

async function start(intents) {
  // partials: starboard must see reactions on messages sent before this boot
  const client = new Client({ intents, partials: [Partials.Message, Partials.Reaction, Partials.Channel] });

  client.once('clientReady', async () => {
    log(`online as ${client.user.tag} (privileged intents: ${privileged})`);
    const setP = () => client.user.setPresence({
      status: 'online',
      activities: [{ name: 'lightskin.gio 👑', type: ActivityType.Watching }],
    });
    setP(); setInterval(setP, 60 * 60 * 1000);
    await loadState(client);
    // founder boost: keep m8ssi at max level / top of the leaderboard
    for (const gid of GUILDS) {
      state.xp[gid] = state.xp[gid] || {};
      const rec = (state.xp[gid][FOUNDER] = state.xp[gid][FOUNDER] || { xp: 0, level: 0, last: 0, total: 0 });
      if (rec.level < 100) { rec.level = 100; rec.total = Math.max(rec.total, 1899250); dirty = true; log('founder boost applied'); }
    }
    await registerCommands(client);
    await welcomeCatchUp(client);
    await boosterCatchUp(client);
    for (const gid of GUILDS) {
      const guild = await client.guilds.fetch(gid).catch(() => null);
      if (guild) await cacheInvites(guild);
    }
    const tick = () => { growthTick(client); qotdTick(client); hangoutTick(client); inviteContestTick(client); memeContestTick(client); resolveBetTick(client); saveState(); };
    tick(); setInterval(tick, 5 * 60 * 1000);

    // Social alerts get their own, faster timer — this is the latency users actually feel.
    const social = () => socialTick(client).then(saveState);
    social(); setInterval(social, 3 * 60 * 1000);

    // Member-count channel: 10-minute cadence (Discord caps renames at 2 per 10 min).
    statsTick(client); setInterval(() => statsTick(client), 10 * 60 * 1000);

    // Truly-live dashboard: instant on join/leave, 10-second heartbeat otherwise.
    dashboardTick(client); setInterval(() => dashRefresh(client), 10 * 1000);

    // Starboard sweep: catch 🔥 milestones missed while offline (boot + hourly).
    starboardSweep(client); setInterval(() => starboardSweep(client), 60 * 60 * 1000);

    // Gateway watchdog: if the connection dies for 5+ minutes, restart clean.
    armWatchdog(client);
  });

  client.on('inviteCreate', (inv) => {
    if (inv.guild) cacheInvites(inv.guild);
  });

  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    if (GUILDS.includes(guild.id)) onAuditEntry(entry, guild, client);
  });

  client.on('messageReactionAdd', (reaction) => onReaction(reaction, client));
  client.on('guildMemberUpdate', (before, after) => onBoost(before, after));

  client.on('messageCreate', async (msg) => {
    try {
      if (msg.author?.bot || !msg.inGuild() || !GUILDS.includes(msg.guildId)) return;
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
      await checkSecretCode(msg);
    } catch (e) { log('messageCreate error: ' + e.message); }
  });

  client.on('guildMemberRemove', (member) => {
    if (!GUILDS.includes(member.guild.id)) return;
    statsUpdate(member.guild); // sidebar counter (rename-capped)
    dashRefresh(client);       // dashboard message (instant)
  });

  client.on('guildMemberAdd', async (member) => {
    try {
      if (!GUILDS.includes(member.guild.id)) return;
      statsUpdate(member.guild); // sidebar counter (rename-capped)
      dashRefresh(client); // dashboard message (instant)
      const autoRole = member.guild.roles.cache.find((r) => r.name === AUTO_ROLE);
      if (autoRole) await member.roles.add(autoRole).catch((e) => log('autorole error: ' + e.message));
      await attributeJoin(member);
      // dedupe: Render's zero-downtime deploys briefly run two bot instances, and
      // both receive this event — only the first one to claim the id may welcome.
      if (member.user.bot || !claimWelcome(member.guild.id, member.id)) return;
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

      } else if (cmd === 'invites') {
        const board = Object.entries(state.invites?.[i.guildId] || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
        if (!board.length) return i.reply('No tracked invites yet — share the server link and climb the board! 📨');
        const medals = ['🥇', '🥈', '🥉'];
        const lines = board.map(([id, n], x) => `${medals[x] || `**${x + 1}.**`} <@${id}> — **${n}** invite${n === 1 ? '' : 's'}`);
        await i.reply({ content: `📨 **Invite Leaderboard**\n${lines.join('\n')}`, allowedMentions: { parse: [] } });

      } else if (cmd === 'daily') {
        const rec = coinRec(i.guildId, i.user.id);
        const now = Date.now();
        if (rec.lastDaily && now - rec.lastDaily < 20 * 60 * 60 * 1000) {
          return i.reply({ content: `⏳ Already claimed — come back <t:${Math.floor((rec.lastDaily + 20 * 60 * 60 * 1000) / 1000)}:R>.`, flags: MessageFlags.Ephemeral });
        }
        rec.streak = rec.lastDaily && now - rec.lastDaily < 48 * 60 * 60 * 1000 ? (rec.streak || 0) + 1 : 1;
        const amount = 100 + Math.min(rec.streak - 1, 10) * 25;
        rec.coins += amount; rec.lastDaily = now; dirty = true;
        await i.reply(`💰 Daily claimed: ${fmtC(amount)} (streak: **${rec.streak}** 🔥) — balance ${fmtC(rec.coins)}`);

      } else if (cmd === 'coins') {
        const target = i.options.getUser('user') || i.user;
        const rec = coinRec(i.guildId, target.id);
        await i.reply({ content: `🪙 **${target.username}** has ${fmtC(rec.coins)}`, allowedMentions: { parse: [] } });

      } else if (cmd === 'rich') {
        const all = Object.entries(state.xp[i.guildId] || {}).filter(([, r]) => r.coins > 0)
          .sort((a, b) => (b[1].coins || 0) - (a[1].coins || 0)).slice(0, 10);
        if (!all.length) return i.reply('Nobody has coins yet. `/daily` is free money. 💰');
        const medals = ['🥇', '🥈', '🥉'];
        await i.reply({
          content: `💰 **Richest in the server**\n${all.map(([id, r], n) => `${medals[n] || `**${n + 1}.**`} <@${id}> — ${fmtC(r.coins)}`).join('\n')}`,
          allowedMentions: { parse: [] },
        });

      } else if (cmd === 'slots') {
        const amount = i.options.getInteger('amount', true);
        const rec = coinRec(i.guildId, i.user.id);
        if (rec.coins < amount) return i.reply({ content: `You only have ${fmtC(rec.coins)}. 💀`, flags: MessageFlags.Ephemeral });
        rec.coins -= amount;
        const { s, win } = spinSlots(amount);
        rec.coins += win; dirty = true;
        await i.reply(
          `🎰 | ${s.join(' | ')} |\n` +
          (win > amount ? `**JACKPOT-ISH!** +${fmtC(win - amount)} — balance ${fmtC(rec.coins)} 🎉`
            : win > 0 ? `Pair! +${fmtC(win - amount)} — balance ${fmtC(rec.coins)}`
            : `Nothing. -${fmtC(amount)} — balance ${fmtC(rec.coins)} 💀`)
        );

      } else if (cmd === 'flip') {
        const amount = i.options.getInteger('amount', true);
        const side = i.options.getString('side', true);
        const rec = coinRec(i.guildId, i.user.id);
        if (rec.coins < amount) return i.reply({ content: `You only have ${fmtC(rec.coins)}. 💀`, flags: MessageFlags.Ephemeral });
        const landed = Math.random() < 0.5 ? 'heads' : 'tails';
        const won = landed === side;
        rec.coins += won ? amount : -amount; dirty = true;
        await i.reply(`🪙 It's **${landed}**! ${won ? `You called it — +${fmtC(amount)}` : `Wrong — -${fmtC(amount)}`} • balance ${fmtC(rec.coins)}`);

      } else if (cmd === 'ship') {
        const a = i.options.getUser('first', true);
        const b = i.options.getUser('second') || i.user;
        const pct = shipScore(a.id, b.id);
        const bar = '❤️'.repeat(Math.round(pct / 10)) + '🖤'.repeat(10 - Math.round(pct / 10));
        const verdict = pct >= 90 ? 'MARRIED. It’s decided. 💍' : pct >= 70 ? 'Okay this actually works?? 👀'
          : pct >= 50 ? 'There’s… something there. Maybe.' : pct >= 30 ? 'Keep it professional. 🤝' : 'Restraining order energy. 🚫';
        await i.reply({ content: `💘 **${a.username}** × **${b.username}**\n${bar} **${pct}%**\n${verdict}`, allowedMentions: { parse: [] } });

      } else if (cmd === 'roast') {
        const target = i.options.getUser('who') || i.user;
        const line = ROASTS[Math.floor(Math.random() * ROASTS.length)];
        await i.reply({ content: `🔥 <@${target.id}> — ${line}`, allowedMentions: { users: [target.id] } });

      } else if (cmd === 'bet') {
        const b = state.bet;
        if (!b || b.status !== 'open') return i.reply({ content: 'No bet is open right now — one opens with every new Gio video. 📈', flags: MessageFlags.Ephemeral });
        if (Date.now() > b.closesAt) return i.reply({ content: `Betting closed — resolution <t:${Math.floor(b.resolvesAt / 1000)}:R>. 🤞`, flags: MessageFlags.Ephemeral });
        if (b.wagers[i.user.id]) return i.reply({ content: `You're already in: **${b.wagers[i.user.id].side}** for ${fmtC(b.wagers[i.user.id].amt)}.`, flags: MessageFlags.Ephemeral });
        const side = i.options.getString('side', true);
        const amt = i.options.getInteger('amount', true);
        const rec = coinRec(i.guildId, i.user.id);
        if (rec.coins < amt) return i.reply({ content: `You only have ${fmtC(rec.coins)}. 💀`, flags: MessageFlags.Ephemeral });
        rec.coins -= amt;
        b.wagers[i.user.id] = { side, amt };
        dirty = true;
        await i.reply(`📈 Locked in: **${side.toUpperCase()}** ${b.line.toLocaleString()} views for ${fmtC(amt)}. Resolves <t:${Math.floor(b.resolvesAt / 1000)}:R>. 🤞`);

      } else if (cmd === 'setcode') {
        const code = i.options.getString('code', true).toLowerCase().trim();
        const max = i.options.getInteger('max') || 10;
        state.secret = { code, max, claimed: [] };
        dirty = true;
        await i.reply({ content: `🗝️ Secret code armed: \`${code}\` — first **${max}** to type it anywhere get the CODEBREAKER role, the vault, and 500 🪙. Their message self-destructs.`, flags: MessageFlags.Ephemeral });

      } else if (cmd === 'report') {
        const what = i.options.getString('what', true);
        const who = i.options.getUser('who');
        const reportText =
          `🚨 **New report**\n` +
          `**From:** ${i.user.tag} (<@${i.user.id}>)\n` +
          (who ? `**About:** ${who.tag} (<@${who.id}>)\n` : '') +
          `**Where:** ${i.channel}\n` +
          `**What:** ${what}\n` +
          `-# <t:${Math.floor(Date.now() / 1000)}:f>`;
        let delivered = false;
        // straight to the founder's DMs
        try {
          const founder = await client.users.fetch(FOUNDER);
          await founder.send({ content: reportText, allowedMentions: { parse: [] } });
          delivered = true;
        } catch (e) { log('report DM failed: ' + e.message); }
        // mirror to mod-logs so it's never lost
        try {
          const logsCh = i.guild.channels.cache.find((c) => c.name.includes('mod-logs'));
          if (logsCh) { await logsCh.send({ content: reportText, allowedMentions: { parse: [] } }); delivered = true; }
        } catch {}
        await i.reply({
          content: delivered
            ? '✅ Report sent privately to the admins. Thank you for keeping the server safe — nobody else can see this.'
            : '⚠️ Could not deliver your report right now — please DM a mod directly.',
          flags: MessageFlags.Ephemeral,
        });

      } else if (cmd === 'antinuke') {
        const me = await i.guild.members.fetchMe();
        const myPos = me.roles.highest.position;
        const above = i.guild.roles.cache.filter((r) => r.position > myPos && r.id !== i.guild.id && !r.managed);
        const rules = Object.values(ANTINUKE)
          .map((r) => `> ${r.max}+ ${r.label} in ${Math.round(r.windowMs / 1000)}s`)
          .join('\n');
        const recent = (state.nuke || []).slice(-3).reverse()
          .map((n) => `> ${n.at.slice(0, 16).replace('T', ' ')} — <@${n.user}>: ${n.count} ${n.action}`)
          .join('\n');
        await i.reply({
          content: `🛡️ **Anti-nuke: ACTIVE**\n\n**Triggers (auto-quarantine):**\n${rules}\n\n` +
            `**Exempt:** server owner (Discord won't let bots act on them)${NUKE_WHITELIST.length ? `, ${NUKE_WHITELIST.length} whitelisted` : ''}\n` +
            `**Can protect against:** ${above.size === 0 ? 'everyone below owner ✅' : `⚠️ **not** ${above.map((r) => r.name).join(', ')} — those roles are above mine, move **Gio Bot** higher in Server Settings → Roles`}\n\n` +
            (recent ? `**Recent incidents:**\n${recent}` : '**Recent incidents:** none 🎉'),
          allowedMentions: { parse: [] },
          flags: MessageFlags.Ephemeral,
        });

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
    new SlashCommandBuilder().setName('invites').setDescription('Who has invited the most people'),
    new SlashCommandBuilder().setName('antinuke').setDescription('Anti-nuke protection status (admins only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('report').setDescription('Privately report something to the admins')
      .addStringOption((o) => o.setName('what').setDescription('What happened?').setRequired(true).setMaxLength(1000))
      .addUserOption((o) => o.setName('who').setDescription('Who is this about? (optional)')),
    new SlashCommandBuilder().setName('daily').setDescription('Claim your daily Gio Coins (streaks pay more)'),
    new SlashCommandBuilder().setName('coins').setDescription('Check a coin balance')
      .addUserOption((o) => o.setName('user').setDescription('Whose balance?')),
    new SlashCommandBuilder().setName('rich').setDescription('Richest members leaderboard'),
    new SlashCommandBuilder().setName('slots').setDescription('Spin the slots 🎰')
      .addIntegerOption((o) => o.setName('amount').setDescription('Bet (10-5000)').setRequired(true).setMinValue(10).setMaxValue(5000)),
    new SlashCommandBuilder().setName('flip').setDescription('Coin flip — double or nothing')
      .addStringOption((o) => o.setName('side').setDescription('Your call').setRequired(true)
        .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' }))
      .addIntegerOption((o) => o.setName('amount').setDescription('Bet (10-5000)').setRequired(true).setMinValue(10).setMaxValue(5000)),
    new SlashCommandBuilder().setName('ship').setDescription('Ship two people 💘')
      .addUserOption((o) => o.setName('first').setDescription('First person').setRequired(true))
      .addUserOption((o) => o.setName('second').setDescription('Second person (default: you)')),
    new SlashCommandBuilder().setName('roast').setDescription('Get someone roasted by Gio Bot')
      .addUserOption((o) => o.setName('who').setDescription('The victim (default: you)')),
    new SlashCommandBuilder().setName('bet').setDescription("Bet on Gio's latest video views 📈")
      .addStringOption((o) => o.setName('side').setDescription('Over or under the line?').setRequired(true)
        .addChoices({ name: 'Over', value: 'over' }, { name: 'Under', value: 'under' }))
      .addIntegerOption((o) => o.setName('amount').setDescription('Coins to stake (10-5000)').setRequired(true).setMinValue(10).setMaxValue(5000)),
    new SlashCommandBuilder().setName('setcode').setDescription('Set the secret vault code (admins only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((o) => o.setName('code').setDescription('The secret word/phrase').setRequired(true).setMaxLength(50))
      .addIntegerOption((o) => o.setName('max').setDescription('How many people can claim it (default 10)').setMinValue(1).setMaxValue(100)),
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
