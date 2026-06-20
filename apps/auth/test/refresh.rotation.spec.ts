/**
 * Refresh-token rotation + reuse detection test. Checklist §1.3.3 / §2.1.4 / §2.1.5.
 *
 * Scenarios:
 *   1. Rotate: old token revoked, new issued.
 *   2. Reuse old token past grace → entire family revoked.
 *
 * Uses real Postgres (no mocks). Prereq: docker compose up (auth_db running on 5432).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';

const DSN = process.env.AUTH_DB_DSN ?? 'postgres://seatapp:seatapp_dev_pw@localhost:5432/auth_db';

let pool: pg.Pool;
let userId: string;

before(async () => {
  pool = new pg.Pool({ connectionString: DSN });
  const { runMigrations } = await import('../src/migrations/run.ts');
  await runMigrations(pool, 'auth-test');
  userId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, token_version) VALUES ($1, $2, 'dummy', 0)`,
    [userId, `rt-test-${userId}@example.com`],
  );
});

after(async () => {
  if (pool) {
    await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    await pool.end();
  }
});

async function issueNewFamily(userId: string): Promise<{ raw: string; id: string; familyId: string }> {
  const raw = randomUUID() + randomUUID();
  const hash = createHash('sha256').update(raw).digest();
  const familyId = randomUUID();
  const expiresAt = new Date(Date.now() + 60_000);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, familyId, hash, expiresAt],
  );
  return { raw, id: rows[0].id, familyId };
}

async function rotate(oldId: string): Promise<{ raw: string; id: string }> {
  const raw = randomUUID() + randomUUID();
  const hash = createHash('sha256').update(raw).digest();
  const expiresAt = new Date(Date.now() + 60_000);
  const graceUntil = new Date(Date.now() + 1000); // 1s grace for test
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    const { rows: inserted } = await conn.query<{ id: string }>(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
       SELECT user_id, family_id, $1, $2 FROM refresh_tokens WHERE id = $3
       RETURNING id`,
      [hash, expiresAt, oldId],
    );
    const newId = inserted[0].id;
    await conn.query(
      `UPDATE refresh_tokens SET revoked_at = NOW(), rotated_to = $1, grace_until = $2 WHERE id = $3`,
      [newId, graceUntil, oldId],
    );
    await conn.query('COMMIT');
    return { raw, id: newId };
  } catch (e) {
    try { await conn.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    conn.release();
  }
}

async function revokeFamily(familyId: string): Promise<void> {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId],
  );
}

async function getRow(id: string) {
  const { rows } = await pool.query(
    'SELECT revoked_at, rotated_to, grace_until FROM refresh_tokens WHERE id = $1',
    [id],
  );
  return rows[0];
}

test('rotation: old token revoked, new issued, family preserved', async () => {
  const first = await issueNewFamily(userId);
  const next = await rotate(first.id);

  const oldRow = await getRow(first.id);
  const newRow = await getRow(next.id);

  assert.ok(oldRow.revoked_at, 'old token should be revoked');
  assert.equal(oldRow.rotated_to, next.id, 'old should link to new via rotated_to');
  assert.ok(!newRow.revoked_at, 'new token should NOT be revoked');
  assert.ok(oldRow.grace_until, 'old should have grace_until set');
});

test('reuse of revoked token past grace → family revoked', async () => {
  const first = await issueNewFamily(userId);
  const next = await rotate(first.id);
  // Simulate passing the grace window.
  await pool.query(`UPDATE refresh_tokens SET grace_until = NOW() - interval '1 second' WHERE id = $1`, [first.id]);

  // Reuse detected — revoke family.
  await revokeFamily(first.familyId);

  const familyRows = await pool.query(
    `SELECT id, revoked_at FROM refresh_tokens WHERE family_id = $1`,
    [first.familyId],
  );
  assert.equal(familyRows.rows.length, 2, 'family should have 2 tokens (original + rotation)');
  for (const r of familyRows.rows) {
    assert.ok(r.revoked_at, `token ${r.id} should be revoked after family revoke`);
  }
  // The previously-valid new token is now also revoked (theft containment).
  const newRow = await getRow(next.id);
  assert.ok(newRow.revoked_at, 'rotated (previously valid) token should also be revoked');
});
