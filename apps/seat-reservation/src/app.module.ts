import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { DbModule } from './config/db.module.js';
import { LoggerModule } from './common/logger.service.js';
import { SeatsModule } from './seats/seats.module.js';
import { HoldsModule } from './holds/holds.module.js';
import { HealthModule } from './health/health.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { RabbitService } from './events/rabbit.service.js';
import { PaymentEventsConsumer } from './events/payment-events.consumer.js';
import { OutboxWorker } from './outbox/outbox.worker.js';
import { HoldSweeper } from './holds/hold-sweeper.js';
import { RateLimitGuard } from './common/rate-limit.guard.js';

@Module({
  imports: [
    DbModule,
    LoggerModule,
    SeatsModule,
    HoldsModule,
    HealthModule,
    MetricsModule,
  ],
  providers: [
    Reflector,
    { provide: APP_GUARD, useClass: RateLimitGuard },
    RabbitService,
    PaymentEventsConsumer,
    OutboxWorker,
    HoldSweeper,
  ],
})
export class AppModule {}
