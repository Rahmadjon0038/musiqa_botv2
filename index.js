require('dotenv').config();

const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  pool,
  initDb,
  getMediaCache,
  upsertMediaCache,
  getSearchCache,
  upsertSearchCache,
  getQueryBest,
  upsertQueryBest,
  putActionToken,
  getActionToken,
  deleteExpiredActionTokens
} = require('./config/db');
const {
  downloadAllMedia,
  searchYouTube,
  downloadYouTubeMp3,
  getYouTubeQualityOptions,
  downloadYouTubeVideoByQuality,
  downloadYouTubeAudioByQuality,
  recognizeSongFromAudioUrl
} = require('./controllers/apiController');

const PORT = Number(process.env.PORT || 3000);

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN is not set');
}

const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'telegram-media-bot' });
});

const bot = new Telegraf(process.env.BOT_TOKEN);

const BRAND_FOOTER = '🤖 @Navobot_bot birinchi raqamli yuklovchi bot';
const MAX_TELEGRAM_UPLOAD_BYTES = Number(process.env.MAX_TELEGRAM_UPLOAD_BYTES || 49 * 1024 * 1024);
const STORAGE_CHAT_ID = process.env.STORAGE_CHAT_ID || process.env.STORAGE_CHANNEL_ID || null;
const MUSIC_CHAT_ID = process.env.MUSIC_CHAT_ID || process.env.MUSIC_CHANNEL_ID || null;
let BOT_USERNAME = process.env.BOT_USERNAME || null;
let BOT_ID = process.env.BOT_ID ? Number(process.env.BOT_ID) : null;
const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n));

const ENABLE_BROADCAST = ['1', 'true', 'yes', 'on'].includes(String(process.env.ENABLE_BROADCAST || '').toLowerCase());

const adminState = new Map(); // telegram_id -> { mode: 'broadcast' }

function isCancelBroadcastText(text) {
  const t = String(text || '').trim().toLowerCase();
  return t === '/cancel' || t === 'cancel' || t === 'bekor' || t === 'bekor qilish' || t === '❌ bekor qilish';
}

function sha1(text) {
  return crypto.createHash('sha1').update(String(text || ''), 'utf8').digest('hex');
}

function buildStorageCaption(kind, meta) {
  const m = meta && typeof meta === 'object' ? meta : null;
  const title = (m?.title || '').toString().trim() || null;
  const originalUrl = (m?.originalUrl || '').toString().trim() || null;
  const header = title
    ? `🎬 ${title}`
    : kind === 'audio'
      ? '🎵 Audio'
      : kind === 'video'
        ? '🎥 Video'
        : '📦 Media';

  // Keep it simple and Telegram-friendly (caption limit is ~1024 chars for most media types).
  let text = [header, originalUrl, '', BRAND_FOOTER].filter(Boolean).join('\n');
  if (text.length > 1024) text = text.slice(0, 1020) + '…';
  return text;
}

function buildMusicCaption(meta, fallbackTitle = null) {
  const m = meta && typeof meta === 'object' ? meta : null;
  const title =
    (m?.title || '').toString().trim() ||
    (fallbackTitle || '').toString().trim() ||
    '';
  // Keep it short; captions for audio are limited.
  let text = title || '🎵 Audio';
  if (text.length > 1024) text = text.slice(0, 1020) + '…';
  return text;
}

function makeUrlCacheKey(kind, url) {
  return `url:${kind}:${sha1(String(url || '').trim().toLowerCase())}`;
}

function makeYouTubeVideoCacheKey(videoId, quality) {
  return `yt:video:${videoId}:${quality}`;
}

function makeYouTubeAudioCacheKey(videoId, quality) {
  return `yt:audio:${videoId}:${quality}`;
}

function makeYouTubeMp3CacheKey(videoId) {
  return `yt:mp3:${videoId}`;
}

function makeSearchQueryKey(query, provider = 'youtube') {
  return `search:${provider}:${sha1(String(query || '').trim().toLowerCase())}`;
}

async function searchYouTubeCached(query) {
  const queryKey = makeSearchQueryKey(query, 'youtube');
  const maxAgeMs = Number(process.env.SEARCH_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
  try {
    const cached = await getSearchCache(queryKey, maxAgeMs);
    if (cached?.results) {
      return { results: cached.results, total: cached.total || null, cached: true };
    }
  } catch (e) {
    console.error('search cache read failed:', e?.message || e);
  }

  const fresh = await searchYouTube(query);
  try {
    await upsertSearchCache({
      queryKey,
      queryText: query,
      provider: 'youtube',
      results: fresh.results || [],
      total: fresh.total || null
    });
  } catch (e) {
    console.error('search cache write failed:', e?.message || e);
  }
  return { results: fresh.results, total: fresh.total, cached: false };
}

async function trySendBestMp3ForQuery(ctx, query) {
  const queryKey = makeSearchQueryKey(query, 'youtube');
  try {
    const best = await getQueryBest(queryKey);
    const bestId = best?.best_id;
    if (!bestId) return false;

    const mp3Cache = await getMediaCache(makeYouTubeMp3CacheKey(bestId));
    if (mp3Cache?.file_id) {
      const caption = [query, '', BRAND_FOOTER].join('\n');
      return await trySendTelegramMediaByFileId(ctx, 'audio', mp3Cache.file_id, caption);
    }
  } catch (e) {
    console.error('trySendBestMp3ForQuery failed:', e?.message || e);
  }
  return false;
}

// Short-lived in-memory cache for callback actions:
// token -> { kind: 'video'|'audio'|'identify'|'search'|'recognize', url, fallbackUrl?, createdAt, ... }
const actionCache = new Map();
const ACTION_TTL_MS = Number(process.env.ACTION_TTL_MS || 6 * 60 * 60 * 1000);

function persistActionToken(token, payload) {
  const expiresAt = new Date(Date.now() + ACTION_TTL_MS);
  putActionToken({ token, payload: { ...payload, createdAt: Date.now() }, expiresAt }).catch((e) => {
    console.error('persistActionToken failed:', e?.message || e);
  });
}

function putAction(payload) {
  const token = crypto.randomUUID();
  actionCache.set(token, { ...payload, createdAt: Date.now() });
  persistActionToken(token, payload);
  return token;
}

async function getAction(token) {
  const entry = actionCache.get(token);
  if (entry) {
    if (Date.now() - entry.createdAt > ACTION_TTL_MS) {
      actionCache.delete(token);
      return null;
    }
    return entry;
  }

  try {
    const row = await getActionToken(token);
    const payload = row?.payload || null;
    if (!payload) return null;
    const createdAt = Number(payload.createdAt || 0);
    if (!createdAt || Date.now() - createdAt > ACTION_TTL_MS) return null;
    actionCache.set(token, payload);
    return payload;
  } catch (e) {
    console.error('getActionToken failed:', e?.message || e);
    return null;
  }
}

function cleanupActions() {
  const now = Date.now();
  for (const [token, entry] of actionCache.entries()) {
    if (now - entry.createdAt > ACTION_TTL_MS) actionCache.delete(token);
  }
}
setInterval(cleanupActions, 60_000).unref();
setInterval(() => {
  deleteExpiredActionTokens().catch(() => {});
}, 10 * 60_000).unref();

// Prevent double-press spam on inline buttons.
const inflightActions = new Set();
function inflightKey(ctx, token) {
  return `${ctx.from?.id || '0'}:${token}`;
}

const LOADER_FRAMES = ['⏳', '⌛️', '⏳', '⌛️'];
async function startLoader(ctx, baseText) {
  let stopped = false;
  let msg;
  try {
    msg = await ctx.reply(`${LOADER_FRAMES[0]} ${baseText}`);
  } catch {
    return { stop: async () => {}, messageId: null };
  }

  const chatId = ctx.chat?.id;
  const messageId = msg?.message_id;
  if (!chatId || !messageId) return { stop: async () => {}, messageId: null };

  let i = 0;
  const intervalMs = Number(process.env.LOADER_INTERVAL_MS || 1200);
  const timer = setInterval(async () => {
    if (stopped) return;
    i = (i + 1) % LOADER_FRAMES.length;
    try {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, `${LOADER_FRAMES[i]} ${baseText}`);
    } catch {
      // ignore edit errors (message deleted, rate limits, etc.)
    }
  }, intervalMs);
  timer.unref?.();

  return {
    messageId,
    stop: async (finalText = null, remove = true) => {
      stopped = true;
      clearInterval(timer);
      try {
        if (finalText) {
          await ctx.telegram.editMessageText(chatId, messageId, undefined, finalText);
        } else if (remove) {
          await ctx.telegram.deleteMessage(chatId, messageId);
        }
      } catch {
        // ignore
      }
    }
  };
}

const SUPPORTED_URL_REGEX =
  /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|instagram\.com|tiktok\.com)\/\S+/i;

function normalizeUrl(text) {
  const t = (text || '').trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (SUPPORTED_URL_REGEX.test(t)) return `https://${t}`;
  return null;
}

function isSupportedUrl(text) {
  return Boolean(normalizeUrl(text));
}

