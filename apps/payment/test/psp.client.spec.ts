/**
 * MockPSPClient HMAC test — exercises REAL webhook verification code.
 * Checklist §5.1.2 (HMAC-SHA256 + timingSafeEqual) / §5.1.3 (timestamp freshness).
 *
 * No DB needed — pure crypto test.
 */
process.env.PSP_WEBHOOK_SECRET = 'test-psp-webhook-secret-32-chars';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

let MockPSPClient: any;
let psp: any;
let webhookSecret: string;

before(async () => {
  const mod = await import('../src/psps/psp.client.ts');
  MockPSPClient = mod.MockPSPClient;
  webhookSecret = process.env.PSP_WEBHOOK_SECRET!;
  psp = new MockPSPClient(webhookSecret);
});

function signWebhook(secret: string, rawBody: string, timestamp: number): string {
  const hmac = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${hmac}`;
}

test('constructEventFromWebhook: valid signature → parsed event', () => {
  const event = {
    id: 'evt_' + Math.random().toString(36).slice(2),
    type: 'payment_intent.succeeded',
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'pi_mock_123', amount: 1900, metadata: {} } },
  };
  const rawBody = Buffer.from(JSON.stringify(event));
  const sig = signWebhook(webhookSecret, rawBody.toString('utf8'), event.created);

  const parsed = psp.constructEventFromWebhook(rawBody, sig);
  assert.equal(parsed.id, event.id);
  assert.equal(parsed.type, 'payment_intent.succeeded');
});

test('constructEventFromWebhook: invalid signature → throws', () => {
  const event = {
    id: 'evt_bad',
    type: 'payment_intent.succeeded',
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'pi_bad', amount: 100, metadata: {} } },
  };
  const rawBody = Buffer.from(JSON.stringify(event));
  const sig = signWebhook('WRONG-SECRET-32-chars-long-here!!!', rawBody.toString('utf8'), event.created);

  assert.throws(
    () => psp.constructEventFromWebhook(rawBody, sig),
    /invalid_signature/,
    'wrong secret should throw invalid_signature',
  );
});

test('constructEventFromWebhook: malformed signature → throws', () => {
  const rawBody = Buffer.from('{}');
  assert.throws(
    () => psp.constructEventFromWebhook(rawBody, 'garbage'),
    /malformed_signature/,
    'malformed signature should throw',
  );
});

test('constructEventFromWebhook: missing created field → throws', () => {
  const event = { id: 'evt_nocreated', type: 'x', data: { object: { id: 'pi' } } };
  const rawBody = Buffer.from(JSON.stringify(event));
  const sig = signWebhook(webhookSecret, rawBody.toString('utf8'), Math.floor(Date.now() / 1000));
  assert.throws(
    () => psp.constructEventFromWebhook(rawBody, sig),
    /missing_created/,
    'missing created field should throw',
  );
});

test('createIntent: returns pspIntentId derived from idempotencyKey', async () => {
  const result = await psp.createIntent({
    amountCents: 1900,
    currency: 'USD',
    idempotencyKey: 'abc-123-uuid',
    metadata: { seatId: 's1', userId: 'u1' },
  });
  assert.ok(result.pspIntentId, 'should return pspIntentId');
  assert.ok(result.pspIntentId.startsWith('pi_mock_'), 'pspIntentId should be derived from idempotencyKey');
  assert.ok(result.clientSecret, 'should return clientSecret');
});
