import { Module } from '@nestjs/common';
import { DbModule } from './config/db.module.js';
import { LoggerModule } from './common/logger.service.js';
import { CheckoutModule } from './checkout/checkout.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { HealthModule } from './health/health.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { RabbitService } from './events/rabbit.service.js';
import { OutboxWorker } from './outbox/outbox.worker.js';

@Module({
  imports: [
    DbModule,
    LoggerModule,
    CheckoutModule,
    WebhooksModule,
    HealthModule,
    MetricsModule,
  ],
  providers: [RabbitService, OutboxWorker],
})
export class AppModule {}
