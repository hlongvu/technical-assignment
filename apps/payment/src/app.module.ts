import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { DbModule } from './config/db.module.js';
import { LoggerModule } from './common/logger.service.js';
import { CheckoutModule } from './checkout/checkout.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { HealthModule } from './health/health.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { RabbitService } from './events/rabbit.service.js';
import { SeatEventsConsumer } from './events/seat-events.consumer.js';
import { OutboxWorker } from './outbox/outbox.worker.js';
import { RateLimitGuard } from './common/rate-limit.guard.js';

@Module({
  imports: [
    DbModule,
    LoggerModule,
    CheckoutModule,
    WebhooksModule,
    HealthModule,
    MetricsModule,
  ],
  providers: [
    Reflector,
    { provide: APP_GUARD, useClass: RateLimitGuard },
    RabbitService,
    SeatEventsConsumer,
    OutboxWorker,
  ],
})
export class AppModule {}
