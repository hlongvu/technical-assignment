import { Module } from '@nestjs/common';
import { HoldsRepository } from './holds.repository.js';

@Module({
  providers: [HoldsRepository],
  exports: [HoldsRepository],
})
export class HoldsModule {}
