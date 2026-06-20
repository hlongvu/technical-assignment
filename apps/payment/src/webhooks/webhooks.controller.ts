import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { MockPSPClient, type PSPWebhookEvent } from '../psps/psp.client.js';
import { PaymentIntentsRepository } from '../checkout/payment-intents.repository.js';
import { LOGGER_SERVICE, LoggerService } from '../common/logger.service.js';
import { AppLogger, REQUEST_ID_HEADER, resolveTraceId } from '@seat-reservation/be-core';
import { loadEnv } from '../config/env.js';
import { randomUUID } from 'node:crypto';
import {
  webhookReceivedTotal,
  webhookDedupedTotal,
  paymentCompletedTotal,
  paymentFailedTotal,
} from '../metrics/metrics.controller.js';

/**
 * Webhook controller. Checklist §3.3.1 / §5.1.2 / §5.1.3 / §5.1.4.
 *
 * Ack-fast pattern (Exceed §5.2):
 *   1. Read raw body (needed for HMAC).
 *   2. Verify HMAC signature (timingSafeEqual inside MockPSPClient).
 *   3. Check timestamp freshness (≤ 5 min, configurable via env).
 *   4. INSERT into webhook_inbox (UNIQUE stripe_event_id → idempotency).
 *   5. Return 200 immediately.
 *   6. Process async (setImmediate) — separate TX updates payment_intents +
 *      appends outbox event. Failure does NOT 5xx the webhook (already acked).
 *      TODO(prod): for strict durability, push to an internal processing queue
 *      so a process crash between ack and process doesn't lose the event.
 */
@Controller('api/payment')
export class WebhooksController {
  private readonly log: AppLogger;
  private readonly psp: MockPSPClient;

  constructor(
    private readonly intents: PaymentIntentsRepository,
    @Inject(LOGGER_SERVICE) loggerService: LoggerService,
  ) {
    this.log = loggerService.create('webhook');
    this.psp = new MockPSPClient(loadEnv().PSP_WEBHOOK_SECRET);
  }

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('stripe-signature') signature: string,
  ) {
    const traceId = resolveTraceId(req.headers[REQUEST_ID_HEADER] as string | undefined);
    if (!signature) throw new UnauthorizedException('missing_signature');

    // Raw body must be available — main.ts registers `express.json({ verify })`.
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      this.log.error({ action: 'webhook_no_raw_body', traceId }, 'raw body missing');
      throw new BadRequestException('raw_body_required');
    }

    // 1. Verify HMAC (timing-safe). §5.1.2.
    let event: PSPWebhookEvent;
    try {
      event = this.psp.constructEventFromWebhook(rawBody, signature);
    } catch (e) {
      this.log.warn({ action: 'webhook_bad_sig', err: String(e), traceId }, 'webhook signature verification failed');
      throw new UnauthorizedException('invalid_signature');
    }

    // 2. Timestamp freshness. §5.1.3.
    const toleranceMs = loadEnv().WEBHOOK_TOLERANCE_MS;
    const ageMs = Date.now() - event.created * 1000;
    if (ageMs > toleranceMs) {
      this.log.warn({ action: 'webhook_stale', eventId: event.id, ageMs, traceId }, 'webhook too old — possible replay');
      throw new UnauthorizedException('stale_event');
    }

    // 3. Idempotent inbox. UNIQUE(stripe_event_id) → duplicate = no-op. §5.1.4.
    webhookReceivedTotal.inc();
    const inserted = await this.intentsInsertInbox(event);
    if (!inserted) {
      webhookDedupedTotal.inc();
      this.log.info({ action: 'webhook_dedupe', eventId: event.id, traceId }, 'duplicate webhook acked (idempotent)');
      return { received: true, deduplicated: true };
    }

    // 4. Ack immediately. Processing is async.
    // Note: we still synchronously kick off the processor here for simplicity;
    // a real ack-fast impl would persist inbox in step 3 and have a separate
    // worker poll the inbox. setImmediate simulates the async boundary.
    setImmediate(() => {
      this.processEvent(event, traceId).catch((e) =>
        this.log.error({ action: 'webhook_process_err', eventId: event.id, err: String(e), traceId }, 'async processing failed'),
      );
    });
    return { received: true, deduplicated: false };
  }

  private async intentsInsertInbox(event: PSPWebhookEvent): Promise<boolean> {
    // Cheap inline INSERT — ON CONFLICT DO NOTHING tells us dedup vs new.
    // Using a quick pool query via the intents repo's pool would be cleaner,
    // but we want the inbox insert independent of intents repo.
    // We piggy-back on a helper that has pool access.
    return this.intents.insertWebhookInbox(event.id, event.type, event);
  }

  private async processEvent(event: PSPWebhookEvent, traceId: string): Promise<void> {
    const eventId = randomUUID();
    if (event.type === 'payment_intent.succeeded') {
      const r = await this.intents.markCompleted(event.data.object.id, eventId, traceId);
      if (r.ok) {
        paymentCompletedTotal.inc();
        this.log.info({ action: 'payment_completed', intentId: r.intent.id, eventId: event.id, traceId }, 'payment completed → seat reserve');
      } else {
        this.log.warn({ action: 'payment_completed_noop', pspIntentId: event.data.object.id, reason: r.reason, traceId }, 'mark completed noop');
      }
    } else if (event.type === 'payment_intent.payment_failed') {
      const r = await this.intents.markFailed(event.data.object.id, 'payment_failed', eventId, traceId);
      if (r.ok) {
        paymentFailedTotal.inc();
        this.log.info({ action: 'payment_failed', intentId: r.intent.id, eventId: event.id, traceId }, 'payment failed → seat release');
      } else {
        this.log.warn({ action: 'payment_failed_noop', pspIntentId: event.data.object.id, reason: r.reason, traceId }, 'mark failed noop');
      }
    } else {
      this.log.info({ action: 'webhook_unhandled_type', type: event.type, eventId: event.id, traceId }, 'unhandled webhook type');
    }
    // Mark inbox processed.
    await this.intents.markWebhookProcessed(event.id);
  }
}
