import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { RabbitService } from '../events/rabbit.service.js';

@Module({
  controllers: [HealthController],
  imports: [],
  providers: [RabbitService],
  exports: [RabbitService],
})
export class HealthModule {}
