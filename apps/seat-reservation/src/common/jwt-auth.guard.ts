import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { loadEnv } from '../config/env.js';

/**
 * JWT auth guard. Verifies AT signature using shared JWT_SECRET.
 *
 * NOTE on tokenVersion (Checklist §2.1.7): the `tv` claim is read from the
 * JWT only — no cross-service DB call. True immediate invalidation on logout
 * requires a Redis cache that auth writes and consumers read on every request.
 * See DECISIONS.md #8. The 15-min AT TTL bounds staleness.
 */
export interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    email: string;
    tokenVersion: number;
    traceId: string;
  };
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing_token');
    }
    const token = auth.slice('Bearer '.length).trim();
    try {
      const claims = jwt.verify(token, loadEnv().JWT_SECRET) as {
        sub: string; email: string; tv: number;
      };
      req.user = {
        userId: claims.sub,
        email: claims.email,
        tokenVersion: claims.tv,
        traceId: (req.headers['x-request-id'] as string) ?? '',
      };
      return true;
    } catch {
      throw new UnauthorizedException('invalid_token');
    }
  }
}
