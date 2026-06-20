import {
  Body,
  Controller,
  Post,
  Req,
  Res,
  UnauthorizedException,
  BadRequestException,
  HttpCode,
} from '@nestjs/common';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { Inject } from '@nestjs/common';
import { UsersRepository } from '../users/users.repository.js';
import { SessionsRepository } from '../sessions/sessions.repository.js';
import { AuditService } from '../audit/audit.module.js';
import { JwtService } from './jwt.service.js';
import { verifyPassword, verifyDummyPassword } from '../users/password.js';
import { loadEnv, RT_COOKIE_NAME, RT_COOKIE_PATH } from '../config/env.js';
import { AppLogger, REQUEST_ID_HEADER, resolveTraceId } from '@seat-reservation/be-core';
import { LOGGER_SERVICE, LoggerService } from '../common/logger.service.js';
import { RateLimit } from '../common/rate-limit.guard.js';

const LoginDto = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
const RegisterDto = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

function setRtCookie(res: Response, raw: string): void {
  const env = loadEnv();
  res.cookie(RT_COOKIE_NAME, raw, {
    httpOnly: true,                           // Checklist §2.1.1
    sameSite: 'strict',
    secure: env.NODE_ENV === 'production',
    path: RT_COOKIE_PATH,                     // scope to /api/auth (Exceed)
    maxAge: env.RT_TTL_SECONDS * 1000,        // 90 days per requirement
  });
}

function clearRtCookie(res: Response): void {
  const env = loadEnv();
  res.clearCookie(RT_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'strict',
    secure: env.NODE_ENV === 'production',
    path: RT_COOKIE_PATH,
  });
}

