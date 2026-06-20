import { z } from 'zod';

/**
 * Versioned event contracts for RabbitMQ messages.
 * Every event carries `schema: '<name>.v<n>'` so consumers can branch on version.
 * Consumers MUST validate with the schema before processing; invalid -> DLQ.
 */

const baseMeta = z.object({
  eventId: z.string().uuid(),
  traceId: z.string().uuid(),
  occurredAt: z.string().datetime(),
});

export const SeatHeldV1 = baseMeta.extend({
  schema: z.literal('seat.held.v1'),
  seatId: z.string().uuid(),
  userId: z.string().uuid(),
  holdId: z.string().uuid(),
  heldUntil: z.string().datetime(),
  priceCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
});
export type SeatHeldV1 = z.infer<typeof SeatHeldV1>;

export const SeatReleasedV1 = baseMeta.extend({
  schema: z.literal('seat.released.v1'),
  seatId: z.string().uuid(),
  userId: z.string().uuid().optional(),
  reason: z.enum(['expired', 'payment_failed', 'user_cancelled', 'sweeper']),
});
export type SeatReleasedV1 = z.infer<typeof SeatReleasedV1>;

export const SeatReservedV1 = baseMeta.extend({
  schema: z.literal('seat.reserved.v1'),
  seatId: z.string().uuid(),
  userId: z.string().uuid(),
  holdId: z.string().uuid(),
});
export type SeatReservedV1 = z.infer<typeof SeatReservedV1>;

export const PaymentSucceededV1 = baseMeta.extend({
  schema: z.literal('payment.succeeded.v1'),
  paymentIntentId: z.string().uuid(),
  seatId: z.string().uuid(),
  userId: z.string().uuid(),
  holdId: z.string().uuid(),
  amountCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  pspIntentId: z.string(),
});
export type PaymentSucceededV1 = z.infer<typeof PaymentSucceededV1>;

export const PaymentFailedV1 = baseMeta.extend({
  schema: z.literal('payment.failed.v1'),
  paymentIntentId: z.string().uuid(),
  seatId: z.string().uuid(),
  userId: z.string().uuid(),
  holdId: z.string().uuid(),
  reason: z.string(),
});
export type PaymentFailedV1 = z.infer<typeof PaymentFailedV1>;

export type AnyEvent =
  | SeatHeldV1
  | SeatReleasedV1
  | SeatReservedV1
  | PaymentSucceededV1
  | PaymentFailedV1;

export const EVENT_SCHEMAS = [
  SeatHeldV1,
  SeatReleasedV1,
  SeatReservedV1,
  PaymentSucceededV1,
  PaymentFailedV1,
] as const;

/** Routing keys used by RabbitMQ topic exchanges. */
export const ROUTING_KEYS = {
  SEAT_HELD: 'seat.held',
  SEAT_RELEASED: 'seat.released',
  SEAT_RESERVED: 'seat.reserved',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
} as const;

export const EXCHANGES = {
  SEAT_EVENTS: 'seat.events',
  PAYMENT_EVENTS: 'payment.events',
} as const;

export const QUEUES = {
  SEAT_PAYMENT_EVENTS: 'seat.payment-events',
  PAYMENT_SEAT_EVENTS: 'payment.seat-events',
} as const;
