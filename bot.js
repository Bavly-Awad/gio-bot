// Gio Bot — presence, community features, XP/leveling, economy of engagement.
// Persistence: state.json attachment in a hidden #🗄️-bot-data channel (survives Render restarts).
const path = require('node:path');
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch {}
const fs = require('node:fs');
const http = require('node:http');
const {
  Client, GatewayIntentBits, ActivityType, REST, Routes,
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits, ChannelType,
  Events, AuditLogEvent,
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
const LEVEL_REWARDS = { 5: 'Regular', 10: 'OG Fan', 25: 'Legend', 50: 'Day One' }; // level -> role name fragment

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
// How long to hold out for the exact video link before announcing with a profile link.
// Time-based, not run-based, so it can't drift with polling frequency.
const FEED_LAG_MS = 20 * 60 * 1000;

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
  if (haveCount && s.tiktokCount == null) { s.tiktokCount = count; dirty = true; }
  if (haveCount && count <= s.tiktokCount) {
    if (count < s.tiktokCount) { s.tiktokCount = count; dirty = true; }
    return;
  }

  const list = await tiktokFeed();
  const ping = `<@&${SOCIAL.role.video}>`;

  const profileFallback = async () => {
    const n = haveCount ? count - s.tiktokCount : 1;
    const ok = await announce(client, SOCIAL.ch.tiktok,
      `${ping} 🎵 **Gio just dropped ${n > 1 ? `${n} new TikToks` : 'a new TikTok'}!**\nhttps://www.tiktok.com/@${SOCIAL.tiktok}`,
      SOCIAL.role.video);
    if (ok) { if (haveCount) s.tiktokCount = count; s.tiktokWaitSince = null; dirty = true; log('tiktok: announced (profile link)'); }
  };

  if (!list) {
    if (haveCount && count > s.tiktokCount) {
      s.tiktokWaitSince = s.tiktokWaitSince || Date.now();
      if (Date.now() - s.tiktokWaitSince > FEED_LAG_MS) await profileFallback();
      dirty = true;
    }
    return;
  }

  const idx = s.tiktokLast ? list.findIndex((v) => v.id === s.tiktokLast) : -1;
  if (!s.tiktokLast) { s.tiktokLast = list[0].id; if (haveCount) s.tiktokCount = count; dirty = true; return; }

  if (idx === 0) {
    // Feed hasn't caught up yet. Never advance tiktokCount here: doing so would
    // suppress the alert forever once the feed refreshes.
    if (haveCount && count > s.tiktokCount) {
      s.tiktokWaitSince = s.tiktokWaitSince || Date.now();
      dirty = true;
      const waited = Math.round((Date.now() - s.tiktokWaitSince) / 60000);
      if (Date.now() - s.tiktokWaitSince > FEED_LAG_MS) { log(`tiktok: feed stale ${waited}m — falling back to profile link`); await profileFallback(); }
      else log(`tiktok: videoCount=${count} but feed stale (${waited}m) — holding for exact link`);
    }
    return;
  }

  const fresh = (idx === -1 ? [list[0]] : list.slice(0, idx)).reverse();
  for (const v of fresh) {
    const ok = await announce(client, SOCIAL.ch.tiktok,
      `${ping} 🎵 **Gio just dropped a new TikTok!**\n${v.title ? `> ${v.title}\n` : ''}${v.url}`,
      SOCIAL.role.video);
    if (!ok) return; // retry next tick, state untouched
    log(`tiktok: posted ${v.id}`);
    s.tiktokLast = v.id;
    dirty = true;
  }
  s.tiktokWaitSince = null;
  if (haveCount) s.tiktokCount = count;
  dirty = true;
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
    if (t === null) return;
    const v = t.trim();
    if (/^\d+\s+(second|minute|hour|day)/i.test(v)) live = true;
    else if (/is offline/i.test(v)) live = false;
    else return; // unknown — never guess a live ping
  }
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
  if (!xml || !xml.includes('<feed')) return;
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
const NUKE_WHITELIST = (process.env.ANTINUKE_WHITELIST || '').split(',').map((s) => s.trim()).filter(Boolean);
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
  GatewayIntentBits.GuildModeration, // required for audit-log events (anti-nuke)
  GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildInvites,
];
const BASIC_INTENTS = [
  GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildInvites, GatewayIntentBits.GuildModeration,
];
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
    for (const gid of GUILDS) {
      const guild = await client.guilds.fetch(gid).catch(() => null);
      if (guild) await cacheInvites(guild);
    }
    const tick = () => { growthTick(client); qotdTick(client); hangoutTick(client); saveState(); };
    tick(); setInterval(tick, 5 * 60 * 1000);

    // Social alerts get their own, faster timer — this is the latency users actually feel.
    const social = () => socialTick(client).then(saveState);
    social(); setInterval(social, 3 * 60 * 1000);
  });

  client.on('inviteCreate', (inv) => {
    if (inv.guild) cacheInvites(inv.guild);
  });

  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    if (GUILDS.includes(guild.id)) onAuditEntry(entry, guild, client);
  });

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
    } catch (e) { log('messageCreate error: ' + e.message); }
  });

  client.on('guildMemberAdd', async (member) => {
    try {
      if (!GUILDS.includes(member.guild.id)) return;
      const autoRole = member.guild.roles.cache.find((r) => r.name === AUTO_ROLE);
      if (autoRole) await member.roles.add(autoRole).catch((e) => log('autorole error: ' + e.message));
      await attributeJoin(member);
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
