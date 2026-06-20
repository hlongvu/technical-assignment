import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { loadEnv } from '../config/env.js';

export interface AccessTokenClaims {
  sub: string;       // user id
  email: string;
  tv: number;        // tokenVersion (Checklist §2.1.7). Bound at issue time; see DECISIONS.md #8.
  iat: number;
  exp: number;
}

@Injectable()
export class JwtService {
  private env = loadEnv();

  signAccessToken(userId: string, email: string, tokenVersion: number): string {
    return jwt.sign(
      { sub: userId, email, tv: tokenVersion },
      this.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: this.env.JWT_AT_TTL_SECONDS },
    );
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    return jwt.verify(token, this.env.JWT_SECRET) as AccessTokenClaims;
  }
}
