import { z } from 'zod';
import { baseEnv, jwtEnv } from '@seat-reservation/be-core';

// REDIS_URL is required for seat-service (rate-limit guard uses it).
const seatBaseEnv = {
  ...baseEnv,
  REDIS_URL: z.string().min(1),
};

export const seatEnvSchema = z.object({
  ...seatBaseEnv,
  ...jwtEnv,
  SEAT_PORT: z.coerce.number().int().positive().default(4002),
  HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  SWEEP_BATCH_LIMIT: z.coerce.number().int().positive().default(100),
  RETRY_AFTER_SECONDS: z.coerce.number().int().positive().default(2),
  RATE_LIMIT_SEAT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_SEAT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
});

export type SeatEnv = z.infer<typeof seatEnvSchema>;

let cached: SeatEnv | null = null;

export function loadEnv(): SeatEnv {
  if (cached) return cached;
  cached = seatEnvSchema.parse(process.env);
  return cached;
}
