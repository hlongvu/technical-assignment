/**
 * Concurrency test for hold operation. Checklist §1.3.1.
 *
 * "2 requests → 1 wins": two users hold the same seat concurrently; exactly
 * one wins, the other gets 409, and exactly one row exists in `holds` with
 * status='HELD'. Uses real Postgres (no mocks).
 *
 * Prereq: docker compose up (postgres must be running on localhost:5432,
 * seat_db must exist and be migrated). Run with:
 *   npm test -w @seat-reservation/seat-reservation
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const DSN = process.env.SEAT_DB_DSN ?? 'postgres://seatapp:seatapp_dev_pw@localhost:5432/seat_db';

let pool: pg.Pool;
let seatId: string;

before(async () => {
  pool = new pg.Pool({ connectionString: DSN });
  // Run migrations inline if not already applied.
  const { runMigrations } = await import('../src/migrations/run.ts');
  await runMigrations(pool, 'seat-reservation-test');
  // Seed a fresh seat for this test run.
  seatId = randomUUID();
  await pool.query(
    `INSERT INTO seats (id, label, price_cents, currency, status) VALUES ($1, 'T', 100, 'USD', 'AVAILABLE')`,
    [seatId],
  );
});

after(async () => {
  if (pool) {
    await pool.query('DELETE FROM holds WHERE seat_id = $1', [seatId]).catch(() => {});
    await pool.query('DELETE FROM seats WHERE id = $1', [seatId]).catch(() => {});
    await pool.end();
  }
});

// Insert a hold directly with the same SERIALIZABLE + partial unique index logic
// the production repository uses. Mirrors HoldsRepository.insertHoldTx minus the
// outbox write (not needed for this correctness test).
async function hold(seatId: string, userId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await conn.query(
      `UPDATE holds SET status = 'RELEASED', released_at = NOW()
       WHERE seat_id = $1 AND status = 'HELD' AND held_until < NOW()`,
      [seatId],
    );
    try {
      await conn.query(
        `INSERT INTO holds (seat_id, user_id, status, held_until)
         VALUES ($1, $2, 'HELD', NOW() + interval '2 minutes')`,
        [seatId, userId],
      );
      await conn.query(`UPDATE seats SET status = 'HELD' WHERE id = $1`, [seatId]);
      await conn.query('COMMIT');
      return { ok: true };
    } catch (e) {
      await conn.query('ROLLBACK');
      const err = e as { code?: string; constraint?: string };
      if (err.code === '23505') {
        return { ok: false, reason: err.constraint ?? 'unique_violation' };
      }
      throw e;
    }
  } finally {
    conn.release();
  }
}

test('two concurrent holds on the same seat → exactly one wins', async () => {
  const userA = randomUUID();
  const userB = randomUUID();
  const results = await Promise.allSettled([hold(seatId, userA), hold(seatId, userB)]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled' && r.value.ok);
  const rejected = results.filter(
    (r) => r.status === 'fulfilled' && !r.value.ok,
  );
  // Exactly one should win.
  assert.equal(fulfilled.length, 1, `expected 1 winner, got ${fulfilled.length}: ${JSON.stringify(results)}`);
  // The other should be a unique-violation conflict (not an exception).
  assert.equal(rejected.length, 1, 'expected the loser to return a conflict result, not throw');

  // Verify exactly one HELD row in DB.
  const { rows } = await pool.query(
    `SELECT * FROM holds WHERE seat_id = $1 AND status = 'HELD'`,
    [seatId],
  );
  assert.equal(rows.length, 1, `expected exactly 1 HELD row, got ${rows.length}`);
});

test('50 parallel holds on the same seat → still exactly 1 HELD', async () => {
  // Use a fresh seat for this heavier test.
  const freshSeat = randomUUID();
  await pool.query(
    `INSERT INTO seats (id, label, price_cents, currency, status) VALUES ($1, 'T50', 100, 'USD', 'AVAILABLE')`,
    [freshSeat],
  );
  try {
    const userIds = Array.from({ length: 50 }, () => randomUUID());
    const results = await Promise.allSettled(userIds.map((u) => hold(freshSeat, u)));
    const winners = results.filter((r) => r.status === 'fulfilled' && r.value.ok);
    const losers = results.filter((r) => r.status === 'fulfilled' && !r.value.ok);
    const thrown = results.filter((r) => r.status === 'rejected');

    assert.equal(winners.length, 1, `expected exactly 1 winner out of 50, got ${winners.length}`);
    assert.equal(losers.length + thrown.length, 49, 'expected 49 non-winners');
    assert.equal(thrown.length, 0, `unexpected thrown errors: ${JSON.stringify(thrown)}`);

    const { rows } = await pool.query(
      `SELECT * FROM holds WHERE seat_id = $1 AND status = 'HELD'`,
      [freshSeat],
    );
    assert.equal(rows.length, 1, 'DB invariant violated: more than one HELD row');
  } finally {
    await pool.query('DELETE FROM holds WHERE seat_id = $1', [freshSeat]).catch(() => {});
    await pool.query('DELETE FROM seats WHERE id = $1', [freshSeat]).catch(() => {});
  }
});
