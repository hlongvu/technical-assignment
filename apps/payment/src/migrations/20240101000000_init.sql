-- 20240101000000_init.sql
-- payment_db initial schema. Checklist §1.2.1.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Amount locked at checkout creation (Checklist §3.3.3 / §5.1.5).
CREATE TABLE IF NOT EXISTS payment_intents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_id         UUID NOT NULL,
  user_id         UUID NOT NULL,
  hold_id         UUID NOT NULL,
  amount_cents    INT  NOT NULL CHECK (amount_cents >= 0),
  currency        TEXT NOT NULL DEFAULT 'USD',
  psp_intent_id   TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | COMPLETED | FAILED
  idempotency_key UUID NOT NULL UNIQUE,             -- client-supplied, prevents double-create (§3.3.4)
  client_secret   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS pi_seat_id ON payment_intents (seat_id);
CREATE INDEX IF NOT EXISTS pi_status ON payment_intents (status) WHERE status = 'PENDING';

-- Webhook idempotency inbox. Checklist §3.3.1 / §5.1.4.
CREATE TABLE IF NOT EXISTS webhook_inbox (
  stripe_event_id TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  payload         JSONB NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS webhook_inbox_unprocessed
  ON webhook_inbox (received_at) WHERE processed_at IS NULL;

-- Denormalized seat prices seeded at migration time. DECISIONS.md #9.
-- 3 static seats; for dynamic pricing, TODO(prod): consume seat.held events to upsert.
CREATE TABLE IF NOT EXISTS seat_prices (
  seat_id     UUID PRIMARY KEY,
  price_cents INT NOT NULL CHECK (price_cents >= 0),
  currency    TEXT NOT NULL DEFAULT 'USD',
  label       TEXT NOT NULL
);

-- Transactional outbox (DECISIONS.md #4).
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

-- Idempotent consumer tracking (Checklist §5.2.5).
CREATE TABLE IF NOT EXISTS consumed_events (
  event_id       UUID NOT NULL,
  consumer_group TEXT NOT NULL,
  processed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, consumer_group)
);
