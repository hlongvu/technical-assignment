import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Tiny forward-only SQL migration runner.
 * Tracks applied migrations in `_migrations` table.
 * Naming convention: YYYYMMDDHHMMSS_<name>.sql
 */
export async function runMigrations(pool: Pool, service: string): Promise<void> {
  const migrationsDir = __dirname;
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const conn = await pool.connect();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    const { rows } = await conn.query('SELECT filename FROM _migrations');
    const applied = new Set(rows.map((r) => r.filename as string));

    for (const filename of files) {
      if (applied.has(filename)) continue;
      const sql = readFileSync(join(migrationsDir, filename), 'utf8');
      await conn.query('BEGIN');
      try {
        await runSqlBlock(conn, sql);
        await conn.query('INSERT INTO _migrations (filename) VALUES ($1)', [filename]);
        await conn.query('COMMIT');
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
          level: 'info', service, action: 'migration_applied', filename,
        }));
      } catch (e) {
        await conn.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    conn.release();
  }
}

const statementSeparator = /;\s*\n/g;

async function runSqlBlock(conn: PoolClient, sql: string): Promise<void> {
  // Split on ; + newline. pg's query() handles individual statements fine for our DDL.
  const stmts = sql.split(statementSeparator).map((s) => s.trim()).filter(Boolean);
  for (const stmt of stmts) {
    await conn.query(stmt);
  }
}

// Allow running this file directly: `npm run migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  const env = z.object({
    POSTGRES_HOST: z.string(),
    POSTGRES_PORT: z.coerce.number(),
    POSTGRES_USER: z.string(),
    POSTGRES_PASSWORD: z.string(),
    POSTGRES_DB: z.string(),
  }).parse(process.env);

  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB,
  });
  await runMigrations(pool, 'auth');
  await pool.end();
}