@Controller('api/auth')
export class AuthController {
  private readonly log: AppLogger;

  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    @Inject(LOGGER_SERVICE) loggerService: LoggerService,
  ) {
    this.log = loggerService.create('auth');
  }

  @Post('register')
  @HttpCode(201)
  async register(@Body() body: unknown, @Req() req: Request): Promise<{ userId: string }> {
    const dto = RegisterDto.parse(body);
    const traceId = resolveTraceId(req.headers[REQUEST_ID_HEADER] as string | undefined);
    try {
      const user = await this.users.create(dto.email, dto.password);
      await this.audit.record(user.id, 'register', { traceId });
      this.log.info({ action: 'register', userId: user.id, traceId }, 'user registered');
      return { userId: user.id };
    } catch (e) {
      // unique violation on email
      if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === '23505') {
        throw new BadRequestException('email_already_registered');
      }
      throw e;
    }
  }

  @Post('login')
  @HttpCode(200)
  @RateLimit({
    name: 'login',
    windowMs: loadEnv().RATE_LIMIT_LOGIN_WINDOW_MS,
    max: loadEnv().RATE_LIMIT_LOGIN_MAX,
  })
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const dto = LoginDto.parse(body);
    const traceId = resolveTraceId(req.headers[REQUEST_ID_HEADER] as string | undefined);
    const ip = req.ip;

    const user = await this.users.findByEmail(dto.email);

    // Timing equalization: if user doesn't exist, run a real argon2 verify against
    // a dummy hash so the response timing matches a failed real login.
    // Checklist §2.1.9 Exceed.
    const ok = user
      ? await verifyPassword(user.password_hash, dto.password)
      : await verifyDummyPassword();

    if (!user || !ok) {
      this.log.warn({ action: 'login_failed', email: dto.email, traceId, ip }, 'login failed');
      await this.audit.record(user?.id ?? null, 'login', { traceId, ip, ok: false });
      throw new UnauthorizedException('invalid_credentials');
    }

    const issued = await this.sessions.issueNewFamily(user.id);
    const at = this.jwt.signAccessToken(user.id, user.email, user.token_version);
    setRtCookie(res, issued.raw);
    await this.audit.record(user.id, 'login', { traceId, ip, ok: true });
    this.log.info({ action: 'login', userId: user.id, traceId }, 'login success');
    return { accessToken: at, userId: user.id };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const env = loadEnv();
    const traceId = resolveTraceId(req.headers[REQUEST_ID_HEADER] as string | undefined);
    const rawRt = req.cookies?.[RT_COOKIE_NAME] as string | undefined;
    if (!rawRt) throw new UnauthorizedException('no_refresh_token');

    const row = await this.sessions.findByRaw(rawRt);
    if (!row) {
      this.log.warn({ action: 'refresh_unknown', traceId }, 'refresh token not recognised');
      throw new UnauthorizedException('invalid_refresh_token');
    }

    const now = Date.now();
    const expired = now >= row.expires_at.getTime();
    if (expired) {
      this.log.warn({ action: 'refresh_expired', traceId, userId: row.user_id }, 'rt expired');
      throw new UnauthorizedException('expired_refresh_token');
    }

    // Branch 1: active (not revoked) → rotate.
    if (row.revoked_at === null) {
      const user = await this.users.findById(row.user_id);
      if (!user) throw new UnauthorizedException('user_not_found');
      const rotated = await this.sessions.rotate(row);
      const at = this.jwt.signAccessToken(user.id, user.email, user.token_version);
      setRtCookie(res, rotated.raw);
      await this.audit.record(user.id, 'refresh', { traceId });
      this.log.info({ action: 'refresh', userId: user.id, traceId }, 'rt rotated');
      return { accessToken: at, userId: user.id };
    }

    // Branch 2: revoked but within grace window → accept as network retry, no rotation.
    // Checklist §2.1.6 Exceed.
    if (row.grace_until && now <= row.grace_until.getTime()) {
      const user = await this.users.findById(row.user_id);
      if (!user) throw new UnauthorizedException('user_not_found');
      const at = this.jwt.signAccessToken(user.id, user.email, user.token_version);
      this.log.warn(
        { action: 'refresh_grace', userId: user.id, traceId },
        'rt reused within grace window (network retry?)',
      );
      await this.audit.record(user.id, 'refresh', { traceId, grace: true });
      return { accessToken: at, userId: user.id };
    }

    // Branch 3: revoked past grace → theft detected. Revoke entire family.
    // Checklist §2.1.5 Exceed.
    await this.sessions.revokeFamily(row.family_id);
    await this.audit.record(row.user_id, 'session_revoke', { traceId, reason: 'reuse_detected' });
    this.log.error(
      { action: 'rt_reuse_detected', userId: row.user_id, familyId: row.family_id, traceId },
      'revoked token reused past grace — family revoked',
    );
    clearRtCookie(res);
    throw new UnauthorizedException('reuse_detected');
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const traceId = resolveTraceId(req.headers[REQUEST_ID_HEADER] as string | undefined);
    const rawRt = req.cookies?.[RT_COOKIE_NAME] as string | undefined;
    if (rawRt) {
      const row = await this.sessions.findByRaw(rawRt);
      if (row) {
        await this.sessions.revoke(row.id);
        // Bump token_version so outstanding ATs become stale at the next check.
        // (True immediate invalidation requires Redis cache — see DECISIONS.md #8.)
        await this.users.bumpTokenVersion(row.user_id);
        await this.audit.record(row.user_id, 'logout', { traceId });
        this.log.info({ action: 'logout', userId: row.user_id, traceId }, 'logout');
      }
    }
    clearRtCookie(res);
  }

  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const traceId = resolveTraceId(req.headers[REQUEST_ID_HEADER] as string | undefined);
    const rawRt = req.cookies?.[RT_COOKIE_NAME] as string | undefined;
    if (rawRt) {
      const row = await this.sessions.findByRaw(rawRt);
      if (row) {
        await this.sessions.revokeAllForUser(row.user_id);
        await this.users.bumpTokenVersion(row.user_id); // invalidate all outstanding ATs
        await this.audit.record(row.user_id, 'logout_all', { traceId });
        this.log.info({ action: 'logout_all', userId: row.user_id, traceId }, 'logout-all');
      }
    }
    clearRtCookie(res);
  }
}
