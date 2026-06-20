# Senior Engineer Assessment — Review Checklist

> Checklist này dùng để review code submission. Mỗi item có 3 mức:
> - ✅ **Pass** — đạt yêu cầu (Meet Expectation)
> - 🌟 **Exceed** — vượt expectation (Exceed Expectation)
> - ❌ **Fail** — thiếu hoặc sai
>

---

## 1. COMMON BEST PRACTICES

### 1.0 Microservices Architecture — BẮT BUỘC

> **Yêu cầu production**: hệ thống phải scale từng service độc lập (auth CPU-bound, seat DB-bound, payment I/O-bound — profile khác nhau, cần scale riêng).
> **Phải là microservices** — mỗi bounded context (auth / seat-reservation / payment) là 1 service riêng, deploy riêng, Dockerfile riêng.
> **Phải dùng message broker** (Kafka hoặc RabbitMQ) — inter-service events async, không HTTP sync.
> Fail 1.0.1 hoặc 1.0.2 = **Auto-Fail toàn bộ submission**.

| # | Item | Pass | Exceed | Fail signal |
|---|---|---|---|---|
| 1.0.1 | **Microservices**: auth, seat-reservation, payment là 3 services riêng biệt | Mỗi service: entry point riêng, Dockerfile riêng, port riêng — deploy độc lập | Gateway layer: client chỉ nói chuyện với gateway, services không expose trực tiếp ra ngoài | Single process / single Dockerfile cho tất cả — tách file nhưng cùng 1 app cũng Fail |
| 1.0.2 | **Message broker** (Kafka / RabbitMQ) cho inter-service events | Kafka hoặc RabbitMQ trong docker-compose, dùng cho ít nhất payment→seat event | Transactional outbox trong same TX với business update; separate consumer/worker service | Không có Kafka/RabbitMQ — services gọi nhau qua HTTP sync hoặc in-process function call |
| 1.0.3 | Services scale độc lập | Có thể chạy N instances của seat-service mà không ảnh hưởng auth | DECISIONS.md giải thích scaling profile từng service (auth=CPU, seat=DB, payment=I/O) | 1 docker-compose service cho toàn bộ backend |
| 1.0.4 | Shared code trong packages/, không duplicate | Common utils/types trong `packages/be-core` hoặc tương đương | Typed event contracts cho Kafka messages, versioned | Copy-paste code giữa services; hoặc service import trực tiếp code của nhau |
| 1.0.5 | Mỗi service có health endpoint riêng | `GET /health` per service, check own deps (DB, Kafka, Redis) | `/health/ready` check all deps, return degraded; compose `depends_on: service_healthy` | Không có health per service — orchestrator không biết service ready chưa |

### 1.1 Code Structure & Best Practices

| # | Item | Pass | Exceed | Fail signal |
|---|---|---|---|---|
| 1.1.1 | Monorepo layout rõ ràng: apps/, packages/, infra/ | `apps/` có ≥3 services, `packages/` shared, `infra/` nginx + kafka config | Turborepo pipeline, shared tsconfig.base.json | Flat folder, không có separation |
| 1.1.2 | Mỗi service boundary có lý do trong DECISIONS.md | Có entry giải thích tại sao tách service này | Explain scale reason (e.g., "auth isolated vì argon2 CPU-bound") | Service tách mà không có justification |
| 1.1.3 | README có folder tree + architecture | README có service list, ports, flow diagram | Architecture diagram, Kafka topics, DB schemas per service | README chỉ có setup steps |
| 1.1.4 | DECISIONS.md ghi lại trade-off | Có file, có vài entries | Mọi shortcut/scope cut đều có entry với "why not implement full" | Không có DECISIONS.md |
| 1.1.5 | TODO(prod) / TODO(scope) comments | Có comments đánh dấu shortcuts | Comments giải thích production path | Không có comments |
| 1.1.6 | TypeScript strict mode | `"strict": true` trong tsconfig | Không có `any` trong critical paths | Widespread `any` types |
| 1.1.7 | Input validation tại API boundary | Có validation (Zod / class-validator) | Typed DTOs, strip unknown fields | `req.body as any` toàn codebase |
| 1.1.8 | Structured JSON logging với correlation ID | JSON logs có `action`, `userId`, `traceId` | `x-request-id` propagated end-to-end | `console.log` strings |
| 1.1.9 | E2E happy path chạy được | Login → hold → pay → reserve flow hoạt động | Smoke test script tự động | Demo broken |

