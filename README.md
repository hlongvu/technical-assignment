# Seat Reservation Platform

A small public seat reservation platform demonstrating 3-seat booking with login, hold, payment, and reservation.
Built as 3 microservices with RabbitMQ for inter-service events, PostgreSQL per service, Redis for rate-limiting, and nginx as gateway.

> See **[DECISIONS.md](./DECISIONS.md)** for architecture trade-offs and scope cuts.
> See **[docs/implementation.md](./docs/implementation.md)** for the full plan that drove this code.
> See **[docs/review-checklist.md](./docs/review-checklist.md)** for the rubric this submission targets.

---

## Stack

- **TypeScript** (strict mode), **NestJS** for all 3 services
- **PostgreSQL 16** — one DB per service (`auth_db`, `seat_db`, `payment_db`)
- **RabbitMQ 3.13** — inter-service async events via transactional outbox
- **Redis 7** — rate-limit state (stateless across restarts)
- **nginx 1.27** — gateway + rate-limit zones (services not exposed directly)
- **Docker Compose** — full local stack

---

## Monorepo layout

```
technical-assignment/
├── docker-compose.yml              postgres, redis, rabbitmq, auth, seat, payment, nginx
├── apps/
│   ├── auth/                       port 4001 — CPU-bound (argon2id)
│   │   ├── src/
│   │   │   ├── main.ts             bootstrap, helmet, cors, sigterm
│   │   │   ├── app.module.ts       NestJS module wiring
│   │   │   ├── config/             env.ts (Zod), db.module.ts (pg.Pool)
│   │   │   ├── users/              register, argon2id, timing equalization
│   │   │   ├── sessions/           RT store, rotation, family reuse detection
│   │   │   ├── auth/               login / refresh / logout / logout-all
│   │   │   ├── audit/              append-only audit_log table
│   │   │   ├── health/             /health/live  /health/ready
│   │   │   ├── metrics/            /metrics (prom-client)
│   │   │   ├── common/             logger, ZodPipe, RateLimitGuard
│   │   │   └── migrations/         20240101000000_init.sql + run.ts
│   │   ├── Dockerfile              multi-stage, USER node
│   │   └── package.json
│   ├── seat-reservation/           port 4002 — DB-bound (locks + sweeper)
│   │   ├── src/
│   │   │   ├── seats/              list, SSE /api/seats/stream, hold, release
│   │   │   ├── holds/              holds.repo, hold-sweeper (SKIP LOCKED)
│   │   │   ├── events/             RabbitService, payment-events.consumer
│   │   │   ├── outbox/             outbox.worker (publishes with confirms)
│   │   │   ├── health/, metrics/, common/, migrations/
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── payment/                    port 4003 — I/O-bound (PSP webhooks)
│   │   ├── src/
│   │   │   ├── checkout/           payment_intents repo + controller
│   │   │   ├── webhooks/           HMAC verify + ack-fast + idempotent inbox
│   │   │   ├── psps/               PSPClient interface, MockPSPClient, CircuitBreaker
│   │   │   ├── events/             RabbitService (publishes payment.* events)
│   │   │   ├── outbox/             outbox.worker
│   │   │   ├── health/, metrics/, common/, migrations/
│   │   ├── Dockerfile
│   │   └── package.json
│   └── web/                        static index.html served by nginx
├── packages/
│   ├── be-core/                    logger (pino), env schema, correlation-id, outbox types
│   ├── contracts/                  versioned event schemas (Zod) + routing keys
│   └── tsconfig-base/              shared tsconfig.base.json (strict: true)
├── infra/
│   ├── nginx/nginx.conf            rate-limit zones (login / api / webhook), reverse proxy
│   ├── postgres/postgres.conf      log_min_duration_statement, log_lock_waits, deadlock_timeout
│   └── postgres/init.sql           creates auth_db, seat_db, payment_db
├── scripts/
│   ├── e2e-smoke.sh                login → hold → checkout → webhook → RESERVED
│   └── seed.ts                     seeds 3 seats into seat_db
├── DECISIONS.md                    12 architecture / scope entries — read first
├── docs/                           requirement, review-checklist, implementation plan
└── .env.example                    every env var documented (required vs optional)
```

---

## Service responsibilities & ports

