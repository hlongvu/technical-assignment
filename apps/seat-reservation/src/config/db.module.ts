import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { loadEnv } from '../config/env.js';

export const PG_POOL = Symbol('PG_POOL');

/**
 * Postgres pool. `max` explicit from env (Checklist §1.2.4).
 * Heuristic (cpu*2)+spindles. TODO(prod): PgBouncer transaction-pooling in front.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => {
        const env = loadEnv();
        return new pg.Pool({
          host: env.POSTGRES_HOST,
          port: env.POSTGRES_PORT,
          user: env.POSTGRES_USER,
          password: env.POSTGRES_PASSWORD,
          database: env.POSTGRES_DB,
          max: env.POSTGRES_POOL_MAX,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        });
      },
    },
  ],
  exports: [PG_POOL],
})
export class DbModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onModuleDestroy(): Promise<void> {
    // Checklist §4.1.4
    await this.pool.end();
  }
}
