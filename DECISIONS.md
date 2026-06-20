# DECISIONS.md — Architecture & Trade-offs

> This file records every meaningful architecture decision, shortcut, and scope cut.
> Written **before** code, per review-checklist §1.1.4 (auto-fail if missing).
> Format: `Decision | Context | Trade-off | Limitation / TODO(prod)`.

---

## 1. Three microservices with own Postgres databases

**Decision**: `auth`, `seat-reservation`, `payment` are 3 separate NestJS apps, each with its own Postgres database (`auth_db`, `seat_db`, `payment_db`).

**Context**: Review checklist §1.0 requires microservices with independent scaling profiles:
- `auth` is CPU-bound (argon2 hashing spikes CPU on login floods)
- `seat-reservation` is DB-bound (row locks on hot `seats` rows, sweeper cadence)
- `payment` is I/O-bound (PSP webhook latency, retries)

**Trade-off accepted**: heavier local dev (compose spins up 3 app containers + postgres + redis + rabbitmq + nginx) vs. clean service boundaries. Single Postgres instance hosts 3 separate DBs to keep compose light; `TODO(prod)` would split to 3 clusters.

**Limitation**: 3 DBs means no FK across services — `payment_intents.seat_id` is a UUID with no FK to `seats.id`. Integrity maintained by event contracts + idempotent consumers, not DB constraints. Accepted for the bounded-context isolation benefit.

---

## 2. Hold locking: partial unique indexes + SERIALIZABLE transaction (belt + suspenders)

**Decision**: Hold insert runs in a `SERIALIZABLE` transaction **and** relies on two partial unique indexes for the actual invariant:
- `UNIQUE (seat_id) WHERE status = 'HELD'` — one active hold per seat
- `UNIQUE (user_id) WHERE status = 'HELD'` — one active hold per user

**Context**: Checklist §3.1 wants DB-level invariants (not application-only checks) and a candidate explanation of failure mode.

**Why both**: `SERIALIZABLE` alone would force retry-on-serialization-failure logic (opaque to client). The partial unique index gives a clean `unique_violation` (Postgres error code `23505`) that we map to `409 Conflict` with a `Retry-After` header. The index also makes the "1 hold per user" invariant explicit, which `SERIALIZABLE` alone wouldn't surface as a structured error.

**Failure mode**: Under heavy contention the second writer gets `unique_violation` → 409 (retryable, client-friendly). The first writer wins, exactly one row in `holds` with `status='HELD'`. The DB connection pool queues waiters; under extreme load they time out at the pool rather than corrupt state. `TODO(prod)`: at stadium scale this would need a sharded lock map or seat-partitioned queues; for 3 seats it's overkill.

**Why not `FOR UPDATE` on the seat row**: would also work and give fail-fast 409, but requires an explicit `SELECT ... FOR UPDATE` on the parent `seats` row first — an extra round trip. The partial unique index makes the insert itself the lock. Equivalent correctness, less ceremony.

---

## 3. MockPSPClient behind an interface — clear boundary for Stripe swap

**Decision**: Payment service talks to a `PSPClient` interface (`createIntent`, `constructEventFromWebhook`). `MockPSPClient` is the only implementation; real `StripeClient` would be a drop-in.

**Context**: Checklist §5.1.1 wants a clear boundary. We don't integrate real Stripe in a 2h assessment, but the seam must be honest — not hardcoded HMAC math in the controller.

**Trade-off**: Mock PSP generates deterministic signatures with the same HMAC-SHA256 algorithm Stripe uses, so the webhook verification path (`crypto.timingSafeEqual` + 5-min timestamp freshness) is real, not stubbed. The only "mock" part is the PSP isn't an external HTTP service.

**Limitation**: Real Stripe SDK shape differs (`stripe.webhooks.constructEvent` does its own parse + verify). The interface abstracts that — `StripeClient` would wrap the SDK. `TODO(prod)`: replace `MockPSPClient` with `StripeClient` behind the same interface; no controller changes.

---

## 4. Transactional outbox over direct RabbitMQ publish

**Decision**: Every service that emits an event writes the business row **and** an `outbox` row in the same DB transaction. A separate worker loop publishes to RabbitMQ with publisher confirms, marks rows `PROCESSING` → `DONE` (deleted) after ack, or `DEAD` after N retries with exponential backoff.

**Context**: Checklist §1.0.2 / §5.2.2 (Exceed signal). Publishing directly to RabbitMQ after commit can lose events if the process crashes between commit and publish. Publishing **inside** the transaction can poison the transaction if RabbitMQ is down.

**Trade-off accepted**: 2x DB write cost per business event (the `outbox` insert) vs. at-least-once delivery guarantee. For 3 seats this is negligible; for high throughput it would be the first bottleneck.

