const axios = require('axios');
const FormData = require('form-data');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const crypto = require('crypto');

function createRapidClient(baseURL, host, timeoutMs = 30_000) {
  return axios.create({
    baseURL,
    timeout: timeoutMs,
    headers: {
      'X-RapidAPI-Key': process.env.RAPIDAPI_KEY || '',
      ...(host ? { 'X-RapidAPI-Host': host } : {})
    }
  });
}

function requireRapidApiKey() {
  if (!process.env.RAPIDAPI_KEY) {
    const err = new Error('RAPIDAPI_KEY is not set');
    err.code = 'CONFIG';
    throw err;
  }
}

function requireBase(baseURL, name) {
  if (!baseURL) {
    const err = new Error(`${name} baseURL is not set`);
    err.code = 'CONFIG';
    throw err;
  }
}

const mediaClient = createRapidClient(process.env.MEDIA_API_BASEURL, process.env.MEDIA_API_HOST);
// Allow using one API for search and another for download if some endpoints are locked by plan.
const ytSearchClient = createRapidClient(process.env.YT_API_BASEURL, process.env.YT_API_HOST);
const ytDlClient = createRapidClient(
  process.env.YT_DL_BASEURL || process.env.YT_API_BASEURL,
  process.env.YT_DL_HOST || process.env.YT_API_HOST
);
const ytVideoClient = createRapidClient(
  process.env.YT_VIDEO_API_BASEURL,
  process.env.YT_VIDEO_API_HOST,
  Number(process.env.YT_VIDEO_TIMEOUT_MS || 60_000)
);

function requireAcrCloudConfig() {
  const host = process.env.ACRCLOUD_HOST;
  const accessKey = process.env.ACRCLOUD_ACCESS_KEY;
  const accessSecret = process.env.ACRCLOUD_ACCESS_SECRET;
  if (!host || !accessKey || !accessSecret) {
    const err = new Error('ACRCloud config is not set');
    err.code = 'CONFIG';
    throw err;
  }
  return { host, accessKey, accessSecret };
}

function pickFirstUrl(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pickFirstUrl(item);
      if (found) return found;
    }
  }
  if (typeof value === 'object') {
    for (const k of [
      'url',
      'link',
      'download',
      'downloadUrl',
      'download_url',
      'src',
      'file',
      'reserved_file',
      'reservedFile',
      'direct',
      'direct_url',
      'directUrl'
    ]) {
      const found = pickFirstUrl(value[k]);
      if (found) return found;
    }
  }
  return null;
}

function pickFirstUrlSkippingReserved(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pickFirstUrlSkippingReserved(item);
      if (found) return found;
    }
  }
  if (typeof value === 'object') {
    for (const k of [
      'url',
      'link',
      'download',
      'downloadUrl',
      'download_url',
      'src',
      'file',
      'direct',
      'direct_url',
      'directUrl'
    ]) {
      const found = pickFirstUrlSkippingReserved(value[k]);
      if (found) return found;
    }
  }
  return null;
}

function pickUrlByKeys(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
  }
  return null;
}

function pickFirstNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pickFirstNumber(item);
      if (found != null) return found;
    }
  }
  if (value && typeof value === 'object') {
    for (const k of ['total', 'totalResults', 'total_results', 'count']) {
      const found = pickFirstNumber(value[k]);
      if (found != null) return found;
    }
  }
  return null;
}

function findFirstVideoCandidates(root) {
  const results = [];
  const seen = new Set();

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    const id =
      node.videoId ||
      node.video_id ||
      node.videoID ||
      node.id?.videoId ||
      node.id?.video_id ||
      node.id ||
      null;
    const title = node.title || node.name || node.video_title || node.fulltitle || null;
    const type = node.type || node.kind || null;

    if (id && title && (!type || String(type).toLowerCase().includes('video'))) {
      results.push({
        id: String(id),
        title: String(title),
        duration: node.duration || node.length || node.lengthSeconds || node.length_seconds || null
      });
    }

    for (const v of Object.values(node)) visit(v);
  }

  visit(root);
  return results;
}

