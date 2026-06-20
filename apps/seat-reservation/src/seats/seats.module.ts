import { Module } from '@nestjs/common';
import { SeatsController } from './seats.controller.js';
import { SeatsRepository } from './seats.repository.js';
import { SeatEventBus } from './seat-event.bus.js';
import { HoldsModule } from '../holds/holds.module.js';

@Module({
  imports: [HoldsModule],
  controllers: [SeatsController],
  providers: [SeatsRepository, SeatEventBus],
  exports: [SeatEventBus],
})
export class SeatsModule {}