**Limitation**: The outbox worker runs in the same pod as the service for this assessment. `TODO(prod)`: split the worker into its own Deployment so it scales independently and doesn't compete with request handlers for the DB pool. The worker uses `FOR UPDATE SKIP LOCKED LIMIT 100` so multiple replicas can run safely.

---

## 5. Refresh token: opaque + family tracking + grace window

**Decision**:
- Refresh tokens are 48 random bytes, base64url-encoded, stored as `SHA-256(rt)` in DB (raw token only in cookie).
- Each token has a `family_id` (set at login, preserved across rotations).
- `rotated_to` links old → new token.
- After rotation, the old token has `grace_until = NOW() + 10s`: within that window, retried requests with the old token are accepted (no rotation), logged as `WARN`.
- Reuse of a revoked token **past grace** → revoke the entire `family_id` (theft detected), audit `session_revoke`.

**Context**: Checklist §2.1.2–2.1.6. JWT refresh tokens are not revocable; raw DB tokens are a DB read per request but revocable. Family tracking is the standard stolen-token containment pattern.

**Trade-off accepted**: Slightly more complex refresh flow (4 branches: active, grace, revoked-past-grace, not-found) vs. better security posture. The grace window exists because mobile clients retry on network blips — hard-failing on the first retry breaks their UX.

