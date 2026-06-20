import { Injectable, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import { PG_POOL } from '../config/db.module.js';
import { loadEnv } from '../config/env.js';

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: Buffer;
  rotated_to: string | null;
  revoked_at: Date | null;
  expires_at: Date;
  grace_until: Date | null;
  created_at: Date;
}

export interface IssuedToken {
  raw: string;       // only returned to the cookie, never persisted in clear
  row: RefreshTokenRow;
}

@Injectable()
export class SessionsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Issue a new refresh token in a new family (used at login). */
  async issueNewFamily(userId: string): Promise<IssuedToken> {
    const env = loadEnv();
    const raw = randomBytes(48).toString('base64url');
    const hash = createHash('sha256').update(raw).digest();
    const familyId = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + env.RT_TTL_SECONDS * 1000);
    const { rows } = await this.pool.query<RefreshTokenRow>(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [userId, familyId, hash, expiresAt],
    );
    return { raw, row: rows[0] };
  }

  /** Look up by raw token; returns null if not found. */
  async findByRaw(raw: string): Promise<RefreshTokenRow | null> {
    const hash = createHash('sha256').update(raw).digest();
    const { rows } = await this.pool.query<RefreshTokenRow>(
      'SELECT * FROM refresh_tokens WHERE token_hash = $1',
      [hash],
    );
    return rows[0] ?? null;
  }

  /**
   * Rotate: in ONE transaction, revoke old row + insert new (same family).
   * Returns the new issued token. Throws if old row is already revoked
   * (caller must branch on grace / reuse before calling this).
   */
  async rotate(oldRow: RefreshTokenRow): Promise<IssuedToken> {
    const env = loadEnv();
    const raw = randomBytes(48).toString('base64url');
    const hash = createHash('sha256').update(raw).digest();
    const expiresAt = new Date(Date.now() + env.RT_TTL_SECONDS * 1000);
    const graceUntil = new Date(Date.now() + env.RT_GRACE_SECONDS * 1000);

    const conn = await this.pool.connect();
    try {
      await conn.query('BEGIN');
      // Lock the old row to make rotation atomic against concurrent /refresh
      const { rows: locked } = await conn.query<RefreshTokenRow>(
        'SELECT * FROM refresh_tokens WHERE id = $1 FOR UPDATE',
        [oldRow.id],
      );
      const current = locked[0];
      if (!current) {
        await conn.query('ROLLBACK');
        throw new Error('rt_not_found');
      }
      // Insert new first so we can link rotated_to
      const { rows: inserted } = await conn.query<RefreshTokenRow>(
        `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [current.user_id, current.family_id, hash, expiresAt],
      );
      const newRow = inserted[0];
      await conn.query(
        `UPDATE refresh_tokens SET revoked_at = NOW(), rotated_to = $1, grace_until = $2
         WHERE id = $3`,
        [newRow.id, graceUntil, current.id],
      );
      await conn.query('COMMIT');
      return { raw, row: newRow };
    } catch (e) {
      try { await conn.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  /** Revoke a single token by id. */
  async revoke(id: string): Promise<void> {
    await this.pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1', [id]);
  }

  /** Revoke all tokens in a family (reuse detection). Checklist §2.1.5 Exceed. */
  async revokeFamily(familyId: string): Promise<void> {
    await this.pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = $1 AND revoked_at IS NULL',
      [familyId],
    );
  }

  /** Revoke all tokens for a user (logout-all). Checklist §2.1.8. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
  }
}
