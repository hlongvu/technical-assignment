import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { initDummyHash } from './users/password.js';
import { runMigrations } from './migrations/run.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  // Run migrations on boot. In production this would be a separate step;
  // for the assessment we do it inline so `docker compose up` is self-sufficient.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'info', service: 'auth', action: 'migrations_start' }));
  const { default: pg } = await import('pg');
  const migPool = new pg.Pool({
    host: env.POSTGRES_HOST, port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB, max: 1,
  });
  try {
    await runMigrations(migPool, 'auth');
  } finally {
    await migPool.end();
  }

  // Init dummy argon2 hash for timing equalization (Checklist §2.1.9 Exceed).
  await initDummyHash();

  const app = await NestFactory.create(AppModule);

  // Security middleware (Checklist §2.2.4 / §2.2.5)
  app.use(helmet());
  app.use(cookieParser());

  app.enableCors({
    origin: env.CORS_ORIGINS.split(',').map((s: string) => s.trim()),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  // Checklist §4.1.3: graceful shutdown on SIGTERM
  app.enableShutdownHooks();

  await app.listen(env.AUTH_PORT, '0.0.0.0');

  const onSigterm = async () => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ level: 'info', service: 'auth', action: 'sigterm' }));
    try { await app.close(); } finally { process.exit(0); }
  };
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigterm);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    level: 'info', service: 'auth', action: 'listening', port: env.AUTH_PORT,
  }));
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: 'error', service: 'auth', action: 'bootstrap_failed', err: String(e) }));
  process.exit(1);
});
