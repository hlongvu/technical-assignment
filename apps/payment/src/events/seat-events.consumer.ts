import { Injectable, OnModuleDestroy, Inject } from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';
import { RabbitService } from './rabbit.service.js';
import { PaymentIntentsRepository } from '../checkout/payment-intents.repository.js';
import { QUEUES } from '@seat-reservation/contracts';
import { SeatReleasedV1 } from '@seat-reservation/contracts';
import { LOGGER_SERVICE, LoggerService } from '../common/logger.service.js';
import { AppLogger } from '@seat-reservation/be-core';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

/**
 * Consumes seat.released events from RabbitMQ. Checklist §5.2.4.
 *
 * On seat.released (sweeper expired the hold, or user cancelled):
 *   → cancel any pending payment intent for that hold (mark FAILED).
 *   → emit payment.failed.v1 so downstream consumers know.
 *
 * Idempotent via consumed_events UNIQUE (event_id, consumer_group). §5.2.5.
 */
@Injectable()
export class SeatEventsConsumer implements OnModuleDestroy {
  private readonly log: AppLogger;
  private started = false;

  constructor(
    private readonly rabbit: RabbitService,
    private readonly intents: PaymentIntentsRepository,
    @Inject(LOGGER_SERVICE) loggerService: LoggerService,
  ) {
    this.log = loggerService.create('seat-consumer');
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.rabbit.connect();
    await this.rabbit.consume(QUEUES.PAYMENT_SEAT_EVENTS, async (msg, ch) => {
      if (!msg) return;
      const content = msg.content.toString();
      let parsed: z.infer<typeof SeatReleasedV1>;
      try {
        parsed = SeatReleasedV1.parse(JSON.parse(content));
      } catch (e) {
        this.log.error({ action: 'seat_event_invalid', err: String(e), raw: content }, 'invalid seat event -> DLQ');
        ch.nack(msg, false, false);
        return;
      }
      try {
        if (parsed.schema === 'seat.released.v1') {
          const eventId = parsed.eventId;
          const traceId = parsed.traceId;
          const r = await this.intents.markFailedBySeatId(parsed.seatId, 'seat_released', randomUUID(), traceId);
          if (r.ok) {
            this.log.info(
              { action: 'intent_cancelled', intentId: r.intent.id, seatId: parsed.seatId, seatEventId: eventId, traceId },
              'pending intent cancelled (seat released)',
            );
          } else {
            this.log.info(
              { action: 'cancel_noop', seatId: parsed.seatId, reason: r.reason, traceId },
              'no pending intent to cancel',
            );
          }
        }
        ch.ack(msg);
      } catch (e) {
        this.log.error({ action: 'seat_event_process_err', err: String(e), eventId: (parsed as { eventId?: string }).eventId }, 'processing error -> requeue');
        ch.nack(msg, false, true);
      }
    });
  }

  onModuleDestroy(): void { /* rabbit.service handles close */ }
}
