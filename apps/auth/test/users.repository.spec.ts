/**
 * UsersRepository + password tests — exercises REAL code.
 * Checklist §2.1.9 (argon2id + timing equalization) / §2.1.7 (tokenVersion).
 *
 * Prereq: docker compose up (auth_db on 5432).
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

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const DSN = 'postgres://seatapp:seatapp_dev_pw@localhost:5432/auth_db';

let pool: pg.Pool;
let UsersRepository: any;
let repo: any;
let hashPassword: (p: string) => Promise<string>;
let verifyPassword: (h: string, p: string) => Promise<boolean>;
let verifyDummyPassword: () => Promise<boolean>;
let initDummyHash: () => Promise<void>;

before(async () => {
  pool = new pg.Pool({ connectionString: DSN });
  const { runMigrations } = await import('../src/migrations/run.ts');
  await runMigrations(pool, 'auth-test');
  const mod = await import('../src/users/users.repository.ts');
  UsersRepository = mod.UsersRepository;
  repo = new UsersRepository(pool);
  const pw = await import('../src/users/password.ts');
  hashPassword = pw.hashPassword;
  verifyPassword = pw.verifyPassword;
  verifyDummyPassword = pw.verifyDummyPassword;
  initDummyHash = pw.initDummyHash;
  await initDummyHash();
});

after(async () => {
  if (pool) await pool.end();
});

test('create: stores user with argon2id hash, email lowercased', async () => {
  const email = `Create-${randomUUID()}@Example.COM`;
  const user = await repo.create(email, 'test-password-123');
  assert.ok(user.id, 'user should have id');
  assert.equal(user.email, email.toLowerCase(), 'email should be lowercased');
  assert.ok(user.password_hash, 'should have password hash');
  assert.equal(user.token_version, 0, 'token_version starts at 0');

  const found = await repo.findByEmail(email.toLowerCase());
  assert.ok(found, 'should find by email');
  assert.equal(found.id, user.id);

  await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
});

test('argon2id: hash + verify roundtrip', async () => {
  const hash = await hashPassword('my-secret-pass');
  assert.ok(hash, 'hash should be produced');
  assert.ok(!hash.startsWith('$2'), 'should NOT be bcrypt');
  assert.ok(hash.startsWith('$argon2id'), 'should be argon2id');

  const ok = await verifyPassword(hash, 'my-secret-pass');
  assert.ok(ok, 'correct password should verify');

  const bad = await verifyPassword(hash, 'wrong-password');
  assert.ok(!bad, 'wrong password should not verify');
});

test('timing equalization: verifyDummyPassword runs and returns false', async () => {
  const start = Date.now();
  const result = await verifyDummyPassword();
  const elapsed = Date.now() - start;
  assert.equal(result, false, 'dummy should always return false');
  // argon2 verify takes real time (at least a few ms).
  assert.ok(elapsed >= 1, 'dummy verify should take real time (timing equalization)');
});

test('bumpTokenVersion: increments token_version', async () => {
  const email = `bump-${randomUUID()}@example.com`;
  const user = await repo.create(email, 'test-password-123');
  assert.equal(user.token_version, 0);

  await repo.bumpTokenVersion(user.id);
  const found = await repo.findById(user.id);
  assert.equal(found.token_version, 1, 'token_version should be 1 after bump');

  await repo.bumpTokenVersion(user.id);
  const found2 = await repo.findById(user.id);
  assert.equal(found2.token_version, 2, 'token_version should be 2 after second bump');

  await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
});

test('findByEmail: returns null for non-existent email', async () => {
  const found = await repo.findByEmail(`nonexistent-${randomUUID()}@example.com`);
  assert.equal(found, null);
});
