# Implementation Plan — Seat Reservation Platform

> Stack: **TypeScript · NestJS · PostgreSQL · RabbitMQ · Redis · Docker Compose**
> Target: satisfy every "Meet Expectation" item in `docs/review-checklist.md` and hit as many "Exceed" judgment signals as feasible within ~2h focused work.
> This file is the **plan**. The actual architecture decisions, trade-offs and shortcuts live in `DECISIONS.md` (required by checklist §1.1.4 — auto-fail if missing).

---

## 0. Hard guardrails (Auto-Fail avoidance)

These are non-negotiable. Every later decision must respect them.

| Rule | How we satisfy it |
|---|---|
| Microservices: auth / seat-reservation / payment are 3 separate services, own Dockerfile, own port | `apps/auth`, `apps/seat-reservation`, `apps/payment` — each with own `Dockerfile` and `main.ts` |
| Message broker for inter-service events (no HTTP sync, no in-process call) | RabbitMQ via `amqplib` + transactional outbox per service |
| RT in httpOnly cookie (not body/localStorage) | `res.cookie('rt', ..., { httpOnly, sameSite:'strict', secure:isProd, path:'/api/auth' })` |
| RT opaque (not JWT), ≥48 bytes, hashed in DB | `crypto.randomBytes(48).toString('base64url')`, store `SHA-256(rt)` |
| Argon2id password hashing | `argon2.hash(pw, { type: argon2.argon2id })` |
| No `JWT_SECRET \|\| 'default'` fallback | Zod env parse at bootstrap, `getOrThrow` semantics |
| Webhook HMAC verified with timing-safe compare | `crypto.timingSafeEqual` + timestamp freshness ≤5 min |
| CORS not `*` with credentials | Whitelist from env, `credentials: true` |
| E2E happy path runnable | `scripts/e2e-smoke.sh`: login → hold → pay → reserve |
| DECISIONS.md with ≥5 real entries | Written first, before any code |

---

## 1. Monorepo layout

```
technical-assignment/
├── apps/
│   ├── auth/                     # port 4001 — CPU-bound (argon2)
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── config/
│   │   │   ├── auth/             # login, refresh, logout, logout-all
│   │   │   ├── sessions/         # RT store, rotation, family reuse detection
│   │   │   ├── users/            # register, argon2 hashing
│   │   │   ├── audit/            # append-only audit log
│   │   │   ├── health/           # /health/live, /health/ready
│   │   │   ├── metrics/          # /metrics (prom-client)
│   │   │   └── migrations/       # sql-miged + Kysely
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── seat-reservation/         # port 4002 — DB-bound
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── seats/            # list, stream (SSE), hold, release
│   │   │   ├── holds/            # sweeper (SKIP LOCKED)
│   │   │   ├── events/           # RabbitMQ consumers (SeatReleaseRequested)
│   │   │   ├── outbox/           # outbox publisher worker
│   │   │   ├── health/
│   │   │   └── migrations/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── payment/                  # port 4003 — I/O-bound (PSP)
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── checkout/         # create intent, amount from DB
│   │   │   ├── webhooks/         # HMAC verify + idempotent inbox
│   │   │   ├── psps/             # MockPSPClient interface (boundary)
│   │   │   ├── events/           # publish PaymentSucceeded / PaymentFailed
│   │   │   ├── outbox/
│   │   │   ├── health/
│   │   │   └── migrations/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web/                      # static front-end (single HTML+JS), served by nginx
├── packages/
│   ├── be-core/                  # shared utils, logger, correlation-id, env schema
│   ├── contracts/                # typed event contracts (versioned) for RabbitMQ
│   └── tsconfig-base/            # shared tsconfig.base.json (strict: true)
├── infra/
│   ├── nginx/
│   │   ├── nginx.conf            # rate-limit zones, reverse proxy
│   │   └── Dockerfile
│   ├── postgres/
│   │   └── postgres.conf         # log_min_duration_statement, log_lock_waits, deadlock_timeout
│   └── docker-compose.yml        # postgres, redis, rabbitmq, 3 apps, nginx
├── scripts/
│   ├── e2e-smoke.sh
│   └── seed.ts                   # 3 seats, 1 demo user
├── DECISIONS.md                  # ≥5 real entries — written first
├── README.md                     # folder tree, architecture, ports, flows
└── .env.example
```

Why this layout satisfies the checklist:
- §1.0.1 / §1.0.3 — three `apps/*` with own `Dockerfile` and port; nginx gateway in `infra/` so services aren't exposed directly.
- §1.0.4 — shared code in `packages/be-core` + `packages/contracts`; no service imports another's source.
- §1.1.1 — explicit `apps/ packages/ infra/` separation.
- §1.1.6 — `tsconfig.base.json` with `"strict": true`.

---

## 2. Service responsibilities & scaling profile

