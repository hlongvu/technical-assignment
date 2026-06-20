import { NestFactory, Reflector } from '@nestjs/core';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { runMigrations } from './migrations/run.js';
import { OutboxWorker } from './outbox/outbox.worker.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'info', service: 'payment', action: 'migrations_start' }));
  const { default: pg } = await import('pg');
  const migPool = new pg.Pool({
    host: env.POSTGRES_HOST, port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB, max: 1,
  });
  try {
    await runMigrations(migPool, 'payment');
  } finally {
    await migPool.end();
  }

  const app = await NestFactory.create(AppModule, {
    // We need the raw body for webhook HMAC verification (§5.1.2).
    // Register a verify hook that exposes req.rawBody while still parsing JSON
    // for other routes.
    bodyParser: true,
  });
  const reflector = app.get(Reflector);

  // Override body parser to keep rawBody around for HMAC.
  // We re-register express.json with a verify hook.
  const express = await import('express');
  app.use(express.json({
    verify: (req: unknown, _res: unknown, buf: Buffer) => {
      // Attach rawBody so the webhook handler can compute HMAC over it.
      (req as { rawBody?: Buffer }).rawBody = buf;
    },
  }));
  void reflector;

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: env.CORS_ORIGINS.split(',').map((s: string) => s.trim()),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id', 'stripe-signature'],
    methods: ['GET', 'POST'],
  });

  app.enableShutdownHooks();

  const outbox = app.get(OutboxWorker);
  outbox.start();

  await app.listen(env.PAYMENT_PORT, '0.0.0.0');

  const onSigterm = async () => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ level: 'info', service: 'payment', action: 'sigterm' }));
    try { await app.close(); } finally { process.exit(0); }
  };
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigterm);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    level: 'info', service: 'payment', action: 'listening', port: env.PAYMENT_PORT,
  }));
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: 'error', service: 'payment', action: 'bootstrap_failed', err: String(e) }));
  process.exit(1);
});
