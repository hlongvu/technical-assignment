-- 20240101000000_init.sql
-- seat_db initial schema. Idempotent where possible. Checklist §1.2.1.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS seats (
  id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label  TEXT NOT NULL,
  price_cents  INT  NOT NULL CHECK (price_cents >= 0),
  currency    TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'AVAILABLE'   -- AVAILABLE | HELD | RESERVED
);

CREATE TABLE IF NOT EXISTS holds (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_id      UUID NOT NULL REFERENCES seats(id),
  user_id      UUID NOT NULL,
  status       TEXT NOT NULL DEFAULT 'HELD',  -- HELD | RELEASED | RESERVED
  held_until   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at  TIMESTAMPTZ,
  reserved_at  TIMESTAMPTZ
);

-- §3.1.2 / §3.1.3: DB-level invariants. The crux of the concurrency story.
-- Partial unique index: at most one active HELD per seat.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_hold_per_seat
  ON holds (seat_id) WHERE status = 'HELD';
-- Partial unique index: at most one active HELD per user.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_hold_per_user
  ON holds (user_id) WHERE status = 'HELD';

-- Hot-path for sweeper query (held_until < NOW() AND status='HELD').
CREATE INDEX IF NOT EXISTS idx_holds_expiry
  ON holds (held_until) WHERE status = 'HELD';

-- Transactional outbox (DECISIONS.md #4). Same columns across services.
CREATE TABLE IF NOT EXISTS outbox (
  id              BIGSERIAL PRIMARY KEY,
  aggregate_id    UUID NOT NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  headers         JSONB NOT NULL DEFAULT '{}',
  state           TEXT NOT NULL DEFAULT 'PENDING',
  attempts        INT  NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox (next_attempt_at) WHERE state = 'PENDING';

-- Idempotent saga steps (Checklist §5.2.5). UNIQUE (event_id, consumer_group).
CREATE TABLE IF NOT EXISTS consumed_events (
  event_id       UUID NOT NULL,
  consumer_group TEXT NOT NULL,
  processed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, consumer_group)
);