function extractMediaLinks(data) {
  const videoCandidates = [
    data?.video,
    data?.videos,
    data?.result?.video,
    data?.result?.videos,
    data?.data?.video,
    data?.data?.videos,
    data?.medias,
    data?.media
  ];
  const audioCandidates = [
    data?.audio,
    data?.audios,
    data?.result?.audio,
    data?.result?.audios,
    data?.data?.audio,
    data?.data?.audios,
    data?.music
  ];

  return {
    videoUrl: pickFirstUrl(videoCandidates),
    audioUrl: pickFirstUrl(audioCandidates),
    title: data?.title || data?.result?.title || data?.data?.title || null
  };
}

async function downloadAllMedia(url) {
  requireRapidApiKey();
  requireBase(process.env.MEDIA_API_BASEURL, 'MEDIA_API_BASEURL');

  const method = (process.env.MEDIA_API_METHOD || 'GET').toUpperCase();
  const path = process.env.MEDIA_API_PATH || '/v1/download';

  let res;
  try {
    if (method === 'POST') {
      res = await mediaClient.post(path, { url }, { headers: { 'Content-Type': 'application/json' } });
    } else {
      res = await mediaClient.get(path, { params: { url } });
    }
  } catch (err) {
    // Fallback for common variants:
    // - GET /v1/download?url=...
    // - POST /v1/social/autolink { url }
    const status = err?.response?.status;
    if (status && (status === 429 || status === 403)) throw err;

    try {
      res = await mediaClient.get('/v1/download', { params: { url } });
    } catch {
      res = await mediaClient.post(
        '/v1/social/autolink',
        { url },
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  const { videoUrl, audioUrl, title } = extractMediaLinks(res.data);
  if (!videoUrl && !audioUrl) {
    throw new Error('Media API returned no downloadable links for this URL');
  }
  return { videoUrl, audioUrl, title, raw: res.data };
}

async function searchYouTube(query) {
  requireRapidApiKey();
  requireBase(process.env.YT_API_BASEURL, 'YT_API_BASEURL');
  const searchPath = process.env.YT_API_SEARCH_PATH || '/search';
  const searchParam = process.env.YT_API_SEARCH_PARAM || 'query';
  const res = await ytSearchClient.get(searchPath, { params: { [searchParam]: query } });

  // Be resilient across many RapidAPI search APIs.
  const candidates = findFirstVideoCandidates(res.data);
  if (!candidates.length) throw new Error('No YouTube results found');

  const total = pickFirstNumber(res.data);
  return {
    id: candidates[0].id,
    title: candidates[0].title,
    results: candidates,
    total,
    raw: res.data
  };
}

async function downloadYouTubeMp3(id) {
  requireRapidApiKey();
  requireBase(process.env.YT_DL_BASEURL || process.env.YT_API_BASEURL, 'YT_DL_BASEURL (or YT_API_BASEURL)');
  const dlPath = process.env.YT_API_DL_PATH || '/dl';
  const dlParam = process.env.YT_API_DL_PARAM || 'id';
  const quality = process.env.YT_API_DL_QUALITY;

  let path = dlPath;
  const params = {};

  if (quality) params.quality = quality;

  // Supports:
  // - query param mode: /dl?id=VIDEO_ID (dlParam is 'id')
  // - path param mode: /get_raw_audio_download_link/{id}?quality=140 (dlParam is '__path__')
  if (path.includes('{id}')) {
    path = path.replace('{id}', encodeURIComponent(id));
  } else if (dlParam === '__path__') {
    path = path.endsWith('/') ? `${path}${encodeURIComponent(id)}` : `${path}/${encodeURIComponent(id)}`;
  } else {
    params[dlParam] = id;
  }

  const res = await ytDlClient.get(path, { params });
  const mp3Url =
    pickFirstUrl(res.data?.link) ||
    pickFirstUrl(res.data?.url) ||
    pickFirstUrl(res.data?.data) ||
    pickFirstUrl(res.data?.result) ||
    pickFirstUrl(res.data);
  if (!mp3Url) throw new Error('MP3 API returned no downloadable URL');
  return { mp3Url, raw: res.data };
}

function isRateLimitOrForbidden(err) {
  const status = err?.response?.status;
  return status === 429 || status === 403;
}

function isUploadFileExpectedError(err) {
  const data = err?.response?.data;
  const msg = JSON.stringify(data || '').toLowerCase();
  return msg.includes('expected uploadfile') || msg.includes('uploadfile');
}

function isAudioOnlyError(err) {
  const data = err?.response?.data;
  const msg = JSON.stringify(data || '').toLowerCase();
  return msg.includes('only .wav') || msg.includes('only .ogg') || msg.includes('only .mp3');
}

function acrDebugEnabled() {
  const v = String(process.env.DEBUG_ACRCLOUD || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

async function fetchSampleBuffer(url, maxBytes = 2_000_000) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30_000,
    headers: { Range: `bytes=0-${maxBytes - 1}` },
    maxContentLength: maxBytes + 1024 * 64,
    maxBodyLength: maxBytes + 1024 * 64,
    validateStatus: (s) => (s >= 200 && s < 300) || s === 206
  });
  const buf = Buffer.from(res.data);
  const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
  return { buf: buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf, contentType, status: res.status };
}

function extFromContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('video/mp4')) return 'mp4';
  if (ct.includes('audio/mpeg') || ct.includes('audio/mp3')) return 'mp3';
  if (ct.includes('audio/mp4') || ct.includes('audio/x-m4a') || ct.includes('audio/m4a')) return 'm4a';
  if (ct.includes('audio/ogg')) return 'ogg';
  if (ct.includes('audio/wav') || ct.includes('audio/x-wav')) return 'wav';
  return 'bin';
}

