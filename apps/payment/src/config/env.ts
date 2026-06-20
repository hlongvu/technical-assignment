import { z } from 'zod';
import { baseEnv, jwtEnv } from '@seat-reservation/be-core';

// REDIS_URL is required for payment-service (rate-limit guard uses it).
const paymentBaseEnv = {
  ...baseEnv,
  REDIS_URL: z.string().min(1),
};

export const paymentEnvSchema = z.object({
  ...paymentBaseEnv,
  ...jwtEnv,
  PAYMENT_PORT: z.coerce.number().int().positive().default(4003),
  WEBHOOK_TOLERANCE_MS: z.coerce.number().int().positive().default(300000),
  PSP_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  PSP_CB_ERROR_THRESHOLD: z.coerce.number().int().positive().default(50),
  PSP_CB_RESET_MS: z.coerce.number().int().positive().default(30000),
  PSP_WEBHOOK_SECRET: z.string().min(16),
  RATE_LIMIT_PAYMENT_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_PAYMENT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
});

export type PaymentEnv = z.infer<typeof paymentEnvSchema>;

let cached: PaymentEnv | null = null;

export function loadEnv(): PaymentEnv {
  if (cached) return cached;
  cached = paymentEnvSchema.parse(process.env);
  return cached;
}
