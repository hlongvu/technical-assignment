import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { JwtService } from './jwt.service.js';
import { UsersModule } from '../users/users.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { SessionsRepository } from '../sessions/sessions.repository.js';
import { LoggerModule } from '../common/logger.service.js';

@Module({
  imports: [UsersModule, AuditModule, LoggerModule],
  controllers: [AuthController],
  providers: [JwtService, SessionsRepository],
})
export class AuthModule {}