async function convertToMp3(inputBuf, inputExtHint = 'mp4', opts = {}) {
  // Requires ffmpeg to be installed in the runtime (server/docker).
  const seconds = Number(opts.seconds ?? 4);
  const bitrate = String(opts.bitrate ?? '96k');
  const sampleRate = Number(opts.sampleRate ?? 16000);
  const channels = Number(opts.channels ?? 1);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'navobot-ffmpeg-'));
  const inPath = path.join(tmpDir, `in.${inputExtHint}`);
  const outPath = path.join(tmpDir, 'out.mp3');
  try {
    await fs.writeFile(inPath, inputBuf);
    await new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-t',
        String(seconds),
        '-i',
        inPath,
        '-vn',
        '-ac',
        String(channels),
        '-ar',
        String(sampleRate),
        '-codec:a',
        'libmp3lame',
        '-b:a',
        bitrate,
        outPath
      ]);
      let stderr = '';
      p.stderr.on('data', (d) => (stderr += d.toString()));
      p.on('error', reject);
      p.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg failed (${code}): ${stderr}`));
      });
    });
    return await fs.readFile(outPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function buildRecognitionSampleMp3FromUrl(sourceUrl) {
  const sampleBytes = Number(process.env.RECOGNITION_SAMPLE_BYTES || 2_000_000);
  const seconds = Number(process.env.RECOGNITION_SAMPLE_SECONDS || 8);
  const { buf, contentType, status } = await fetchSampleBuffer(sourceUrl, sampleBytes);
  const dbg = acrDebugEnabled();
  if (dbg) console.log('[acr] fetched', { status, contentType, bytes: buf.length, sampleBytes, seconds });

  if (String(contentType).includes('text/html')) {
    const err = new Error('NOT_MEDIA');
    err.code = 'NOT_MEDIA';
    err.details = { status, contentType };
    throw err;
  }

  const extHint = extFromContentType(contentType);
  const out = await convertToMp3(buf, extHint, { seconds, bitrate: '96k', sampleRate: 16000, channels: 1 });
  if (dbg) console.log('[acr] sample ready', { bytes: out.length });
  return out;
}

async function recognizeSongWithAcrCloudFromUrl(sourceUrl) {
  const { host, accessKey, accessSecret } = requireAcrCloudConfig();
  const dbg = acrDebugEnabled();
  const endpointPath = process.env.ACRCLOUD_PATH || '/v1/identify';
  const url = /^https?:\/\//i.test(host) ? `${host}${endpointPath}` : `https://${host}${endpointPath}`;

  const sample = await buildRecognitionSampleMp3FromUrl(sourceUrl);
  const dataType = 'audio';
  const signatureVersion = '1';
  const timestamp = Math.floor(Date.now() / 1000);
  const stringToSign = ['POST', endpointPath, accessKey, dataType, signatureVersion, String(timestamp)].join('\n');
  const signature = crypto.createHmac('sha1', accessSecret).update(stringToSign, 'utf8').digest('base64');

  const fd = new FormData();
  fd.append('sample', sample, { filename: 'sample.mp3', contentType: 'audio/mpeg' });
  fd.append('sample_bytes', String(sample.length));
  fd.append('access_key', accessKey);
  fd.append('data_type', dataType);
  fd.append('signature_version', signatureVersion);
  fd.append('signature', signature);
  fd.append('timestamp', String(timestamp));

  if (dbg) console.log('[acr] request', { url, endpointPath, sampleBytes: sample.length });

  const res = await axios.post(url, fd, {
    headers: fd.getHeaders(),
    timeout: Number(process.env.ACRCLOUD_TIMEOUT_MS || 60_000),
    validateStatus: () => true
  });

  if (dbg) console.log('[acr] response', { httpStatus: res.status, status: res.data?.status || null });

  if (res.status >= 400) {
    const err = new Error('ACRCloud HTTP error');
    err.details = res.data;
    throw err;
  }

  const code = res.data?.status?.code;
  if (code !== 0) {
    const err = new Error('Recognition API could not identify the track');
    err.code = 'NO_MATCH';
    err.details = res.data?.status || res.data;
    throw err;
  }

  const music = res.data?.metadata?.music?.[0] || null;
  const title = music?.title || null;
  const artist = (music?.artists || []).map((a) => a?.name).filter(Boolean).join(', ') || null;

  if (!title && !artist) {
    const err = new Error('Recognition API could not identify the track');
    err.code = 'NO_MATCH';
    err.details = res.data;
    throw err;
  }

  return { title, artist, raw: res.data };
}