| Service | Port | Own DB schema | Profile | Why separate |
|---|---|---|---|---|
| auth | 4001 | `auth.*` | CPU-bound (argon2) | Argon2 spikes CPU; isolate so login flood doesn't starve seat/payment pods |
| seat-reservation | 4002 | `seat.*` | DB-bound (locks, sweeps) | Hot rows on `seats`; needs own pool tuning and sweeper cadence |
| payment | 4003 | `payment.*` | I/O-bound (PSP webhooks) | Sensitive to PSP latency & retry; webhook idempotency is its own problem space |
| web | — (nginx) | — | static | Front-end served by nginx |

Each service has its **own Postgres database** (separate `POSTGRES_DB_*` env vars). Rationale recorded in `DECISIONS.md` entry #1. This avoids shared-table coupling and lets each service be handed off / scaled independently.

Scaling story (§1.0.3 / §4.4): each service can be scaled with `docker-compose up --scale seat-reservation=3`. Replica-safety is handled per-service:
- seat sweeper uses `FOR UPDATE SKIP LOCKED` (§4.4.4)
- outbox publishers use `SKIP LOCKED` on `outbox` rows
- tokenVersion check hits DB for now; `TODO(prod)` Redis cache (§4.4.5)
- SSE fan-out uses in-process EventEmitter now; `TODO(prod)` Redis pub/sub (§4.4.1/§4.4.2)

---

## 3. Inter-service communication — RabbitMQ + transactional outbox

No HTTP sync between services. All cross-service flow is async events.

### 3.1 RabbitMQ topology
- Exchange: `seat.events` (topic), `payment.events` (topic)
- Queues:
  - `seat.payment-events` → bound to `payment.events` with routing keys `payment.succeeded`, `payment.failed`
  - `payment.seat-events` → bound to `seat.events` with `seat.held`, `seat.released`
- Dead-letter exchange: `*.dlx` with `x-dead-letter-exchange` arg on each queue (§5.2.3)
- Publisher confirms enabled; consumer manual ack.

### 3.2 Transactional outbox (§1.0.2 / §5.2.2 — Exceed signal)

Every service that emits an event has an `outbox` table in its own DB:

```sql
CREATE TABLE outbox (
  id            BIGSERIAL PRIMARY KEY,
  aggregate_id  UUID NOT NULL,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  headers       JSONB NOT NULL DEFAULT '{}',  -- traceId, userId, occurredAt
  state         TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|PROCESSING|DEAD
  attempts      INT  NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_outbox_pending ON outbox (next_attempt_at) WHERE state = 'PENDING';
```

**Pattern**: business write + `INSERT INTO outbox` in the **same** DB transaction. A separate worker loop (`setInterval` + `FOR UPDATE SKIP LOCKED LIMIT 100`) publishes to RabbitMQ with publisher confirms, marks row `PROCESSING` → deletes (or marks `DONE`) only after ack. On nack/retry → exponential backoff, `attempts++`, after N → `DEAD` + alert log.

This guarantees no event is lost even if the process crashes between commit and publish (§5.2.2 Exceed).

### 3.3 Event flow — happy path

```
Browser → nginx → auth-service  (login → AT body + RT cookie)
Browser → nginx → seat-service  (POST /seats/:id/hold) → inserts outbox{seat.held}
                                  outbox worker → RabbitMQ{seat.held}
Browser → nginx → payment-service (POST /checkout { seatId })
                                  → creates payment_intent with amount from seat.price (server-side, §3.3.3/§5.1.5)
                                  → calls MockPSPClient.createIntent → returns clientSecret
Browser → MockPSP (mock)  → POST /payment/webhook (HMAC)  → payment-service
                                  → verify HMAC (timingSafeEqual) + timestamp ≤5min
                                  → INSERT webhook_inbox (UNIQUE stripe_event_id) — idempotency §5.1.4
                                  → ack-fast: 200 immediately, process async
                                  async: on payment_failed → outbox{payment.failed} (same TX as payment update)
                                         on payment_succeeded → outbox{payment.succeeded}
RabbitMQ{payment.succeeded} → seat-service consumer
                                  → idempotent consumer (UNIQUE (event_id, consumer_group) §5.2.5)
                                  → UPDATE seat SET status='RESERVED' WHERE id=? AND status='HELD'
                                  → outbox{seat.reserved}
RabbitMQ{payment.failed} → seat-service consumer
                                  → release hold (compensation §5.2.1)
                                  → outbox{seat.released}
```

### 3.4 Event contracts (§1.0.4 Exceed)

`packages/contracts/src/events.ts` exports versioned, strictly-typed payloads:

```ts
export const SeatHeldV1 = z.object({
  eventId: z.string().uuid(),
  seatId: z.string().uuid(),
  userId: z.string().uuid(),
  heldUntil: z.string().datetime(),
  traceId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  schema: z.literal('seat.held.v1'),
});
// ...likewise for seat.released.v1, payment.succeeded.v1, payment.failed.v1
```

