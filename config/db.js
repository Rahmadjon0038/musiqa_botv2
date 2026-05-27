const { Pool } = require('pg');

function shouldUseSsl(databaseUrl) {
  if (!databaseUrl) return false;
  // Prefer explicit control via env.
  const envMode = String(process.env.PGSSLMODE || '').toLowerCase();
  if (envMode === 'disable' || envMode === 'off' || envMode === 'false') return false;
  if (envMode === 'require' || envMode === 'verify-ca' || envMode === 'verify-full') return true;

  // If URL explicitly asks for SSL, honor it.
  try {
    const u = new URL(databaseUrl);
    const sslmode = String(u.searchParams.get('sslmode') || '').toLowerCase();
    if (sslmode === 'disable') return false;
    if (sslmode === 'require' || sslmode === 'verify-ca' || sslmode === 'verify-full') return true;

    // Default: do NOT use SSL for local/dev and docker-compose service names.
    const host = (u.hostname || '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === 'db') return false;

    // For remote hosts, SSL is commonly required; keep it on by default.
    return true;
  } catch {
    // If parsing fails, keep previous safe default: no SSL.
    return false;
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: shouldUseSsl(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined
});

async function initDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username VARCHAR(100),
      first_name VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_cache (
      cache_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      file_id TEXT NOT NULL,
      storage_chat_id BIGINT,
      storage_message_id BIGINT,
      meta JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function getMediaCache(cacheKey) {
  const res = await pool.query(
    `SELECT cache_key, kind, file_id, storage_chat_id, storage_message_id, meta
     FROM media_cache
     WHERE cache_key = $1
     LIMIT 1`,
    [cacheKey]
  );
  return res.rows?.[0] || null;
}

async function upsertMediaCache({ cacheKey, kind, fileId, storageChatId = null, storageMessageId = null, meta = null }) {
  await pool.query(
    `INSERT INTO media_cache (cache_key, kind, file_id, storage_chat_id, storage_message_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (cache_key)
     DO UPDATE SET
       kind = EXCLUDED.kind,
       file_id = EXCLUDED.file_id,
       storage_chat_id = COALESCE(EXCLUDED.storage_chat_id, media_cache.storage_chat_id),
       storage_message_id = COALESCE(EXCLUDED.storage_message_id, media_cache.storage_message_id),
       meta = COALESCE(EXCLUDED.meta, media_cache.meta),
       updated_at = NOW()`,
    [cacheKey, kind, fileId, storageChatId, storageMessageId, meta]
  );
}

module.exports = { pool, initDb, getMediaCache, upsertMediaCache };