function isGroupChat(ctx) {
  const t = ctx.chat?.type;
  return t === 'group' || t === 'supergroup';
}

function isReplyToBot(ctx) {
  const from = ctx.message?.reply_to_message?.from;
  if (!from) return false;
  if (BOT_ID && from.id === BOT_ID) return true;
  if (BOT_USERNAME && from.username && String(from.username).toLowerCase() === String(BOT_USERNAME).toLowerCase()) {
    return true;
  }
  return false;
}

function mentionsBot(text) {
  if (!BOT_USERNAME) return false;
  const t = String(text || '');
  return new RegExp(`\\B@${BOT_USERNAME}\\b`, 'i').test(t);
}

function isAdmin(ctx) {
  const id = ctx.from?.id;
  return Boolean(id && ADMIN_IDS.includes(Number(id)));
}

async function adminPanel(ctx) {
  const rows = [[Markup.button.callback('📊 Statistika', 'adm:stats')]];
  if (ENABLE_BROADCAST) {
    rows.push([Markup.button.callback('📣 Reklama yuborish', 'adm:bcast')]);
    rows.push([Markup.button.callback('🗑 Oxirgi reklama (o‘chirish)', 'adm:del_last')]);
  }
  await ctx.reply(
    '🔐 Admin panel',
    Markup.inlineKeyboard(rows, { columns: 1 })
  );
}

function adminStaticKeyboard() {
  const rows = ENABLE_BROADCAST
    ? [['📊 Statistika', '📣 Reklama'], ['🗑 Oxirgi reklama']]
    : [['📊 Statistika']];
  return Markup.keyboard(rows)
    .resize()
    .oneTime(false);
}

function adminBroadcastCancelKeyboard() {
  return Markup.keyboard([['❌ Bekor qilish']]).resize().oneTime(false);
}

async function handleAdminStats(ctx) {
  try {
    const users = await pool.query('SELECT COUNT(*)::bigint AS n FROM users');
    const mediaCache = await pool.query('SELECT COUNT(*)::bigint AS n FROM media_cache');
    const searchCache = await pool.query('SELECT COUNT(*)::bigint AS n FROM search_cache');
    const broadcasts = await pool.query('SELECT COUNT(*)::bigint AS n FROM broadcasts');
    const mediaN = Number(mediaCache.rows?.[0]?.n || 0);
    const searchN = Number(searchCache.rows?.[0]?.n || 0);
    const text = [
      '📊 Statistika',
      '',
      `👤 Foydalanuvchilar: ${users.rows?.[0]?.n || 0}`,
      mediaN ? `🎞️ Baza (saqlangan media): ${mediaN}` : null,
      searchN ? `🔎 Baza (saqlangan qidiruvlar): ${searchN}` : null,
      `📣 Reklamalar: ${broadcasts.rows?.[0]?.n || 0}`
    ]
      .filter(Boolean)
      .join('\n');
    await ctx.reply(text);
  } catch (e) {
    console.error('admin stats failed:', e?.message || e);
    await ctx.reply('Statistika olishda xatolik bo‘ldi.');
  }
}

async function handleAdminBroadcastStart(ctx) {
  adminState.set(ctx.from.id, { mode: 'broadcast' });
  await ctx.reply(
    "Reklama matnini yuboring (keyingi xabaringiz hamma foydalanuvchilarga ketadi).\n\nBekor qilish uchun: /cancel yoki \"❌ Bekor qilish\" ni bosing.",
    adminBroadcastCancelKeyboard()
  );
}

async function handleAdminBroadcastCancel(ctx) {
  if (ctx.chat?.type !== 'private' || !isAdmin(ctx)) return false;
  const st = adminState.get(ctx.from?.id);
  if (!st?.mode) return false;
  adminState.delete(ctx.from.id);
  await ctx.reply('Bekor qilindi.', adminStaticKeyboard());
  return true;
}

async function handleAdminDeleteLastBroadcast(ctx) {
  const status = await startLoader(ctx, 'Oxirgi reklamani o‘chiryapman…');
  try {
    const last = await pool.query(
      `SELECT id, text FROM broadcasts
       WHERE deleted_at IS NULL
       ORDER BY id DESC
       LIMIT 1`
    );
    const row = last.rows?.[0];
    if (!row?.id) {
      await status.stop(null, true);
      await ctx.reply('O‘chirish uchun reklama topilmadi.');
      return;
    }

    const msgs = await pool.query(
      `SELECT telegram_id, message_id
       FROM broadcast_messages
       WHERE broadcast_id = $1`,
      [row.id]
    );

    let ok = 0;
    let fail = 0;
    for (const r of msgs.rows) {
      const chatId = Number(r.telegram_id);
      const messageId = Number(r.message_id);
      if (!chatId || !messageId) continue;
      try {
        await ctx.telegram.deleteMessage(chatId, messageId);
        ok++;
      } catch {
        fail++;
      }
      await new Promise((res) => setTimeout(res, 40));
    }

    await pool.query('UPDATE broadcasts SET deleted_at = NOW() WHERE id = $1', [row.id]);
    await status.stop(null, true);
    await ctx.reply(`🗑 O‘chirildi: ${ok}\n❌ O‘chmadi: ${fail}`);
  } catch (e) {
    await status.stop(null, true);
    console.error('delete last broadcast failed:', e?.message || e);
    await ctx.reply('Reklamani o‘chirishda xatolik bo‘ldi.');
  }
}

