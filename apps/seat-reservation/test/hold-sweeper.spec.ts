/**
 * HoldSweeper test — exercises REAL sweeper code. Checklist §3.2.1 / §3.2.2 / §4.4.4.
 *
 * Scenarios:
 *   1. Expired hold → sweeper releases it, seat AVAILABLE, outbox seat.released.v1 appended.
 *   2. Non-expired hold → sweeper does nothing.
 *
 * Uses real Postgres. Prereq: docker compose up (seat_db on 5432).
 */
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-at-least-32-chars';
process.env.CORS_ORIGINS = 'http://localhost';
process.env.POSTGRES_HOST = 'localhost';
process.env.POSTGRES_PORT = '5432';
process.env.POSTGRES_USER = 'seatapp';
process.env.POSTGRES_PASSWORD = 'seatapp_dev_pw';
process.env.POSTGRES_DB = 'seat_db';
process.env.RABBITMQ_URL = 'amqp://seatapp:seatapp_dev_pw@localhost:5672';
process.env.REDIS_URL = 'redis://localhost:6379';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const DSN = 'postgres://seatapp:seatapp_dev_pw@localhost:5432/seat_db';

let pool: pg.Pool;
let HoldSweeper: any;
let sweeper: any;

before(async () => {
  pool = new pg.Pool({ connectionString: DSN });
  const { runMigrations } = await import('../src/migrations/run.ts');
  await runMigrations(pool, 'seat-test');
  const mod = await import('../src/holds/hold-sweeper.ts');
  HoldSweeper = mod.HoldSweeper;

  // Stub event bus.
  const bus = { emit: () => {} };
  const loggerService = {
    create: () => ({
      debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
      child: function () { return this; },
    }),
  };
  sweeper = new HoldSweeper(pool, loggerService as any, bus as any);
});

after(async () => {
  if (pool) await pool.end();
});

async function seedSeat(): Promise<string> {
  const seatId = randomUUID();
  await pool.query(
    `INSERT INTO seats (id, label, price_cents, currency, status) VALUES ($1, 'S', 100, 'USD', 'AVAILABLE')`,
    [seatId],
  );
  return seatId;
}

test('sweeper: expired hold → released, seat AVAILABLE, outbox appended', async () => {
  const seatId = await seedSeat();
  const userId = randomUUID();
  try {
    // Insert an already-expired hold directly.
    const holdId = randomUUID();
    await pool.query(
      `INSERT INTO holds (id, seat_id, user_id, status, held_until)
       VALUES ($1, $2, $3, 'HELD', NOW() - interval '1 minute')`,
      [holdId, seatId, userId],
    );
    await pool.query(`UPDATE seats SET status = 'HELD' WHERE id = $1`, [seatId]);

    await sweeper.tick();

    const hold = await pool.query('SELECT status FROM holds WHERE id = $1', [holdId]);
    assert.equal(hold.rows[0].status, 'RELEASED', 'expired hold should be RELEASED');

    const seat = await pool.query('SELECT status FROM seats WHERE id = $1', [seatId]);
    assert.equal(seat.rows[0].status, 'AVAILABLE', 'seat should be AVAILABLE');

    const outbox = await pool.query(`SELECT * FROM outbox WHERE aggregate_id = $1 AND event_type = 'seat.released.v1'`, [holdId]);
    assert.ok(outbox.rows.length >= 1, 'seat.released.v1 outbox row should exist');
  } finally {
    await pool.query('DELETE FROM outbox WHERE aggregate_id IN (SELECT id FROM holds WHERE seat_id = $1)', [seatId]).catch(() => {});
    await pool.query('DELETE FROM holds WHERE seat_id = $1', [seatId]).catch(() => {});
    await pool.query('DELETE FROM seats WHERE id = $1', [seatId]).catch(() => {});
  }
});

test('sweeper: non-expired hold → untouched', async () => {
  const seatId = await seedSeat();
  const userId = randomUUID();
  try {
    const holdId = randomUUID();
    await pool.query(
      `INSERT INTO holds (id, seat_id, user_id, status, held_until)
       VALUES ($1, $2, $3, 'HELD', NOW() + interval '10 minutes')`,
      [holdId, seatId, userId],
    );
    await pool.query(`UPDATE seats SET status = 'HELD' WHERE id = $1`, [seatId]);

    await sweeper.tick();

    const hold = await pool.query('SELECT status FROM holds WHERE id = $1', [holdId]);
    assert.equal(hold.rows[0].status, 'HELD', 'non-expired hold should remain HELD');

    const seat = await pool.query('SELECT status FROM seats WHERE id = $1', [seatId]);
    assert.equal(seat.rows[0].status, 'HELD', 'seat should remain HELD');
  } finally {
    await pool.query('DELETE FROM outbox WHERE aggregate_id IN (SELECT id FROM holds WHERE seat_id = $1)', [seatId]).catch(() => {});
    await pool.query('DELETE FROM holds WHERE seat_id = $1', [seatId]).catch(() => {});
    await pool.query('DELETE FROM seats WHERE id = $1', [seatId]).catch(() => {});
  }
});
