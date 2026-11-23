import pg from 'pg';
import { env, requireEnv } from './env.mjs';

const { Pool } = pg;
let pool;

// DATE 一律以 'YYYY-MM-DD' 字符串返回，避免时区换算导致日期偏移一天。
pg.types.setTypeParser(1082, (value) => value);

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: requireEnv('databaseUrl'),
      options: '-c search_path=cinescope,public',
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (error) => {
      console.error('[db] idle client error:', error.message);
    });
  }
  return pool;
}

export async function query(text, params = []) {
  const result = await getPool().query(text, params);
  return result;
}

export async function one(text, params = []) {
  const { rows } = await query(text, params);
  return rows[0] ?? null;
}

export async function many(text, params = []) {
  const { rows } = await query(text, params);
  return rows;
}

export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function logPublish({ target, status, reference, detail = {}, error }) {
  if (!env.databaseUrl) return;
  await query(
    `INSERT INTO publish_logs (target, status, reference, detail, error, finished_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [target, status, reference ?? null, JSON.stringify(detail), error ?? null],
  );
}
