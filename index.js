require('dotenv').config();

const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { pool, initDb } = require('./config/db');
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

// Short-lived in-memory cache for callback actions:
// token -> { kind: 'video'|'audio'|'identify'|'search'|'recognize', url, fallbackUrl?, createdAt, ... }
const actionCache = new Map();
const ACTION_TTL_MS = 10 * 60 * 1000;

function putAction(payload) {
  const token = crypto.randomUUID();
  actionCache.set(token, { ...payload, createdAt: Date.now() });
  return token;
}

function getAction(token) {
  const entry = actionCache.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > ACTION_TTL_MS) {
    actionCache.delete(token);
    return null;
  }
  return entry;
}

function cleanupActions() {
  const now = Date.now();
  for (const [token, entry] of actionCache.entries()) {
    if (now - entry.createdAt > ACTION_TTL_MS) actionCache.delete(token);
  }
}
setInterval(cleanupActions, 60_000).unref();

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

  await ctx.reply(
    [
      "YouTube / TikTok / Instagram havolasini yuboring — yuklab beraman.",
      "Yoki qo‘shiq nomini (matn) yuboring — qidirib MP3 qilib yuboraman.",
      '',
      'Eslatma:',
      '- Havola yuborsangiz: Video / MP3 tugmalari chiqadi.',
      "- Instagram/TikTok: qo‘shiqni aniqlash (🔎 Identify Song) ham bor."
    ].join('\n')
  );
});

// Never crash the process on Telegram callback/query errors.
bot.catch((err, ctx) => {
  const updateType = ctx?.updateType || 'unknown';
  console.error(`Telegraf error (${updateType}):`, err?.response?.description || err?.message || err);
});

bot.on('text', async (ctx) => {
  const text = (ctx.message?.text || '').trim();
  if (!text) return;

  if (isSupportedUrl(text)) {
    await handleMediaLink(ctx, normalizeUrl(text));
    return;
  }

  await handleMusicSearch(ctx, text);
});

async function handleMediaLink(ctx, url) {
  try {
    await ctx.reply('Yuklab olish havolalarini topyapman…');
    const { videoUrl, audioUrl, title, raw } = await downloadAllMedia(url);

    const host = new URL(url).hostname.toLowerCase();
    const isShort = host.includes('instagram.com') || host.includes('tiktok.com');
    const isYouTube = host.includes('youtube.com') || host.includes('youtu.be');

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
      const token = putAction({ kind: 'audio', url: audioUrl });
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
      const videoButtons = buildYouTubeVideoButtons(yt.videos || [], videoUrl || null);
      const audioButton = audioUrl
        ? Markup.button.callback("🎵 Audioni yuklab olish", `dl:a:${putAction({ kind: 'audio', url: audioUrl })}`)
        : null;

      const keyboardRows = [];
      for (const row of chunk(videoButtons, 2)) keyboardRows.push(row);
      if (audioButton) keyboardRows.push([audioButton]);

      const header = title ? `🍿 ${title}` : 'YouTube video';
      const text = [header, url, '', BRAND_FOOTER].filter(Boolean).join('\n');
      await ctx.reply(text, Markup.inlineKeyboard(keyboardRows));
      return;
    }

    if (isShort && videoUrl) {
      const caption = BRAND_FOOTER;
      await ctx.replyWithVideo(videoUrl, {
        caption,
        ...Markup.inlineKeyboard(buttons, { columns: 2 })
      });
      return;
    }

    // Default flow: show choice buttons (YouTube va boshqalar).
    if (videoUrl) {
      const token = putAction({ kind: 'video', url: videoUrl });
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

function buildYouTubeVideoButtons(videos, fallbackUrl) {
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
        `dl:v:${putAction({ kind: 'video', url: fallbackUrl })}`
      )
    );
  }

  return out;
}

async function handleMusicSearch(ctx, query) {
  try {
    await ctx.reply('Qidiryapman…');
    const { results, total } = await searchYouTube(query);

    const allUnique = [];
    const seen = new Set();
    for (const r of results || []) {
      if (!r?.id || seen.has(r.id)) continue;
      seen.add(r.id);
      allUnique.push(r);
      if (allUnique.length >= 50) break;
    }

    if (!allUnique.length) {
      await ctx.reply("Hech narsa topilmadi. Boshqa so‘z bilan urinib ko‘ring.");
      return;
    }

    const token = putAction({ kind: 'search', query, results: allUnique, page: 0, total: total || null });
    await sendSearchPage(ctx, token);
  } catch (err) {
    console.error('handleMusicSearch error:', err?.response?.data || err?.message || err);
    const status = err?.response?.status;
    if (status === 429) {
      await ctx.reply("YouTube API limiti tugadi (429). Keyinroq qayta urinib ko‘ring.");
      return;
    }
    if (status === 403) {
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
  const entry = getAction(token);
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
  const entry = getAction(token);

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
    if (type === 'v') {
      const ok = await withTimeout(
        sendTelegramMedia(
          ctx,
          'video',
          entry.url,
          BRAND_FOOTER,
          entry.fallbackUrl,
          entry.expectedHeight
        ),
        120_000
      );
      if (!ok) throw new Error('VIDEO_SEND_FAILED');
    } else {
      const ok = await withTimeout(
        sendTelegramMedia(ctx, 'audio', entry.url, BRAND_FOOTER, entry.fallbackUrl),
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
  const entry = getAction(token);
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

    const { id } = await searchYouTube(fullQuery);
    const { mp3Url } = await downloadYouTubeMp3(id);

    try {
      await ctx.replyWithAudio(mp3Url, { caption: `${fullQuery}\n\n${BRAND_FOOTER}` });
    } catch (sendErr) {
      console.error('replyWithAudio (identified) failed:', sendErr?.message || sendErr);
      await ctx.reply("Qo‘shiq aniqlandi, lekin Telegram MP3 ni URL orqali yuklay olmadi. Keyinroq urinib ko‘ring.");
    }
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
        "Server sozlamalari yetishmayapti. `.env` da `RAPIDAPI_KEY`, `SHAZAM_API_BASEURL`, `SHAZAM_API_HOST` ni to‘ldirib, keyin qayta ishga tushiring."
      );
      return;
    }
    await ctx.reply("Kechirasiz, bu audio orqali original qo‘shiqni aniqlab bo‘lmadi.");
  }
});

