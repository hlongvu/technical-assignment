import { Injectable, OnModuleDestroy, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../config/db.module.js';
import { PaymentIntentsRepository } from '../checkout/payment-intents.repository.js';
import { LOGGER_SERVICE, LoggerService } from '../common/logger.service.js';
import { AppLogger } from '@seat-reservation/be-core';
import { loadEnv } from '../config/env.js';
import type { PSPWebhookEvent } from '../psps/psp.client.js';
import { randomUUID } from 'node:crypto';

/**
 * Webhook reprocessor — makes the ack-fast pattern durable. §5.1.4 / §3.3.1.
 *
 * If the process crashes between acking a webhook (insert into webhook_inbox)
 * and processing it (setImmediate), the event would be lost. This worker polls
 * webhook_inbox for rows with processed_at IS NULL and reprocesses them.
 *
 * The inbox INSERT is idempotent (UNIQUE stripe_event_id), so reprocessing is
 * safe — it just re-runs the markCompleted/markFailed logic (which is itself
 * idempotent via WHERE status='PENDING').
 */
@Injectable()
export class WebhookReprocessor implements OnModuleDestroy {
  private readonly log: AppLogger;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly intents: PaymentIntentsRepository,
    @Inject(LOGGER_SERVICE) loggerService: LoggerService,
  ) {
    this.log = loggerService.create('webhook-reprocessor');
  }

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log.error({ action: 'reprocess_tick_failed', err: String(e) }));
    }, 30000);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { rows } = await this.pool.query<{ stripe_event_id: string; type: string; payload: unknown }>(
        `SELECT stripe_event_id, type, payload FROM webhook_inbox
         WHERE processed_at IS NULL
         ORDER BY received_at
         LIMIT 50`,
      );
      if (rows.length === 0) return;
      this.log.info({ action: 'reprocess_batch', count: rows.length }, 'reprocessing unprocessed webhooks');
      for (const row of rows) {
        await this.reprocess(row.stripe_event_id, row.type, row.payload as PSPWebhookEvent);
      }
    } finally {
      this.running = false;
    }
  }

  private async reprocess(stripeEventId: string, type: string, event: PSPWebhookEvent): Promise<void> {
    const traceId = 'reprocess-' + randomUUID();
    const eventId = randomUUID();
    try {
      if (type === 'payment_intent.succeeded') {
        await this.intents.markCompleted(event.data.object.id, eventId, traceId);
      } else if (type === 'payment_intent.payment_failed') {
        await this.intents.markFailed(event.data.object.id, 'payment_failed', eventId, traceId);
      }
      await this.intents.markWebhookProcessed(stripeEventId);
      this.log.info({ action: 'reprocessed', stripeEventId, type, traceId }, 'webhook reprocessed');
    } catch (e) {
      this.log.error({ action: 'reprocess_failed', stripeEventId, err: String(e), traceId }, 'reprocess failed — will retry next tick');
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
