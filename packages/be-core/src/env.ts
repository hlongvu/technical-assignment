import { z } from 'zod';

/**
 * Shared env schema fragments. Each service composes these with its own
 * service-specific vars and calls `.parse(process.env)` at bootstrap.
 * Missing required vars => process exits with a clear error.
 */

export const baseEnv = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z.string().min(1),
  POSTGRES_HOST: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_POOL_MAX: z.coerce.number().int().positive().default(20),
  RABBITMQ_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).optional(),
};

export const jwtEnv = {
  // No defaults. Bootstrap throws if missing. Checklist §2.2.7 / §4.2.5.
  JWT_SECRET: z
    .string()
    .min(32)
    .refine((v) => v !== 'CHANGE_ME_EXAMPLE_SECRET_DO_NOT_USE', {
      message: 'JWT_SECRET must be overridden from .env.example placeholder',
    }),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32)
    .refine((v) => v !== 'CHANGE_ME_EXAMPLE_REFRESH_SECRET_DO_NOT_USE', {
      message: 'JWT_REFRESH_SECRET must be overridden from .env.example placeholder',
    }),
  JWT_AT_TTL_SECONDS: z.coerce.number().int().positive().default(900),
};

export type BaseEnv = z.infer<z.ZodObject<typeof baseEnv>>;