async function handleAdminBroadcastMessage(ctx) {
  const st = adminState.get(ctx.from?.id);
  if (ctx.chat?.type !== 'private' || !isAdmin(ctx) || st?.mode !== 'broadcast') return false;

  adminState.delete(ctx.from.id);
  const status = await startLoader(ctx, 'Reklama yuborilyapti…');
  try {
    const adFooter = process.env.AD_FOOTER || BRAND_FOOTER;
    const hasTextOnly = Boolean(ctx.message?.text);
    const rawText = (ctx.message?.text || '').trim();
    const broadcastText = hasTextOnly ? `${rawText}\n\n${adFooter}` : rawText;

    const created = await pool.query(
      'INSERT INTO broadcasts (created_by, text) VALUES ($1, $2) RETURNING id',
      [ctx.from.id, hasTextOnly ? broadcastText : '[media]']
    );
    const broadcastId = created.rows?.[0]?.id;

    const res = await pool.query('SELECT telegram_id FROM users');
    const ids = res.rows.map((r) => Number(r.telegram_id)).filter(Boolean);
    if (!ids.length) {
      await status.stop(null, true);
      await ctx.reply("Hali foydalanuvchilar yo‘q (users jadvali bo‘sh). Avval foydalanuvchilar botga /start bosishi kerak.");
      return true;
    }

    let ok = 0;
    let fail = 0;
    for (const id of ids) {
      try {
        if (hasTextOnly) {
          const sent = await ctx.telegram.sendMessage(id, broadcastText);
          if (broadcastId && sent?.message_id) {
            await pool.query(
              'INSERT INTO broadcast_messages (broadcast_id, telegram_id, message_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
              [broadcastId, id, sent.message_id]
            );
          }
        } else {
          const captionBase = String(ctx.message?.caption || '').trim();
          let caption = [captionBase, adFooter].filter(Boolean).join('\n\n');
          if (caption.length > 1024) caption = caption.slice(0, 1020) + '…';

          let sent;
          if (ctx.message?.video?.file_id) {
            sent = await ctx.telegram.sendVideo(id, ctx.message.video.file_id, { caption });
          } else if (Array.isArray(ctx.message?.photo) && ctx.message.photo.length) {
            const best = ctx.message.photo[ctx.message.photo.length - 1];
            sent = await ctx.telegram.sendPhoto(id, best.file_id, { caption });
          } else if (ctx.message?.animation?.file_id) {
            sent = await ctx.telegram.sendAnimation(id, ctx.message.animation.file_id, { caption });
          } else if (ctx.message?.document?.file_id) {
            sent = await ctx.telegram.sendDocument(id, ctx.message.document.file_id, { caption });
          } else {
            // Fallback: unknown message type, copy as-is and send footer separately.
            const copied = await ctx.telegram.copyMessage(id, ctx.chat.id, ctx.message.message_id);
            sent = copied;
            await ctx.telegram.sendMessage(id, adFooter);
          }

          if (broadcastId && sent?.message_id) {
            await pool.query(
              'INSERT INTO broadcast_messages (broadcast_id, telegram_id, message_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
              [broadcastId, id, sent.message_id]
            );
          }
        }
        ok++;
      } catch {
        fail++;
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    await status.stop(null, true);
    await ctx.reply(`✅ Yuborildi: ${ok}\n❌ Xato: ${fail}`);
  } catch (e) {
    await status.stop(null, true);
    console.error('broadcast failed:', e?.message || e);
    await ctx.reply('Reklama yuborishda xatolik bo‘ldi.');
  }
  return true;
}

bot.start(async (ctx) => {
  try {
    const telegramId = ctx.from?.id;
    const username = ctx.from?.username || null;
    const firstName = ctx.from?.first_name || null;

    if (telegramId) {
      await pool.query(
        `
        INSERT INTO users (telegram_id, username, first_name)
        VALUES ($1, $2, $3)
        ON CONFLICT (telegram_id) DO NOTHING
      `,
        [telegramId, username, firstName]
      );
    }
  } catch (err) {
    console.error('DB insert on /start failed:', err?.message || err);
  }

  const welcomeText = [
    'Salom men Navobotman!',
    '',
    '✅ Mening xususiyatlarim bilan tanishing:',
    '',
    ' • Qo‘shiq matni, nomi yoki ijrochi ismi orqali musiqa topaman',
    '',
    ' • Instagram, Youtube va Tik-Tokdan video va undagi musiqani yuklab beraman'
  ].join('\n');

  if (ctx.chat?.type === 'private' && isAdmin(ctx)) {
    await ctx.reply(welcomeText, adminStaticKeyboard());
    return;
  }

  await ctx.reply(
    [
      'Salom men Navobotman!',
      '',
      '✅ Mening xususiyatlarim bilan tanishing:',
      '',
      ' • Qo‘shiq matni, nomi yoki ijrochi ismi orqali musiqa topaman',
      '',
      ' • Instagram, Youtube va Tik-Tokdan video va undagi musiqani yuklab beraman'
    ].join('\n')
  );
});

// Never crash the process on Telegram callback/query errors.
bot.catch((err, ctx) => {
  const updateType = ctx?.updateType || 'unknown';
  console.error(`Telegraf error (${updateType}):`, err?.response?.description || err?.message || err);
});

bot.command('storageid', async (ctx) => {
  await ctx.reply(
    [
      "Storage kanal ID sini olishning 2 ta yo‘li bor:",
      "1) Kanaldan istalgan postni botga FORWARD qiling (kanalda 'Protect content' yoqilmagan bo‘lishi kerak).",
      "2) Botni kanalda admin qiling va kanalda 'test' post yozing — bot logida kanal ID chiqadi.",
      "",
      "Keyin `.env` ga qo‘shasiz: STORAGE_CHAT_ID=-100..."
    ].join('\n')
  );
});

bot.command('musicid', async (ctx) => {
  await ctx.reply(
    [
      "Music (audio arxiv) kanal ID sini olish:",
      "1) Kanaldan istalgan postni botga FORWARD qiling (kanalda 'Protect content' yoqilmagan bo‘lsin).",
      "2) Botni kanalda admin qiling va kanalda 'test' post yozing — bot logida kanal ID chiqadi.",
      "",
      "Keyin `.env` ga qo‘shasiz: MUSIC_CHAT_ID=-100..."
    ].join('\n')
  );
});

bot.command('myid', async (ctx) => {
  const id = ctx.from?.id;
  const username = ctx.from?.username || null;
  const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || null;
  console.log('myid:', { id: id || null, username, name });
  if (!id) {
    await ctx.reply('ID topilmadi.');
    return;
  }
  await ctx.reply(`Sizning Telegram ID: ${id}`);
});

bot.command('whois', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const reply = ctx.message?.reply_to_message;
  const u = reply?.from;
  if (!u?.id) {
    await ctx.reply('Biror foydalanuvchi xabariga reply qilib `/whois` yozing.', { parse_mode: 'Markdown' });
    return;
  }
  console.log('whois:', { id: u.id, username: u.username || null, name: [u.first_name, u.last_name].filter(Boolean).join(' ') || null });
  await ctx.reply(`Telegram ID: ${u.id}\nUsername: ${u.username ? '@' + u.username : '-'}`);
});

bot.command('admin', async (ctx) => {
  console.log('admin command:', { from: ctx.from?.id || null, isAdmin: isAdmin(ctx) });
  if (!isAdmin(ctx)) {
    await ctx.reply('Bu buyruq faqat adminlar uchun.');
    return;
  }
  await adminPanel(ctx);
});

bot.action('adm:stats', async (ctx) => {
  if (!isAdmin(ctx)) return;
  try {
    await ctx.answerCbQuery('Yig‘ilyapti…');
  } catch {}
  await handleAdminStats(ctx);
});

bot.action('adm:bcast', async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (!ENABLE_BROADCAST) {
    try {
      await ctx.answerCbQuery('O‘chirilgan');
    } catch {}
    return;
  }
  try {
    await ctx.answerCbQuery('OK');
  } catch {}
  await handleAdminBroadcastStart(ctx);
});

bot.action('adm:del_last', async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (!ENABLE_BROADCAST) {
    try {
      await ctx.answerCbQuery('O‘chirilgan');
    } catch {}
    return;
  }
  try {
    await ctx.answerCbQuery('OK');
  } catch {}
  await handleAdminDeleteLastBroadcast(ctx);
});

bot.use(async (ctx, next) => {
  // Admin broadcast mode should accept any message type (text/photo/video/etc) in private chat.
  try {
    if (ENABLE_BROADCAST) {
      const text = ctx.message?.text;
      if (isCancelBroadcastText(text)) {
        const cancelled = await handleAdminBroadcastCancel(ctx);
        if (cancelled) return;
      }
      const handled = await handleAdminBroadcastMessage(ctx);
      if (handled) return;
    }
  } catch (e) {
    console.error('broadcast middleware failed:', e?.message || e);
  }

  const msg = ctx.message;
  const forwarded = msg?.forward_from_chat;
  if (forwarded?.type === 'channel' && forwarded?.id) {
    await ctx.reply(
      `Forward qilingan kanal ID: ${forwarded.id}\n.env ga qo‘shing: STORAGE_CHAT_ID=${forwarded.id} yoki MUSIC_CHAT_ID=${forwarded.id}`
    );
    return;
  }
  return next();
});

bot.on('channel_post', async (ctx) => {
  const chatId = ctx.chat?.id;
  const title = ctx.chat?.title;
  if (chatId) {
    console.log('CHANNEL_POST chat.id:', chatId, 'title:', title || null);
  }
});

bot.on('my_chat_member', async (ctx) => {
  const chat = ctx.chat;
  if (!chat?.id) return;
  const newStatus = ctx.update?.my_chat_member?.new_chat_member?.status || null;
  const oldStatus = ctx.update?.my_chat_member?.old_chat_member?.status || null;
  console.log('MY_CHAT_MEMBER:', {
    chatId: chat.id,
    type: chat.type || null,
    title: chat.title || null,
    username: chat.username || null,
    oldStatus,
    newStatus
  });
});

bot.on('text', async (ctx) => {
  const text = (ctx.message?.text || '').trim();
  if (!text) return;

  // Admin static menu (private only)
  if (ctx.chat?.type === 'private' && isAdmin(ctx)) {
    if (text === '📊 Statistika') {
      await handleAdminStats(ctx);
      return;
    }
    if (ENABLE_BROADCAST) {
      if (text === '📣 Reklama') {
        await handleAdminBroadcastStart(ctx);
        return;
      }
      if (text === '🗑 Oxirgi reklama') {
        await handleAdminDeleteLastBroadcast(ctx);
        return;
      }
    }
  }

  // In groups, avoid responding to every message:
  // - Always allow supported URLs
  // - Allow commands (/start, /help, etc.)
  // - Allow when user replies to the bot
  // - Allow when bot is mentioned (@BotName)
  if (isGroupChat(ctx)) {
    const isCommand = text.startsWith('/');
    if (!isSupportedUrl(text) && !isCommand && !isReplyToBot(ctx) && !mentionsBot(text)) {
      return;
    }
  }

  if (isSupportedUrl(text)) {
    await handleMediaLink(ctx, normalizeUrl(text));
    return;
  }

  await handleMusicSearch(ctx, text);
});

