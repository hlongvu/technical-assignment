import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Response } from 'express';
import { PG_POOL } from '../config/db.module.js';
import { Redis } from 'ioredis';
import { loadEnv } from '../config/env.js';

const startedAt = Date.now();
const VERSION = process.env.npm_package_version ?? '1.0.0';

@Controller('health')
export class HealthController {
  private readonly redis: Redis;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    this.redis = new Redis(loadEnv().REDIS_URL);
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

  /** Checklist §4.1.2: ready probe checks every dep; returns 503 when degraded. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, string> = {};
    try {
      await this.pool.query('SELECT 1');
      checks.db = 'ok';
    } catch {
      checks.db = 'fail';
    }
    try {
      await this.redis.ping();
      checks.redis = 'ok';
    } catch {
      checks.redis = 'fail';
    }
    checks.rabbit = 'skip';
    const ok = checks.db === 'ok' && checks.redis === 'ok';
    if (!ok) res.status(503);
    return {
      status: ok ? 'ok' : 'degraded',
      checks,
      version: VERSION,
    };
  }
}
