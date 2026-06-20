/**
 * AuthController test — exercises REAL controller with real repositories.
 * Checklist §1.3.2 (integration tests for critical flows).
 *
 * Tests the login → refresh → logout flow end-to-end at the controller level
 * (no HTTP server, but real Postgres + real argon2 hashing).
 *
 * Prereq: docker compose up (auth_db on 5432, redis on 6379).
 */
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-at-least-32-chars';
process.env.CORS_ORIGINS = 'http://localhost';
process.env.POSTGRES_HOST = 'localhost';
process.env.POSTGRES_PORT = '5432';
process.env.POSTGRES_USER = 'seatapp';
process.env.POSTGRES_PASSWORD = 'seatapp_dev_pw';
process.env.POSTGRES_DB = 'auth_db';
process.env.RABBITMQ_URL = 'amqp://seatapp:seatapp_dev_pw@localhost:5672';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.RT_GRACE_SECONDS = '1';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const DSN = 'postgres://seatapp:seatapp_dev_pw@localhost:5432/auth_db';

let pool: pg.Pool;
let controller: any;
let cookieStore: Record<string, string> = {};

before(async () => {
  pool = new pg.Pool({ connectionString: DSN });
  const { runMigrations } = await import('../src/migrations/run.ts');
  await runMigrations(pool, 'auth-test');
  await (await import('../src/users/password.ts')).initDummyHash();

  const { UsersRepository } = await import('../src/users/users.repository.ts');
  const { SessionsRepository } = await import('../src/sessions/sessions.repository.ts');
  const { JwtService } = await import('../src/auth/jwt.service.ts');
  const { AuditService } = await import('../src/audit/audit.module.ts');
  const { AuthController } = await import('../src/auth/auth.controller.ts');

  const users = new UsersRepository(pool);
  const sessions = new SessionsRepository(pool);
  const jwt = new JwtService();
  const audit = new AuditService(pool);

  // Minimal logger stub.
  const loggerService = {
    create: () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: function () { return this; },
    }),
  };

  controller = new AuthController(users, sessions, jwt, audit, loggerService as any);
});

after(async () => {
  if (pool) await pool.end();
});

function makeReq(body: unknown, headers: Record<string, string> = {}): any {
  return {
    body,
    headers: { 'x-request-id': randomUUID(), ...headers },
    ip: '127.0.0.1',
    cookies: { ...cookieStore },
  };
}

function makeRes(): any {
  const res: any = {
    cookies: {} as Record<string, string>,
    headers: {} as Record<string, string>,
    statusCode: 200,
    cookie(name: string, val: string, _opts: unknown) { res.cookies[name] = val; },
    clearCookie(name: string, _opts: unknown) { delete res.cookies[name]; delete cookieStore[name]; },
    setHeader(name: string, val: string) { res.headers[name] = val; },
    status(code: number) { res.statusCode = code; return res; },
    json(val: unknown) { res.body = val; return res; },
  };
  return res;
}

test('register → login → refresh → logout flow', async () => {
  const email = `flow-${randomUUID()}@example.com`;
  const password = 'test-password-123';

  // 1. Register
  const regReq = makeReq({ email, password });
  const regResult = await controller.register(regReq.body, regReq);
  assert.ok(regResult.userId, 'register should return userId');

  // 2. Login
  const loginReq = makeReq({ email, password });
  const loginRes = makeRes();
  const loginResult = await controller.login(loginReq.body, loginReq, loginRes);
  assert.ok(loginResult.accessToken, 'login should return accessToken');
  assert.ok(loginResult.userId, 'login should return userId');
  assert.ok(loginRes.cookies.rt, 'login should set rt cookie');

  // Store cookie for subsequent requests.
  cookieStore.rt = loginRes.cookies.rt;

  // 3. Refresh — should rotate
  const refreshReq = makeReq({});
  const refreshRes = makeRes();
  const refreshResult = await controller.refresh(refreshReq, refreshRes);
  assert.ok(refreshResult.accessToken, 'refresh should return new accessToken');
  assert.ok(refreshRes.cookies.rt, 'refresh should set new rt cookie');
  cookieStore.rt = refreshRes.cookies.rt;

  // 4. Logout
  const logoutReq = makeReq({});
  const logoutRes = makeRes();
  await controller.logout(logoutReq, logoutRes);
  // Cookie should be cleared.
  assert.ok(!logoutRes.cookies.rt, 'logout should clear rt cookie');
  cookieStore = {};

  // Cleanup
  await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [regResult.userId]);
  await pool.query('DELETE FROM users WHERE id = $1', [regResult.userId]);
});

test('login with wrong password → UnauthorizedException', async () => {
  const email = `wrong-${randomUUID()}@example.com`;
  const password = 'test-password-123';
  await controller.register(makeReq({ email, password }), makeReq());

  await assert.rejects(
    async () => {
      const res = makeRes();
      await controller.login(makeReq({ email, password: 'WRONG' }), makeReq(), res);
    },
    (e: any) => e.message === 'invalid_credentials',
    'should throw UnauthorizedException',
  );

  await pool.query('DELETE FROM users WHERE email = $1', [email]);
});

test('login with non-existent user → UnauthorizedException (after dummy hash)', async () => {
  const start = Date.now();
  await assert.rejects(
    async () => {
      const res = makeRes();
      await controller.login(
        makeReq({ email: `nonexistent-${randomUUID()}@example.com`, password: 'whatever' }),
        makeReq(),
        res,
      );
    },
    (e: any) => e.message === 'invalid_credentials',
    'should throw for non-existent user',
  );
  const elapsed = Date.now() - start;
  // Timing equalization: should have taken real time (argon2 dummy verify).
  assert.ok(elapsed >= 1, 'login for non-existent user should take real time');
});