async function handleMediaLink(ctx, url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const isShort = host.includes('instagram.com') || host.includes('tiktok.com');
    const isYouTube = host.includes('youtube.com') || host.includes('youtu.be');

    // If this exact link was already processed, serve from cache in groups/private chats without hitting APIs.
    if (isShort) {
      const linkKey = makeUrlCacheKey('video', url);
      try {
        const cached = await getMediaCache(linkKey);
        if (cached?.file_id) {
          const cachedMeta = cached?.meta && typeof cached.meta === 'object' ? cached.meta : null;
          const token = putAction({
            kind: 'recognize',
            audioUrl: cachedMeta?.audioUrl || null,
            videoUrl: cachedMeta?.videoUrl || null,
            originalUrl: cachedMeta?.originalUrl || url
          });
          await ctx.replyWithVideo(cached.file_id, {
            caption: BRAND_FOOTER,
            ...Markup.inlineKeyboard([Markup.button.callback("🎵 Qo‘shiqni yuklab olish", `rs:${token}`)], { columns: 1 })
          });
          return;
        }
      } catch (e) {
        console.error('short-link cache read failed:', e?.message || e);
      }
    }

    const loader = await startLoader(ctx, 'Yuklab olish havolalarini topyapman…');
    const { videoUrl, audioUrl, title, raw } = await downloadAllMedia(url);
    await loader.stop(null, true);

    const buttons = [];

    // Instagram/TikTok uchun tugma doim chiqsin: qo‘shiqni aniqlab, variantlarni taklif qiladi.
    // Ba'zi downloaderlar audioUrl bermaydi; shunda videoUrl orqali ham sinab ko‘ramiz.
    if (isShort && (audioUrl || videoUrl)) {
      const token = putAction({
        kind: 'recognize',
        audioUrl: audioUrl || null,
        videoUrl: videoUrl || null
      });
      buttons.push(Markup.button.callback("🎵 Qo‘shiqni yuklab olish", `rs:${token}`));
    } else if (audioUrl) {
      const token = putAction({ kind: 'audio', url: audioUrl, originalUrl: url });
      buttons.push(Markup.button.callback('🎵 Audio ⬇️', `dl:a:${token}`));
    }

    if (isYouTube) {
          const videoId = extractYouTubeId(url);
      if (videoId) {
        try {
          const opts = await getYouTubeQualityOptions(videoId);
          const videoQualities = pickBestPerQuality(opts.video || []).slice(0, 12);
          const audioQualities = opts.audio || [];

          const videoButtons = videoQualities.map((q) => {
            const friendly = q.label && q.label !== q.id ? q.label : labelFromQualityId(q.id);
            const label = `🎬 ${friendly} ⬇️${approxFromBytes(q.size)}`;
            const token = putAction({ kind: 'ytvideo', id: videoId, quality: q.id });
            return Markup.button.callback(label, `yv:${token}`);
          });

          const cleanAudio = audioQualities.filter((a) => a?.id && String(a.id) !== '0');
          const preferredAudio =
            cleanAudio.find((a) => String(a.id) === '251') ||
            cleanAudio.find((a) => String(a.id) === '140') ||
            cleanAudio[0] ||
            null;

          const keyboardRows = [];
          for (const row of chunk(videoButtons, 2)) keyboardRows.push(row);
          if (preferredAudio) {
            const at = putAction({ kind: 'ytaudio2', id: videoId, quality: preferredAudio.id, title: title || null });
            keyboardRows.push([Markup.button.callback("🎵 Audioni yuklab olish", `ya2:${at}`)]);
          }
          // Download MP3 from the same YouTube videoId (fast path).
          const mt = putAction({ kind: 'ytmp3', id: videoId, title: title || null });
          keyboardRows.push([Markup.button.callback("🎵 Musiqani yuklab olish (MP3)", `ym:${mt}`)]);

          if (!keyboardRows.length) {
            await ctx.reply("Bu videoda formatlar topilmadi. Boshqa YouTube link yuboring yoki keyinroq urinib ko‘ring.");
            return;
          }

          const header = title ? `🍿 ${title}` : 'YouTube video';
          const text = [header, url, '', BRAND_FOOTER].filter(Boolean).join('\n');
          await ctx.reply(text, Markup.inlineKeyboard(keyboardRows));
          return;
        } catch (e) {
          console.error('YT quality options failed, falling back:', e?.response?.data || e?.message || e);
        }
      }

      // Fallback: old behavior from universal downloader response.
      const yt = extractYouTubeOptions(raw);
      const videoButtons = buildYouTubeVideoButtons(yt.videos || [], videoUrl || null, url);
      const audioButton = audioUrl
        ? Markup.button.callback(
            "🎵 Audioni yuklab olish",
            `dl:a:${putAction({ kind: 'audio', url: audioUrl, originalUrl: url })}`
          )
        : null;
      const fallbackVideoId = extractYouTubeId(url);
      const mp3Button = fallbackVideoId
        ? Markup.button.callback(
            "🎵 Musiqani yuklab olish (MP3)",
            `ym:${putAction({ kind: 'ytmp3', id: fallbackVideoId, title: title || null })}`
          )
        : null;

      const keyboardRows = [];
      for (const row of chunk(videoButtons, 2)) keyboardRows.push(row);
      if (audioButton) keyboardRows.push([audioButton]);
      if (mp3Button) keyboardRows.push([mp3Button]);

      const header = title ? `🍿 ${title}` : 'YouTube video';
      const text = [header, url, '', BRAND_FOOTER].filter(Boolean).join('\n');
      await ctx.reply(text, Markup.inlineKeyboard(keyboardRows));
      return;
    }

    if (isShort && videoUrl) {
      const caption = BRAND_FOOTER;
      const sent = await ctx.replyWithVideo(videoUrl, {
        caption,
        ...Markup.inlineKeyboard(buttons, { columns: 2 })
      });
      try {
        // Cache both by the original link and by the resolved CDN URL.
        const stored = await maybeCacheAndStore(
          ctx,
          'video',
          makeUrlCacheKey('video', url),
          sent,
          { videoUrl, audioUrl, title: title || null, source: 'short', originalUrl: url }
        );
        if (stored?.fileId) {
          await upsertMediaCache({
            cacheKey: makeUrlCacheKey('video', videoUrl),
            kind: 'video',
            fileId: stored.fileId,
            storageChatId: stored.storageChatId,
            storageMessageId: stored.storageMessageId,
            meta: { videoUrl, audioUrl, title: title || null, source: 'short', originalUrl: url }
          });
        }
      } catch (e) {
        console.error('store short video failed:', e?.message || e);
      }
      return;
    }

    // Default flow: show choice buttons (YouTube va boshqalar).
    if (videoUrl) {
      const token = putAction({ kind: 'video', url: videoUrl, originalUrl: url });
      buttons.unshift(Markup.button.callback('🎥 Video', `dl:v:${token}`));
    }
    const caption = [title ? `Topildi: ${title}` : 'Nimani yuklab olamiz?', '', BRAND_FOOTER].join('\n');
    await ctx.reply(caption, Markup.inlineKeyboard(buttons, { columns: 2 }));
  } catch (err) {
    console.error('handleMediaLink error:', err?.response?.data || err?.message || err);
    const status = err?.response?.status;
    if (status === 429) {
      await ctx.reply("Media API limiti tugadi (429). Keyinroq qayta urinib ko‘ring.");
      return;
    }
    if (status === 403) {
      await ctx.reply("Media API ruxsat bermadi (403). RapidAPI obuna/host sozlamalarini tekshiring.");
      return;
    }
    if (err?.code === 'CONFIG') {
      await ctx.reply(
        "Server sozlamalari yetishmayapti. `.env` da `RAPIDAPI_KEY`, `MEDIA_API_BASEURL`, `MEDIA_API_HOST` ni to‘ldirib, keyin qayta ishga tushiring."
      );
      return;
    }
    await ctx.reply("Media topilmadi. Havola noto‘g‘ri, yopiq (private) yoki muddati o‘tgan bo‘lishi mumkin.");
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function pickFirstString(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = pickFirstString(v);
      if (found) return found;
    }
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) {
      const found = pickFirstString(v);
      if (found) return found;
    }
  }
  return null;
}

function formatDurationSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function extractYouTubeId(inputUrl) {
  try {
    const u = new URL(inputUrl);
    const host = u.hostname.toLowerCase();
    if (host.includes('youtu.be')) {
      const id = u.pathname.replace('/', '').trim();
      return id || null;
    }
    if (host.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;
      // Shorts: /shorts/{id}
      const parts = u.pathname.split('/').filter(Boolean);
      const shortsIdx = parts.indexOf('shorts');
      if (shortsIdx >= 0 && parts[shortsIdx + 1]) return parts[shortsIdx + 1];
    }
  } catch {
    // ignore
  }
  return null;
}

function labelFromQualityId(id) {
  const map = {
    160: '144p',
    133: '240p',
    134: '360p',
    135: '480p',
    136: '720p',
    137: '1080p',
    247: '720p',
    248: '1080p',
    243: '360p',
    244: '480p',
    245: '480p',
    246: '480p',
    249: 'Audio',
    250: 'Audio',
    251: 'Audio',
    140: 'Audio'
  };
  const n = Number(id);
  if (Number.isFinite(n) && map[n]) return map[n];
  return String(id);
}

function approxFromBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  const mb = n / (1024 * 1024);
  return ` ~${Math.round(mb)}MB`;
}

function pickBestPerQuality(list) {
  const byQ = new Map();
  for (const item of list || []) {
    const q = String(item?.label || '').trim();
    if (!q) continue;
    if (!byQ.has(q)) {
      byQ.set(q, item);
      continue;
    }
    const cur = byQ.get(q);
    const curMime = String(cur?.mime || '').toLowerCase();
    const nextMime = String(item?.mime || '').toLowerCase();
    const curScore =
      (curMime.includes('mp4') ? 2 : 0) + (curMime.includes('avc1') ? 2 : 0) + (Number(cur?.size) ? 1 : 0);
    const nextScore =
      (nextMime.includes('mp4') ? 2 : 0) + (nextMime.includes('avc1') ? 2 : 0) + (Number(item?.size) ? 1 : 0);
    if (nextScore > curScore) byQ.set(q, item);
  }

  return [...byQ.entries()]
    .sort((a, b) => {
      const an = Number(a[0].replace(/[^0-9]/g, '')) || 0;
      const bn = Number(b[0].replace(/[^0-9]/g, '')) || 0;
      return an - bn;
    })
    .map(([, v]) => v);
}

