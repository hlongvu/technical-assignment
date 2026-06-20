/**
 * Outbox row shape shared by every service that emits events.
 * Table DDL lives in each service's migration (same columns).
 */
export interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  headers: Record<string, string>;
  state: 'PENDING' | 'PROCESSING' | 'DEAD';
  attempts: number;
  next_attempt_at: Date;
  created_at: Date;
}

/**
 * Idempotent-consumer table shape. PRIMARY KEY (event_id, consumer_group)
 * guarantees a redelivered event is processed exactly once per consumer.
 */
export interface ConsumedEventRow {
  event_id: string;
  consumer_group: string;
  processed_at: Date;
}
