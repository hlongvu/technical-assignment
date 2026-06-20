import { Module } from '@nestjs/common';
import { SessionsRepository } from './sessions.repository.js';

@Module({
  providers: [SessionsRepository],
  exports: [SessionsRepository],
})
export class SessionsModule {}