function extractYouTubeOptions(raw) {
  // Heuristics across downloader providers.
  const duration =
    formatDurationSeconds(raw?.duration) ||
    formatDurationSeconds(raw?.lengthSeconds) ||
    formatDurationSeconds(raw?.data?.duration) ||
    formatDurationSeconds(raw?.result?.duration) ||
    null;

  const formats =
    raw?.formats ||
    raw?.data?.formats ||
    raw?.result?.formats ||
    raw?.videos ||
    raw?.data?.videos ||
    raw?.result?.videos ||
    raw?.links ||
    raw?.data?.links ||
    raw?.result?.links ||
    [];

  const candidates = [];
  const visited = new Set();

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const it of node) visit(it);
      return;
    }

    const url = node.url || node.link || node.download || node.downloadUrl || node.download_url || null;
    const quality =
      node.quality ||
      node.label ||
      node.resolution ||
      node.res ||
      node.height ||
      node.itag ||
      null;
    const size =
      node.filesize ||
      node.fileSize ||
      node.filesize_bytes ||
      node.contentLength ||
      node.content_length ||
      null;
    const mime = node.mimeType || node.mime_type || node.type || null;

    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      const height =
        typeof node.height === 'number'
          ? node.height
          : typeof quality === 'string'
            ? Number(String(quality).match(/(\d{3,4})p/i)?.[1])
            : typeof quality === 'number'
              ? quality
              : null;

      candidates.push({ url, height: Number.isFinite(height) ? height : null, size, mime });
    }

    for (const v of Object.values(node)) visit(v);
  }

  visit(formats);
  // Some providers don't expose formats cleanly; keep a wider scan as fallback.
  visit(raw);

  const videos = [];
  // Prefer likely-direct media URLs first.
  const scored = candidates
    .map((c) => ({
      ...c,
      score:
        (c.url.includes('googlevideo.com') ? 5 : 0) +
        (c.url.includes('.mp4') ? 2 : 0) +
        (c.mime && String(c.mime).includes('video') ? 1 : 0) +
        (c.size ? 1 : 0)
    }))
    .sort((a, b) => b.score - a.score);

  for (const c of scored) {
    if (!c.height) continue;
    if (videos.some((v) => v.height === c.height)) continue;
    videos.push(c);
  }

  videos.sort((a, b) => (a.height || 0) - (b.height || 0));

  // Try to find a clean audio URL too (if provider returns it).
  const audioUrl =
    raw?.audioUrl ||
    raw?.audio_url ||
    raw?.audio?.url ||
    raw?.data?.audioUrl ||
    raw?.result?.audioUrl ||
    pickFirstString(raw?.audio) ||
    null;

  return { duration, videos, audioUrl };
}

function sizeToApproxMb(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Some APIs give bytes, some give strings; we handle number only.
  const mb = n / (1024 * 1024);
  if (mb < 0.5) return '<1MB';
  return `~${Math.round(mb)}MB`;
}

function buildYouTubeVideoButtons(videos, fallbackUrl, originalUrl) {
  const preferred = [144, 240, 360, 480, 720, 1080];
  const byHeight = new Map();
  for (const v of videos || []) {
    if (!v?.url || !v?.height) continue;
    if (!byHeight.has(v.height)) byHeight.set(v.height, v);
  }

  const out = [];
  const usedUrls = new Set();
  for (const h of preferred) {
    const v = byHeight.get(h);
    if (!v) continue;
    // If API gives the same URL for many qualities, show it once.
    if (usedUrls.has(v.url)) continue;
    usedUrls.add(v.url);
    const approx = sizeToApproxMb(v.size);
    const label = `🎬 ${h}p ⬇️${approx ? ` ${approx}` : ''}`;
    out.push(
      Markup.button.callback(
        label,
        `dl:v:${putAction({
          kind: 'video',
          url: v.url,
          originalUrl: originalUrl || undefined,
          fallbackUrl: fallbackUrl || undefined,
          expectedHeight: h
        })}`
      )
    );
  }

  // Fallback: if we didn't match preferred list, just show up to 6 qualities we have.
  if (!out.length) {
    const top = (videos || []).slice(0, 6);
    for (const v of top) {
      if (usedUrls.has(v.url)) continue;
      usedUrls.add(v.url);
      const label = `🎬 ${v.height || '?'}p ⬇️`;
      out.push(
        Markup.button.callback(
          label,
          `dl:v:${putAction({
            kind: 'video',
            url: v.url,
            originalUrl: originalUrl || undefined,
            fallbackUrl: fallbackUrl || undefined,
            expectedHeight: v.height || undefined
          })}`
        )
      );
    }
  }

  // If still empty, at least offer a single download button using the provider's default URL.
  if (!out.length && fallbackUrl) {
    out.push(
      Markup.button.callback(
        '🎬 Video ⬇️',
        `dl:v:${putAction({ kind: 'video', url: fallbackUrl, originalUrl: originalUrl || undefined })}`
      )
    );
  }

  return out;
}

async function handleMusicSearch(ctx, query) {
  const loader = await startLoader(ctx, 'Qidiryapman…');
  try {
    const { results, total } = await searchYouTubeCached(query);

    const allUnique = [];
    const seen = new Set();
    for (const r of results || []) {
      if (!r?.id || seen.has(r.id)) continue;
      seen.add(r.id);
      allUnique.push(r);
      if (allUnique.length >= 50) break;
    }

    if (!allUnique.length) {
      await loader.stop(null, true);
      await ctx.reply("Hech narsa topilmadi. Boshqa so‘z bilan urinib ko‘ring.");
      return;
    }

    const token = putAction({ kind: 'search', query, results: allUnique, page: 0, total: total || null });
    await loader.stop(null, true);
    await sendSearchPage(ctx, token);
  } catch (err) {
    await loader.stop(null, true);
    console.error('handleMusicSearch error:', err?.response?.data || err?.message || err);
    const status = err?.response?.status;
    const msg = String(err?.response?.data?.message || err?.message || '').toLowerCase();
    if (status === 429) {
      await ctx.reply("YouTube API limiti tugadi (429). Keyinroq qayta urinib ko‘ring.");
      return;
    }
    if (status === 403) {
      if (msg.includes('exceeded') && msg.includes('quota')) {
        await ctx.reply("YouTube API oylik limit tugagan. RapidAPI planingizni yangilang yoki limit yangilanishini kuting.");
        return;
      }
      await ctx.reply("YouTube API ruxsat bermadi (403). RapidAPI obuna/host sozlamalarini tekshiring.");
      return;
    }
    if (err?.code === 'CONFIG') {
      await ctx.reply(
        "Server sozlamalari yetishmayapti. `.env` da `RAPIDAPI_KEY`, `YT_API_BASEURL`, `YT_API_HOST` ni to‘ldirib, keyin qayta ishga tushiring."
      );
      return;
    }
    await ctx.reply("Hozircha bu so‘rov bo‘yicha MP3 topib/yuklab bo‘lmadi.");
  }
}

function buildSearchKeyboard(token, countOnPage, hasNext) {
  const row1 = [];
  const row2 = [];
  for (let i = 1; i <= countOnPage; i++) {
    const btn = Markup.button.callback(String(i), `s:${token}:${i}`);
    (i <= 5 ? row1 : row2).push(btn);
  }
  const rows = [row1, row2].filter((r) => r.length);
  if (hasNext) {
    rows.push([Markup.button.callback('➡️', `sn:${token}`)]);
  }
  return Markup.inlineKeyboard(rows);
}

async function sendSearchPage(ctx, token) {
  const entry = await getAction(token);
  if (!entry || entry.kind !== 'search') {
    await ctx.reply("Qidiruv muddati o‘tgan. Qaytadan so‘rov yuboring.");
    return;
  }

  const page = Number(entry.page || 0);
  const start = page * 10;
  const end = start + 10;
  const slice = (entry.results || []).slice(start, end);

  const shownFrom = start + 1;
  const shownTo = start + slice.length;
  const total = entry.total || entry.results?.length || null;

  const header = `Natijalar: “${entry.query}”\n(${shownFrom}-${shownTo}${total ? ` / ${total}` : ''})\n`;
  const lines = slice.map((r, i) => `${i + 1}. ${r.title}`);
  const text = [header, ...lines, '', 'Raqamni tanlang:', '', BRAND_FOOTER].join('\n');

  const hasNext = end < (entry.results || []).length;
  await ctx.reply(text, buildSearchKeyboard(token, slice.length, hasNext));
}

