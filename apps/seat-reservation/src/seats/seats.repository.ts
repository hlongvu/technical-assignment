import { Injectable, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../config/db.module.js';

export interface SeatRow {
  id: string;
  label: string;
  price_cents: number;
  currency: string;
  status: 'AVAILABLE' | 'HELD' | 'RESERVED';
  held_by_user_id?: string | null;
  held_until?: Date | null;
}

@Injectable()
export class SeatsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async listAll(): Promise<SeatRow[]> {
    const { rows } = await this.pool.query<SeatRow>(
      `SELECT s.id, s.label, s.price_cents, s.currency, s.status,
              h.user_id AS held_by_user_id, h.held_until
       FROM seats s
       LEFT JOIN holds h ON h.seat_id = s.id AND h.status = 'HELD'
       ORDER BY s.label`,
    );
    return rows;
  }

  async getPrice(seatId: string): Promise<{ price_cents: number; currency: string } | null> {
    const { rows } = await this.pool.query<{ price_cents: number; currency: string }>(
      'SELECT price_cents, currency FROM seats WHERE id = $1',
      [seatId],
    );
    return rows[0] ?? null;
  }
}
