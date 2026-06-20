import { Controller, Get } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../config/db.module.js';
import { Redis } from 'ioredis';
import { loadEnv } from '../config/env.js';

const startedAt = Date.now();
const VERSION = process.env.npm_package_version ?? '1.0.0';

@Controller('health')
export class HealthController {
  private redis: Redis | null = null;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    if (loadEnv().REDIS_URL) {
      this.redis = new Redis(loadEnv().REDIS_URL!);
    }
  }

  /** Checklist §4.1.1: process-alive probe. */
  @Get('live')
  live() {
    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      version: VERSION,
    };
  }

  /** Checklist §4.1.2: ready probe checks every dep; returns degraded state. */
  @Get('ready')
  async ready() {
    const checks: Record<string, string> = {};
    try {
      await this.pool.query('SELECT 1');
      checks.db = 'ok';
    } catch {
      checks.db = 'fail';
    }
    try {
      if (this.redis) {
        await this.redis.ping();
        checks.redis = 'ok';
      } else {
        checks.redis = 'skip';
      }
    } catch {
      checks.redis = 'fail';
    }
    // Rabbit is not a hard dep for auth-service in the assessment scope.
    checks.rabbit = 'skip';
    const ok = Object.values(checks).every((v) => v === 'ok' || v === 'skip');
    return {
      status: ok ? 'ok' : 'degraded',
      checks,
      version: VERSION,
    };
  }
}
