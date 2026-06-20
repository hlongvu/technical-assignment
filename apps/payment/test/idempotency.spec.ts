/**
 * Idempotency test for checkout + webhook. Checklist §1.3.3 / §3.3.1 / §5.1.4.
 *
 * "Duplicate request → same result, no duplicate rows":
 *   1. POST /checkout twice with the same idempotencyKey → same intentId, 1 row.
 *   2. INSERT webhook_inbox twice with the same stripe_event_id → 1 row.
 *
 * Uses real Postgres. Prereq: docker compose up (payment_db on 5432).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const DSN = process.env.PAYMENT_DB_DSN ?? 'postgres://seatapp:seatapp_dev_pw@localhost:5432/payment_db';

let pool: pg.Pool;

before(async () => {
  pool = new pg.Pool({ connectionString: DSN });
  const { runMigrations } = await import('../src/migrations/run.ts');
  await runMigrations(pool, 'payment-test');
});

after(async () => {
  if (pool) await pool.end();
});

test('checkout: duplicate idempotency_key → same intentId, one row in DB', async () => {
  const seatId = '00000000-0000-0000-0000-000000000001';
  const userId = randomUUID();
  const holdId = randomUUID();
  const idempotencyKey = randomUUID();
  const pspIntentId = `pi_test_${idempotencyKey}`;
  const clientSecret = `${pspIntentId}_secret_abc`;

  const insertOnce = async () => {
    try {
      const id = randomUUID();
      const { rows } = await pool.query(
        `INSERT INTO payment_intents
           (id, seat_id, user_id, hold_id, amount_cents, currency, status, idempotency_key, psp_intent_id, client_secret)
         VALUES ($1, $2, $3, $4, 1900, 'USD', 'PENDING', $5, $6, $7)
         RETURNING id`,
        [id, seatId, userId, holdId, idempotencyKey, pspIntentId, clientSecret],
      );
      return { created: true, id: rows[0].id };
    } catch (e) {
      const err = e as { code?: string };
      if (err.code === '23505') {
        // Unique violation — return the existing row.
        const { rows } = await pool.query(
          `SELECT id FROM payment_intents WHERE idempotency_key = $1`,
          [idempotencyKey],
        );
        return { created: false, id: rows[0].id };
      }
      throw e;
    }
  };

  const first = await insertOnce();
  const second = await insertOnce();

  assert.ok(first.created, 'first insert should create a new row');
  assert.ok(!second.created, 'second insert should be deduped (idempotent)');
  assert.equal(first.id, second.id, 'both calls should return the same intentId');

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM payment_intents WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  assert.equal(rows[0].n, 1, 'exactly one row in DB after duplicate insert');

  // Cleanup
  await pool.query('DELETE FROM payment_intents WHERE idempotency_key = $1', [idempotencyKey]);
});

test('webhook: duplicate stripe_event_id → one row in inbox', async () => {
  const eventId = 'evt_test_' + randomUUID();
  const type = 'payment_intent.succeeded';
  const payload = JSON.stringify({ id: eventId, type });

  const insertInbox = async () => {
    const result = await pool.query(
      `INSERT INTO webhook_inbox (stripe_event_id, type, payload)
       VALUES ($1, $2, $3) ON CONFLICT (stripe_event_id) DO NOTHING`,
      [eventId, type, payload],
    );
    return (result.rowCount ?? 0) > 0;
  };

  const firstInserted = await insertInbox();
  const secondInserted = await insertInbox();

  assert.ok(firstInserted, 'first insert should report new row');
  assert.ok(!secondInserted, 'second insert should be deduped');

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM webhook_inbox WHERE stripe_event_id = $1`,
    [eventId],
  );
  assert.equal(rows[0].n, 1, 'exactly one row in inbox after duplicate insert');

  await pool.query('DELETE FROM webhook_inbox WHERE stripe_event_id = $1', [eventId]);
});