bot.action(/^dl:(v|a):(.+)$/, async (ctx) => {
  const type = ctx.match?.[1];
  const token = ctx.match?.[2];
  const entry = await getAction(token);

  if (!entry) {
    try {
      await ctx.answerCbQuery("Bu tugma muddati o‘tgan. Havolani qaytadan yuboring.");
    } catch {
      // ignore
    }
    return;
  }

  try {
    await ctx.answerCbQuery('Bajarilyapti…');
  } catch {
    // Callback query can expire; ignore.
  }

  let statusMsgId = null;
  try {
    const m = await ctx.reply(type === 'v' ? 'Video yuklanyapti…' : 'Audio yuklanyapti…');
    statusMsgId = m?.message_id || null;
  } catch {
    // ignore
  }

  try {
    let url = entry.url;
    let fallbackUrl = entry.fallbackUrl;
    let expectedHeight = entry.expectedHeight;

    const createdAt = Number(entry.createdAt || 0);
    const isOld = createdAt && Date.now() - createdAt > 60_000;
    if (entry.originalUrl && isOld) {
      try {
        const refreshed = await downloadAllMedia(entry.originalUrl);
        if (type === 'v') {
          url = refreshed.videoUrl || url;
        } else {
          url = refreshed.audioUrl || url;
        }
      } catch (e) {
        console.error('refresh download link failed:', e?.response?.data || e?.message || e);
      }
    }

    if (type === 'v') {
      const ok = await withTimeout(
        sendTelegramMedia(
          ctx,
          'video',
          url,
          BRAND_FOOTER,
          fallbackUrl,
          expectedHeight,
          makeUrlCacheKey('video', url),
          { originalUrl: entry.originalUrl || null }
        ),
        120_000
      );
      if (!ok) throw new Error('VIDEO_SEND_FAILED');
    } else {
      const ok = await withTimeout(
        sendTelegramMedia(ctx, 'audio', url, BRAND_FOOTER, fallbackUrl, undefined, makeUrlCacheKey('audio', url), {
          originalUrl: entry.originalUrl || null
        }),
        120_000
      );
      if (!ok) throw new Error('AUDIO_SEND_FAILED');
    }
  } catch (err) {
    console.error('Telegram send failed:', err?.message || err);
    await ctx.reply(
      "Video yuborib bo‘lmadi. Pastroq sifatni tanlang yoki havolani qaytadan yuboring."
    );
  } finally {
    if (statusMsgId) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsgId);
      } catch {
        // ignore
      }
    }
  }
});

bot.action(/^id:(.+)$/, async (ctx) => {
  const token = ctx.match?.[1];
  const entry = await getAction(token);
  if (!entry) {
    try {
      await ctx.answerCbQuery("Bu tugma muddati o‘tgan. Havolani qaytadan yuboring.");
    } catch {
      // ignore
    }
    return;
  }

  try {
    await ctx.answerCbQuery('Aniqlayapman…');
  } catch {
    // ignore
  }

  try {
    const { title, artist } = await recognizeSongFromAudioUrl(entry.url);
    const fullQuery = [artist, title].filter(Boolean).join(' - ') || title;
	    await ctx.reply(`Aniqlandi: ${fullQuery}\n\n${BRAND_FOOTER}`);

	    const { results } = await searchYouTubeCached(fullQuery);
	    const id = results?.[0]?.id;
	    if (!id) throw new Error('No YouTube results found');
	    const { mp3Url } = await downloadYouTubeMp3(id);
		    await sendTelegramMedia(ctx, 'audio', mp3Url, `${fullQuery}\n\n${BRAND_FOOTER}`, undefined, undefined, makeYouTubeMp3CacheKey(id), {
          title: fullQuery || null,
          originalUrl: id ? `https://youtu.be/${id}` : null
        });
		  } catch (err) {
    console.error('identify error:', err?.response?.data || err?.message || err);
    const status = err?.response?.status;
    if (status === 429 || err?.code === 'RAPIDAPI_LIMIT') {
      await ctx.reply("Qo‘shiq aniqlash API limiti tugadi. Keyinroq qayta urinib ko‘ring.");
      return;
    }
    if (status === 403) {
      await ctx.reply("Qo‘shiq aniqlash API ruxsat bermadi (403). RapidAPI obuna/host sozlamalarini tekshiring.");
      return;
    }
    if (err?.code === 'CONFIG') {
      await ctx.reply(
        "Server sozlamalari yetishmayapti. `.env` da `ACRCLOUD_HOST`, `ACRCLOUD_ACCESS_KEY`, `ACRCLOUD_ACCESS_SECRET` ni to‘ldirib, keyin qayta ishga tushiring."
      );
      return;
    }
    await ctx.reply("Kechirasiz, bu audio orqali original qo‘shiqni aniqlab bo‘lmadi.");
  }
});

bot.action(/^rs:(.+)$/, async (ctx) => {
  const token = ctx.match?.[1];
  const entry = await getAction(token);
  if (!entry || entry.kind !== 'recognize') {
    try {
      await ctx.answerCbQuery("Bu tugma muddati o‘tgan. Havolani qaytadan yuboring.");
    } catch {
      // ignore
    }
    return;
  }

	try {
	  await ctx.answerCbQuery('Qidiryapman…');
	} catch {
	  // ignore
	}

	const loader = await startLoader(ctx, 'Qo‘shiqni aniqlayapman…');
	let query = null;
	try {
	  let sourceUrl = entry.audioUrl || entry.videoUrl;
	  const originalUrl = entry.originalUrl || null;
	  if (!sourceUrl && originalUrl) {
	    try {
	      const m = await downloadAllMedia(originalUrl);
	      sourceUrl = m.audioUrl || m.videoUrl || null;
	    } catch (e) {
	      console.error('recognize fallback downloadAllMedia failed:', e?.response?.data || e?.message || e);
	    }
	  }
	  if (!sourceUrl) {
	    await ctx.reply("Audio topilmadi. Iltimos, havolani qaytadan yuboring.");
	    return;
	  }

	  let recognized;
	  try {
	    recognized = await recognizeSongFromAudioUrl(sourceUrl);
	  } catch (e) {
	    // If recognition failed because the source URL isn't a direct media file, retry via downloader using original link.
	    if ((e?.code === 'NOT_MEDIA' || String(e?.message || '') === 'NOT_MEDIA') && originalUrl) {
	      const m = await downloadAllMedia(originalUrl);
	      const retryUrl = m.audioUrl || m.videoUrl || null;
	      if (retryUrl) {
	        recognized = await recognizeSongFromAudioUrl(retryUrl);
	      } else {
	        throw e;
	      }
	    } else {
	      throw e;
	    }
	  }

	  const { title, artist } = recognized;
	  query = [artist, title].filter(Boolean).join(' - ') || title;
	  await loader.stop(null, true);
	  await ctx.reply(`Aniqlandi: ${query}\n\n${BRAND_FOOTER}`);
	} catch (err) {
	  await loader.stop(null, true);
	  console.error('recognize error:', err?.response?.data || err?.message || err);
	  if (err?.code === 'ECONNABORTED' || String(err?.message || '').toLowerCase().includes('timeout')) {
	    await ctx.reply("Musiqani topib bo‘lmadi. Keyinroq urinib ko‘ring.");
	    return;
	  }
	  await ctx.reply("Musiqani topib bo‘lmadi.");
	  return;
	}

		// Search step is best-effort: never show "aniqlanmadi" if recognition already succeeded.
		try {
		  // If a best match is already known and its MP3 is cached, send it without searching again.
		  const served = await trySendBestMp3ForQuery(ctx, query);
		  if (served) return;

		  const searchLoader = await startLoader(ctx, 'YouTube’da qidiryapman…');
		  const { results, total } = await searchYouTubeCached(query);
		  await searchLoader.stop(null, true);
	  const allUnique = [];
	  const seen = new Set();
	  for (const r of results || []) {
	    if (!r?.id || seen.has(r.id)) continue;
	    seen.add(r.id);
	    allUnique.push(r);
	    if (allUnique.length >= 50) break;
	  }

	  if (!allUnique.length) {
	    await ctx.reply("YouTube’da natija topilmadi.");
	    return;
	  }

	  const searchToken = putAction({ kind: 'search', query, results: allUnique, page: 0, total: total || null });
	  await sendSearchPage(ctx, searchToken);
	} catch (e) {
	  console.error('recognize->search error:', e?.response?.data || e?.message || e);
	  const msg = String(e?.response?.data?.message || e?.message || '').toLowerCase();
	  if (msg.includes('exceeded') && msg.includes('quota')) {
	    await ctx.reply("YouTube qidiruv limiti tugagan. Hozircha MP3 topib bo‘lmaydi. Keyinroq urinib ko‘ring.");
	    return;
	  }
	  await ctx.reply("YouTube qidiruvi ishlamayapti. Keyinroq urinib ko‘ring.");
	}
});