### 1.2 Database

| # | Item | Pass | Exceed | Fail signal |
|---|---|---|---|---|
| 1.2.1 | Migrations có, versioned | Migration files tồn tại và chạy được | Timestamps theo convention, idempotent (`IF NOT EXISTS`) | Không có migrations; schema hardcode |
| 1.2.2 | Partial indexes cho status-filtered queries | `WHERE status = 'HELD'` index tồn tại | Multiple partial indexes cho mọi hot-path query | Full table scan cho hold/reserve queries |
| 1.2.3 | Migration backward compatibility | Không DROP column mà code vẫn đọc | Expand-contract pattern documented trong DECISIONS.md | DROP trong migration cùng với code change (breaking deploy) |
| 1.2.4 | Connection pool configured | `max` set explicitly, không dùng default | Pool size comment theo công thức `(cpu×2)+spindles`, PgBouncer noted | Không có pool config; unlimited connections |
| 1.2.5 | Slow query logging | `log_min_duration_statement` trong docker-compose | `log_lock_waits=on`, `deadlock_timeout=1s` | Không có Postgres config; blind to slow queries |

### 1.3 Testing

| # | Item | Pass | Exceed | Fail signal |
|---|---|---|---|---|
| 1.3.1 | Test concurrent hold: "2 requests → 1 wins" | Test tồn tại và pass | Test dùng real DB (không mock), verify chính xác 1 row updated | Không có concurrency test |
| 1.3.2 | Integration tests cho critical flows | Auth, hold, payment flows có tests | Tests hit real Postgres, verify DB state after | Chỉ unit test với mocks |
| 1.3.3 | Idempotency test | Duplicate request trả cùng kết quả | Test verify no duplicate rows in DB | Không test idempotency |

---

## 2. SECURITY

### 2.1 Authentication & Session

| # | Item | Pass | Exceed | Fail signal |
|---|---|---|---|---|
| 2.1.1 | Refresh token trong httpOnly cookie | `httpOnly: true`, `sameSite: 'strict'`, `secure: isProd` | `path: '/api/auth'` scope, `maxAge` explicit | RT trong JSON body / localStorage — **CRITICAL FAIL** |
| 2.1.2 | RT opaque (không phải JWT) | 48+ bytes random, base64url | `crypto.randomBytes(48).toString('base64url')` | JWT làm refresh token — không revocable |
| 2.1.3 | RT hashed trong DB | SHA-256(token) lưu, raw token chỉ trong cookie | Constant-time compare khi verify | Raw token lưu thẳng vào DB |
| 2.1.4 | RT rotation mỗi /refresh | Old token revoked, new token issued | `rotatedTo` field link đến successor | Reuse cùng RT mãi mãi |
| 2.1.5 | Reuse detection (theft detection) | Nếu revoked token được dùng lại → revoke toàn family | `familyId` tracking, revoke all tokens cùng family | Không detect reuse |
| 2.1.6 | Grace window cho network retry | Trong N giây sau rotation, old token vẫn valid | Explicit grace window config + log khi reuse trong grace | Hard fail ngay — retry của mobile app bị break |
| 2.1.7 | Logout invalidate AT ngay | `tokenVersion` column trên User, bump khi logout | Check `tokenVersion` trong auth middleware mỗi request | Logout chỉ revoke RT, AT vẫn valid đến hết TTL |
| 2.1.8 | Logout-all (all devices) | `revokeAllRefreshTokensForUser` | Kết hợp với tokenVersion bump | Không có logout-all |
| 2.1.9 | Password hashing Argon2id | `argon2id` với memory/iteration params phù hợp | Timing dummy hash cho non-existent user (prevent user enumeration) | bcrypt hoặc SHA-256 — **CRITICAL FAIL** |
| 2.1.10 | Access token ngắn hạn | AT TTL ≤ 15 phút | AT TTL configurable qua env | AT TTL 1 ngày hoặc không expire |

