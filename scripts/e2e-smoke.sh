#!/usr/bin/env bash
# E2E smoke test: login → hold → checkout → mock webhook → seat RESERVED.
# Run AFTER `docker compose up --build`.
# Checklist §1.1.9 — auto-fail if broken.
#
# Usage:
#   export JWT_SECRET="..." PSP_WEBHOOK_SECRET="..."   # match .env
#   ./scripts/e2e-smoke.sh
set -euo pipefail

BASE="${BASE_URL:-http://localhost:8080}"
EMAIL="${SMOKE_EMAIL:-smoke-$(date +%s)@example.com}"
PASSWORD="${SMOKE_PASSWORD:-password123}"
SEAT_ID="${SEAT_ID:-00000000-0000-0000-0000-000000000001}"
PSP_WEBHOOK_SECRET="${PSP_WEBHOOK_SECRET:?need PSP_WEBHOOK_SECRET from .env}"

echo "→ register $EMAIL"
curl -sS -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null

echo "→ login"
LOGIN=$(curl -sS -c /tmp/smoke_cookies -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
AT=$(echo "$LOGIN" | python3 -c 'import sys,json; print(json.load(sys.stdin)["accessToken"])')
if [ -z "$AT" ]; then echo "FAIL: no accessToken in login response: $LOGIN"; exit 1; fi
echo "  access token: ${AT:0:32}..."

echo "→ hold seat $SEAT_ID"
HOLD=$(curl -sS -b /tmp/smoke_cookies -X POST "$BASE/api/seats/$SEAT_ID/hold" \
  -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d '{}')
HOLD_ID=$(echo "$HOLD" | python3 -c 'import sys,json; print(json.load(sys.stdin)["holdId"])')
PRICE_CENTS=$(echo "$HOLD" | python3 -c 'import sys,json; print(json.load(sys.stdin)["priceCents"])')
echo "  hold: $HOLD_ID  price: $PRICE_CENTS"

echo "→ checkout"
IDEMPOTENCY_KEY=$(python3 -c 'import uuid; print(uuid.uuid4())')
CHECKOUT=$(curl -sS -b /tmp/smoke_cookies -X POST "$BASE/api/payment/checkout" \
  -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' \
  -d "{\"seatId\":\"$SEAT_ID\",\"holdId\":\"$HOLD_ID\",\"idempotencyKey\":\"$IDEMPOTENCY_KEY\"}")
INTENT_ID=$(echo "$CHECKOUT" | python3 -c 'import sys,json; print(json.load(sys.stdin)["intentId"])')
CLIENT_SECRET=$(echo "$CHECKOUT" | python3 -c 'import sys,json; print(json.load(sys.stdin)["clientSecret"])')
PSP_INTENT_ID="${CLIENT_SECRET%%_secret_*}"
echo "  intent: $INTENT_ID  pspIntentId: $PSP_INTENT_ID"

echo "→ deliver mock webhook (HMAC-signed)"
EVENT_ID="evt_$(date +%s%N)"
CREATED=$(date +%s)
PAYLOAD="{\"id\":\"$EVENT_ID\",\"type\":\"payment_intent.succeeded\",\"created\":$CREATED,\"data\":{\"object\":{\"id\":\"$PSP_INTENT_ID\",\"amount\":$PRICE_CENTS,\"metadata\":{\"seatId\":\"$SEAT_ID\",\"holdId\":\"$HOLD_ID\"}}}}"
SIG_T="$CREATED"
SIG_V1=$(printf '%s.%s' "$SIG_T" "$PAYLOAD" | openssl dgst -sha256 -hmac "$PSP_WEBHOOK_SECRET" -hex | awk '{print $NF}')
SIGNATURE="t=$SIG_T,v1=$SIG_V1"
WH=$(curl -sS -X POST "$BASE/api/payment/webhook" \
  -H "stripe-signature: $SIGNATURE" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD")
echo "  webhook response: $WH"

echo "→ wait for async processing + RabbitMQ delivery"
for i in $(seq 1 30); do
  sleep 1
  SEAT=$(curl -sS "$BASE/api/seats/" | python3 -c "
import sys, json
seats = json.load(sys.stdin)['seats']
seat = next(s for s in seats if s['id'] == '$SEAT_ID')
print(seat['status'])
")
  echo "  attempt $i: seat status = $SEAT"
  if [ "$SEAT" = "RESERVED" ]; then echo "PASS: seat reserved"; exit 0; fi
done
echo "FAIL: seat did not become RESERVED within 30s"
exit 1
