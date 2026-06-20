/**
 * CircuitBreaker test — exercises REAL code. Checklist §4.4.3.
 *
 * No DB needed — pure logic test.
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
process.env.PSP_TIMEOUT_MS = '2000';
process.env.PSP_CB_ERROR_THRESHOLD = '4';
process.env.PSP_CB_RESET_MS = '500';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let CircuitBreaker: any;
let breaker: any;

before(async () => {
  const mod = await import('../src/psps/circuit-breaker.ts');
  CircuitBreaker = mod.CircuitBreaker;
  breaker = new CircuitBreaker();
});

test('circuit starts closed', () => {
  assert.equal(breaker.currentState, 'closed');
});

test('circuit opens after enough failures', async () => {
  // PSP_CB_ERROR_THRESHOLD=4, opens when failures*2 >= 4, i.e., at 2 failures.
  const fail = async () => { throw new Error('fail'); };
  await assert.rejects(() => breaker.exec(fail));
  assert.equal(breaker.currentState, 'closed', 'still closed after 1 failure');
  await assert.rejects(() => breaker.exec(fail));
  assert.equal(breaker.currentState, 'open', 'should open after 2 failures');
});

test('open circuit rejects immediately with circuit_open', async () => {
  // The breaker is open from the previous test.
  await assert.rejects(
    () => breaker.exec(async () => 'should not run'),
    (e: any) => e.message === 'circuit_open',
    'open circuit should reject with circuit_open',
  );
});

test('circuit transitions to half_open after reset time, then closes on success', async () => {
  // Wait for reset window (PSP_CB_RESET_MS=500ms).
  await new Promise((r) => setTimeout(r, 600));

  // Next call should be half_open and succeed.
  const ok = async () => 'recovered';
  const result = await breaker.exec(ok);
  assert.equal(result, 'recovered');
  assert.equal(breaker.currentState, 'closed', 'should close after successful half-open probe');
});
