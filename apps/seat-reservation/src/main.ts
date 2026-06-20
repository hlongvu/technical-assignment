import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { runMigrations } from './migrations/run.js';
import { PaymentEventsConsumer } from './events/payment-events.consumer.js';
import { OutboxWorker } from './outbox/outbox.worker.js';
import { HoldSweeper } from './holds/hold-sweeper.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  // Run migrations on boot.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'info', service: 'seat-reservation', action: 'migrations_start' }));
  const { default: pg } = await import('pg');
  const migPool = new pg.Pool({
    host: env.POSTGRES_HOST, port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB, max: 1,
  });
  try {
    await runMigrations(migPool, 'seat-reservation');
  } finally {
    await migPool.end();
  }

  const app = await NestFactory.create(AppModule);

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: env.CORS_ORIGINS.split(',').map((s: string) => s.trim()),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
    methods: ['GET', 'POST'],
  });

  app.enableShutdownHooks();

  // Start background workers (sweeper, outbox publisher, event consumer).
  const sweeper = app.get(HoldSweeper);
  const outbox = app.get(OutboxWorker);
  const consumer = app.get(PaymentEventsConsumer);
  sweeper.start();
  outbox.start();
  await consumer.start();

  await app.listen(env.SEAT_PORT, '0.0.0.0');

  const onSigterm = async () => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ level: 'info', service: 'seat-reservation', action: 'sigterm' }));
    try { await app.close(); } finally { process.exit(0); }
  };
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigterm);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    level: 'info', service: 'seat-reservation', action: 'listening', port: env.SEAT_PORT,
  }));
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: 'error', service: 'seat-reservation', action: 'bootstrap_failed', err: String(e) }));
  process.exit(1);
});
