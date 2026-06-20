import { Controller, Get, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../config/db.module.js';
import { RabbitService } from '../events/rabbit.service.js';

const startedAt = Date.now();
const VERSION = process.env.npm_package_version ?? '1.0.0';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly rabbit: RabbitService,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok', uptime: Math.floor((Date.now() - startedAt) / 1000), version: VERSION };
  }

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
      await this.rabbit.connect();
      checks.rabbit = 'ok';
    } catch {
      checks.rabbit = 'fail';
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    return { status: ok ? 'ok' : 'degraded', checks, version: VERSION };
  }
}