**Limitation**: `grace_until` of 10s is a guess; `TODO(prod)` make it env-configurable per client platform. Family revocation is per-user (one stolen RT kills all that user's sessions in the family) — acceptable for assessment, `TODO(prod)` finer-grained per-device family.

---

## 6. Expand-contract migration policy + connection pool sizing

**Decision**:
- Migrations are forward-only at runtime; any breaking schema change goes through expand → migrate → contract across 2 releases. We never `DROP COLUMN` in the same release as the code change that removes the column read.
- Each service uses `pg` with explicit `max=20` connections. Pool size comment: `(cpu × 2) + effective_spindle_count` heuristic from Hikari docs; 20 is a safe default for a single-container service.
- `postgres.conf` enables `log_min_duration_statement=200ms`, `log_lock_waits=on`, `deadlock_timeout=1s`.

**Context**: Checklist §1.2.3 (expand-contract), §1.2.4 (pool), §1.2.5 (slow query logging).

**Trade-off accepted**: 2-release migration discipline is heavier than "just drop and ship" but prevents 3am breaking-deploy incidents. For this assessment, migrations are simple enough that expand-contract is documented but not exercised — noted here so reviewers know we know.

**Limitation**: No `PgBouncer` in `docker-compose.yml`. Each service opens its own 20-conn pool; with 3 services that's 60 connections against one Postgres. Default `max_connections=100` leaves headroom. `TODO(prod)`: put PgBouncer in transaction-pooling mode in front of Postgres; tune pool per service CPU.

---

## 7. SSE in-process EventEmitter, not Redis pub/sub

**Decision**: `GET /seats/stream` is an SSE endpoint backed by a NestJS `EventEmitter` in the seat-reservation process. Every seat/hold state change emits `seat:changed`.

**Context**: Checklist §3.2.3 / §4.4.1 wants the endpoint to exist; §4.4.2 Exceed wants Redis pub/sub. Within 2h we don't stand up Redis pub/sub for a 3-seat app.

**Trade-off accepted**: In-process bus works only for single replica. If `docker-compose up --scale seat-reservation=3`, a client connected to replica A won't see seat changes made on replica B.

**Limitation / TODO(prod)**: Replace `EventEmitter` with Redis pub/sub: every state change publishes to `seat:changed` channel; every SSE connection subscribes and fans out. Singleflight pattern for cache stampede prevention is a further enhancement. The SSE endpoint shape and contract stay identical — only the transport changes.

---

## 8. tokenVersion: AT claim only, no cross-service DB lookup

**Decision**: Access token JWT includes `tv: user.tokenVersion` claim. Seat/payment middleware extracts `tv` from the **JWT signature verification** (no DB call). Logout bumps `token_version` in the auth DB → the **next** AT issued carries the new version. Existing ATs remain valid until their 15-min TTL expires.

**Context**: Checklist §2.1.7 wants logout to invalidate AT immediately. True immediate invalidation requires the middleware to check `tv` against a current source of truth on every request. Seat/payment services have their own DBs and **must not** query the auth DB (would violate service isolation and create cross-service coupling).

**Trade-off accepted**: AT invalidation on logout is "eventual" within ≤15 min (the AT TTL), not immediate. This is a deliberate scope cut: the alternative is either (a) cross-service DB read (breaks isolation) or (b) Redis cache that auth writes and seat/payment read on every request (Redis infra + cache-invalidation complexity). For a 2h assessment, the 15-min TTL bound is acceptable and the JWT signature check is still authoritative.

**Limitation / TODO(prod)**: Add a `TokenVersionCache` backed by Redis with 30s TTL. Auth service writes to Redis on logout (bump + publish invalidate). Seat/payment middleware reads Redis on each request → real immediate invalidation with ≤30s cache lag. Documented in §4.4.5 of checklist as the Exceed path.

---

## 9. Amount locked at checkout creation, sourced from a seeded `seat_prices` table in payment DB

**Decision**: Payment service has its own `seat_prices` table seeded at migration time (3 seats, known prices). `POST /checkout` looks up the price by `seatId` from this local table, **never** from the client body. The `amount` is stored in `payment_intents` at row creation and used for the PSP call.

**Context**: Checklist §3.3.3 / §5.1.5 wants server-controlled amount. The obvious alternative — calling seat-service over HTTP for the price — is an **auto-fail** (HTTP sync between services). Replicating via the `seat.held` event has a race: the browser calls `/checkout` right after `/hold`, before RabbitMQ delivers the event to payment-service.

**Trade-off accepted**: Prices are duplicated in two DBs (`seat_db.seats.price` and `payment_db.seat_prices.price`). For 3 static seats this is trivial; for dynamic pricing it's a real consistency problem.

**Limitation / TODO(prod)**: Consume `seat.held` / `seat.price_changed` events in payment-service to upsert `seat_prices` idempotently. Use the seeded table as the fallback when no event has arrived yet. For a real catalog with price changes, add a `price_version` field and reject checkout if client sends a stale version.

---

## 10. Separate `JWT_SECRET` and `JWT_REFRESH_SECRET`, no defaults

**Decision**: Two separate env vars, both required at bootstrap via Zod parse. Missing either → process exits with code 1. No `|| 'dev-secret'` fallback anywhere in the codebase (grep-enforced).

**Context**: Checklist §2.2.7 (auto-fail if `JWT_SECRET || 'default'`). Using the same secret for AT signing and RT-related operations (e.g., signing any auxiliary token) is a key-confusion risk.

**Trade-off accepted**: Slightly more ops friction (two secrets to rotate) vs. clear key separation.

**Limitation**: For local dev, `.env.example` provides non-secret-looking placeholder values that **must** be overridden; the Zod schema rejects the placeholder strings via a regex (`not the example value`). `TODO(prod)`: pull secrets from Vault/SSM, not env files.

---

## 11. Scope cuts (each with "why not implement full")

| Cut | Why cut | Production path |
|---|---|---|
| No real Stripe | Out of scope for 2h assessment; mock PSP exercises the same HMAC + idempotency paths | `StripeClient` implements `PSPClient` interface |
| No real email verification | Requirement only asks for login | `TODO(prod)`: email service + verification flow |
| Front-end is single HTML file | 3 seats don't justify a SPA build pipeline | `TODO(prod)`: Vite + React, refresh-on-401 interceptor |
| No K8s manifests | docker-compose is the assessment deployment target | `TODO(prod)`: Helm chart with HPA per service |
| No PgBouncer in compose | 3 services × 20 conns = 60, under Postgres default 100 | `TODO(prod)`: PgBouncer transaction-pooling mode |
| Outbox worker in same pod | Simpler compose; doesn't exercise independent scaling | `TODO(prod)`: separate Deployment for worker |
| No distributed tracing (OTel) | pino JSON logs with `traceId` cover the basics | `TODO(prod)`: OpenTelemetry SDK + Jaeger |
| No Prometheus server in compose | `/metrics` endpoint exists, scrape config is `TODO(prod)` | `TODO(prod)`: add `prom/prometheus` + Grafana |
| tokenVersion cache (Redis) | AT TTL bound (15 min) is acceptable | `TODO(prod)`: see decision #8 |
| SSE via Redis pub/sub | Single-replica is fine for assessment | `TODO(prod)`: see decision #7 |
| No logout-all on every device immediately | tokenVersion bump covers it within AT TTL | `TODO(prod)`: see decision #8 |

---

## 12. Why NestJS

**Decision**: NestJS for all 3 services.

**Context**: User-specified stack. NestJS gives us: module system (clean boundaries), DI (testable), `@nestjs/throttler` + `throttler-storage-redis` (Redis-backed rate limit, stateless across restarts — checklist §2.2.1 Exceed), `@nestjs/schedule` (sweeper cron), `@Sse()` decorator (SSE endpoint), `enableShutdownHooks()` (checklist §4.1.3), Zod validation pipe via `nestjs-zod`.

**Trade-off accepted**: Heavier than a bare Express app; boot time ~1s. Worth it for the structured module/DI/test story and the batteries for rate-limit, schedule, SSE, shutdown.

---

End of `DECISIONS.md`. Next file to create: monorepo scaffold.
