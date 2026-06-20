import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import Redis from 'ioredis';
import { DbModule } from './config/db.module.js';
import { LoggerModule } from './common/logger.service.js';
import { UsersModule } from './users/users.module.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { RateLimitGuard } from './common/rate-limit.guard.js';

@Module({
  imports: [
    DbModule,
    LoggerModule,
    UsersModule,
    SessionsModule,
    AuditModule,
    AuthModule,
    HealthModule,
    MetricsModule,
  ],
  providers: [
    Reflector,
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
