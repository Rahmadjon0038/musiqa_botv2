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
}

module.exports = { pool, initDb };
