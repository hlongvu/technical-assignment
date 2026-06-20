import { z } from 'zod';
import { baseEnv, jwtEnv } from '@seat-reservation/be-core';

// REDIS_URL is required for auth-service (rate-limit guard + health check use it).
const authBaseEnv = {
  ...baseEnv,
  REDIS_URL: z.string().min(1),
};

/**
 * Auth-service env. Composes shared fragments + service-specific vars.
 * No defaults on secrets — bootstrap throws if missing (Checklist §2.2.7 / §4.2.5).
 */
export const authEnvSchema = z.object({
  ...authBaseEnv,
  ...jwtEnv,
  AUTH_PORT: z.coerce.number().int().positive().default(4001),
  RT_TTL_SECONDS: z.coerce.number().int().positive().default(7776000),
  RT_GRACE_SECONDS: z.coerce.number().int().positive().default(10),
  ARGON2_MEMORY_KIB: z.coerce.number().int().positive().default(65536),
  ARGON2_TIME_COST: z.coerce.number().int().positive().default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().default(1),
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_LOGIN_WINDOW_MS: z.coerce.number().int().positive().default(60000),
});

export type AuthEnv = z.infer<typeof authEnvSchema>;

let cached: AuthEnv | null = null;

export function loadEnv(): AuthEnv {
  if (cached) return cached;
  cached = authEnvSchema.parse(process.env);
  return cached;
}

export const RT_COOKIE_NAME = 'rt';
export const RT_COOKIE_PATH = '/api/auth';
