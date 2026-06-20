import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../config/db.module.js';
import { loadEnv } from '../config/env.js';
import { SeatEventBus } from '../seats/seat-event.bus.js';
import { LOGGER_SERVICE, LoggerService } from '../common/logger.service.js';
import { AppLogger } from '@seat-reservation/be-core';
import { randomUUID } from 'node:crypto';

/**
 * Background sweeper for expired holds. Checklist §3.2.1 / §3.2.2 / §4.4.4.
 *
 * Replica-safety: uses `FOR UPDATE SKIP LOCKED LIMIT N` so multiple seat-service
 * instances can run the sweeper concurrently without overlap or coordination.
 * SKIP LOCKED is PgBouncer-safe (no advisory lock needed). DECISIONS.md #4.
 *
 * TODO(prod): if cadence needs to be exactly-once globally, add leader
 * election (e.g., Redis redlock) so only one replica schedules sweeps.
 */
@Injectable()
export class HoldSweeper implements OnModuleDestroy {
  private readonly log: AppLogger;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(LOGGER_SERVICE) loggerService: LoggerService,
    private readonly bus: SeatEventBus,
  ) {
    this.log = loggerService.create('sweeper');
  }

  start(): void {
    const env = loadEnv();
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log.error({ action: 'sweep_tick_failed', err: String(e) }));
    }, env.SWEEP_INTERVAL_MS);
  }

  async tick(): Promise<void> {
    const env = loadEnv();
    const traceId = randomUUID();
    const conn = await this.pool.connect();
    try {
      await conn.query('BEGIN');
      // SKIP LOCKED: multi-replica safe. LIMIT: avoid locking the whole table.
      const { rows } = await conn.query<{ id: string; seat_id: string }>(
        `UPDATE holds
         SET status = 'RELEASED', released_at = NOW()
         WHERE id IN (
           SELECT id FROM holds
           WHERE status = 'HELD' AND held_until < NOW()
           FOR UPDATE SKIP LOCKED LIMIT $1
         )
         RETURNING id, seat_id`,
        [env.SWEEP_BATCH_LIMIT],
      );
      // Re-avail seats with no remaining active hold.
      for (const r of rows) {
        await conn.query(
          `UPDATE seats SET status = 'AVAILABLE'
           WHERE id = $1 AND NOT EXISTS (
             SELECT 1 FROM holds WHERE seat_id = $1 AND status = 'HELD'
           )`,
          [r.seat_id],
        );
        // Outbox event for the release (so payment-service can cancel any pending intent).
        await conn.query(
          `INSERT INTO outbox (aggregate_id, event_type, payload, headers)
           VALUES ($1, $2, $3, $4)`,
          [
            r.id,
            'seat.released.v1',
            JSON.stringify({
              schema: 'seat.released.v1',
              eventId: randomUUID(),
              seatId: r.seat_id,
              reason: 'sweeper',
              traceId,
              occurredAt: new Date().toISOString(),
            }),
            JSON.stringify({ traceId, reason: 'sweeper' }),
          ],
        );
        this.bus.emit({ type: 'seat:released', seatId: r.seat_id });
      }
      await conn.query('COMMIT');
      if (rows.length > 0) {
        this.log.info({ action: 'swept', count: rows.length, traceId }, 'swept expired holds');
      }
    } catch (e) {
      try { await conn.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
