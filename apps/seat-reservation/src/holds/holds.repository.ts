import { Injectable, Inject } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../config/db.module.js';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../config/env.js';

export type HoldStatus = 'HELD' | 'RELEASED' | 'RESERVED';

export interface HoldRow {
  id: string;
  seat_id: string;
  user_id: string;
  status: HoldStatus;
  held_until: Date;
  created_at: Date;
  released_at: Date | null;
  reserved_at: Date | null;
}

export interface InsertHoldResult {
  ok: true;
  hold: HoldRow;
}

export interface InsertHoldConflict {
  ok: false;
  reason: 'seat_held' | 'user_has_hold';
}

@Injectable()
export class HoldsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Atomically insert a hold. SERIALIZABLE isolation + partial unique indexes
   * (uniq_active_hold_per_seat / _per_user) enforce the invariants at DB level.
   * Checklist §3.1.1 / §3.1.2 / §3.1.3.
   *
   * Failure mode (DECISIONS.md #2): concurrent writers get `unique_violation`
   * (Postgres SQLSTATE 23505) — we map to a structured `InsertHoldConflict`
   * result that the controller turns into 409 + Retry-After.
   */
  async insertHoldTx(
    seatId: string,
    userId: string,
    traceId: string,
  ): Promise<InsertHoldResult | InsertHoldConflict> {
    const env = loadEnv();
    const heldUntil = new Date(Date.now() + env.HOLD_TTL_SECONDS * 1000);
    const holdId = randomUUID();
    const eventId = randomUUID();

    const conn = await this.pool.connect();
    try {
      await conn.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      // Lazy cleanup of any expired hold on this seat (Checklist §3.2.1).
      // Trade-off noted in DECISIONS.md: lazy = simple, slight stale-UI risk;
      // we ALSO have the background sweeper for proactive cleanup.
      await conn.query(
        `UPDATE holds SET status = 'RELEASED', released_at = NOW()
         WHERE seat_id = $1 AND status = 'HELD' AND held_until < NOW()`,
        [seatId],
      );

      // Insert hold. Partial unique indexes catch concurrent races at DB level.
      try {
        const { rows } = await conn.query<HoldRow>(
          `INSERT INTO holds (id, seat_id, user_id, status, held_until)
           VALUES ($1, $2, $3, 'HELD', $4)
           RETURNING *`,
          [holdId, seatId, userId, heldUntil],
        );
        const hold = rows[0];

        // Mark seat HELD. Idempotent given hold uniqueness.
        await conn.query(`UPDATE seats SET status = 'HELD' WHERE id = $1`, [seatId]);

        // Append outbox row in same TX. Checklist §5.2.2 — event is not lost
        // even if process crashes after commit; outbox worker publishes later.
        await conn.query(
          `INSERT INTO outbox (aggregate_id, event_type, payload, headers)
           VALUES ($1, $2, $3, $4)`,
          [
            hold.id,
            'seat.held.v1',
            JSON.stringify({
              schema: 'seat.held.v1',
              eventId,
              seatId,
              userId,
              holdId: hold.id,
              heldUntil: heldUntil.toISOString(),
              priceCents: (await this.lookupPrice(conn, seatId))?.price_cents ?? 0,
              currency: (await this.lookupPrice(conn, seatId))?.currency ?? 'USD',
              traceId,
              occurredAt: new Date().toISOString(),
            }),
            JSON.stringify({ traceId, userId }),
          ],
        );

        await conn.query('COMMIT');
        return { ok: true, hold };
      } catch (e) {
        const err = e as { code?: string; constraint?: string };
        if (err.code === '23505') {
          await conn.query('ROLLBACK');
          const reason = err.constraint === 'uniq_active_hold_per_user'
            ? 'user_has_hold'
            : 'seat_held';
          return { ok: false, reason };
        }
        throw e;
      }
    } catch (e) {
      try { await conn.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  private async lookupPrice(conn: PoolClient, seatId: string) {
    const { rows } = await conn.query<{ price_cents: number; currency: string }>(
      'SELECT price_cents, currency FROM seats WHERE id = $1',
      [seatId],
    );
    return rows[0];
  }

  /** Release a hold (used by payment-failed compensation & user cancel). */
  async releaseHold(
    holdId: string,
    reason: string,
    traceId: string,
  ): Promise<{ released: boolean; seatId?: string }> {
    const conn = await this.pool.connect();
    try {
      await conn.query('BEGIN');
      const { rows } = await conn.query<{ id: string; seat_id: string }>(
        `UPDATE holds SET status = 'RELEASED', released_at = NOW()
         WHERE id = $1 AND status = 'HELD' RETURNING id, seat_id`,
        [holdId],
      );
      if (rows.length === 0) {
        await conn.query('ROLLBACK');
        return { released: false };
      }
      const seatId = rows[0].seat_id;
      // If no other active hold exists, mark seat AVAILABLE again.
      await conn.query(
        `UPDATE seats SET status = 'AVAILABLE'
         WHERE id = $1 AND NOT EXISTS (
           SELECT 1 FROM holds WHERE seat_id = $1 AND status = 'HELD'
         )`,
        [seatId],
      );
      await conn.query(
        `INSERT INTO outbox (aggregate_id, event_type, payload, headers)
         VALUES ($1, $2, $3, $4)`,
        [
          holdId,
          'seat.released.v1',
          JSON.stringify({
            schema: 'seat.released.v1',
            eventId: randomUUID(),
            seatId,
            reason,
            traceId,
            occurredAt: new Date().toISOString(),
          }),
          JSON.stringify({ traceId }),
        ],
      );
      await conn.query('COMMIT');
      return { released: true, seatId };
    } catch (e) {
      try { await conn.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  /** Mark a hold as RESERVED (payment succeeded). Idempotent via consumed_events. */
  async reserveHold(
    holdId: string,
    eventId: string,
    consumerGroup: string,
    traceId: string,
  ): Promise<{ reserved: boolean; seatId?: string; userId?: string }> {
    const conn = await this.pool.connect();
    try {
      await conn.query('BEGIN');
      // Idempotency guard: UNIQUE (event_id, consumer_group). If 0 rows inserted,
      // this event was already processed — skip. Checklist §5.2.5.
      const inserted = await conn.query(
        `INSERT INTO consumed_events (event_id, consumer_group) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [eventId, consumerGroup],
      );
      if (inserted.rowCount === 0) {
        await conn.query('ROLLBACK');
        return { reserved: false };
      }
      const { rows } = await conn.query<{ seat_id: string; user_id: string }>(
        `UPDATE holds SET status = 'RESERVED', reserved_at = NOW()
         WHERE id = $1 AND status = 'HELD' RETURNING seat_id, user_id`,
        [holdId],
      );
      if (rows.length === 0) {
        await conn.query('ROLLBACK');
        return { reserved: false };
      }
      const { seat_id, user_id } = rows[0];
      await conn.query(`UPDATE seats SET status = 'RESERVED' WHERE id = $1`, [seat_id]);
      await conn.query(
        `INSERT INTO outbox (aggregate_id, event_type, payload, headers)
         VALUES ($1, $2, $3, $4)`,
        [
          holdId,
          'seat.reserved.v1',
          JSON.stringify({
            schema: 'seat.reserved.v1',
            eventId: randomUUID(),
            seatId: seat_id,
            userId: user_id,
            holdId,
            traceId,
            occurredAt: new Date().toISOString(),
          }),
          JSON.stringify({ traceId }),
        ],
      );
      await conn.query('COMMIT');
      return { reserved: true, seatId: seat_id, userId: user_id };
    } catch (e) {
      try { await conn.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  /** Find the active hold for a seat (used by payment consumer). */
  async findActiveHoldForSeat(seatId: string): Promise<HoldRow | null> {
    const { rows } = await this.pool.query<HoldRow>(
      `SELECT * FROM holds WHERE seat_id = $1 AND status = 'HELD' LIMIT 1`,
      [seatId],
    );
    return rows[0] ?? null;
  }
}
