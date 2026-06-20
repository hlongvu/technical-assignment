/**
 * JwtService test — exercises REAL code. Checklist §2.1.10 (AT TTL) / §2.1.7 (tv claim).
 */
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-at-least-32-chars';
process.env.CORS_ORIGINS = 'http://localhost';
process.env.POSTGRES_HOST = 'localhost';
process.env.POSTGRES_PORT = '5432';
process.env.POSTGRES_USER = 'seatapp';
process.env.POSTGRES_PASSWORD = 'seatapp_dev_pw';
process.env.POSTGRES_DB = 'auth_db';
process.env.RABBITMQ_URL = 'amqp://seatapp:seatapp_dev_pw@localhost:5672';
process.env.REDIS_URL = 'redis://localhost:6379';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

let JwtService: any;
let jwt: any;

before(async () => {
  const mod = await import('../src/auth/jwt.service.ts');
  JwtService = mod.JwtService;
  jwt = new JwtService();
});

test('signAccessToken: produces verifiable JWT with tv claim', () => {
  const userId = randomUUID();
  const email = 'test@example.com';
  const tokenVersion = 3;
  const token = jwt.signAccessToken(userId, email, tokenVersion);

  assert.ok(token, 'token should be produced');
  const parts = token.split('.');
  assert.equal(parts.length, 3, 'JWT should have 3 parts');

  const claims = jwt.verifyAccessToken(token);
  assert.equal(claims.sub, userId);
  assert.equal(claims.email, email);
  assert.equal(claims.tv, tokenVersion, 'tv (tokenVersion) claim should match');
  assert.ok(claims.exp > claims.iat, 'exp should be after iat');
});

test('AT TTL is 15 minutes (900s)', () => {
  const token = jwt.signAccessToken(randomUUID(), 'test@example.com', 0);
  const claims = jwt.verifyAccessToken(token);
  const ttlSec = claims.exp - claims.iat;
  assert.equal(ttlSec, 900, 'AT TTL should be 900 seconds (15 min)');
});

test('verifyAccessToken: rejects tampered token', () => {
  const token = jwt.signAccessToken(randomUUID(), 'test@example.com', 0);
  const tampered = token.slice(0, -5) + 'XXXXX';
  assert.throws(() => jwt.verifyAccessToken(tampered), 'tampered token should throw');
});

test('verifyAccessToken: rejects token signed with different secret', async () => {
  const jwtLib = (await import('jsonwebtoken')).default;
  const badToken = jwtLib.sign({ sub: randomUUID() }, 'different-secret-32-chars-long-here!!');
  assert.throws(() => jwt.verifyAccessToken(badToken), 'token with wrong secret should throw');
});
