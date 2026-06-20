import { Injectable, Module } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../config/db.module.js';

export type AuditAction =
  | 'login'
  | 'logout'
  | 'logout_all'
  | 'refresh'
  | 'session_revoke'
  | 'register';

export interface AuditMeta {
  traceId?: string;
  ip?: string;
  reason?: string;
  [k: string]: unknown;
}

@Injectable()
export class AuditService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Append-only audit log. Checklist §2.2.8. */
  async record(userId: string | null, action: AuditAction, meta: AuditMeta = {}): Promise<void> {
    await this.pool.query(
      'INSERT INTO audit_log (user_id, action, meta) VALUES ($1, $2, $3)',
      [userId, action, JSON.stringify(meta)],
    );
  }
}

@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
