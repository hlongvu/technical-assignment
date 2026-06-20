/**
 * HoldsRepository test — exercises the REAL repository code (not re-implemented SQL).
 * Checklist §1.3.1 / §1.3.2 / §3.1.1-§3.1.5 / §5.2.5.
 *
 * Scenarios:
 *   1. insertHoldTx → hold created, seat marked HELD, outbox row appended.
 *   2. Concurrent insertHoldTx on same seat → exactly 1 wins, 1 conflict.
 *   3. releaseHold → hold RELEASED, seat AVAILABLE, outbox row appended.
 *   4. reserveHold idempotency → duplicate event = no-op (consumed_events).
 *   5. insertHoldTx on same seat for same user → user_has_hold conflict.
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
let HoldsRepository: any;
let repo: any;

before(async () => {
  pool = new pg.Pool({ connectionString: DSN });
  const { runMigrations } = await import('../src/migrations/run.ts');
  await runMigrations(pool, 'seat-test');
  const mod = await import('../src/holds/holds.repository.ts');
  HoldsRepository = mod.HoldsRepository;
  repo = new HoldsRepository(pool);
});

after(async () => {
  if (pool) await pool.end();
});

async function seedSeat(label?: string): Promise<string> {
  const seatId = randomUUID();
  await pool.query(
    `INSERT INTO seats (id, label, price_cents, currency, status) VALUES ($1, $2, 100, 'USD', 'AVAILABLE')`,
    [seatId, label ?? `T-${seatId.slice(0, 8)}`],
  );
  return seatId;
}

test('insertHoldTx: hold created, seat HELD, outbox row appended', async () => {
  const seatId = await seedSeat();
  const userId = randomUUID();
  try {
    const result = await repo.insertHoldTx(seatId, userId, 'trace-test');
    assert.ok(result.ok, 'hold should succeed');
    assert.ok(result.hold.id, 'hold should have id');
    assert.equal(result.hold.status, 'HELD');
    assert.equal(result.hold.seat_id, seatId);

    const seat = await pool.query('SELECT status FROM seats WHERE id = $1', [seatId]);
    assert.equal(seat.rows[0].status, 'HELD', 'seat should be HELD');

    const outbox = await pool.query('SELECT * FROM outbox WHERE aggregate_id = $1', [result.hold.id]);
    assert.equal(outbox.rows.length, 1, 'outbox row should be appended');
    assert.equal(outbox.rows[0].event_type, 'seat.held.v1');
  } finally {
    await pool.query('DELETE FROM outbox WHERE aggregate_id IN (SELECT id FROM holds WHERE seat_id = $1)', [seatId]).catch(() => {});
    await pool.query('DELETE FROM holds WHERE seat_id = $1', [seatId]).catch(() => {});
    await pool.query('DELETE FROM seats WHERE id = $1', [seatId]).catch(() => {});
  }
});

test('concurrent insertHoldTx on same seat → exactly 1 wins', async () => {
  const seatId = await seedSeat();
  const userA = randomUUID();
  const userB = randomUUID();
  try {
    const results = await Promise.allSettled([
      repo.insertHoldTx(seatId, userA, 'trace-a'),
      repo.insertHoldTx(seatId, userB, 'trace-b'),
    ]);

    const winners = results.filter((r) => r.status === 'fulfilled' && r.value.ok);
    const conflicts = results.filter((r) => r.status === 'fulfilled' && !r.value.ok);
    const thrown = results.filter((r) => r.status === 'rejected');

    assert.equal(winners.length, 1, `expected 1 winner, got ${winners.length}`);
    assert.equal(conflicts.length, 1, 'expected 1 conflict result');
    assert.equal(thrown.length, 0, 'should not throw — conflicts are structured results');

    const heldRows = await pool.query(`SELECT * FROM holds WHERE seat_id = $1 AND status = 'HELD'`, [seatId]);
    assert.equal(heldRows.rows.length, 1, 'exactly 1 HELD row in DB');
  } finally {
    await pool.query('DELETE FROM outbox WHERE aggregate_id IN (SELECT id FROM holds WHERE seat_id = $1)', [seatId]).catch(() => {});
    await pool.query('DELETE FROM holds WHERE seat_id = $1', [seatId]).catch(() => {});
    await pool.query('DELETE FROM seats WHERE id = $1', [seatId]).catch(() => {});
  }
});

test('same user holding 2 seats → user_has_hold conflict', async () => {
  const seatA = await seedSeat('A');
  const seatB = await seedSeat('B');
  const userId = randomUUID();
  try {
    const r1 = await repo.insertHoldTx(seatA, userId, 'trace-1');
    assert.ok(r1.ok, 'first hold should succeed');

    const r2 = await repo.insertHoldTx(seatB, userId, 'trace-2');
    assert.ok(!r2.ok, 'second hold should conflict');
    assert.equal(r2.reason, 'user_has_hold', 'conflict reason should be user_has_hold');
  } finally {
    await pool.query('DELETE FROM outbox WHERE aggregate_id IN (SELECT id FROM holds WHERE seat_id IN ($1, $2))', [seatA, seatB]).catch(() => {});
    await pool.query('DELETE FROM holds WHERE seat_id IN ($1, $2)', [seatA, seatB]).catch(() => {});
    await pool.query('DELETE FROM seats WHERE id IN ($1, $2)', [seatA, seatB]).catch(() => {});
  }
});

test('releaseHold: hold RELEASED, seat AVAILABLE, outbox appended', async () => {
  const seatId = await seedSeat();
  const userId = randomUUID();
  try {
    const holdResult = await repo.insertHoldTx(seatId, userId, 'trace-rel');
    assert.ok(holdResult.ok);

    const { released, seatId: sid } = await repo.releaseHold(holdResult.hold.id, 'user_cancelled', 'trace-rel');
    assert.ok(released, 'hold should be released');
    assert.equal(sid, seatId);

    const seat = await pool.query('SELECT status FROM seats WHERE id = $1', [seatId]);
    assert.equal(seat.rows[0].status, 'AVAILABLE', 'seat should be AVAILABLE after release');

    const outbox = await pool.query(`SELECT * FROM outbox WHERE event_type = 'seat.released.v1' AND aggregate_id = $1`, [holdResult.hold.id]);
    assert.ok(outbox.rows.length >= 1, 'seat.released.v1 outbox row should exist');
  } finally {
    await pool.query('DELETE FROM outbox WHERE aggregate_id IN (SELECT id FROM holds WHERE seat_id = $1)', [seatId]).catch(() => {});
    await pool.query('DELETE FROM holds WHERE seat_id = $1', [seatId]).catch(() => {});
    await pool.query('DELETE FROM seats WHERE id = $1', [seatId]).catch(() => {});
  }
});

test('reserveHold idempotency: duplicate event = no-op', async () => {
  const seatId = await seedSeat();
  const userId = randomUUID();
  try {
    const holdResult = await repo.insertHoldTx(seatId, userId, 'trace-res');
    assert.ok(holdResult.ok);

    const eventId = randomUUID();
    const consumerGroup = 'seat-service';

    const r1 = await repo.reserveHold(holdResult.hold.id, eventId, consumerGroup, 'trace-1');
    assert.ok(r1.reserved, 'first reserve should succeed');
    assert.equal(r1.seatId, seatId);

    const r2 = await repo.reserveHold(holdResult.hold.id, eventId, consumerGroup, 'trace-2');
    assert.ok(!r2.reserved, 'duplicate event should be no-op (idempotent)');

    const consumedCount = await pool.query(
      `SELECT COUNT(*)::int AS n FROM consumed_events WHERE event_id = $1 AND consumer_group = $2`,
      [eventId, consumerGroup],
    );
    assert.equal(consumedCount.rows[0].n, 1, 'exactly 1 consumed_events row');
  } finally {
    await pool.query('DELETE FROM consumed_events WHERE consumer_group = $1', ['seat-service']).catch(() => {});
    await pool.query('DELETE FROM outbox WHERE aggregate_id IN (SELECT id FROM holds WHERE seat_id = $1)', [seatId]).catch(() => {});
    await pool.query('DELETE FROM holds WHERE seat_id = $1', [seatId]).catch(() => {});
    await pool.query('DELETE FROM seats WHERE id = $1', [seatId]).catch(() => {});
  }
});