Consumers validate with the schema before processing; invalid → DLQ.

---

## 4. Data model (per service / per DB)

### 4.1 auth DB
```sql
-- users
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,                 -- argon2id
  token_version INT  NOT NULL DEFAULT 0,       -- bump on logout-all (§2.1.7/§2.1.8)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- refresh tokens (opaque, hashed)
CREATE TABLE refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id    UUID NOT NULL,                   -- reuse detection (§2.1.5)
  token_hash   BYTEA NOT NULL UNIQUE,           -- SHA-256(rt)
  rotated_to   UUID REFERENCES refresh_tokens(id), -- §2.1.4 rotation chain
  revoked_at   TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  grace_until  TIMESTAMPTZ,                     -- §2.1.6 grace window
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX rt_user_active ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX rt_family ON refresh_tokens (family_id);

-- audit log (append-only)
CREATE TABLE audit_log (
  id      BIGSERIAL PRIMARY KEY,
  user_id UUID,
  action  TEXT NOT NULL,      -- 'login'|'logout'|'logout_all'|'refresh'|'session_revoke'
  meta    JSONB NOT NULL DEFAULT '{}',
  at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4.2 seat DB
```sql
CREATE TABLE seats (
  id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label  TEXT NOT NULL,
  price  NUMERIC(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'AVAILABLE'  -- AVAILABLE|HELD|RESERVED
);

CREATE TABLE holds (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_id      UUID NOT NULL REFERENCES seats(id),
  user_id      UUID NOT NULL,
  status       TEXT NOT NULL DEFAULT 'HELD',   -- HELD|RELEASED|RESERVED
  held_until   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at  TIMESTAMPTZ,
  reserved_at  TIMESTAMPTZ
);

-- §3.1.2 / §3.1.3: DB-level invariants (the crux of the concurrency story)
CREATE UNIQUE INDEX uniq_active_hold_per_seat
  ON holds (seat_id) WHERE status = 'HELD';
CREATE UNIQUE INDEX uniq_active_hold_per_user
  ON holds (user_id) WHERE status = 'HELD';

CREATE INDEX idx_holds_expiry ON holds (held_until) WHERE status = 'HELD';

CREATE TABLE outbox ( ... );  -- see §3.2
CREATE TABLE consumed_events (                 -- §5.2.5 idempotent saga steps
  event_id      UUID NOT NULL,
  consumer_group TEXT NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, consumer_group)
);
```

### 4.3 payment DB
```sql
CREATE TABLE payment_intents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_id         UUID NOT NULL,
  user_id         UUID NOT NULL,
  amount          NUMERIC(10,2) NOT NULL,      -- locked at create (§5.1.5)
  currency        TEXT NOT NULL DEFAULT 'USD',
  psp_intent_id   TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|COMPLETED|FAILED
  idempotency_key UUID NOT NULL UNIQUE,        -- client-supplied, prevents double-create
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE TABLE webhook_inbox (                   -- §5.1.4 / §3.3.1
  stripe_event_id TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  payload         JSONB NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ
);

