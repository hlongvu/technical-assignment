import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { loadEnv } from '../config/env.js';

export interface AuthenticatedRequest extends Request {
  user: { userId: string; email: string; tokenVersion: number; traceId: string };
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
