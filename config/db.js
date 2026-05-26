const { Pool } = require('pg');

function shouldUseSsl(databaseUrl) {
  if (!databaseUrl) return false;
  return !/localhost|127\.0\.0\.1/i.test(databaseUrl);
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

