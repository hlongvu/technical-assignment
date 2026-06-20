import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Redis } from 'ioredis';
import { loadEnv } from '../config/env.js';

export const RATE_LIMIT_KEY = 'rateLimit';

export interface RateLimitConfig {
  name: string;
  windowMs: number;
  max: number;
}

export function RateLimit(cfg: RateLimitConfig): MethodDecorator & ClassDecorator {
  return SetMetadata(RATE_LIMIT_KEY, cfg) as MethodDecorator & ClassDecorator;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly redis: Redis;
  constructor(private readonly reflector: Reflector) {
    this.redis = new Redis(loadEnv().REDIS_URL);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const cfg = this.reflector.get<RateLimitConfig | undefined>(
      RATE_LIMIT_KEY,
      ctx.getHandler(),
    );
    if (!cfg) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.ip ?? 'unknown';
    const key = `rl:${cfg.name}:${ip}`;

    const now = Date.now();
    const windowStart = now - cfg.windowMs;
    const multi = this.redis.multi();
    multi.zremrangebyscore(key, 0, windowStart);
    multi.zadd(key, now, `${now}:${Math.random()}`);
    multi.zcount(key, windowStart, now);
    multi.pexpire(key, cfg.windowMs);
    const results = await multi.exec();
    const count = (results?.[2]?.[1] as number) ?? 0;

    res.setHeader('X-RateLimit-Limit', String(cfg.max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, cfg.max - count)));

    if (count > cfg.max) {
      res.setHeader('Retry-After', String(Math.ceil(cfg.windowMs / 1000)));
      res.status(429).json({ error: 'rate_limited', retryAfter: Math.ceil(cfg.windowMs / 1000) });
      return false;
    }
    return true;
  }
}
