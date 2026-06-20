import { Injectable, Inject } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../config/db.module.js';
import { randomUUID } from 'node:crypto';

export interface PaymentIntentRow {
  id: string;
  seat_id: string;
  user_id: string;
  hold_id: string;
  amount_cents: number;
  currency: string;
  psp_intent_id: string | null;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  idempotency_key: string;
  client_secret: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface CheckoutResult {
  intent: PaymentIntentRow;
  created: boolean;   // false if returned existing (idempotency)
}

@Injectable()
export class PaymentIntentsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Look up seat price (server-controlled amount, §3.3.3 / §5.1.5). */
  async getSeatPrice(seatId: string): Promise<{ price_cents: number; currency: string; label: string } | null> {
    const { rows } = await this.pool.query<{ price_cents: number; currency: string; label: string }>(
      'SELECT price_cents, currency, label FROM seat_prices WHERE seat_id = $1',
      [seatId],
    );
    return rows[0] ?? null;
  }

  /** Find an existing intent by idempotency key (idempotency, §3.3.4). */
  async findByIdempotencyKey(key: string): Promise<PaymentIntentRow | null> {
    const { rows } = await this.pool.query<PaymentIntentRow>(
      'SELECT * FROM payment_intents WHERE idempotency_key = $1',
      [key],
    );
    return rows[0] ?? null;
  }

  /** Insert a new intent. Throws on duplicate idempotency_key (UNIQUE). */
  async createIntent(opts: {
    seatId: string; userId: string; holdId: string;
    amountCents: number; currency: string; idempotencyKey: string;
    pspIntentId: string; clientSecret: string;
  }): Promise<PaymentIntentRow> {
    const id = randomUUID();
    const { rows } = await this.pool.query<PaymentIntentRow>(
      `INSERT INTO payment_intents
         (id, seat_id, user_id, hold_id, amount_cents, currency, status, idempotency_key, psp_intent_id, client_secret)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, $9)
       RETURNING *`,
      [id, opts.seatId, opts.userId, opts.holdId, opts.amountCents, opts.currency,
       opts.idempotencyKey, opts.pspIntentId, opts.clientSecret],
    );
    return rows[0];
  }

  /** Mark intent COMPLETED and append payment.succeeded outbox row in same TX. §5.2.2. */
  async markCompleted(
    pspIntentId: string,
    eventId: string,
    traceId: string,
  ): Promise<{ ok: true; intent: PaymentIntentRow } | { ok: false; reason: string }> {
    const conn = await this.pool.connect();
    try {
      await conn.query('BEGIN');
      const { rows } = await conn.query<PaymentIntentRow>(
        `UPDATE payment_intents
         SET status = 'COMPLETED', completed_at = NOW()
         WHERE psp_intent_id = $1 AND status = 'PENDING'
         RETURNING *`,
        [pspIntentId],
      );
      if (rows.length === 0) {
        await conn.query('ROLLBACK');
        return { ok: false, reason: 'no_pending_intent' };
      }
      const intent = rows[0];
      await appendOutbox(conn, intent.id, 'payment.succeeded.v1', {
        schema: 'payment.succeeded.v1',
        eventId,
        paymentIntentId: intent.id,
        seatId: intent.seat_id,
        userId: intent.user_id,
        holdId: intent.hold_id,
        amountCents: intent.amount_cents,
        currency: intent.currency,
        pspIntentId: intent.psp_intent_id!,
        traceId,
        occurredAt: new Date().toISOString(),
      }, { traceId, userId: intent.user_id });
      await conn.query('COMMIT');
      return { ok: true, intent };
    } catch (e) {
      try { await conn.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  /** Mark intent FAILED and append payment.failed outbox row in same TX. Compensation. §5.2.1. */
  async markFailed(
    pspIntentId: string,
    reason: string,
    eventId: string,
    traceId: string,
  ): Promise<{ ok: true; intent: PaymentIntentRow } | { ok: false; reason: string }> {
    const conn = await this.pool.connect();
    try {
      await conn.query('BEGIN');
      const { rows } = await conn.query<PaymentIntentRow>(
        `UPDATE payment_intents
         SET status = 'FAILED', completed_at = NOW()
         WHERE psp_intent_id = $1 AND status = 'PENDING'
         RETURNING *`,
        [pspIntentId],
      );
      if (rows.length === 0) {
        await conn.query('ROLLBACK');
        return { ok: false, reason: 'no_pending_intent' };
      }
      const intent = rows[0];
      await appendOutbox(conn, intent.id, 'payment.failed.v1', {
        schema: 'payment.failed.v1',
        eventId,
        paymentIntentId: intent.id,
        seatId: intent.seat_id,
        userId: intent.user_id,
        holdId: intent.hold_id,
        reason,
        traceId,
        occurredAt: new Date().toISOString(),
      }, { traceId, userId: intent.user_id });
      await conn.query('COMMIT');
      return { ok: true, intent };
    } catch (e) {
      try { await conn.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  async findByPspIntentId(pspIntentId: string): Promise<PaymentIntentRow | null> {
    const { rows } = await this.pool.query<PaymentIntentRow>(
      'SELECT * FROM payment_intents WHERE psp_intent_id = $1',
      [pspIntentId],
    );
    return rows[0] ?? null;
  }

  /** Insert webhook inbox row; returns true if inserted (new), false if dedup'd. §5.1.4. */
  async insertWebhookInbox(stripeEventId: string, type: string, payload: unknown): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO webhook_inbox (stripe_event_id, type, payload)
       VALUES ($1, $2, $3) ON CONFLICT (stripe_event_id) DO NOTHING`,
      [stripeEventId, type, JSON.stringify(payload)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markWebhookProcessed(stripeEventId: string): Promise<void> {
    await this.pool.query(
      'UPDATE webhook_inbox SET processed_at = NOW() WHERE stripe_event_id = $1',
      [stripeEventId],
    );
  }
}

/** Shared outbox-appender helper. Checklist §5.2.2 — must be inside the same TX. */
export async function appendOutbox(
  conn: PoolClient,
  aggregateId: string,
  eventType: string,
  payload: unknown,
  headers: Record<string, string>,
): Promise<void> {
  await conn.query(
    `INSERT INTO outbox (aggregate_id, event_type, payload, headers)
     VALUES ($1, $2, $3, $4)`,
    [aggregateId, eventType, JSON.stringify(payload), JSON.stringify(headers)],
  );
}