bot.action(/^rs:(.+)$/, async (ctx) => {
  const token = ctx.match?.[1];
  const entry = getAction(token);
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

  try {
    const sourceUrl = entry.audioUrl || entry.videoUrl;
    if (!sourceUrl) {
      await ctx.reply("Audio topilmadi. Iltimos, havolani qaytadan yuboring.");
      return;
    }

    const { title, artist } = await recognizeSongFromAudioUrl(sourceUrl);
    const query = [artist, title].filter(Boolean).join(' - ') || title;

    const { results, total } = await searchYouTube(query);
    const allUnique = [];
    const seen = new Set();
    for (const r of results || []) {
      if (!r?.id || seen.has(r.id)) continue;
      seen.add(r.id);
      allUnique.push(r);
      if (allUnique.length >= 50) break;
    }

    if (!allUnique.length) {
      await ctx.reply("Qo‘shiq aniqlandi, lekin YouTube’da natija topilmadi.");
      return;
    }

    const searchToken = putAction({ kind: 'search', query, results: allUnique, page: 0, total: total || null });
    await sendSearchPage(ctx, searchToken);
  } catch (err) {
    console.error('recognize->search error:', err?.response?.data || err?.message || err);
    await ctx.reply("Kechirasiz, videodagi qo‘shiqni aniqlab bo‘lmadi. Keyinroq urinib ko‘ring.");
  }
});

bot.action(/^s:([^:]+):(\d+)$/, async (ctx) => {
  const token = ctx.match?.[1];
  const index = Number(ctx.match?.[2]) - 1;
  const entry = getAction(token);
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

  try {
    const { mp3Url } = await downloadYouTubeMp3(picked.id);
    await sendTelegramMedia(ctx, 'audio', mp3Url, `${picked.title}\n\n${BRAND_FOOTER}`);
  } catch (err) {
    console.error('search pick download error:', err?.response?.data || err?.message || err);
    await ctx.reply("MP3 yuklab bo‘lmadi. Keyinroq urinib ko‘ring.");
  }
});

bot.action(/^sn:([^:]+)$/, async (ctx) => {
  const token = ctx.match?.[1];
  const entry = getAction(token);
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
  const entry = getAction(token);
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
    await sendTelegramMedia(ctx, 'audio', mp3Url, caption);
  } catch (err) {
    console.error('youtube audio download error:', err?.response?.data || err?.message || err);
    await ctx.reply("Audioni yuklab bo‘lmadi. Keyinroq urinib ko‘ring.");
  }
});

bot.action(/^yv:(.+)$/, async (ctx) => {
  const token = ctx.match?.[1];
  const entry = getAction(token);
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
    const { url } = await downloadYouTubeVideoByQuality(entry.id, entry.quality);
    await sendTelegramMedia(ctx, 'video', url, BRAND_FOOTER, undefined, labelFromQualityId(entry.quality));
  } catch (err) {
    console.error('youtube video download error:', err?.response?.data || err?.message || err);
    await ctx.reply("Video yuklab bo‘lmadi. Boshqa sifatni tanlang.");
  }
});

bot.action(/^ya2:(.+)$/, async (ctx) => {
  const token = ctx.match?.[1];
  const entry = getAction(token);
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
    const { url } = await downloadYouTubeAudioByQuality(entry.id, entry.quality);
    const caption = [entry.title || 'YouTube audio', '', BRAND_FOOTER].join('\n');
    await sendTelegramMedia(ctx, 'audio', url, caption);
  } catch (err) {
    console.error('youtube audio (quality) error:', err?.response?.data || err?.message || err);
    await ctx.reply("Audioni yuklab bo‘lmadi. Keyinroq urinib ko‘ring.");
  }
});

async function sendTelegramMedia(ctx, kind, url, caption, fallbackUrl, expectedHeight) {
  // 1) Try by URL (fast path). Telegram may fail if URL is blocked/temporary/too large.
  try {
    if (kind === 'video') {
      await ctx.replyWithVideo(url, { caption });
    } else {
      await ctx.replyWithAudio(url, { caption });
    }
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
    if (kind === 'video') {
      await ctx.replyWithVideo({ source }, { caption });
    } else {
      await ctx.replyWithAudio({ source }, { caption });
    }
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
      if (fallbackUrl && fallbackUrl !== url) return await sendTelegramMedia(ctx, kind, fallbackUrl, caption);
      await ctx.reply("Bu format hozir ishlamayapti. Boshqa sifatni tanlang.");
      return false;
    }
    if (fallbackUrl && fallbackUrl !== url) {
      return await sendTelegramMedia(ctx, kind, fallbackUrl, caption);
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

  app.listen(PORT, () => {
    console.log(`Express server listening on port ${PORT}`);
  });

  await bot.launch();
  console.log('Telegraf bot started (polling)');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

start().catch((err) => {
  console.error('Fatal startup error:', err?.message || err);
  process.exit(1);
});
