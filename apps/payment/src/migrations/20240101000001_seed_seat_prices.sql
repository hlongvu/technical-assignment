-- 20240101000001_seed_seat_prices.sql
-- Seed the 3 known seat prices into the payment-service DB. DECISIONS.md #9.
-- For dynamic pricing, TODO(prod): consume seat.held / seat.price_changed events.

INSERT INTO seat_prices (seat_id, price_cents, currency, label) VALUES
  ('00000000-0000-0000-0000-000000000001', 1900, 'USD', 'A1'),
  ('00000000-0000-0000-0000-000000000002', 2900, 'USD', 'A2'),
  ('00000000-0000-0000-0000-000000000003', 3900, 'USD', 'A3')
ON CONFLICT (seat_id) DO NOTHING;