function pickQualities(data) {
  // If API returns a flat list of qualities (array), split by type.
  if (Array.isArray(data)) {
    const video = data.filter((x) => String(x?.type || '').toLowerCase() === 'video');
    const audio = data.filter((x) => String(x?.type || '').toLowerCase() === 'audio');
    return { video, audio };
  }

  // Try common shapes first.
  const video =
    data?.video ||
    data?.videos ||
    data?.videoQualities ||
    data?.video_qualities ||
    data?.result?.video ||
    data?.result?.videos ||
    data?.data?.video ||
    data?.data?.videos ||
    null;
  const audio =
    data?.audio ||
    data?.audios ||
    data?.audioQualities ||
    data?.audio_qualities ||
    data?.result?.audio ||
    data?.result?.audios ||
    data?.data?.audio ||
    data?.data?.audios ||
    null;

  if (Array.isArray(video) || Array.isArray(audio)) {
    return { video: Array.isArray(video) ? video : [], audio: Array.isArray(audio) ? audio : [] };
  }

  // Fallback: deep-scan for arrays under keys that include 'video'/'audio' and 'quality'.
  const found = { video: [], audio: [] };
  const seen = new Set();

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    for (const [k, v] of Object.entries(node)) {
      const key = String(k).toLowerCase();
      if (Array.isArray(v)) {
        if (key.includes('video') && (key.includes('quality') || key.includes('qualities') || key.includes('available'))) {
          found.video = v;
        }
        if (key.includes('audio') && (key.includes('quality') || key.includes('qualities') || key.includes('available'))) {
          found.audio = v;
        }
      } else if (v && typeof v === 'object') {
        visit(v);
      }
    }
  }

  visit(data);
  return found;
}

function normalizeQualityList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => {
      if (x == null) return null;
      if (typeof x === 'number' || typeof x === 'string') return { id: String(x), label: String(x) };
      if (typeof x === 'object') {
        const id = x.id || x.itag || x.value || x.code;
        const label =
          x.quality ||
          x.label ||
          x.name ||
          x.qualityLabel ||
          x.quality_label ||
          x.resolution ||
          (id ? String(id) : null);
        return id
          ? {
              id: String(id),
              label: label ? String(label) : String(id),
              size: x.size ?? x.filesize ?? x.fileSize ?? null,
              mime: x.mime ?? x.mimeType ?? x.type ?? null,
              bitrate: x.bitrate ?? null
            }
          : null;
      }
      return null;
    })
    .filter(Boolean);
}

