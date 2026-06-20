import { Controller, Get } from '@nestjs/common';
import promClient from 'prom-client';

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// Business counters (Checklist §4.3.4)
export const seatsHeldTotal = new promClient.Counter({
  name: 'seats_held_total', help: 'Total seats held', registers: [register],
});
export const seatsReleasedTotal = new promClient.Counter({
  name: 'seats_released_total', help: 'Total seats released (incl. compensation)', registers: [register],
});
export const seatsReservedTotal = new promClient.Counter({
  name: 'seats_reserved_total', help: 'Total seats reserved', registers: [register],
});
export const reservationsCancelledTotal = new promClient.Counter({
  name: 'reservations_cancelled_total', help: 'Reservations cancelled/compensated', registers: [register],
});
export const holdConflictsTotal = new promClient.Counter({
  name: 'hold_conflicts_total', help: 'Hold conflicts (409)', registers: [register],
});
export const hotSeatDetectedTotal = new promClient.Counter({
  name: 'hot_seat_detected_total', help: 'Hot-seat contention events', registers: [register],
});

@Controller('metrics')
export class MetricsController {
  @Get()
  async metrics(): Promise<string> { return register.metrics(); }
}
