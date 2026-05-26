const axios = require('axios');

function createRapidClient(baseURL, host) {
  return axios.create({
    baseURL,
    timeout: 30_000,
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
const shazamClient = createRapidClient(process.env.SHAZAM_API_BASEURL, process.env.SHAZAM_API_HOST);

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
    for (const k of ['url', 'link', 'download', 'downloadUrl', 'download_url', 'src']) {
      const found = pickFirstUrl(value[k]);
      if (found) return found;
    }
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

async function fetchAudioSampleBase64(audioUrl, maxBytes = 2_000_000) {
  // Avoid downloading the full file. Many servers support Range; if not, we still cap by truncating locally.
  const res = await axios.get(audioUrl, {
    responseType: 'arraybuffer',
    timeout: 30_000,
    headers: { Range: `bytes=0-${maxBytes - 1}` },
    maxContentLength: maxBytes + 1024 * 64,
    maxBodyLength: maxBytes + 1024 * 64,
    validateStatus: (s) => (s >= 200 && s < 300) || s === 206
  });

  const buf = Buffer.from(res.data);
  const sliced = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  return sliced.toString('base64');
}

async function recognizeSongFromAudioUrl(audioUrl) {
  requireRapidApiKey();
  requireBase(process.env.SHAZAM_API_BASEURL, 'SHAZAM_API_BASEURL');

  try {
    const detectPath = process.env.SHAZAM_DETECT_PATH || '/songs/v2/detect';
    const contentType = process.env.SHAZAM_CONTENT_TYPE || 'application/json';

    let res;
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const fileField = process.env.SHAZAM_FILE_FIELD || 'file';
      const mode = (process.env.SHAZAM_FILE_MODE || 'url').toLowerCase();

      const form = new URLSearchParams();
      if (mode === 'base64') {
        const audioBase64 = await fetchAudioSampleBase64(audioUrl);
        form.set(fileField, audioBase64);
      } else {
        // Many RapidAPI "Shazam Core" recognize endpoints accept a direct URL in "file".
        form.set(fileField, audioUrl);
      }

      res = await shazamClient.post(detectPath, form.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    } else {
      const audioField = process.env.SHAZAM_AUDIO_FIELD || 'audio';
      const audioBase64 = await fetchAudioSampleBase64(audioUrl);
      res = await shazamClient.post(
        detectPath,
        { [audioField]: audioBase64 },
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    const track = res.data?.track || res.data?.data?.track || res.data?.result?.track || null;
    const title = track?.title || null;
    const artist = track?.subtitle || track?.artist || null;

    if (!title && !artist) {
      const err = new Error('Recognition API could not identify the track');
      err.code = 'NO_MATCH';
      throw err;
    }

    return { title, artist, raw: res.data };
  } catch (err) {
    if (isRateLimitOrForbidden(err)) {
      const e = new Error('Recognition API quota/forbidden');
      e.code = 'RAPIDAPI_LIMIT';
      throw e;
    }
    throw err;
  }
}

module.exports = {
  downloadAllMedia,
  searchYouTube,
  downloadYouTubeMp3,
  recognizeSongFromAudioUrl
};