### 2.2 API Security

| # | Item | Pass | Exceed | Fail signal |
|---|---|---|---|---|
| 2.2.1 | Rate limiting trên login | ≤ 10 req/phút per IP | Redis-backed throttle (không mất state khi restart) | Không có rate limit → brute force |
| 2.2.2 | Rate limiting per endpoint | Seat/payment endpoints có riêng limit | `RATE_LIMIT_SEAT_MAX`, `RATE_LIMIT_PAYMENT_MAX` configurable qua env | Chỉ có global limit hoặc không có gì |
| 2.2.3 | nginx rate limit zones | `limit_req_zone` trong nginx.conf | Multiple zones (login/api/webhook), burst config | Không có nginx config |
| 2.2.4 | CORS configured | `origin` whitelist, không phải `*` | `credentials: true`, `allowedHeaders` explicit | `origin: '*'` — **CRITICAL FAIL nếu có auth** |
| 2.2.5 | Security headers | Helmet middleware tồn tại | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` set | Không có security headers |
| 2.2.6 | Webhook HMAC verification | `crypto.timingSafeEqual(expected, received)` | Timestamp freshness check (reject nếu > 5 phút cũ) | Không verify webhook signature — **CRITICAL FAIL** |
| 2.2.7 | JWT_SECRET required, không có default | Startup fail nếu thiếu | Separate secret cho refresh token (`JWT_REFRESH_SECRET`) | `process.env.JWT_SECRET \|\| 'secret'` — **CRITICAL FAIL** |
| 2.2.8 | Audit log cho sensitive actions | Log `login`, `logout`, `payment_initiate`, `session_revoke` | Append-only audit table (không chỉ log) | Không có audit trail |

---

## 3. CONCURRENCY

> **Đánh giá judgment, không đánh giá pattern.**
> Candidate có thể dùng `FOR UPDATE`, `SERIALIZABLE`, hoặc optimistic + DB constraint — tất cả đều Pass nếu đúng.
> Exceed = candidate giải thích được *tại sao* chọn approach đó và biết failure mode của nó.
> Fail = approach sai về correctness (TOCTOU, application-only check) hoặc không giải thích được.

### 3.1 Hold Locking — Correctness

| # | Item | Pass | Exceed | Fail signal |
|---|---|---|---|---|
| 3.1.1 | Hold operation là atomic | Check + update trong 1 transaction (bất kỳ isolation level nào) | Candidate ghi trong DECISIONS.md tại sao chọn isolation level đó (e.g., "SERIALIZABLE vì không muốn explicit lock"; "FOR UPDATE vì cần fail-fast 409") | `SELECT` availability rồi `UPDATE` trong 2 queries riêng — TOCTOU window |
| 3.1.2 | DB-level invariant, không phải chỉ application-level | Partial unique index `WHERE status='HELD'` **hoặc** explicit row lock (`FOR UPDATE`) — DB enforces constraint | Cả hai: DB constraint + lock (belt + suspenders). Candidate biết tại sao chỉ app-level check là insufficient | Chỉ `if (seat.status === 'available') { update }` — bypass được bằng concurrent request |
| 3.1.3 | "1 hold per user" enforced | Partial unique index `UNIQUE (user_id) WHERE status='HELD'` — DB rejects duplicate | Candidate hiểu tại sao DB constraint > application check ("app check có race, DB constraint không có") | Không có check — user hold nhiều seats cùng lúc |
| 3.1.4 | Candidate biết failure mode của approach mình chọn | DECISIONS.md hoặc comment giải thích: "approach X có giới hạn Y, tôi accept vì Z" | Candidate có thể trả lời khi reviewer hỏi "nếu 1000 user cùng hold seat này thì sao?" — giải thích DB connection pool queue vs fail-fast | Không có gì trong DECISIONS.md về locking strategy — candidate không nghĩ đến concurrency |
| 3.1.5 | Contention response có thể retry được | 409 response, hoặc `Retry-After` header | `Retry-After: N` với N có nghĩa (không phải random). Comment/doc note về retry storm risk | 500 khi conflict → client không biết đây là transient hay permanent |

### 3.2 Hold Expiry & Cleanup

| # | Item | Pass | Exceed | Fail signal |
|---|---|---|---|---|
| 3.2.1 | Expired holds được cleanup | Background sweeper (`setInterval` hoặc cron) **hoặc** lazy cleanup mỗi request kèm lý do | Candidate note rõ trade-off: "lazy = đơn giản nhưng stale UI; sweeper = phức tạp hơn nhưng proactive" | Không có gì — expired holds giữ seat mãi |
| 3.2.2 | Sweeper không gây vấn đề khi scale | `LIMIT N` per batch (tránh lock cả bảng), hoặc `FOR UPDATE SKIP LOCKED` (multi-replica safe) | Candidate giải thích được tại sao SKIP LOCKED tốt hơn advisory lock trong PgBouncer pool | Unbounded `UPDATE WHERE held_until < NOW()` — lock toàn bộ bảng; hoặc không comment gì về multi-replica |
| 3.2.3 | SSE endpoint hoặc polling hook tồn tại | `GET /seats/stream` với `text/event-stream`, hoặc rõ ràng document tại sao dùng polling | TODO(prod) comment giải thích Redis pub/sub khi horizontal scale | Chỉ polling, không có comment/doc — reviewer không biết candidate có biết real-time approach không |

### 3.3 Payment Idempotency

| # | Item | Pass | Exceed | Fail signal |
|---|---|---|---|---|
| 3.3.1 | Webhook idempotency | DB `UNIQUE` trên `stripe_event_id` — duplicate event = no-op | Candidate note tại sao ack trước rồi process async (ack-fast pattern) hoặc implement webhook_inbox | Process webhook multiple times — duplicate reservation/charge |
| 3.3.2 | Seat released nếu payment fails | `payment_intent.payment_failed` handler release hold | Release trong same TX với payment status update. Candidate note compensation pattern | Payment fail, seat vẫn HELD — user khác không book được |
| 3.3.3 | Payment amount server-controlled | Server lấy amount từ DB row khi confirm, không trust client payload | Candidate ghi trong DECISIONS.md: "amount locked at checkout creation, không cho phép client override" | Client-sent amount dùng để charge — price manipulation risk |
| 3.3.4 | Candidate biết double-charge risk | Xử lý idempotency ở đâu đó (webhook dedup, PI idempotency key) | Có thể explain: "PI idempotency key tránh double-create; stripe_event_id dedup tránh double-fulfill" | Không có bất kỳ idempotency nào — reviewer hỏi "Stripe retry thì sao?" candidate không trả lời được |

---

## 4. OPS READINESS

### 4.1 Health & Graceful Shutdown

| # | Item | Pass | Exceed | Fail signal |
|---|---|---|---|---|
| 4.1.1 | `/health/live` endpoint | Return 200 nếu process alive | Return JSON với uptime, version | Không có — K8s không biết khi nào restart pod |
| 4.1.2 | `/health/ready` endpoint | Check DB + Redis connected | Check mọi dep (Kafka, Redis, DB), return degraded state | `/ready` chỉ return 200 hardcode — không detect dep failure |
| 4.1.3 | SIGTERM graceful shutdown | `process.on('SIGTERM', ...)` — stop accepting requests, drain | NestJS `app.enableShutdownHooks()`, clearInterval cleanup timers | Process kill ngay — in-flight requests bị cut |
| 4.1.4 | Redis/DB disconnect on shutdown | Cleanup trong `onModuleDestroy` / shutdown hook | Disconnect tất cả clients (pub/sub, cache, main) | Connection leak khi pod restart |
| 4.1.5 | Docker healthcheck trong compose | `healthcheck` block với interval/timeout/retries | `depends_on` với `condition: service_healthy` | Không có healthcheck — app start trước DB ready |

### 4.2 Infrastructure

| # | Item | Pass | Exceed | Fail signal |
|---|---|---|---|---|
| 4.2.1 | docker-compose đủ services | postgres + redis + kafka/rabbitmq + **≥3 separate app services** (auth, seat, payment) | nginx, pgbouncer, payment-worker tách, monitoring | Chỉ có 1 app container (monolith) + DB; hoặc thiếu message broker |
| 4.2.2 | nginx.conf với rate limiting | `limit_req_zone` + `limit_req` directives | Multiple zones per route type, burst config, `limit_req_status 429` | Không có nginx — rate limit chỉ ở app level |
| 4.2.3 | Non-root Dockerfile | `USER node` hoặc tương đương | Multi-stage build, `.dockerignore`, no dev deps in prod image | Root user trong container |
| 4.2.4 | `.env.example` có tất cả vars | Mọi env var đều có trong .env.example | Comment giải thích từng var, required vs optional | Thiếu .env.example — reviewer không setup được |
| 4.2.5 | Secret vars không có default | `process.env.JWT_SECRET` throw nếu undefined | `config.getOrThrow()` hoặc Zod parse at startup | `JWT_SECRET \|\| 'dev-secret'` fallback |

### 4.3 Observability

| # | Item | Pass | Exceed | Fail signal |
|---|---|---|---|---|
| 4.3.1 | Structured JSON logs | Mọi log là JSON với `action`, `timestamp` | `traceId` / `correlationId` trong mọi log line | `console.log("user logged in")` strings |
| 4.3.2 | Log levels per env | DEBUG/INFO/WARN/ERROR, không log debug trong prod | Per-service log level config qua env | Tất cả logs ở DEBUG level trong production container |
| 4.3.3 | Metrics endpoint | `/metrics` tồn tại | `prom-client` với counters per business event | Không có metrics — blind monitoring |
| 4.3.4 | Business metrics | Log success/failure counts | `seats_held`, `reservations_cancelled`, `hot_seat_detected` counters | Chỉ infra metrics, không có business metrics |
| 4.3.5 | `Retry-After` trên rate limit responses | 429 responses có header | `X-RateLimit-Limit`, `X-RateLimit-Remaining` headers | Client không biết khi nào retry |

### 4.4 Scalability Hooks

| # | Item | Pass | Exceed | Fail signal |
|---|---|---|---|---|
| 4.4.1 | SSE endpoint tồn tại | `GET /seats/stream` với `text/event-stream` | Redis pub/sub fan-out (multi-instance safe) | Chỉ polling client; không có real-time |
| 4.4.2 | Redis pub/sub cho seat updates | Publish on every seat state change | Singleflight pattern cho cache stampede prevention | In-process EventEmitter — không scale khi horizontal |
| 4.4.3 | Circuit breaker cho external calls | Timeout trên Stripe/PSP calls | `CircuitBreaker` class với open/half-open/closed states | Không có timeout — hung request khi PSP down |
| 4.4.4 | Sweep job replica-safe | Advisory lock hoặc SKIP LOCKED | `FOR UPDATE SKIP LOCKED` (không cần coordination, PgBouncer-safe) | Mọi replica chạy cùng sweep job |
| 4.4.5 | tokenVersion cache | TODO(prod) Redis cache cho tokenVersion lookup | `TokenVersionCache` với TTL | DB query mỗi request cho tokenVersion check — bottleneck khi scale |

---

## 5. FINANCE HANDLING

### 5.1 Payment Flow

| # | Item | Pass | Exceed | Fail signal |
|---|---|---|---|---|
| 5.1.1 | Mock payment client với clear boundary | Interface/abstract class tách payment logic | `StripeClient` interface → easy swap to real Stripe | Payment logic hardcode, không có abstraction |
| 5.1.2 | Webhook HMAC-SHA256 verification | `stripe.webhooks.constructEvent()` hoặc manual HMAC | Timing-safe compare (`crypto.timingSafeEqual`) | Không verify signature — bất kỳ ai gọi được webhook |
| 5.1.3 | Webhook timestamp freshness | Reject nếu `timestamp > 5 phút` | Configurable tolerance qua env | Không check timestamp — replay attack possible |
| 5.1.4 | Webhook idempotency | UNIQUE trên `stripe_event_id` | 2-layer: Redis fast-path + DB authoritative | Process webhook nhiều lần — charge nhiều lần |
| 5.1.5 | Amount server-side controlled | Server lấy amount từ DB, không tin client | `price` locked in `payment_intents` row khi create | Client gửi amount lên → price manipulation |
| 5.1.6 | Payment intent trạng thái machine | `PENDING → COMPLETED / FAILED` với DB record | Audit log cho mọi status transition | Không track payment state — không biết charge thành công chưa |

### 5.2 Saga / Compensation

| # | Item | Pass | Exceed | Fail signal |
|---|---|---|---|---|
| 5.2.1 | Seat released nếu payment fails | `SeatReleaseRequested` event khi payment fail | Compensation với retry + dead letter | Payment fail nhưng seat vẫn HELD mãi |
| 5.2.2 | Outbox trong same TX | `appendOutbox(manager, ...)` trong cùng transaction với business update | Separate outbox lifecycle (PENDING→PROCESSING→DEAD) | Publish event sau commit — event có thể mất nếu crash |
| 5.2.3 | Outbox worker với retry | Retry failed outbox entries | Exponential backoff, max retries, DEAD state + alert | Fire-and-forget — không retry failed events |
| 5.2.4 | Hold released nếu payment không bắt đầu | Sweeper cleanup expired holds | Hold TTL ngắn hơn payment intent expiry | Hold giữ vô thời hạn nếu user bỏ giữa chừng |
| 5.2.5 | Idempotent saga steps | `markProcessed(eventId, consumer)` trước execute | `UNIQUE (event_id, consumer_group)` constraint | Saga step chạy nhiều lần khi Kafka redeliver |

---

## Scoring Guide

### Meet Expectation
- Không trigger Auto-Fail nào
- **Architecture 1.0**: auth, seat-reservation, payment là 3 services riêng biệt với Dockerfile riêng — bắt buộc
- **Architecture 1.0**: inter-service communication qua message broker (Kafka/RabbitMQ) — bắt buộc
- Security 2.1: ≥ 7/10 Pass (RT cookie, argon2id, rotation là bắt buộc)
- Concurrency 3.1: hold operation atomic + ít nhất 1 DB-level invariant (unique index hoặc row lock)
- Concurrency 3.1: candidate có giải thích locking strategy trong DECISIONS.md hoặc comment
- Ops 4.1: `/health/live`, `/health/ready`, SIGTERM handler — cả 3 phải có, per service
- Finance 5.1: webhook HMAC verify + stripe_event_id dedup
- Finance 5.2: seat released khi payment fail (compensation)
- DECISIONS.md tồn tại với ≥ 5 entries thực sự (không phải placeholder)

### Exceed Expectation
Meet Expectation + **candidate demonstrate judgment** — ít nhất 3 trong số sau:

**Judgment signals (không cần implement phức tạp — chỉ cần thể hiện hiểu vấn đề):**
- [ ] DECISIONS.md giải thích locking trade-off: "tôi chọn X vì Y, limitation là Z"
- [ ] TODO(prod) tại mọi điểm scale boundary (rate limit, sweeper, SSE, tokenVersion)
- [ ] Sweeper có batch limit + ghi chú replica-safety (SKIP LOCKED hoặc advisory lock)
- [ ] Reuse detection với family tracking (stolen RT revokes all sessions)
- [ ] Separate refresh secret (`JWT_REFRESH_SECRET`) tách biệt với access secret
- [ ] SSE endpoint skeleton tồn tại (dù chỉ in-process) + TODO(prod) Redis pub/sub
- [ ] Webhook ack-fast pattern: verify HMAC → store inbox → 200 ngay, process async
- [ ] Outbox / compensation pattern cho payment failure documented hoặc implemented
- [ ] `Retry-After` header trên mọi 409/429 — client-friendly backoff
- [ ] Timing equalization cho login (dummy hash khi email không tồn tại)

### Auto-Fail (bất kể điểm khác)
- ❌ **Phải là microservices** — auth, seat-reservation, payment mỗi cái là 1 service riêng, Dockerfile riêng, port riêng. Monolith (1 process cho tất cả) = fail bất kể code quality
- ❌ **Phải có message broker** (Kafka hoặc RabbitMQ) — inter-service events async. HTTP sync giữa services hoặc in-process call = fail
- ❌ Refresh token trong JSON body / localStorage
- ❌ SHA-256 / MD5 / bcrypt password hashing (phải là argon2id)
- ❌ `JWT_SECRET || 'default'` fallback (hoặc bất kỳ hardcoded secret default nào)
- ❌ Webhook không verify HMAC
- ❌ `CORS origin: '*'` với credentials
- ❌ E2E flow không chạy được
- ❌ Không có DECISIONS.md

---

## Quick Scan (5 phút đầu)

Dùng để detect Auto-Fail và check judgment signals nhanh. **Đọc DECISIONS.md trước** — nếu file rỗng hoặc không có, stop và note.

```bash
# 0. Auto-fail: Monolith check
ls apps/ 2>/dev/null || echo "NO apps/ FOLDER — likely monolith"
ls apps/
# Expect: ≥3 separate service folders (auth, seat-reservation/seat, payment)
# Fail: chỉ có 1 folder hoặc không có apps/