CREATE TABLE outbox ( ... );
CREATE TABLE consumed_events ( ... );
```

### 4.4 Migrations (§1.2)
- Tool: **Kysely** (lightweight, SQL-first, no heavy ORM) — `packages/be-core` exposes migrator helper.
- Naming: `YYYYMMDDHHMMSS_<name>.ts` per service under `apps/<svc>/src/migrations/`.
- Idempotent where possible (`CREATE INDEX ... IF NOT EXISTS`).
- **Expand-contract** documented in `DECISIONS.md` entry #6 (no destructive change in same release as code change).
- Slow-query logging + `log_lock_waits=on` + `deadlock_timeout=1s` in `infra/postgres/postgres.conf` (§1.2.5).
- Connection pool: `pg` `max=20` explicit, comment with `(cpu×2)+spindles` heuristic + PgBouncer TODO (§1.2.4).

---

## 5. Auth service — security detail

Maps directly to checklist §2.1 / §2.2.

### 5.1 Login
1. Body `{ email, password }` validated by Zod pipe (§1.1.7).
2. Lookup user by email. If not found, **run a dummy argon2 verify** against a precomputed hash to equalize timing (§2.1.9 Exceed — user enumeration prevention).
3. `argon2.verify(hash, pw)` with `type: argon2id`.
4. Issue:
   - Access token: **JWT**, TTL 15 min (§2.1.10), claims `{ sub, email, tv: tokenVersion }`. Signed with `JWT_SECRET`. Returned in JSON body.
   - Refresh token: 48 random bytes, base64url. Hashed SHA-256 → store in `refresh_tokens` with new `family_id`. Set in cookie:
     ```ts
     res.cookie('rt', rawRt, {
       httpOnly: true,
       sameSite: 'strict',
       secure: isProd,
       path: '/api/auth',
       maxAge: 90 * 24 * 60 * 60 * 1000,   // 90d session expiry per requirement
     });
     ```
5. Rate limit: ≤10 req/min per IP on `/api/auth/login` via Redis-backed throttle (§2.2.1).
6. Audit row `action='login'` (§2.2.8).

### 5.2 Refresh
1. Read `rt` cookie. If absent → 401.
2. Hash and look up. Cases:
   - **Found, not revoked, not expired**: rotate.
     - Mark old row `revoked_at = NOW()`, set `rotated_to = newId`. Insert new row **same family_id**, `grace_until = NOW() + 10s` (§2.1.6).
     - Issue new AT + new RT cookie.
   - **Found, revoked, but within `grace_until`** (network retry from mobile): accept, log warn, do not rotate. (§2.1.6 Exceed)
   - **Found, revoked, past grace** → **reuse/theft detected**: revoke entire `family_id` (§2.1.5 Exceed), audit `session_revoke`, return 401.
   - **Not found** → 401.
3. AT includes `tv: user.tokenVersion`. Middleware on seat/payment checks `tv` matches DB (§2.1.7). Logout-all bumps `token_version`, invalidating all outstanding ATs (§2.1.8).

### 5.3 Logout / logout-all
- `POST /api/auth/logout`: revoke current RT, **bump `token_version`** so AT dies immediately (§2.1.7).
- `POST /api/auth/logout-all`: `UPDATE users SET token_version = token_version + 1` + revoke all RTs for user (§2.1.8).

### 5.4 Env (§2.2.7 / §4.2.5)
```ts
const env = z.object({
  JWT_SECRET: z.string().min(32),            // no default → startup throw if missing
  JWT_REFRESH_SECRET: z.string().min(32),    // separate secret (Exceed)
  JWT_AT_TTL_SECONDS: z.coerce.number().default(900),
  RT_GRACE_SECONDS: z.coerce.number().default(10),
  ARGON2_MEMORY_KIB: z.coerce.number().default(65536),
  ARGON2_TIME_COST: z.coerce.number().default(3),
  ARGON2_PARALLELISM: z.coerce.number().default(1),
  // ...
}).parse(process.env);
```
`JWT_SECRET` absence = bootstrap throw. **No `|| 'dev'` fallback anywhere.** Grep enforced.

### 5.5 Rate limit + headers + CORS (§2.2)
- `@nestjs/throttler` with Redis storage (`throttler-storage-redis`) — stateless across restarts (§2.2.1 Exceed).
- Per-endpoint limits configurable: `RATE_LIMIT_LOGIN_MAX`, `RATE_LIMIT_SEAT_MAX`, `RATE_LIMIT_PAYMENT_MAX` (§2.2.2).
- `helmet` (§2.2.5).
- CORS: `origin: env.CORS_ORIGINS.split(',')`, `credentials: true`, explicit `allowedHeaders` (§2.2.4).
- `x-request-id` extracted or generated, attached to every log line and propagated to downstream RabbitMQ headers (§1.1.8 Exceed).

---

## 6. Seat-reservation service — concurrency detail

The hardest part. Maps to checklist §3.1 / §3.2.

### 6.1 Hold endpoint — `POST /seats/:id/hold`
Single transaction, `SERIALIZABLE` isolation, plus partial unique indexes (§3.1.1, §3.1.2, §3.1.3).

```ts
await dataSource.transaction('SERIALIZABLE', async (tx) => {
  // 1. Lazy cleanup of any expired hold on this seat (§3.2.1)
  await tx.createQueryBuilder()
    .update(Hold)
    .set({ status: 'RELEASED', releasedAt: new Date() })
    .where('seat_id = :seatId AND status = :st AND held_until < NOW()', { seatId, st: 'HELD' })
    .execute();

  // 2. Insert hold — partial unique indexes (uniq_active_hold_per_seat, _per_user) catch races at DB level
  try {
    await tx.insert(Hold).values({
      seatId, userId, status: 'HELD',
      heldUntil: new Date(Date.now() + HOLD_TTL_MS),
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictException(); // → 409 with Retry-After
    throw e;
  }

  // 3. Append outbox in same TX (§5.2.2)
  await appendOutbox(tx, 'seat.held.v1', { seatId, userId, heldUntil, traceId });
});
```

**Why both `SERIALIZABLE` and partial unique index?** Belt + suspenders (§3.1.2 Exceed). `SERIALIZABLE` alone would force retry-on-serialization-failure (more complex); the partial unique index gives a clean 409 we can map to `Retry-After`. We document the trade-off in `DECISIONS.md` entry #2:

> Choice: partial unique index `WHERE status='HELD'` on `(seat_id)` and `(user_id)` + `SERIALIZABLE` TX. Failure mode: under heavy contention the second writer gets `unique_violation` (409 Conflict, retryable). We accept 409 over opaque serialization retries because clients can retry with backoff and the index also enforces "1 hold per user" invariant which `SERIALIZABLE` alone wouldn't make explicit. Limitation: serializes on the seat row family — fine for 3 seats, would need sharding for stadium scale. `TODO(prod)`: sharded lock map.

### 6.2 Conflict response (§3.1.5)
```ts
@Catch(ConflictException)
export class ConflictFilter {
  catch(_, host: ArgumentsHost, exc: ConflictException) {
    const res = host.switchToHttp().getResponse();
    res.status(409).set('Retry-After', String(RETRY_AFTER_SECONDS)).json({
      error: 'seat_unavailable', traceId: reqId,
    });
  }
}
```

### 6.3 Hold expiry sweeper (§3.2.1, §3.2.2, §4.4.4)
`@Injectable()` `@Cron('*/15 * * * * *')` (every 15s) — or `setInterval`:
```sql
UPDATE holds
SET status='RELEASED', released_at=NOW()
WHERE id IN (
  SELECT id FROM holds
  WHERE status='HELD' AND held_until < NOW()
  FOR UPDATE SKIP LOCKED LIMIT 100      -- §3.2.2 batch limit + replica-safe
);
-- publish seat.released for each via outbox
```
Comment in code: `// SKIP LOCKED — safe under PgBouncer and multi-replica; no advisory lock coordination needed`. `TODO(prod)`: leader election if cadence needs to be exactly-once globally.

### 6.4 SSE endpoint (§3.2.3, §4.4.1)
```ts
@Sse('/seats/stream')
stream(): Observable<MessageEvent> {
  return fromEvent(this.bus, 'seat:changed').pipe(
    map((e) => ({ data: e }))
  );
}
```
- In-process `EventEmitter` for now.
- On every seat/hold state change → `bus.emit('seat:changed', payload)`.
- **`TODO(prod)` comment in code**: "Replace with Redis pub/sub so multiple seat-service instances fan-out consistently. In-process bus only works for single replica."
- Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.

### 6.5 Consume payment events (§5.2.1, §5.2.5)
On `payment.succeeded.v1`:
```ts
await tx.transaction(async (t) => {
  // idempotency guard
  await t.insert(ConsumedEvent).values({ eventId, consumerGroup: 'seat-service' })
    .onConflict().doNothing();  // if 0 rows inserted → already processed, skip
  // reserve seat
  const r = await t.update(Hold)
    .set({ status: 'RESERVED', reservedAt: new Date() })
    .where('seat_id = :seatId AND user_id = :userId AND status = :st', { seatId, userId, st: 'HELD' })
    .returning('*');
  if (r.length) await appendOutbox(t, 'seat.reserved.v1', { ... });
});
```
On `payment.failed.v1` → release hold (compensation §5.2.1) + outbox `seat.released`.

---

## 7. Payment service — finance handling detail

Maps to §3.3 / §5.1 / §5.2.

### 7.1 Boundary abstraction (§5.1.1)
```ts
export interface PSPClient {
  createIntent(opts: { amount: number; currency: string; idempotencyKey: string; metadata: Record<string,string> }):
    Promise<{ pspIntentId: string; clientSecret: string }>;
  constructEventFromWebhook(rawBody: Buffer, signature: string): PSPEvent;
}
export class MockPSPClient implements PSPClient { ... }
```
`StripeClient` would be a drop-in replacement — documented in `DECISIONS.md` entry #3.

### 7.2 Checkout — `POST /payment/checkout`
1. Body `{ seatId, idempotencyKey }` (Zod validated).
2. **Call seat-service for current price? No — that would be HTTP sync (auto-fail).** Instead, seat price is replicated into the seat DB; payment-service reads from a denormalized `seat_prices` cache table refreshed by `seat.held` event payload, OR (chosen) the price is included in the `seat.held` event payload from seat-service and stored in `payment_intents.amount` at checkout creation.
3. Insert `payment_intents` with `amount` from event payload (server-controlled, §3.3.3/§5.1.5). `idempotency_key` UNIQUE → duplicate request = return existing intent (§3.3.4 / idempotency).
4. `psp.createIntent({ amount, idempotencyKey })` with **timeout** (§4.4.3) and **circuit breaker** (`opossum` or hand-rolled) around the call.
5. Return `{ clientSecret, intentId }`.

### 7.3 Webhook — `POST /payment/webhook` (§5.1.2 / §5.1.3 / §5.1.4 / §5.2.1)
1. Read **raw body** (not parsed JSON) — needed for HMAC.
2. `psp.constructEventFromWebhook(rawBody, sig)` — uses `crypto.timingSafeEqual` internally.
3. Timestamp freshness: `if (Date.now() - event.created*1000 > WEBHOOK_TOLERANCE_MS) return 401` (§5.1.3).
4. **Ack-fast pattern** (Exceed §5.2):
   ```ts
   await tx.insert(WebhookInbox).values({ stripeEventId, type, payload })
     .onConflict('stripe_event_id').doNothing();   // §5.1.4 idempotency
   // 200 immediately
   res.status(200).send();
   // process async (setImmediate / queue) — separate TX
   ```
5. Async processor: based on `type`:
   - `payment_intent.succeeded` → update `payment_intents.status='COMPLETED'` + outbox `payment.succeeded.v1` **in same TX** (§5.2.2).
   - `payment_intent.payment_failed` → update `payment_intents.status='FAILED'` + outbox `payment.failed.v1` (compensation trigger, §5.2.1).
6. Audit log `payment_initiate` and `payment_completed/failed` (§2.2.8).

### 7.4 Circuit breaker (§4.4.3)
```ts
const breaker = new CircuitBreaker(psp.createIntent, {
  timeout: 5000, errorThresholdPercentage: 50, resetTimeout: 30000,
});
breaker.on('open', () => log.warn({ action: 'psp_cb_open' }));
```
`TODO(prod)` note in code: tune thresholds per PSP SLA.

---

## 8. Ops readiness (checklist §4)

### 8.1 Health endpoints — every service (§4.1.1 / §4.1.2)
```ts
@Controller('health')
export class HealthController {
  @Get('live') live() { return { status: 'ok', uptime: process.uptime(), version }; }
  @Get('ready') async ready() {
    const checks = {
      db: await pingDB().then(() => 'ok').catch(() => 'fail'),
      rabbit: await pingRabbit().then(() => 'ok').catch(() => 'fail'),
      redis: await pingRedis().then(() => 'ok').catch(() => 'fail'),  // if used
    };
    const ok = Object.values(checks).every(v => v === 'ok');
    return res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', checks });
  }
}
```
Used by `docker-compose` `healthcheck` + `depends_on: condition: service_healthy` (§4.1.5).

### 8.2 Graceful shutdown (§4.1.3 / §4.1.4)
```ts
app.enableShutdownHooks();
process.on('SIGTERM', async () => {
  log.info({ action: 'sigterm' });
  await app.close();      // NestJS calls onModuleDestroy on every module → close pg/redis/amqp
  clearInterval(sweeperHandle);
  await outboxWorker.stop();
  process.exit(0);
});
```
Each module's `OnModuleDestroy` closes its DB pool / RabbitMQ channel / Redis client (§4.1.4).

### 8.3 Logging (§1.1.8 / §4.3.1 / §4.3.2)
`packages/be-core` exposes a `pino`-based logger. Every log line is JSON with:
`{ ts, level, action, userId?, traceId, service, msg, ...props }`

`traceId` from `x-request-id` (generated if missing), propagated to RabbitMQ `headers.traceId`. Log level per env (`LOG_LEVEL=info` prod, `debug` dev) — §4.3.2.

### 8.4 Metrics (§4.3.3 / §4.3.4)
`prom-client` per service. `/metrics` exposes:
- Default Node metrics.
- Business counters: `seats_held_total`, `seats_reserved_total`, `reservations_cancelled_total`, `hot_seat_detected_total`, `payment_completed_total`, `payment_failed_total`, `auth_login_success_total`, `auth_login_fail_total`.

### 8.5 Docker / compose (§4.2)
- Each `Dockerfile` is multi-stage, `USER node`, `.dockerignore` excludes `node_modules`, `*.md`, `.env` (§4.2.3).
- `infra/docker-compose.yml`:
  - `postgres` (with `postgres.conf` mount + healthcheck)
  - `redis` (healthcheck)
  - `rabbitmq:3.13-management` (healthcheck)
  - `auth`, `seat-reservation`, `payment` (each `build: ./apps/<x>`, `depends_on` db+rabbit with `service_healthy`)
  - `nginx` (`depends_on` all 3 apps)
  - No `network_mode: host`; each service on the same `backend` network.
- `.env.example` documents every var with `# required` / `# optional` comments (§4.2.4).

### 8.6 nginx (§4.2.2 / §2.2.3)
```nginx
limit_req_zone $binary_remote_addr zone=login:10m rate=10r/m;
limit_req_zone $binary_remote_addr zone=api:10m    rate=60r/m;
limit_req_zone $binary_remote_addr zone=webhook:10m rate=100r/m;

location /api/auth/login { limit_req zone=login burst=5; proxy_pass http://auth:4001; }
location /api/seats/      { limit_req zone=api burst=20; proxy_pass http://seat-reservation:4002; }
location /api/payment/    { limit_req zone=api burst=10; proxy_pass http://payment:4003; }
location /payment/webhook { limit_req zone=webhook burst=20; proxy_pass http://payment:4003; }
limit_req_status 429;
```

---

## 9. Testing (checklist §1.3)

Tool: **Jest** + `testcontainers` to spin real Postgres / RabbitMQ.

### 9.1 Concurrency test (§1.3.1 — required)
```ts
it('two concurrent holds on same seat → exactly one wins', async () => {
  await seedSeat();
  const [a, b] = await Promise.allSettled([
    hold(userIdA), hold(userIdB),
  ]);
  expect([a, b].filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect([a, b].filter(r => r.status === 'rejected' && r.reason.status === 409)).toHaveLength(1);
  const holds = await db.query('SELECT * FROM holds WHERE seat_id=$1 AND status=$2', [seatId, 'HELD']);
  expect(holds.rows).toHaveLength(1);
});
```
Real DB, no mocks (§1.3.2). Repeat with 50 parallel holds → assert still exactly 1 HELD.

### 9.2 Idempotency test (§1.3.3)
- POST `/payment/checkout` twice with same `idempotencyKey` → same `intentId`, one DB row.
- POST webhook twice with same `stripe_event_id` → one `webhook_inbox` row, one seat reservation.

### 9.3 Auth flow tests
- RT cookie present, `httpOnly`, `sameSite=strict`, `secure` (when `NODE_ENV=production`).
- Rotation issues new RT, old RT revoked.
- Reuse of revoked RT (post grace) revokes whole family.
- Logout bumps `token_version`; subsequent AT-bearing request → 401.

### 9.4 E2E smoke (§1.1.9 / auto-fail if broken)
`scripts/e2e-smoke.sh`:
```bash
curl -X POST /api/auth/register  ...
curl -c cookies -X POST /api/auth/login  ...
curl -b cookies -X POST /api/seats/$SEAT/hold
curl -b cookies -X POST /api/payment/checkout -d '{"seatId":"$SEAT","idempotencyKey":"..."}'
curl -X POST /api/payment/webhook -H 'x-signature: ...' -d @event.json
curl /api/seats/$SEAT | grep RESERVED
```
Asserts final seat state = `RESERVED`. Run as part of submission verification.

---

## 10. Front-end (`apps/web`)

Single `index.html` + small JS module (no framework needed; keep in scope). Shows 3 seats, polls `GET /seats` every 2s with `If-None-Match` (or connects to `/seats/stream` SSE — preferred since §4.4.1 wants the endpoint anyway). Login form posts to `/api/auth/login`, stores AT in memory, relies on RT cookie for refresh.

`TODO(prod)` comment: real SPA + refresh-on-401 interceptor.

---

## 11. Documentation deliverables

### 11.1 `README.md` (§1.1.3)
- Folder tree.
- Service list with ports.
- Architecture diagram (ASCII / mermaid): browser → nginx → 3 services → RabbitMQ + Postgres + Redis.
- RabbitMQ topics + routing keys.
- DB schemas per service.
- Setup: `cp .env.example .env && docker compose up --build && ./scripts/e2e-smoke.sh`.

### 11.2 `DECISIONS.md` (§1.1.4 / §1.1.2 / auto-fail if missing)
≥5 real entries (target ≥8 for Exceed). Drafted **before** coding:

1. **Three services with own Postgres DBs** — why split (scaling profiles), why separate DBs (no shared-table coupling), trade-off: harder local dev (compose heavy) — accepted.
2. **Hold locking strategy** — partial unique indexes + `SERIALIZABLE`, failure mode = `unique_violation` → 409, limitation under stadium scale, `TODO(prod)` sharded lock.
3. **MockPSPClient boundary** — interface extracted so Stripe is drop-in; honest note that Stripe SDK differs in shape.
4. **Transactional outbox over direct publish** — at-least-once delivery, 2x DB write cost accepted for correctness.
5. **Refresh token: opaque + family tracking + grace window** — why not JWT RT (not revocable); why grace (mobile retry); why family (theft containment).
6. **Expand-contract migration policy** — never DROP in same release as code change; document each schema change as expand → migrate → contract.
7. **SSE in-process, not Redis pub/sub** — keeps scope at 2h; `TODO(prod)` clearly marks the multi-instance gap.
8. **tokenVersion via DB lookup** — fine for ≤1k RPS; `TODO(prod)` Redis cache with 30s TTL + logout invalidation.
9. **Amount locked at checkout creation** — price taken from `seat.held` event payload, never from client body; rationale: prevent price manipulation (§3.3.3).
10. **Scope cuts** — no real Stripe, no real email, front-end minimal, no K8s manifests. Each cut has a `TODO(prod)` line.

### 11.3 `TODO(prod)` density (§1.1.5 / Exceed judgment)
Sprinkle `// TODO(prod): ...` at every scale boundary:
- seat sweeper (leader election), SSE (Redis pub/sub), tokenVersion cache, rate-limit (Redis cluster), outbox worker (Kafka migration if throughput demands), circuit breaker tuning, PgBouncer in front of pool, idempotency Redis fast-path in front of DB dedup, audit log to append-only S3 + DB.

Target: `grep -r "TODO(prod)" apps | wc -l` ≥ 10.

---

## 12. Implementation order (2-hour budget)

| Step | Time | What |
|---|---|---|
| 0 | 5 min | `DECISIONS.md` draft (entries 1–6) |
| 1 | 10 min | Monorepo skeleton: `apps/ packages/ infra/`, `tsconfig.base.json`, `packages/be-core`, `packages/contracts` |
| 2 | 15 min | `docker-compose.yml` (postgres, redis, rabbitmq, nginx, 3 apps), `.env.example`, `postgres.conf`, `nginx.conf` |
| 3 | 10 min | Migrations for all 3 services (Kysely) |
| 4 | 25 min | auth-service: register/login/refresh/logout/logout-all + RT rotation + reuse detection + cookie + audit + health + metrics + rate-limit |
| 5 | 25 min | seat-service: list, SSE, hold (transactional + indexes), sweeper (SKIP LOCKED), RabbitMQ consumer for payment events, outbox worker |
| 6 | 20 min | payment-service: checkout, MockPSPClient, webhook (HMAC + inbox + ack-fast), outbox, circuit breaker |
| 7 | 10 min | `apps/web` minimal HTML + JS |
| 8 | 15 min | Tests: concurrency hold, idempotency, auth rotation; `e2e-smoke.sh` |
| 9 | 10 min | `README.md` with tree + diagram; finalize `DECISIONS.md`; `TODO(prod)` pass |
| Buffer | 10 min | Lint/typecheck (`tsc --noEmit`, `eslint`), fix env-validation gaps, run smoke |

If time runs short, drop in this order (each documented as a scope cut in `DECISIONS.md`):
1. prom-client business metrics (keep `/metrics` infra default only)
2. logout-all endpoint (keep logout)
3. SSE in favor of polling (but still document why)

Never dropped (auto-fail otherwise): microservices split, RabbitMQ, argon2id, RT cookie, HMAC webhook, hold DB-level invariant, DECISIONS.md, health endpoints, E2E smoke.

---

## 13. Verification matrix (reviewer perspective)

For every checklist item, the table below says where it's satisfied.

| Checklist | Where |
|---|---|
| 1.0.1 microservices | `apps/{auth,seat-reservation,payment}` + own Dockerfile |
| 1.0.2 broker + outbox | RabbitMQ in compose; `outbox` tables + workers per service |
| 1.0.3 scale | `DECISIONS.md` #1, `docker-compose` `--scale` note |
| 1.0.4 shared packages | `packages/be-core`, `packages/contracts` |
| 1.0.5 health per service | `HealthController` in each app |
| 1.1.1 layout | `apps/ packages/ infra/` tree |
| 1.1.2 service boundaries | `DECISIONS.md` #1 |
| 1.1.3 README | `README.md` |
| 1.1.4 trade-offs | `DECISIONS.md` (≥8 entries) |
| 1.1.5 TODO(prod) | grep across `apps/` |
| 1.1.6 strict TS | `packages/tsconfig-base/tsconfig.base.json` |
| 1.1.7 validation | Zod pipes at every controller |
| 1.1.8 JSON logs + traceId | `packages/be-core/logger` |
| 1.1.9 E2E | `scripts/e2e-smoke.sh` |
| 1.2.* DB | migrations, partial indexes, pool config, `postgres.conf` |
| 1.3.* testing | `*.spec.ts` per service + `e2e-smoke.sh` |
| 2.1.1–2.1.10 auth | §5 of this doc |
| 2.2.* API sec | §5.5 of this doc + nginx |
| 3.1.* hold | §6.1, `DECISIONS.md` #2 |
| 3.2.* expiry | §6.3 sweeper, §6.4 SSE |
| 3.3.* payment idem | §7 |
| 4.1.* health/shutdown | §8.1, §8.2 |
| 4.2.* infra | §8.5, §8.6 |
| 4.3.* observability | §8.3, §8.4 |
| 4.4.* scalability | SSE + circuit breaker + SKIP LOCKED + TODO(prod) caches |
| 5.1.* payment flow | §7 |
| 5.2.* saga | outbox + compensation on `payment.failed` |

---

## 14. Risks & explicit scope cuts (also mirrored to `DECISIONS.md`)

| Risk / cut | Mitigation / TODO |
|---|---|
| No real Stripe | `MockPSPClient` behind interface; `TODO(prod)` swap |
| SSE only in-process | `TODO(prod)` Redis pub/sub; documented in `DECISIONS.md` #7 |
| tokenVersion DB lookup each request | `TODO(prod)` Redis cache 30s TTL |
| No PgBouncer in compose | `DECISIONS.md` #6 notes pool size rationale; `TODO(prod)` |
| Front-end minimal | Single HTML; `TODO(prod)` SPA |
| No K8s manifests | docker-compose is deployment target for assessment |
| No real email / verification | Out of scope per requirement |
| Outbox worker as `setInterval` in same pod | `TODO(prod)` separate worker deployment for independent scaling |

---

End of plan. Next step: create `DECISIONS.md` first (auto-fail guard), then scaffold the monorepo per §1 and proceed in the order in §12.
