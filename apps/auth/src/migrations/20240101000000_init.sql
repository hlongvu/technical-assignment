-- 20240101000000_init.sql
-- auth_db initial schema. Idempotent where possible. Checklist §1.2.1.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                            -- argon2id encoded string
  token_version INT  NOT NULL DEFAULT 0,                  -- Checklist §2.1.7 / §2.1.8
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id    UUID NOT NULL,                             -- Checklist §2.1.5 reuse detection
  token_hash   BYTEA NOT NULL UNIQUE,                     -- SHA-256(rt). Checklist §2.1.3
  rotated_to   UUID REFERENCES refresh_tokens(id),
  revoked_at   TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  grace_until  TIMESTAMPTZ,                               -- Checklist §2.1.6
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Active (non-revoked) tokens per user — partial index, hot path for /refresh.
CREATE INDEX IF NOT EXISTS rt_user_active
  ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- Family lookup for reuse detection (revoke-all-family).
CREATE INDEX IF NOT EXISTS rt_family
  ON refresh_tokens (family_id);

-- Audit log is append-only. Checklist §2.2.8.
CREATE TABLE IF NOT EXISTS audit_log (
  id      BIGSERIAL PRIMARY KEY,
  user_id UUID,
  action  TEXT NOT NULL,
  meta    JSONB NOT NULL DEFAULT '{}',
  at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_user_action ON audit_log (user_id, action);
