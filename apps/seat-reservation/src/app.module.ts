import { Module } from '@nestjs/common';
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

@Module({
  imports: [
    DbModule,
    LoggerModule,
    SeatsModule,
    HoldsModule,
    HealthModule,
    MetricsModule,
  ],
  providers: [RabbitService, PaymentEventsConsumer, OutboxWorker, HoldSweeper],
})
export class AppModule {}