bot.action(/^s:([^:]+):(\d+)$/, async (ctx) => {
  const token = ctx.match?.[1];
  const index = Number(ctx.match?.[2]) - 1;
  const entry = await getAction(token);
  if (!entry || entry.kind !== 'search') {
    try {
      await ctx.answerCbQuery("Bu tugma muddati o‘tgan. Qidiruvni qayta yuboring.");
    } catch {
      // ignore
    }
    return;
  }

  const page = Number(entry.page || 0);
  const picked = entry.results?.[page * 10 + index];
  if (!picked?.id) {
    try {
      await ctx.answerCbQuery("Noto‘g‘ri tanlov. Qaytadan urinib ko‘ring.");
    } catch {
      // ignore
    }
    return;
  }

  try {
    await ctx.answerCbQuery('Yuklanyapti…');
  } catch {
    // ignore
  }

  const k = inflightKey(ctx, `s:${token}`);
  if (inflightActions.has(k)) {
    try {
      await ctx.answerCbQuery('Iltimos, kuting…');
    } catch {}
    return;
  }
  inflightActions.add(k);

  try {
    let mp3Url;
    try {
      mp3Url = (await downloadYouTubeMp3(picked.id)).mp3Url;
    } catch (e) {
      // Retry once: some providers return short-lived URLs.
      mp3Url = (await downloadYouTubeMp3(picked.id)).mp3Url;
    }
	    await sendTelegramMedia(ctx, 'audio', mp3Url, `${picked.title}\n\n${BRAND_FOOTER}`, undefined, undefined, makeYouTubeMp3CacheKey(picked.id), {
        title: picked.title || null,
        originalUrl: picked.id ? `https://youtu.be/${picked.id}` : null
      });
	    try {
      // Remember the best pick for this query so next time we can send instantly from cache.
      const qKey = makeSearchQueryKey(entry.query, 'youtube');
      await upsertQueryBest({ queryKey: qKey, provider: 'youtube', bestId: picked.id });
    } catch (e) {
      console.error('upsertQueryBest failed:', e?.message || e);
    }
  } catch (err) {
    console.error('search pick download error:', err?.response?.data || err?.message || err);
    try {
      await ctx.answerCbQuery("MP3 tayyor bo‘lmadi. Qayta urinib ko‘ring.", { show_alert: true });
    } catch {}
    // Avoid spamming chat with many identical messages on repeated clicks.
    try {
      await ctx.reply("MP3 yuklab bo‘lmadi. Keyinroq urinib ko‘ring.");
    } catch {}
  } finally {
    inflightActions.delete(k);
  }
});

bot.action(/^sn:([^:]+)$/, async (ctx) => {
  const token = ctx.match?.[1];
  const entry = await getAction(token);
  if (!entry || entry.kind !== 'search') {
    try {
      await ctx.answerCbQuery("Bu tugma muddati o‘tgan.");
    } catch {
      // ignore
    }
    return;
  }

  const page = Number(entry.page || 0) + 1;
  entry.page = page;
  actionCache.set(token, entry);
  try {
    await ctx.answerCbQuery('Keyingi sahifa…');
  } catch {
    // ignore
  }
  await sendSearchPage(ctx, token);
});

bot.action(/^ya:(.+)$/, async (ctx) => {
  const token = ctx.match?.[1];
  const entry = await getAction(token);
  if (!entry || entry.kind !== 'ytaudio' || !entry.id) {
    try {
      await ctx.answerCbQuery("Bu tugma muddati o‘tgan. Havolani qaytadan yuboring.");
    } catch {
      // ignore
    }
    return;
  }

  try {
    await ctx.answerCbQuery('Yuklanyapti…');
  } catch {
    // ignore
  }

  try {
    const { mp3Url } = await downloadYouTubeMp3(entry.id);
    const caption = [entry.title || 'YouTube audio', '', BRAND_FOOTER].join('\n');
    await sendTelegramMedia(ctx, 'audio', mp3Url, caption, undefined, undefined, makeYouTubeMp3CacheKey(entry.id), {
      title: entry.title || null,
      originalUrl: entry.id ? `https://youtu.be/${entry.id}` : null
    });
  } catch (err) {
    console.error('youtube audio download error:', err?.response?.data || err?.message || err);
    await ctx.reply("Audioni yuklab bo‘lmadi. Keyinroq urinib ko‘ring.");
  }
});

bot.action(/^yv:(.+)$/, async (ctx) => {
  const token = ctx.match?.[1];
  const entry = await getAction(token);
  if (!entry || entry.kind !== 'ytvideo' || !entry.id || !entry.quality) {
    try {
      await ctx.answerCbQuery("Bu tugma muddati o‘tgan. Havolani qaytadan yuboring.");
    } catch {
      // ignore
    }
    return;
  }

  try {
    await ctx.answerCbQuery('Video tayyorlanyapti…');
  } catch {
    // ignore
  }

  try {
    console.log('YT video download start:', { id: entry.id, quality: entry.quality });
    const { url, reservedUrl, raw } = await downloadYouTubeVideoByQuality(entry.id, entry.quality);
    console.log('YT video download:', { id: entry.id, quality: entry.quality, url, reservedUrl });

    const chosen = await waitUntilReady([url, reservedUrl].filter(Boolean), 180_000);
    if (!chosen) {
      await ctx.reply("Video tayyor bo‘lmadi. 1-2 daqiqadan keyin yana urinib ko‘ring.");
      return;
    }

    const qLabel = labelFromQualityId(entry.quality);
    await sendTelegramMedia(
      ctx,
      'video',
      chosen,
      `${qLabel}\n${BRAND_FOOTER}`,
      undefined,
      qLabel,
      makeYouTubeVideoCacheKey(entry.id, entry.quality),
      { title: qLabel || null, originalUrl: entry.id ? `https://youtu.be/${entry.id}` : null }
    );
  } catch (err) {
    console.error(
      'youtube video download error:',
      err?.response?.data || err?.details || err?.message || err
    );
    await ctx.reply("Video yuklab bo‘lmadi. Boshqa sifatni tanlang.");
  }
});

bot.action(/^ya2:(.+)$/, async (ctx) => {
  const token = ctx.match?.[1];
  const entry = await getAction(token);
  if (!entry || entry.kind !== 'ytaudio2' || !entry.id || !entry.quality) {
    try {
      await ctx.answerCbQuery("Bu tugma muddati o‘tgan. Havolani qaytadan yuboring.");
    } catch {
      // ignore
    }
    return;
  }

  try {
    await ctx.answerCbQuery('Audio tayyorlanyapti…');
  } catch {
    // ignore
  }

  try {
    console.log('YT audio download start:', { id: entry.id, quality: entry.quality });
    const { url, reservedUrl } = await downloadYouTubeAudioByQuality(entry.id, entry.quality);
    const chosen = await waitUntilReady([url, reservedUrl].filter(Boolean), 180_000);
    if (!chosen) {
      await ctx.reply("Audio tayyor bo‘lmadi. 1-2 daqiqadan keyin yana urinib ko‘ring.");
      return;
    }
    const caption = [entry.title || 'YouTube audio', '', BRAND_FOOTER].join('\n');
    await sendTelegramMedia(ctx, 'audio', chosen, caption, undefined, undefined, makeYouTubeAudioCacheKey(entry.id, entry.quality), {
      title: entry.title || null,
      originalUrl: entry.id ? `https://youtu.be/${entry.id}` : null
    });
  } catch (err) {
    console.error(
      'youtube audio (quality) error:',
      err?.response?.data || err?.details || err?.message || err
    );
    await ctx.reply("Audioni yuklab bo‘lmadi. Keyinroq urinib ko‘ring.");
  }
});

bot.action(/^ym:(.+)$/, async (ctx) => {
  const token = ctx.match?.[1];
  const entry = await getAction(token);
  if (!entry || entry.kind !== 'ytmp3' || !entry.id) {
    try {
      await ctx.answerCbQuery("Bu tugma muddati o‘tgan. Havolani qaytadan yuboring.");
    } catch {
      // ignore
    }
    return;
  }

  try {
    await ctx.answerCbQuery('Yuklanyapti…');
  } catch {
    // ignore
  }

  const loader = await startLoader(ctx, 'MP3 tayyorlanyapti…');
  const k = inflightKey(ctx, `ym:${token}`);
  if (inflightActions.has(k)) {
    await loader.stop(null, true);
    try {
      await ctx.answerCbQuery('Iltimos, kuting…');
    } catch {}
    return;
  }
  inflightActions.add(k);
  try {
    let mp3Url;
    try {
      mp3Url = (await downloadYouTubeMp3(entry.id)).mp3Url;
    } catch {
      mp3Url = (await downloadYouTubeMp3(entry.id)).mp3Url;
    }
    await loader.stop(null, true);
    const caption = [entry.title || 'YouTube MP3', '', BRAND_FOOTER].join('\n');
    await sendTelegramMedia(ctx, 'audio', mp3Url, caption, undefined, undefined, makeYouTubeMp3CacheKey(entry.id), {
      title: entry.title || null,
      originalUrl: entry.id ? `https://youtu.be/${entry.id}` : null
    });
  } catch (err) {
    await loader.stop(null, true);
    console.error('youtube mp3 by id error:', err?.response?.data || err?.message || err);
    await ctx.reply("MP3 yuklab bo‘lmadi. Keyinroq urinib ko‘ring.");
  } finally {
    inflightActions.delete(k);
  }
});

