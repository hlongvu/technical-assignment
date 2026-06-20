/**
 * SessionsRepository test — exercises the REAL repository code (not re-implemented SQL).
 * Checklist §1.3.2 / §1.3.3 / §2.1.4 / §2.1.5 / §2.1.6.
 *
 * Scenarios:
 *   1. issueNewFamily → raw token returned, hash stored, row findable by raw.
 *   2. rotate → old revoked + rotated_to set + grace_until set, new token active.
 *   3. reuse past grace → revokeFamily → all family tokens revoked.
 *   4. revokeAllForUser → all user tokens revoked.
 *
 * Uses real Postgres. Prereq: docker compose up (auth_db on 5432).
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
process.env.RT_GRACE_SECONDS = '1';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const DSN = 'postgres://seatapp:seatapp_dev_pw@localhost:5432/auth_db';

let pool: pg.Pool;
let userId: string;
let SessionsRepository: any;
let repo: any;

before(async () => {
  pool = new pg.Pool({ connectionString: DSN });
  const { runMigrations } = await import('../src/migrations/run.ts');
  await runMigrations(pool, 'auth-test');
  const mod = await import('../src/sessions/sessions.repository.ts');
  SessionsRepository = mod.SessionsRepository;
  repo = new SessionsRepository(pool);

  userId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, token_version) VALUES ($1, $2, 'dummy', 0)`,
    [userId, `sessions-test-${userId}@example.com`],
  );
});

after(async () => {
  if (pool) {
    await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    await pool.end();
  }
});

test('issueNewFamily: raw token returned, hash stored, findable by raw', async () => {
  const issued = await repo.issueNewFamily(userId);
  assert.ok(issued.raw, 'raw token should be returned');
  assert.ok(issued.raw.length >= 64, 'raw token should be base64url of 48 bytes');
  assert.ok(issued.row.id, 'row should have id');
  assert.ok(issued.row.family_id, 'row should have family_id');

  const found = await repo.findByRaw(issued.raw);
  assert.ok(found, 'should find row by raw token');
  assert.equal(found.id, issued.row.id);
  assert.equal(found.revoked_at, null, 'new token should not be revoked');
});

test('rotate: old revoked, rotated_to set, grace_until set, new active', async () => {
  const issued = await repo.issueNewFamily(userId);
  const rotated = await repo.rotate(issued.row);

  assert.ok(rotated.raw, 'new raw token returned');
  assert.ok(rotated.row.id, 'new row has id');
  assert.equal(rotated.row.family_id, issued.row.family_id, 'family preserved');

  const oldRow = await repo.findByRaw(issued.raw);
  assert.ok(oldRow.revoked_at, 'old token should be revoked');
  assert.equal(oldRow.rotated_to, rotated.row.id, 'old should link to new');
  assert.ok(oldRow.grace_until, 'old should have grace_until');

  const newRow = await repo.findByRaw(rotated.raw);
  assert.equal(newRow.revoked_at, null, 'new token should NOT be revoked');
});

test('reuse of revoked token past grace → revokeFamily revokes all', async () => {
  const issued = await repo.issueNewFamily(userId);
  const rotated = await repo.rotate(issued.row);

  // Force grace window to expire.
  await pool.query(`UPDATE refresh_tokens SET grace_until = NOW() - interval '1 second' WHERE id = $1`, [issued.row.id]);

  await repo.revokeFamily(issued.row.family_id);

  const familyRows = await pool.query(
    `SELECT id, revoked_at FROM refresh_tokens WHERE family_id = $1`,
    [issued.row.family_id],
  );
  assert.ok(familyRows.rows.length >= 2, 'family should have at least 2 tokens');
  for (const r of familyRows.rows) {
    assert.ok(r.revoked_at, `token ${r.id} should be revoked after family revoke`);
  }
});

test('revokeAllForUser revokes all tokens for user', async () => {
  const a = await repo.issueNewFamily(userId);
  const b = await repo.issueNewFamily(userId);

  await repo.revokeAllForUser(userId);

  const ra = await repo.findByRaw(a.raw);
  const rb = await repo.findByRaw(b.raw);
  assert.ok(ra.revoked_at, 'token a should be revoked');
  assert.ok(rb.revoked_at, 'token b should be revoked');
});
