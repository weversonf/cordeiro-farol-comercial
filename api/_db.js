import pg from 'pg';

const { Pool } = pg;
let pool;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.PGHOST || process.env.DB_HOST,
      port: Number(process.env.PGPORT || process.env.DB_PORT || 6543),
      database: process.env.PGDATABASE || process.env.DB_NAME || 'postgres',
      user: process.env.PGUSER || process.env.DB_USER,
      password: process.env.PGPASSWORD || process.env.DB_PASS,
      ssl: { rejectUnauthorized: false },
      max: 4,
      connectionTimeoutMillis: 25000
    });
  }
  return pool;
}

export function toNumber(value) {
  return Number(value || 0);
}
