import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { Inject } from '@nestjs/common';
import { PG_POOL } from '../config/db.module.js';
import { hashPassword } from './password.js';

export const RegisterDto = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
});
export type RegisterDto = z.infer<typeof RegisterDto>;

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  token_version: number;
  created_at: Date;
}

@Injectable()
export class UsersRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findByEmail(email: string): Promise<UserRow | null> {
    const { rows } = await this.pool.query<UserRow>(
      'SELECT id, email, password_hash, token_version, created_at FROM users WHERE email = $1',
      [email.toLowerCase()],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<UserRow | null> {
    const { rows } = await this.pool.query<UserRow>(
      'SELECT id, email, password_hash, token_version, created_at FROM users WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  async create(email: string, password: string): Promise<UserRow> {
    const hash = await hashPassword(password);
    const { rows } = await this.pool.query<UserRow>(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       RETURNING id, email, password_hash, token_version, created_at`,
      [email.toLowerCase(), hash],
    );
    return rows[0];
  }

  /** Bump token_version → all outstanding ATs become stale (Checklist §2.1.7/§2.1.8). */
  async bumpTokenVersion(id: string): Promise<void> {
    await this.pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [id]);
  }
}
