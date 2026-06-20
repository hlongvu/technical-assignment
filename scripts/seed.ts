/**
 * Seed 3 seats into the seat_db and a demo user into the auth_db.
 * Run after `docker compose up` so the DBs exist:
 *   docker compose exec seat-reservation node /app/dist/scripts/seed.js
 *   (or locally with env pointing at compose-exposed ports 5432)
 */
import pg from 'pg';

const SEAT_DSN = process.env.SEAT_DB_DSN ?? 'postgres://seatapp:seatapp_dev_pw@localhost:5432/seat_db';
const AUTH_DSN = process.env.AUTH_DB_DSN ?? 'postgres://seatapp:seatapp_dev_pw@localhost:5432/auth_db';

async function main() {
  // Seats
  const seatPool = new pg.Pool({ connectionString: SEAT_DSN });
  try {
    await seatPool.query(`
      INSERT INTO seats (id, label, price_cents, currency, status) VALUES
        ('00000000-0000-0000-0000-000000000001', 'A1', 1900, 'USD', 'AVAILABLE'),
        ('00000000-0000-0000-0000-000000000002', 'A2', 2900, 'USD', 'AVAILABLE'),
        ('00000000-0000-0000-0000-000000000003', 'A3', 3900, 'USD', 'AVAILABLE')
      ON CONFLICT (id) DO NOTHING
    `);
    console.log('seeded 3 seats');
  } finally {
    await seatPool.end();
  }

  // Demo user (password: "password123" — argon2id precomputed at runtime via register endpoint
  // is preferred. For a quick seed we register via the API instead.)
  if (process.env.SEED_DEMO_USER === '1') {
    const res = await fetch('http://localhost:8080/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@example.com', password: 'password123' }),
    });
    if (res.ok) console.log('registered demo@example.com / password123');
    else if (res.status === 400) console.log('demo user already exists');
    else console.log('register failed:', res.status, await res.text());
  } else {
    console.log('skipping demo user seed (set SEED_DEMO_USER=1 to register via API)');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
