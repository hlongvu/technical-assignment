import { randomUUID } from 'node:crypto';

/**
 * Correlation-id helpers. `x-request-id` header is propagated end-to-end:
 * - extracted at HTTP ingress (or generated if missing)
 * - attached to every log line
 * - propagated into RabbitMQ message headers for downstream consumers
 */
export const REQUEST_ID_HEADER = 'x-request-id';

export function resolveTraceId(header?: string): string {
  if (header && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(header)) {
    return header;
  }
  return randomUUID();
}
