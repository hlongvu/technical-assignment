/**
 * PaymentIntentsRepository test — exercises REAL repository code.
 * Checklist §1.3.3 / §3.3.1 / §3.3.3 / §5.1.4 / §5.1.5 / §5.1.6 / §5.2.1.
 *
 * Scenarios:
 *   1. createIntent + findByIdempotencyKey (idempotency).
 *   2. markCompleted: status → COMPLETED, outbox payment.succeeded.v1 appended.
 *   3. markFailed: status → FAILED, outbox payment.failed.v1 appended.
 *   4. insertWebhookInbox: duplicate = no-op (idempotency).
 *   5. markFailedBySeatId: cancels pending intent (seat released compensation).
 *   6. getSeatPrice: server-controlled amount lookup.
 *
 * Uses real Postgres. Prereq: docker compose up (payment_db on 5432).
 */
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-at-least-32-chars';
process.env.CORS_ORIGINS = 'http://localhost';
process.env.POSTGRES_HOST = 'localhost';
process.env.POSTGRES_PORT = '5432';
process.env.POSTGRES_USER = 'seatapp';
process.env.POSTGRES_PASSWORD = 'seatapp_dev_pw';
process.env.POSTGRES_DB = 'payment_db';
process.env.RABBITMQ_URL = 'amqp://seatapp:seatapp_dev_pw@localhost:5672';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.PSP_WEBHOOK_SECRET = 'test-psp-webhook-secret-32-chars';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const DSN = 'postgres://seatapp:seatapp_dev_pw@localhost:5432/payment_db';

let pool: pg.Pool;
let PaymentIntentsRepository: any;
let repo: any;

before(async () => {
  pool = new pg.Pool({ connectionString: DSN });
  const { runMigrations } = await import('../src/migrations/run.ts');
  await runMigrations(pool, 'payment-test');
  const mod = await import('../src/checkout/payment-intents.repository.ts');
  PaymentIntentsRepository = mod.PaymentIntentsRepository;
  repo = new PaymentIntentsRepository(pool);
});

after(async () => {
  if (pool) await pool.end();
});

async function cleanupIntent(id: string): Promise<void> {
  await pool.query('DELETE FROM outbox WHERE aggregate_id = $1', [id]).catch(() => {});
  await pool.query('DELETE FROM payment_intents WHERE id = $1', [id]).catch(() => {});
}

test('createIntent + findByIdempotencyKey: idempotency', async () => {
  const seatId = '00000000-0000-0000-0000-000000000001';
  const userId = randomUUID();
  const holdId = randomUUID();
  const idempotencyKey = randomUUID();
  const pspIntentId = `pi_test_${idempotencyKey}`;

  const intent = await repo.createIntent({
    seatId, userId, holdId, amountCents: 1900, currency: 'USD',
    idempotencyKey, pspIntentId, clientSecret: 'secret_abc',
  });
  assert.ok(intent.id, 'intent should have id');
  assert.equal(intent.status, 'PENDING');
  assert.equal(intent.amount_cents, 1900);

  const found = await repo.findByIdempotencyKey(idempotencyKey);
  assert.ok(found, 'should find by idempotency key');
  assert.equal(found.id, intent.id);

  // Duplicate insert should throw 23505.
  await assert.rejects(
    async () => await repo.createIntent({
      seatId, userId, holdId, amountCents: 1900, currency: 'USD',
      idempotencyKey, pspIntentId: 'pi_dup', clientSecret: 'secret_dup',
    }),
    (e: any) => e.code === '23505',
    'duplicate idempotency_key should throw unique violation',
  );

  await cleanupIntent(intent.id);
});

test('markCompleted: status → COMPLETED, outbox payment.succeeded.v1 appended', async () => {
  const seatId = '00000000-0000-0000-0000-000000000001';
  const userId = randomUUID();
  const holdId = randomUUID();
  const idempotencyKey = randomUUID();
  const pspIntentId = `pi_ok_${idempotencyKey}`;

  const intent = await repo.createIntent({
    seatId, userId, holdId, amountCents: 1900, currency: 'USD',
    idempotencyKey, pspIntentId, clientSecret: 'secret_ok',
  });

  const eventId = randomUUID();
  const r = await repo.markCompleted(pspIntentId, eventId, 'trace-ok');
  assert.ok(r.ok, 'markCompleted should succeed');
  assert.equal(r.intent.status, 'COMPLETED');

  const outbox = await pool.query(
    `SELECT * FROM outbox WHERE aggregate_id = $1 AND event_type = 'payment.succeeded.v1'`,
    [intent.id],
  );
  assert.equal(outbox.rows.length, 1, 'payment.succeeded.v1 outbox row should exist');

  // Idempotency: second markCompleted should be no-op (no pending intent).
  const r2 = await repo.markCompleted(pspIntentId, randomUUID(), 'trace-ok2');
  assert.ok(!r2.ok, 'second markCompleted should be no-op');

  await cleanupIntent(intent.id);
});

