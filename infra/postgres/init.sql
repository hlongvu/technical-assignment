-- Run once at Postgres init to create the 3 per-service databases.
-- Each service connects only to its own DB; no cross-service FKs (DECISIONS.md #1).
CREATE DATABASE auth_db;
CREATE DATABASE seat_db;
CREATE DATABASE payment_db;
