import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Response } from 'express';
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
  async ready(@Res({ passthrough: true }) res: Response) {
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
    if (!ok) res.status(503);
    return { status: ok ? 'ok' : 'degraded', checks, version: VERSION };
  }
}
