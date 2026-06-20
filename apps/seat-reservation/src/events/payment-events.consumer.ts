import { Injectable, OnModuleDestroy, Inject } from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';
import { RabbitService } from './rabbit.service.js';
import { HoldsRepository } from '../holds/holds.repository.js';
import { SeatsRepository } from '../seats/seats.repository.js';
import { SeatEventBus } from '../seats/seat-event.bus.js';
import { QUEUES } from '@seat-reservation/contracts';
import {
  PaymentSucceededV1,
  PaymentFailedV1,
  SeatHeldV1,
  SeatReleasedV1,
  SeatReservedV1,
} from '@seat-reservation/contracts';
import { LOGGER_SERVICE, LoggerService } from '../common/logger.service.js';
import { AppLogger } from '@seat-reservation/be-core';
import { z } from 'zod';
import { seatsReservedTotal, seatsReleasedTotal } from '../metrics/metrics.controller.js';

const AnyEvent = z.union([PaymentSucceededV1, PaymentFailedV1, SeatHeldV1, SeatReleasedV1, SeatReservedV1]);

/**
 * Consumes payment events from RabbitMQ and applies them to seat state.
 * Idempotent via consumed_events UNIQUE (event_id, consumer_group). §5.2.5.
 *
 * On payment.succeeded → reserve the seat (UPDATE hold -> RESERVED).
 * On payment.failed    → release the hold (compensation, §5.2.1).
 */
@Injectable()
export class PaymentEventsConsumer implements OnModuleDestroy {
  private readonly log: AppLogger;
  private started = false;

  constructor(
    private readonly rabbit: RabbitService,
    private readonly holds: HoldsRepository,
    private readonly seats: SeatsRepository,
    private readonly bus: SeatEventBus,
    @Inject(LOGGER_SERVICE) loggerService: LoggerService,
  ) {
    this.log = loggerService.create('payment-consumer');
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.rabbit.connect();
    await this.rabbit.consume(QUEUES.SEAT_PAYMENT_EVENTS, async (msg, ch) => {
      if (!msg) return;
      const content = msg.content.toString();
      let parsed: z.infer<typeof AnyEvent>;
      try {
        parsed = AnyEvent.parse(JSON.parse(content));
      } catch (e) {
        this.log.error({ action: 'event_invalid', err: String(e), raw: content }, 'invalid event -> DLQ');
        ch.nack(msg, false, false); // do not requeue; let DLX route to DLQ
        return;
      }
      try {
        if (parsed.schema === 'payment.succeeded.v1') {
          const r = await this.holds.reserveHold(parsed.holdId, parsed.eventId, 'seat-service', parsed.traceId);
          if (r.reserved) {
            seatsReservedTotal.inc();
            this.bus.emit({ type: 'seat:reserved', seatId: r.seatId, userId: r.userId });
            this.log.info({ action: 'reserved', seatId: r.seatId, userId: r.userId, traceId: parsed.traceId }, 'seat reserved');
          } else {
            this.log.warn({ action: 'reserve_noop', holdId: parsed.holdId, eventId: parsed.eventId, traceId: parsed.traceId }, 'reserve noop (idempotent skip or no active hold)');
          }
        } else if (parsed.schema === 'payment.failed.v1') {
          const r = await this.holds.releaseHold(parsed.holdId, 'payment_failed', parsed.traceId);
          if (r.released) {
            seatsReleasedTotal.inc();
            this.bus.emit({ type: 'seat:released', seatId: r.seatId });
            this.log.info({ action: 'released', seatId: r.seatId, traceId: parsed.traceId }, 'seat released (payment failed)');
          } else {
            this.log.warn({ action: 'release_noop', holdId: parsed.holdId, traceId: parsed.traceId }, 'release noop');
          }
        }
        ch.ack(msg);
      } catch (e) {
        this.log.error({ action: 'event_process_err', err: String(e), eventId: (parsed as { eventId?: string }).eventId }, 'processing error -> requeue');
        ch.nack(msg, false, true);
      }
    });
  }

  onModuleDestroy(): void { /* rabbit.service handles close */ }
}
