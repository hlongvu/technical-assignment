import { Injectable, OnModuleDestroy, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../config/db.module.js';
import { RabbitService } from '../events/rabbit.service.js';
import { EXCHANGES } from '@seat-reservation/contracts';
import { LOGGER_SERVICE, LoggerService } from '../common/logger.service.js';
import { AppLogger } from '@seat-reservation/be-core';
import { loadEnv } from '../config/env.js';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  headers: Record<string, string>;
  state: 'PENDING' | 'PROCESSING' | 'DEAD';
  attempts: number;
  next_attempt_at: Date;
}

/**
 * Transactional outbox publisher worker. DECISIONS.md #4.
 * Polls PENDING rows with FOR UPDATE SKIP LOCKED LIMIT N (multi-replica safe),
 * publishes to RabbitMQ with publisher confirms, marks DONE (deleted) or
 * schedules a retry with exponential backoff. After MAX_ATTEMPTS → DEAD + alert.
 * Checklist §1.0.2 / §5.2.2 / §5.2.3.
 *
 * TODO(prod): split into a separate worker Deployment so it scales independently.
 */
@Injectable()
export class OutboxWorker implements OnModuleDestroy {
  private readonly log: AppLogger;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly MAX_ATTEMPTS = 10;
  private readonly BASE_BACKOFF_MS = 1000;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly rabbit: RabbitService,
    @Inject(LOGGER_SERVICE) loggerService: LoggerService,
  ) {
    this.log = loggerService.create('outbox-worker');
  }

  start(): void {
    const env = loadEnv();
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log.error({ action: 'outbox_tick_failed', err: String(e) }));
    }, env.SWEEP_INTERVAL_MS); // reuse the same cadence
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const conn = await this.pool.connect();
      try {
        // Recovery: re-queue PROCESSING rows that have been stuck for > 5 min.
        // This handles the case where a replica crashed after marking PROCESSING
        // but before publishing. §5.2.3 reliability.
        await conn.query(
          `UPDATE outbox SET state = 'PENDING', next_attempt_at = NOW()
           WHERE state = 'PROCESSING' AND next_attempt_at < NOW() - interval '5 minutes'`,
        );

        await conn.query('BEGIN');
        const { rows } = await conn.query<OutboxRow>(
          `SELECT id, aggregate_id, event_type, payload, headers, state, attempts, next_attempt_at
           FROM outbox
           WHERE state = 'PENDING' AND next_attempt_at <= NOW()
           ORDER BY next_attempt_at
           FOR UPDATE SKIP LOCKED LIMIT 100`,
        );
        if (rows.length === 0) {
          await conn.query('ROLLBACK');
          return;
        }
        // Mark processing so other replicas skip them.
        const ids = rows.map((r) => r.id);
        await conn.query(`UPDATE outbox SET state = 'PROCESSING' WHERE id = ANY($1)`, [ids]);
        await conn.query('COMMIT');

        for (const row of rows) {
          await this.processRow(row);
        }
      } finally {
        conn.release();
      }
    } finally {
      this.running = false;
    }
  }

  private async processRow(row: OutboxRow): Promise<void> {
    // Map event_type -> exchange
    const exchange = row.event_type.startsWith('seat.')
      ? EXCHANGES.SEAT_EVENTS
      : EXCHANGES.PAYMENT_EVENTS;
    const routingKey = row.event_type.replace(/\.v\d+$/, '');
    const payload = Buffer.from(JSON.stringify(row.payload));
    let ok = false;
    try {
      ok = await this.rabbit.publish(exchange, routingKey, payload, row.headers);
    } catch (e) {
      this.log.warn({ action: 'outbox_publish_err', id: row.id, err: String(e) });
    }
    if (ok) {
      await this.pool.query(`DELETE FROM outbox WHERE id = $1`, [row.id]);
      return;
    }
    // Retry with exponential backoff. After MAX_ATTEMPTS → DEAD.
    const attempts = row.attempts + 1;
    const backoff = this.BASE_BACKOFF_MS * Math.pow(2, Math.min(attempts, 8));
    if (attempts >= this.MAX_ATTEMPTS) {
      await this.pool.query(
        `UPDATE outbox SET state = 'DEAD', attempts = $1, next_attempt_at = NOW() + interval '1 hour' WHERE id = $2`,
        [attempts, row.id],
      );
      this.log.error({ action: 'outbox_dead', id: row.id, eventType: row.event_type, attempts }, 'outbox row dead-lettered');
    } else {
      await this.pool.query(
        `UPDATE outbox SET state = 'PENDING', attempts = $1, next_attempt_at = NOW() + ($2 || ' milliseconds')::interval WHERE id = $3`,
        [attempts, String(backoff), row.id],
      );
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
