import { Controller, Get } from '@nestjs/common';
import promClient from 'prom-client';

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

export const paymentInitiatedTotal = new promClient.Counter({
  name: 'payment_initiated_total', help: 'Payment intents created', registers: [register],
});
export const paymentCompletedTotal = new promClient.Counter({
  name: 'payment_completed_total', help: 'Payments completed', registers: [register],
});
export const paymentFailedTotal = new promClient.Counter({
  name: 'payment_failed_total', help: 'Payments failed', registers: [register],
});
export const webhookReceivedTotal = new promClient.Counter({
  name: 'webhook_received_total', help: 'Webhooks received', registers: [register],
});
export const webhookDedupedTotal = new promClient.Counter({
  name: 'webhook_deduped_total', help: 'Webhooks deduplicated', registers: [register],
});

@Controller('metrics')
export class MetricsController {
  @Get()
  async metrics(): Promise<string> { return register.metrics(); }
}