async function getYouTubeQualityOptions(videoId) {
  requireRapidApiKey();
  requireBase(process.env.YT_VIDEO_API_BASEURL, 'YT_VIDEO_API_BASEURL');
  const tpl = process.env.YT_VIDEO_QUALITIES_PATH || '/get_available_quality/{id}';
  const pathUrl = tpl.includes('{id}') ? tpl.replace('{id}', encodeURIComponent(videoId)) : `${tpl}/${encodeURIComponent(videoId)}`;
  const res = await ytVideoClient.get(pathUrl, { params: { response_mode: 'default' } });
  const { video, audio } = pickQualities(res.data);
  return {
    video: normalizeQualityList(video),
    audio: normalizeQualityList(audio),
    raw: res.data
  };
}

async function downloadYouTubeVideoByQuality(videoId, quality) {
  requireRapidApiKey();
  requireBase(process.env.YT_VIDEO_API_BASEURL, 'YT_VIDEO_API_BASEURL');
  const tpl = process.env.YT_VIDEO_DOWNLOAD_PATH || '/download_video/{id}';
  const pathUrl = tpl.includes('{id}') ? tpl.replace('{id}', encodeURIComponent(videoId)) : `${tpl}/${encodeURIComponent(videoId)}`;
  const res = await ytVideoClient.get(pathUrl, { params: { quality, response_mode: 'default' } });
  const url =
    pickFirstUrlSkippingReserved(res.data?.url) ||
    pickFirstUrlSkippingReserved(res.data?.link) ||
    pickFirstUrlSkippingReserved(res.data?.data) ||
    pickFirstUrlSkippingReserved(res.data?.result) ||
    pickFirstUrlSkippingReserved(res.data);
  const reservedUrl =
    pickUrlByKeys(res.data, ['reserved_file', 'reservedFile']) ||
    pickUrlByKeys(res.data?.result, ['reserved_file', 'reservedFile']) ||
    null;
  if (!url) {
    const err = new Error('Video download API returned no URL');
    err.details = res.data;
    throw err;
  }
  return { url, reservedUrl, raw: res.data };
}

async function downloadYouTubeAudioByQuality(videoId, quality) {
  requireRapidApiKey();
  requireBase(process.env.YT_VIDEO_API_BASEURL, 'YT_VIDEO_API_BASEURL');
  const tpl = process.env.YT_VIDEO_AUDIO_PATH || '/download_audio/{id}';
  const pathUrl = tpl.includes('{id}') ? tpl.replace('{id}', encodeURIComponent(videoId)) : `${tpl}/${encodeURIComponent(videoId)}`;
  const res = await ytVideoClient.get(pathUrl, { params: { quality, response_mode: 'default' } });
  const url =
    pickFirstUrlSkippingReserved(res.data?.url) ||
    pickFirstUrlSkippingReserved(res.data?.link) ||
    pickFirstUrlSkippingReserved(res.data?.data) ||
    pickFirstUrlSkippingReserved(res.data?.result) ||
    pickFirstUrlSkippingReserved(res.data);
  const reservedUrl =
    pickUrlByKeys(res.data, ['reserved_file', 'reservedFile']) ||
    pickUrlByKeys(res.data?.result, ['reserved_file', 'reservedFile']) ||
    null;
  if (!url) {
    const err = new Error('Audio download API returned no URL');
    err.details = res.data;
    throw err;
  }
  return { url, reservedUrl, raw: res.data };
}

async function recognizeSongFromAudioUrl(audioUrl) {
  // Switched from RapidAPI Shazam Core to ACRCloud.
  return await recognizeSongWithAcrCloudFromUrl(audioUrl);
}

module.exports = {
  downloadAllMedia,
  searchYouTube,
  downloadYouTubeMp3,
  getYouTubeQualityOptions,
  downloadYouTubeVideoByQuality,
  downloadYouTubeAudioByQuality,
  recognizeSongFromAudioUrl
};
