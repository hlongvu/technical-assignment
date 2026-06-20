import argon2 from 'argon2';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Argon2id password hashing. Checklist §2.1.9.
 * Params from env (ARGON2_MEMORY_KIB / TIME_COST / PARALLELISM).
 *
 * Timing equalization for login on non-existent users: we precompute a real
 * argon2 hash at module load and run a dummy verify against it when the user
 * is not found, so an attacker can't distinguish "no such email" from
 * "wrong password" by response timing. Checklist §2.1.9 Exceed.
 */
let dummyHash: string;

export async function initDummyHash(): Promise<void> {
  dummyHash = await argon2.hash('dummy-password-for-timing-equalization', {
    type: argon2.argon2id,
    memoryCost: Number(process.env.ARGON2_MEMORY_KIB ?? 65536),
    timeCost: Number(process.env.ARGON2_TIME_COST ?? 3),
    parallelism: Number(process.env.ARGON2_PARALLELISM ?? 1),
  });
}

export interface Argon2Params {
  type: typeof argon2.argon2id;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

export function argon2Params(): Argon2Params {
  return {
    type: argon2.argon2id,
    memoryCost: Number(process.env.ARGON2_MEMORY_KIB ?? 65536),
    timeCost: Number(process.env.ARGON2_TIME_COST ?? 3),
    parallelism: Number(process.env.ARGON2_PARALLELISM ?? 1),
  };
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, argon2Params());
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/** Timing equalization: run a real verify against a dummy hash for non-existent users. */
export async function verifyDummyPassword(): Promise<boolean> {
  if (!dummyHash) await initDummyHash();
  await argon2.verify(dummyHash, 'does-not-matter');
  return false;
}

/** SHA-256 of the raw refresh token; we store only the hash (Checklist §2.1.3). */
export function hashRefreshToken(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}

/** Constant-time compare of two SHA-256 hashes (Checklist §2.1.3 Exceed). */
export function safeEqualHash(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