test('markFailed: status → FAILED, outbox payment.failed.v1 appended', async () => {
  const seatId = '00000000-0000-0000-0000-000000000001';
  const userId = randomUUID();
  const holdId = randomUUID();
  const idempotencyKey = randomUUID();
  const pspIntentId = `pi_fail_${idempotencyKey}`;

  const intent = await repo.createIntent({
    seatId, userId, holdId, amountCents: 2900, currency: 'USD',
    idempotencyKey, pspIntentId, clientSecret: 'secret_fail',
  });

  const r = await repo.markFailed(pspIntentId, 'payment_failed', randomUUID(), 'trace-fail');
  assert.ok(r.ok, 'markFailed should succeed');
  assert.equal(r.intent.status, 'FAILED');

  const outbox = await pool.query(
    `SELECT * FROM outbox WHERE aggregate_id = $1 AND event_type = 'payment.failed.v1'`,
    [intent.id],
  );
  assert.equal(outbox.rows.length, 1, 'payment.failed.v1 outbox row should exist');

  await cleanupIntent(intent.id);
});

test('insertWebhookInbox: duplicate = no-op', async () => {
  const eventId = 'evt_test_' + randomUUID();
  const type = 'payment_intent.succeeded';
  const payload = { id: eventId, type, created: Math.floor(Date.now() / 1000), data: { object: { id: 'pi_x' } } };

  const first = await repo.insertWebhookInbox(eventId, type, payload);
  assert.ok(first, 'first insert should return true (new)');

  const second = await repo.insertWebhookInbox(eventId, type, payload);
  assert.ok(!second, 'second insert should return false (dedup)');

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM webhook_inbox WHERE stripe_event_id = $1', [eventId]);
  assert.equal(rows[0].n, 1, 'exactly 1 row');

  await repo.markWebhookProcessed(eventId);
  const proc = await pool.query('SELECT processed_at FROM webhook_inbox WHERE stripe_event_id = $1', [eventId]);
  assert.ok(proc.rows[0].processed_at, 'processed_at should be set');

  await pool.query('DELETE FROM webhook_inbox WHERE stripe_event_id = $1', [eventId]);
});

test('markFailedBySeatId: cancels pending intent (seat released compensation)', async () => {
  const seatId = '00000000-0000-0000-0000-000000000002';
  const userId = randomUUID();
  const holdId = randomUUID();
  const idempotencyKey = randomUUID();
  const pspIntentId = `pi_seat_rel_${idempotencyKey}`;

  const intent = await repo.createIntent({
    seatId, userId, holdId, amountCents: 2900, currency: 'USD',
    idempotencyKey, pspIntentId, clientSecret: 'secret_rel',
  });

  const r = await repo.markFailedBySeatId(seatId, 'seat_released', randomUUID(), 'trace-rel');
  assert.ok(r.ok, 'markFailedBySeatId should succeed');
  assert.equal(r.intent.status, 'FAILED');
  assert.equal(r.intent.id, intent.id);

  const outbox = await pool.query(
    `SELECT * FROM outbox WHERE aggregate_id = $1 AND event_type = 'payment.failed.v1'`,
    [intent.id],
  );
  assert.equal(outbox.rows.length, 1, 'payment.failed.v1 outbox should exist for cancelled intent');

  await cleanupIntent(intent.id);
});

test('getSeatPrice: server-controlled amount lookup', async () => {
  const price = await repo.getSeatPrice('00000000-0000-0000-0000-000000000001');
  assert.ok(price, 'seeded price should be found');
  assert.equal(price.price_cents, 1900);
  assert.equal(price.currency, 'USD');
  assert.equal(price.label, 'A1');

  const unknown = await repo.getSeatPrice('00000000-0000-0000-0000-999999999999');
  assert.equal(unknown, null, 'unknown seat should return null');
});