async function waitUntilReady(urls, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  const tried = new Set();
  while (Date.now() < deadline) {
    for (const url of urls) {
      if (!url || tried.has(`${url}:ok`)) continue;
      try {
        const res = await axios.get(url, {
          timeout: 20_000,
          responseType: 'arraybuffer',
          headers: { Range: 'bytes=0-0', 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.youtube.com/' },
          validateStatus: () => true
        });
        if (res.status === 200 || res.status === 206) {
          tried.add(`${url}:ok`);
          return url;
        }
        // 404 is expected while provider is preparing the file.
      } catch {
        // ignore and retry
      }
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return null;
}

async function sendTelegramMedia(ctx, kind, url, caption, fallbackUrl, expectedHeight, cacheKeyOverride, storageMeta = null) {
  try {
    const u = new URL(String(url || ''));
    const host = (u.hostname || '').toLowerCase();
    if (host === 't.me' || host === 'telegram.me') {
      await ctx.reply(
        "Downloader xizmatidan noto‘g‘ri (reklama) havola qaytdi. Iltimos, keyinroq urinib ko‘ring yoki admin RapidAPI downloader hostini almashtirsin."
      );
      return false;
    }
  } catch {
    // ignore URL parse errors
  }

  const cacheKey =
    cacheKeyOverride ||
    (() => {
      if (!url) return null;
      if (kind === 'video' || kind === 'audio') return makeUrlCacheKey(kind, url);
      return null;
    })();

  if (cacheKey) {
    try {
      const cached = await getMediaCache(cacheKey);
      if (cached?.file_id) {
        const ok = await trySendTelegramMediaByFileId(ctx, kind, cached.file_id, caption);
        if (ok) return true;
      }
    } catch (e) {
      console.error('cache lookup/send failed:', e?.message || e);
    }
  }

  // 1) Try by URL (fast path). Telegram may fail if URL is blocked/temporary/too large.
  try {
    let sent;
    if (kind === 'video') {
      sent = await ctx.replyWithVideo(url, { caption });
    } else {
      sent = await ctx.replyWithAudio(url, { caption });
    }
    await maybeCacheAndStore(ctx, kind, cacheKey, sent, storageMeta);
    return true;
  } catch (err) {
    // Continue to fallback: download then upload.
    console.error('URL send failed, falling back to upload:', err?.message || err);
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'navobot-'));
  const filePath = path.join(tmpDir, kind === 'video' ? 'file.mp4' : 'file.mp3');

  let bytes = 0;
  try {
    const res = await axios.get(url, {
      responseType: 'stream',
      timeout: 60_000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        // Some CDNs block unknown clients; these headers help for googlevideo/tiktokcdn style URLs.
        Referer: 'https://www.youtube.com/',
        Origin: 'https://www.youtube.com'
      },
      maxRedirects: 5
    });

    const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
    if (contentType.includes('text/html') || contentType.includes('text/plain')) {
      throw Object.assign(new Error('NOT_MEDIA'), { code: 'NOT_MEDIA' });
    }

    const writer = fs.createWriteStream(filePath);

    await new Promise((resolve, reject) => {
      res.data.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_TELEGRAM_UPLOAD_BYTES) {
          res.data.destroy(new Error('FILE_TOO_LARGE'));
        }
      });
      res.data.on('error', reject);
      writer.on('error', reject);
      writer.on('finish', resolve);
      res.data.pipe(writer);
    });

    const source = fs.createReadStream(filePath);
    let sent;
    if (kind === 'video') {
      sent = await ctx.replyWithVideo({ source }, { caption });
    } else {
      sent = await ctx.replyWithAudio({ source }, { caption });
    }
    await maybeCacheAndStore(ctx, kind, cacheKey, sent, storageMeta);
    return true;
  } catch (err) {
    if (err?.message === 'FILE_TOO_LARGE') {
      await ctx.reply(
        "Fayl juda katta. Iltimos, pastroq sifatni tanlang (masalan 144p/240p/360p) yoki MP3 ni yuklab oling."
      );
      return false;
    }
    if (err?.code === 'NOT_MEDIA' || err?.message === 'NOT_MEDIA') {
      // If user picked a specific YouTube quality, don't silently fallback to default,
      // otherwise it looks like every button downloads the same file.
      if (kind === 'video' && expectedHeight) {
        await ctx.reply(
          `${expectedHeight}p format hozir ishlamayapti (to‘g‘ridan-to‘g‘ri video fayl emas). Boshqa sifatni tanlang.`
        );
        return false;
      }
      if (fallbackUrl && fallbackUrl !== url) {
        return await sendTelegramMedia(ctx, kind, fallbackUrl, caption, undefined, expectedHeight, cacheKey, storageMeta);
      }
      await ctx.reply("Bu format hozir ishlamayapti. Boshqa sifatni tanlang.");
      return false;
    }
    if (fallbackUrl && fallbackUrl !== url) {
      return await sendTelegramMedia(ctx, kind, fallbackUrl, caption, undefined, expectedHeight, cacheKey, storageMeta);
    }
    throw err;
  } finally {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function extractFileIdFromMessage(kind, msg) {
  if (!msg) return null;
  if (kind === 'video') {
    return msg.video?.file_id || msg.document?.file_id || null;
  }
  if (kind === 'audio') {
    return msg.audio?.file_id || msg.voice?.file_id || msg.document?.file_id || null;
  }
  return null;
}

async function trySendTelegramMediaByFileId(ctx, kind, fileId, caption) {
  try {
    if (kind === 'video') {
      await ctx.replyWithVideo(fileId, { caption });
    } else {
      await ctx.replyWithAudio(fileId, { caption });
    }
    return true;
  } catch (e) {
    console.error('file_id send failed:', e?.message || e);
    return false;
  }
}

async function maybeCacheAndStore(ctx, kind, cacheKey, sentMessage, metaOverride = null) {
  if (!cacheKey || !sentMessage) return;
  const fileId = extractFileIdFromMessage(kind, sentMessage);
  if (!fileId) return;

  let storageMessageId = null;
  const storageChatId = STORAGE_CHAT_ID ? String(STORAGE_CHAT_ID) : null;
  if (!storageChatId) {
    console.warn('STORAGE_CHAT_ID is not set; skipping storage copy');
  } else {
    try {
      const copied = await ctx.telegram.copyMessage(storageChatId, ctx.chat.id, sentMessage.message_id);
      storageMessageId = copied?.message_id || null;
      // Optionally enrich the storage-channel caption with source details.
      if (storageMessageId && metaOverride) {
        try {
          const cap = buildStorageCaption(kind, metaOverride);
          // Works for video/audio/document messages copied to channels.
          await ctx.telegram.editMessageCaption(storageChatId, storageMessageId, undefined, cap);
        } catch (e) {
          console.warn('storage caption edit failed:', e?.response?.description || e?.message || e);
        }
      }
      console.log('stored to channel:', { storageChatId, storageMessageId, kind, cacheKey });
    } catch (e) {
      console.error('copy to storage failed:', e?.response?.description || e?.message || e);
    }
  }

  // Optional: also collect ONLY audios (with title-only caption) into a separate private channel.
  // This channel is not used as a DB/cache; it is just an archive for you.
  const musicChatId = MUSIC_CHAT_ID ? String(MUSIC_CHAT_ID) : null;
  if (kind === 'audio' && musicChatId) {
    try {
      const copied = await ctx.telegram.copyMessage(musicChatId, ctx.chat.id, sentMessage.message_id);
      const musicMessageId = copied?.message_id || null;
      if (musicMessageId) {
        const fallbackTitle = sentMessage?.audio?.title || sentMessage?.audio?.file_name || null;
        const cap = buildMusicCaption(metaOverride, fallbackTitle);
        try {
          await ctx.telegram.editMessageCaption(musicChatId, musicMessageId, undefined, cap);
        } catch (e) {
          console.warn('music caption edit failed:', e?.response?.description || e?.message || e);
        }
      }
      console.log('copied to music channel:', { musicChatId, kind, cacheKey });
    } catch (e) {
      console.error('copy to music channel failed:', e?.response?.description || e?.message || e);
    }
  }

  try {
    await upsertMediaCache({
      cacheKey,
      kind,
      fileId,
      storageChatId: storageChatId || null,
      storageMessageId,
      meta: metaOverride
    });
  } catch (e) {
    console.error('cache upsert failed:', e?.message || e);
  }

  return { fileId, storageChatId: storageChatId || null, storageMessageId };
}

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('TIMEOUT')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function start() {
  await initDb();
  console.log('DB connected and users table is ready');
  console.log('Storage configured:', { STORAGE_CHAT_ID: STORAGE_CHAT_ID || null });
  console.log('Music channel configured:', { MUSIC_CHAT_ID: MUSIC_CHAT_ID || null });
  console.log('Admin configured:', { adminCount: ADMIN_IDS.length });

  app.listen(PORT, () => {
    console.log(`Express server listening on port ${PORT}`);
  });

  // Safety: if someone set a webhook on this token, remove it so polling works reliably
  // and to reduce the chance of a rogue webhook receiving updates.
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  } catch (e) {
    console.warn('Failed to delete webhook:', e?.message || e);
  }

  await bot.launch();
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me?.username || BOT_USERNAME;
    BOT_ID = me?.id || BOT_ID;
    console.log('Bot identity:', { username: BOT_USERNAME || null, id: BOT_ID || null });
  } catch (e) {
    console.warn('Failed to get bot identity:', e?.message || e);
  }
  console.log('Telegraf bot started (polling)');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

start().catch((err) => {
  console.error('Fatal startup error:', err?.message || err);
  process.exit(1);
});