# 0b. Auto-fail: Message broker
grep -r "kafka\|rabbitmq\|amqp\|bull\|BullMQ" --include="*.ts" --include="*.json" -l | head -5
# Expect: có — nếu không có thì inter-service communication missing

# 1. Auto-fail: RT trong body
grep -r "refreshToken" --include="*.ts" | grep -v "httpOnly\|cookie\|hash\|verify\|rotate\|revoke" | head -5
# Expect: không có hit nào chứa "body" hoặc "res.json"

# 2. Auto-fail: password hashing
grep -r "bcrypt\|sha256\|md5\|SHA" --include="*.ts" | grep -i "password\|hash" | head -5
# Expect: không có — phải dùng argon2

# 3. Auto-fail: JWT_SECRET fallback
grep -rE "JWT_SECRET.{0,10}(\|\||default|??|fallback)" --include="*.ts" --include="*.js" --include="*.env*" | head -5
# Expect: không có

# 4. Concurrency: có DB-level invariant không
grep -r "FOR UPDATE\|SERIALIZABLE\|unique.*where\|WHERE status" --include="*.ts" --include="*.sql" -i | head -10
# Expect: ít nhất 1 — nếu không có thì concurrency approach là application-only (fail)

# 5. Concurrency: DECISIONS.md có giải thích locking không
grep -i "lock\|serial\|optimistic\|pessimistic\|concurrent" DECISIONS.md 2>/dev/null | head -5
# Expect: có — nếu không có thì candidate không nghĩ đến concurrency

# 6. Webhook HMAC
grep -r "timingSafeEqual\|constructEvent\|createHmac" --include="*.ts" | head -5
# Expect: có

# 7. httpOnly cookie
grep -r "httpOnly" --include="*.ts" | head -5
# Expect: có trong auth cookie set

# 8. Health + SIGTERM
grep -r "health\|live\|ready" --include="*.ts" | grep -i "route\|get\|handler" | head -5
grep -r "SIGTERM\|enableShutdownHooks\|OnApplicationShutdown" --include="*.ts" | head -5
# Expect: cả hai có

# 9. Seat release khi payment fail
grep -r "payment_failed\|paymentFailed\|payment_intent.payment_failed" --include="*.ts" | head -5
# Expect: có handler — nếu không có thì seat không được release (compensation missing)

# 10. TODO(prod) density — judgment signal
grep -r "TODO(prod)\|TODO(scale)\|TODO(prod):" --include="*.ts" | wc -l
# Expect: ≥ 3 — candidate có production awareness. 0 = red flag
```