| Service              | Port | DB           | Profile       | Why separate (DECISIONS.md #1)                          |
|----------------------|------|--------------|---------------|---------------------------------------------------------|
| auth                 | 4001 | auth_db      | CPU-bound     | argon2 spikes CPU on login floods                       |
| seat-reservation     | 4002 | seat_db      | DB-bound      | row locks on `holds`, sweeper cadence                   |
| payment              | 4003 | payment_db   | I/O-bound     | PSP latency & retries, webhook idempotency              |
| nginx (gateway)      | 8080 | —            | —             | only entrypoint clients talk to (Exceed §1.0.1)         |

Each service can be scaled independently:
```bash
docker compose up --scale seat-reservation=3
```
Replica-safety: sweeper uses `FOR UPDATE SKIP LOCKED`; outbox workers use `FOR UPDATE SKIP LOCKED`;
SSE fan-out is in-process (TODO(prod): Redis pub/sub — see DECISIONS.md #7).

---

## Architecture diagram

```
                ┌─────────────────────────────┐
                │         Browser             │
                │   apps/web (static HTML)    │
                └──────────────┬──────────────┘
                               │  HTTP
                               ▼
                ┌─────────────────────────────┐
                │     nginx :8080             │
                │  rate-limit zones:          │
                │   login (10r/m)             │
                │   api (60r/m, burst 20)     │
                │   webhook (100r/m)          │
                └───┬───────┬───────┬─────────┘
                    │       │       │
            ┌───────▼──┐ ┌──▼─────┐ ┌▼─────────┐
            │ auth:4001│ │ seat:  │ │ payment: │
            │          │ │  4002  │ │  4003    │
            │ argon2id │ │ hold   │ │ checkout │
            │ RT rotate│ │ SSE    │ │ webhook  │
            │ family   │ │ sweep  │ │ HMAC     │
            │ reuse    │ │ outbox │ │ outbox   │
            └─────┬────┘ └───┬────┘ └────┬─────┘
                  │          │           │
                  │   RabbitMQ (async)   │
                  │   seat.events        │
                  │   payment.events     │
                  │          │           │
                  └──────────┴───────────┘
                             │
              ┌──────────────┴───────────────┐
              │     PostgreSQL (3 DBs)        │
              │  auth_db  seat_db  payment_db │
              └───────────────────────────────┘
                             │
                       Redis :6379
                       (rate-limit state)
```

---

## RabbitMQ topology

| Exchange           | Type   | Routing keys                                      | Bound to queue                  |
|--------------------|--------|---------------------------------------------------|---------------------------------|
| `seat.events`      | topic  | `seat.held`, `seat.released`, `seat.reserved`     | `payment.seat-events`           |
| `payment.events`   | topic  | `payment.succeeded`, `payment.failed`             | `seat.payment-events`           |
| `*.dlx`            | topic  | `#`                                               | `*.dlq` (dead-letter queues)    |

- Publisher confirms enabled on every emitter.
- Consumers use manual ack + prefetch 10.
- Events are versioned via `packages/contracts`: `seat.held.v1`, `payment.succeeded.v1`, etc.

---

## Event flow (happy path)

```
1. Browser → POST /api/auth/login              → auth issues AT(body) + RT(httpOnly cookie)
2. Browser → POST /api/seats/:id/hold          → seat-service SERIALIZABLE tx + partial unique
                                                 indexes → outbox{seat.held.v1} → RabbitMQ
3. Browser → POST /api/payment/checkout        → payment-service looks up amount from
                                                 seat_prices (server-controlled) → MockPSP
                                                 → inserts payment_intent(PENDING)
4. Mock PSP → POST /api/payment/webhook        → payment-service verifies HMAC (timingSafeEqual)
                                                 + timestamp freshness → insert webhook_inbox
                                                 (UNIQUE stripe_event_id) → 200 ack-fast
                                                 async: mark COMPLETED + outbox{payment.succeeded.v1}
5. RabbitMQ → seat.payment-events              → seat-service consumer: idempotency guard
                                                 (consumed_events UNIQUE) → UPDATE hold=RESERVED
                                                 + seat=RESERVED + outbox{seat.reserved.v1}
                                                 → SSE emits seat:reserved to browsers
```

Payment failure path: webhook `payment_intent.payment_failed` → `markFailed` + outbox `payment.failed.v1`
→ seat-service releases the hold (compensation, §5.2.1).

---

## DB schemas (per service)

### auth_db
- `users(id, email UNIQUE, password_hash, token_version, created_at)`
- `refresh_tokens(id, user_id, family_id, token_hash UNIQUE, rotated_to, revoked_at, expires_at, grace_until, created_at)`
- `audit_log(id, user_id, action, meta jsonb, at)` — append-only
- partial index `rt_user_active ON refresh_tokens(user_id) WHERE revoked_at IS NULL`
- index `rt_family ON refresh_tokens(family_id)`

### seat_db
- `seats(id, label, price_cents, currency, status)`
- `holds(id, seat_id, user_id, status, held_until, created_at, released_at, reserved_at)`
- `UNIQUE (seat_id) WHERE status='HELD'` — partial unique index (one active hold per seat, §3.1.2)
- `UNIQUE (user_id) WHERE status='HELD'` — partial unique index (one active hold per user, §3.1.3)
- partial index `idx_holds_expiry ON holds(held_until) WHERE status='HELD'`
- `outbox(id, aggregate_id, event_type, payload, headers, state, attempts, next_attempt_at)`
- `consumed_events(event_id, consumer_group, processed_at)` — idempotent saga steps (§5.2.5)

### payment_db
- `payment_intents(id, seat_id, user_id, hold_id, amount_cents, currency, psp_intent_id, status, idempotency_key UNIQUE, client_secret, ...)`
- `webhook_inbox(stripe_event_id PK, type, payload, received_at, processed_at)` — idempotent webhooks (§5.1.4)
- `seat_prices(seat_id PK, price_cents, currency, label)` — denormalized, seeded (DECISIONS.md #9)
- `outbox(...)` (same shape as seat_db)
- `consumed_events(...)` (same shape)

Migrations are forward-only SQL files under `apps/<svc>/src/migrations/`, run on boot via `run.ts`.
Naming convention: `YYYYMMDDHHMMSS_<name>.sql`. Idempotent where possible.

---

## Quick start

```bash
# 1. Configure env (every var documented in .env.example)
cp .env.example .env
# IMPORTANT: override the placeholder secrets:
#   JWT_SECRET=$(openssl rand -base64 48)
#   JWT_REFRESH_SECRET=$(openssl rand -base64 48)
#   PSP_WEBHOOK_SECRET=$(openssl rand -base64 48)

# 2. Start the stack
docker compose up --build

# 3. (optional) seed demo user + 3 seats (seats are also seeded by seat_db migration? no — seat seeding is via scripts/seed.ts)
SEED_DEMO_USER=1 npx tsx scripts/seed.ts
# Or via the UI: open http://localhost:8080 and click "Register"

# 4. Run the E2E smoke test (auto-fail guard §1.1.9)
./scripts/e2e-smoke.sh
# Expect: "PASS: seat reserved"
```

Service URLs (after `docker compose up`):
- nginx (front-end + API): http://localhost:8080
- auth direct: http://localhost:4001/health/live
- seat direct: http://localhost:4002/health/live
- payment direct: http://localhost:4003/health/live
- RabbitMQ management: http://localhost:15672 (seatapp / seatapp_dev_pw)

---

## Health endpoints (per service, §4.1)

- `GET /health/live` — process-alive probe (uptime, version)
- `GET /health/ready` — checks DB + RabbitMQ (+ Redis for auth), returns degraded state

`docker-compose` uses `healthcheck` blocks with `depends_on: { condition: service_healthy }`
so apps don't start until their deps are ready.

## Graceful shutdown (§4.1.3 / §4.1.4)

- `app.enableShutdownHooks()` → NestJS calls `OnModuleDestroy` on every module
- `DbModule.onModuleDestroy` → `pool.end()`
- `RabbitService.onModuleDestroy` → close channel + connection
- `process.on('SIGTERM', ...)` → `app.close()` then `process.exit(0)`
- Sweeper + outbox workers `clearInterval` on destroy

---

## Observability (§4.3)

- **Logs**: pino JSON with `{ ts, level, action, userId, traceId, service, component }`.
  `x-request-id` header extracted (generated if missing), propagated into RabbitMQ headers.
- **Metrics**: `/metrics` per service (prom-client). Business counters:
  - auth: `auth_login_success_total`, `auth_login_fail_total`, `auth_refresh_total`, `auth_reuse_detected_total`
  - seat: `seats_held_total`, `seats_released_total`, `seats_reserved_total`, `reservations_cancelled_total`, `hold_conflicts_total`, `hot_seat_detected_total`
  - payment: `payment_initiated_total`, `payment_completed_total`, `payment_failed_total`, `webhook_received_total`, `webhook_deduped_total`
- TODO(prod): add `prom/prometheus` + Grafana to compose (scope cut, DECISIONS.md #11).

---

## Security checklist (highlights)

| Concern | Where |
|---|---|
| RT in httpOnly cookie, `sameSite=strict`, `secure=isProd`, `path=/api/auth` | `auth.controller.ts setRtCookie` |
| RT opaque (48 random bytes, base64url), hashed SHA-256 in DB | `sessions.repository.ts` |
| RT rotation every /refresh, `rotated_to` chain | `sessions.repository.ts rotate()` |
| Family tracking + grace window (10s) + reuse detection → revoke family | `auth.controller.ts refresh` |
| Logout bumps `token_version` (immediate-ish AT invalidation within TTL) | `users.repository.ts bumpTokenVersion` |
| argon2id with timing dummy hash for non-existent users | `users/password.ts` |
| AT TTL 15 min, configurable via `JWT_AT_TTL_SECONDS` | `jwt.service.ts` |
| Redis-backed sliding rate-limit on login (10 req/min per IP) | `common/rate-limit.guard.ts` |
| Per-endpoint limits via env (`RATE_LIMIT_*`) | `.env.example` |
| Helmet security headers | `main.ts` |
| CORS whitelist (never `*` with credentials) | `main.ts` |
| JWT_SECRET / JWT_REFRESH_SECRET required (Zod parse at bootstrap, no defaults) | `config/env.ts` |
| Webhook HMAC-SHA256 with `crypto.timingSafeEqual` | `psps/psp.client.ts constructEventFromWebhook` |
| Webhook timestamp freshness ≤5 min (`WEBHOOK_TOLERANCE_MS`) | `webhooks.controller.ts` |
| Webhook idempotency: `UNIQUE(stripe_event_id)` | `webhook_inbox` table |
| Append-only audit log | `audit_log` table + `AuditService` |

---

## Concurrency strategy (§3.1, DECISIONS.md #2)

`POST /api/seats/:id/hold` runs in a `SERIALIZABLE` transaction with:
1. Lazy cleanup of any expired hold on this seat
2. `INSERT INTO holds ...` — caught by partial unique indexes at DB level:
   - `UNIQUE (seat_id) WHERE status='HELD'`
   - `UNIQUE (user_id) WHERE status='HELD'`
3. `UPDATE seats SET status='HELD'`
4. `INSERT INTO outbox (seat.held.v1)` — same transaction

Belt + suspenders: `SERIALIZABLE` alone would force opaque serialization-failure retries; the partial unique index gives a clean `unique_violation` (SQLSTATE 23505) that the controller maps to **409 Conflict** with a **Retry-After** header.

Sweeper: `FOR UPDATE SKIP LOCKED LIMIT 100` (§3.2.2 / §4.4.4) — multi-replica safe, no advisory lock needed.

---

## Payment & saga (§5.1 / §5.2)

- **Boundary**: `PSPClient` interface; `MockPSPClient` is the only impl (DECISIONS.md #3).
- **Amount server-controlled**: client sends `seatId` only; server reads `seat_prices` table
  (DECISIONS.md #9).
- **Idempotency**: `payment_intents.idempotency_key UNIQUE` (double-create prevented) +
  `webhook_inbox.stripe_event_id UNIQUE` (double-process prevented).
- **Ack-fast webhook**: verify HMAC → insert inbox → 200 immediately → process async.
- **Compensation**: `payment.failed.v1` event → seat-service releases the hold.
- **Outbox**: business update + outbox row in same TX (§5.2.2). Worker publishes with
  publisher confirms, exponential backoff, `DEAD` state after 10 attempts (§5.2.3).

---

## Testing (§1.3)

Tests live in `apps/<svc>/test/` and use Jest + `testcontainers` to spin a real Postgres + RabbitMQ.

- `apps/seat-reservation/test/hold.concurrency.spec.ts` — two concurrent holds → exactly one wins (§1.3.1)
- `apps/seat-reservation/test/hold.fifty.parallel.spec.ts` — 50 parallel → still exactly 1 HELD
- `apps/payment/test/checkout.idempotency.spec.ts` — duplicate `idempotencyKey` → same intent (§1.3.3)
- `apps/payment/test/webhook.idempotency.spec.ts` — duplicate `stripe_event_id` → one row, one reservation
- `apps/auth/test/refresh.rotation.spec.ts` — rotation issues new RT, old revoked
- `apps/auth/test/refresh.reuse.spec.ts` — reuse of revoked RT past grace → family revoked

Run with `npm test -w apps/<svc>`.

The E2E happy path is verified by `scripts/e2e-smoke.sh` (auto-fail guard §1.1.9).

---

## Production TODOs (`grep -r "TODO(prod)" apps | wc -l`)

- SSE: Redis pub/sub for multi-instance fan-out
- tokenVersion: Redis cache (30s TTL) for immediate AT invalidation
- PgBouncer in transaction-pooling mode in front of Postgres
- Outbox worker as separate Deployment for independent scaling
- Circuit-breaker thresholds tuned per PSP SLA
- Idempotency Redis fast-path in front of DB dedup
- Audit log to append-only S3 + DB
- OpenTelemetry SDK + Jaeger
- Real Stripe client implementing `PSPClient`
- Real email verification flow
- K8s Helm chart with HPA per service
- Vite + React SPA with refresh-on-401 interceptor

Each is marked in code with `// TODO(prod): ...` and explained in `DECISIONS.md`.

---

## License

Provided as-is for the technical assessment.
