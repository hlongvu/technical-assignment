#!/usr/bin/env bash
# =============================================================================
# Production-Readiness Integration Test
# =============================================================================
# Verifies the entire stack is ready for production deployment.
# Run AFTER `docker compose up --build`.
#
# Usage:
#   export PSP_WEBHOOK_SECRET="$(grep PSP_WEBHOOK_SECRET .env | cut -d= -f2)"
#   ./scripts/verify-production.sh
#
# Tests:
#   1. Health endpoints (live + ready) — all 3 services
#   2. Register → Login flow
#   3. Refresh token rotation
#   4. Logout + session invalidation
#   5. Seat listing via gateway
#   6. SSE streaming endpoint
#   7. Concurrent hold → exactly 1 wins
#   8. User-hold limit (1 hold per user)
#   9. Checkout + server-controlled amount
#  10. Webhook HMAC verification (good + bad sig)
#  11. Webhook idempotency (duplicate = no-op)
#  12. Full E2E flow → seat RESERVED
#  13. Rate limiting (429 on brute force)
#  14. Metrics endpoints (business counters)
#  15. Refresh token reuse detection (theft)
# =============================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0

BASE="${BASE_URL:-http://localhost:8080}"
AUTH="http://localhost:4001"
SEAT="http://localhost:4002"
PAY="http://localhost:4003"

EMAIL="verify-$(date +%s)@example.com"
PASSWORD="verify-password-123"
SEAT_ID="${SEAT_ID:-00000000-0000-0000-0000-000000000001}"

psp_secret="${PSP_WEBHOOK_SECRET:?need PSP_WEBHOOK_SECRET from env}"

pass() { echo -e "${GREEN}PASS${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}FAIL${NC} $1"; FAIL=$((FAIL+1)); }
warn() { echo -e "${YELLOW}WARN${NC} $1"; WARN=$((WARN+1)); }
info() { echo -e "  → $1"; }

assert_eq() {
  local label=$1 expected=$2 actual=$3
  if [ "$actual" != "$expected" ]; then
    fail "$label — expected '$expected', got '$actual'"
  else
    pass "$label"
  fi
}

assert_ge() {
  local label=$1 expected=$2 actual=$3
  if [ "$actual" -ge "$expected" ]; then
    pass "$label"
  else
    fail "$label — expected ≥ $expected, got $actual"
  fi
}

assert_contains() {
  local label=$1 haystack=$2 needle=$3
  if echo "$haystack" | grep -q "$needle"; then
    pass "$label"
  else
    fail "$label — response did not contain '$needle'"
  fi
}

assert_http() {
  local label=$1 expected=$2 actual=$3
  if [ "$actual" = "$expected" ]; then
    pass "$label"
  else
    fail "$label — expected HTTP $expected, got $actual"
  fi
}

echo ""
echo "============================================"
echo " Production-Readiness Integration Test"
echo "============================================"
echo " Base URL:  $BASE"
echo " Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "============================================"
echo ""

# ── 1. HEALTH ENDPOINTS ──────────────────────────────────────────
echo "── 1. HEALTH ENDPOINTS ──"

for pair in "auth|$AUTH" "seat-reservation|$SEAT" "payment|$PAY"; do
  name="${pair%%|*}" url="${pair##*|}"
  live=$(curl -sS -o /dev/null -w "%{http_code}" "$url/health/live" || echo "ERR")
  assert_http "$name /health/live" "200" "$live"

  ready_status=$(curl -sS -o /dev/null -w "%{http_code}" "$url/health/ready" || echo "ERR")
  ready_body=$(curl -sS "$url/health/ready" 2>/dev/null || echo "{}")
  assert_http "$name /health/ready" "200" "$ready_status"
  assert_contains "$name /health/ready has 'status'" "$ready_body" '"status"'
done

echo ""

# ── 2. REGISTER + LOGIN ──────────────────────────────────────────
echo "── 2. AUTH: REGISTER + LOGIN ──"

REG=$(curl -sS -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
USER_ID=$(echo "$REG" | python3 -c 'import sys,json; print(json.load(sys.stdin)["userId"])' 2>/dev/null || echo "")
if [ -n "$USER_ID" ]; then pass "register returns userId"; else fail "register failed: $REG"; fi

LOGIN=$(curl -sS -c /tmp/verify_cookies -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
AT=$(echo "$LOGIN" | python3 -c 'import sys,json; print(json.load(sys.stdin)["accessToken"])' 2>/dev/null || echo "")
RT_COOKIE=$(grep rt /tmp/verify_cookies 2>/dev/null | awk '{print $NF}' || echo "")
if [ -n "$AT" ]; then pass "login returns accessToken"; else fail "login failed: $LOGIN"; fi
if [ -n "$RT_COOKIE" ]; then pass "login sets httpOnly rt cookie"; else fail "login missing rt cookie"; fi

echo ""

# ── 3. REFRESH TOKEN ROTATION ────────────────────────────────────
echo "── 3. AUTH: REFRESH ROTATION ──"

REFRESH=$(curl -sS -b /tmp/verify_cookies -c /tmp/verify_cookies2 -X POST "$BASE/api/auth/refresh" \
  -H 'Content-Type: application/json')
REFRESH_AT=$(echo "$REFRESH" | python3 -c 'import sys,json; print(json.load(sys.stdin)["accessToken"])' 2>/dev/null || echo "")
NEW_RT=$(grep rt /tmp/verify_cookies2 2>/dev/null | awk '{print $NF}' || echo "")
if [ -n "$REFRESH_AT" ]; then pass "refresh returns new accessToken"; else fail "refresh failed: $REFRESH"; fi
if [ -n "$NEW_RT" ] && [ "$NEW_RT" != "$RT_COOKIE" ]; then
  pass "refresh rotates rt cookie"
else
  fail "refresh did not rotate rt cookie"
fi

info "reusing old (now-revoked) rt within grace → should still work"
OLD_RT_REFRESH=$(curl -sS -b /tmp/verify_cookies -X POST "$BASE/api/auth/refresh" \
  -H 'Content-Type: application/json' 2>/dev/null || echo "{}")
OLD_RT_OK=$(echo "$OLD_RT_REFRESH" | python3 -c 'import sys,json; print("accessToken" in json.load(sys.stdin))' 2>/dev/null || echo "False")
if [ "$OLD_RT_OK" = "True" ]; then
  warn "grace window accepted old RT (expected — 10s grace)"
else
  warn "grace window rejected old RT (might have expired — check RT_GRACE_SECONDS)"
fi

cp /tmp/verify_cookies2 /tmp/verify_cookies  # use new cookies going forward
AT="$REFRESH_AT"

echo ""

# ── 4. LOGOUT ────────────────────────────────────────────────────
echo "── 4. AUTH: LOGOUT ──"

LOGOUT_CODE=$(curl -sS -o /dev/null -w "%{http_code}" -b /tmp/verify_cookies -X POST "$BASE/api/auth/logout")
assert_http "logout returns 204" "204" "$LOGOUT_CODE"

info "verify refresh after logout fails"
POST_LOGOUT=$(curl -sS -o /dev/null -w "%{http_code}" -b /tmp/verify_cookies -X POST "$BASE/api/auth/refresh")
if [ "$POST_LOGOUT" = "401" ]; then pass "refresh after logout → 401"; else fail "refresh after logout should be 401, got $POST_LOGOUT"; fi

# Re-login for remaining tests
LOGIN2=$(curl -sS -c /tmp/verify_cookies -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
AT=$(echo "$LOGIN2" | python3 -c 'import sys,json; print(json.load(sys.stdin)["accessToken"])' 2>/dev/null || echo "")

echo ""

# ── 5. SEAT LISTING ──────────────────────────────────────────────
echo "── 5. SEATS: LIST ──"

SEATS=$(curl -sS "$BASE/api/seats/" 2>/dev/null || echo '{"seats":[]}')
SEAT_COUNT=$(echo "$SEATS" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["seats"]))' 2>/dev/null || echo "0")
assert_ge "seat list returns ≥ 1 seats" 1 "$SEAT_COUNT"

echo ""

# ── 6. SSE STREAMING ─────────────────────────────────────────────
echo "── 6. SEATS: SSE STREAM ──"

SSE_OUT=$(mktemp)
curl -sS --max-time 3 "$BASE/api/seats/stream" > "$SSE_OUT" 2>/dev/null || true
if grep -q "event:\|data:" "$SSE_OUT" 2>/dev/null || grep -q "hello\|ping" "$SSE_OUT" 2>/dev/null; then
  pass "SSE endpoint streams events"
else
  info "SSE content: $(head -5 "$SSE_OUT")"
  warn "SSE stream may need proxy_buffering off (check nginx config)"
fi
rm -f "$SSE_OUT"

echo ""

# ── 7. CONCURRENT HOLD ───────────────────────────────────────────
echo "── 7. SEATS: CONCURRENT HOLD (2 users, 1 seat, 1 wins) ──"

# Create second user (can't hold 2 seats with same user)
EMAIL2="verify2-$(date +%s)@example.com"
curl -sS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL2\",\"password\":\"$PASSWORD\"}" > /dev/null
LOGIN2_DATA=$(curl -sS -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL2\",\"password\":\"$PASSWORD\"}")
AT2=$(echo "$LOGIN2_DATA" | python3 -c 'import sys,json; print(json.load(sys.stdin)["accessToken"])' 2>/dev/null || echo "")

# Release any existing holds on seat 1 first
curl -sS -X POST "$BASE/api/seats/$SEAT_ID/release" -H "Authorization: Bearer $AT" > /dev/null 2>&1 || true
curl -sS -X POST "$BASE/api/seats/$SEAT_ID/release" -H "Authorization: Bearer $AT2" > /dev/null 2>&1 || true
sleep 1

# Concurrent hold
HOLD1=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$BASE/api/seats/$SEAT_ID/hold" \
  -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d '{}' &)
HOLD2=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$BASE/api/seats/$SEAT_ID/hold" \
  -H "Authorization: Bearer $AT2" -H 'Content-Type: application/json' -d '{}' &)
wait

HOLD1_CODE="${HOLD1:-ERR}"
HOLD2_CODE="${HOLD2:-ERR}"
info "hold responses: user1=$HOLD1_CODE user2=$HOLD2_CODE"

if [ "$HOLD1_CODE" = "200" ] && [ "$HOLD2_CODE" = "409" ]; then
  pass "concurrent hold: user1 wins (200), user2 gets conflict (409)"
elif [ "$HOLD2_CODE" = "200" ] && [ "$HOLD1_CODE" = "409" ]; then
  pass "concurrent hold: user2 wins (200), user1 gets conflict (409)"
else
  fail "concurrent hold unexpected: user1=$HOLD1_CODE user2=$HOLD2_CODE (expected 200+409)"
fi

# Verify exactly 1 HELD
SEATS_AFTER=$(curl -sS "$BASE/api/seats/" | python3 -c "
import sys, json
seats = json.load(sys.stdin)['seats']
held = [s for s in seats if s['status'] == 'HELD']
print(len(held))
" 2>/dev/null || echo "ERR")
assert_eq "exactly 1 HELD seat in DB" "1" "$SEATS_AFTER"

echo ""

# ── 8. USER-HOLD LIMIT ───────────────────────────────────────────
echo "── 8. SEATS: USER CANNOT HOLD 2 SEATS ──"

SEAT_ID2="00000000-0000-0000-0000-000000000002"
curl -sS -X POST "$BASE/api/seats/$SEAT_ID2/release" -H "Authorization: Bearer $AT" > /dev/null 2>&1 || true
sleep 1

USER2HOLD=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$BASE/api/seats/$SEAT_ID2/hold" \
  -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d '{}')
if [ "$USER2HOLD" = "409" ]; then
  pass "user_has_hold enforced (409 on second hold)"
else
  fail "user_has_hold not enforced: got $USER2HOLD (expected 409)"
fi

echo ""

# ── 9. CHECKOUT: SERVER-CONTROLLED AMOUNT ────────────────────────
echo "── 9. PAYMENT: CHECKOUT (server-controlled amount) ──"

# Release and re-hold with a fresh user for clean checkout
curl -sS -X POST "$BASE/api/seats/$SEAT_ID/release" -H "Authorization: Bearer $AT" > /dev/null 2>&1 || true
sleep 2

EMAIL3="verify3-$(date +%s)@example.com"
curl -sS -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL3\",\"password\":\"$PASSWORD\"}" > /dev/null
LOGIN3=$(curl -sS -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL3\",\"password\":\"$PASSWORD\"}")
AT3=$(echo "$LOGIN3" | python3 -c 'import sys,json; print(json.load(sys.stdin)["accessToken"])' 2>/dev/null || echo "")

HOLD_RESULT=$(curl -sS -X POST "$BASE/api/seats/$SEAT_ID/hold" \
  -H "Authorization: Bearer $AT3" -H 'Content-Type: application/json' -d '{}')
HOLD_ID=$(echo "$HOLD_RESULT" | python3 -c 'import sys,json; print(json.load(sys.stdin)["holdId"])' 2>/dev/null || echo "")
HOLD_PRICE=$(echo "$HOLD_RESULT" | python3 -c 'import sys,json; print(json.load(sys.stdin)["priceCents"])' 2>/dev/null || echo "0")

IdempotencyKey=$(python3 -c 'import uuid; print(uuid.uuid4())')

# Try sending amount in body — should be IGNORED
CO_RESULT=$(curl -sS -X POST "$BASE/api/payment/checkout" \
  -H "Authorization: Bearer $AT3" -H 'Content-Type: application/json' \
  -d "{\"seatId\":\"$SEAT_ID\",\"holdId\":\"$HOLD_ID\",\"idempotencyKey\":\"$IdempotencyKey\",\"amountCents\":999999}")
CO_AMOUNT=$(echo "$CO_RESULT" | python3 -c 'import sys,json; print(json.load(sys.stdin)["amountCents"])' 2>/dev/null || echo "ERR")
CO_INTENT=$(echo "$CO_RESULT" | python3 -c 'import sys,json; print(json.load(sys.stdin)["intentId"])' 2>/dev/null || echo "")
PSP_ID=$(echo "$CO_RESULT" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("clientSecret",""))' 2>/dev/null || echo "")

if [ -n "$CO_INTENT" ]; then pass "checkout creates payment intent"; else fail "checkout failed: $CO_RESULT"; fi
if [ "$CO_AMOUNT" != "ERR" ] && [ "$CO_AMOUNT" != "999999" ]; then
  pass "amount is server-controlled ($CO_AMOUNT != 999999)"
elif [ "$CO_AMOUNT" = "ERR" ]; then
  fail "could not read amount from checkout response"
else
  fail "client-sent amount was accepted ($CO_AMOUNT == 999999)"
fi

info "checkout idempotency: duplicate idempotencyKey → same intent"
CO2=$(curl -sS -X POST "$BASE/api/payment/checkout" \
  -H "Authorization: Bearer $AT3" -H 'Content-Type: application/json' \
  -d "{\"seatId\":\"$SEAT_ID\",\"holdId\":\"$HOLD_ID\",\"idempotencyKey\":\"$IdempotencyKey\"}")
CO2_INTENT=$(echo "$CO2" | python3 -c 'import sys,json; print(json.load(sys.stdin)["intentId"])' 2>/dev/null || echo "")
CO2_IDEMPOTENT=$(echo "$CO2" | python3 -c 'import sys,json; print(json.load(sys.stdin)["idempotent"])' 2>/dev/null || echo "False")
assert_eq "duplicate checkout returns same intentId" "$CO_INTENT" "$CO2_INTENT"
assert_eq "duplicate checkout marks idempotent=true" "True" "$CO2_IDEMPOTENT"

echo ""

# ── 10. WEBHOOK HMAC VERIFICATION ────────────────────────────────
echo "── 10. PAYMENT: WEBHOOK HMAC ──"

APP_ID="app_$(python3 -c 'import uuid; print(uuid.uuid4())')"
NOW=$(date +%s)
PAYLOAD="{\"id\":\"evt_test_${NOW}\",\"type\":\"payment_intent.succeeded\",\"created\":${NOW},\"data\":{\"object\":{\"id\":\"pi_mock_${IdempotencyKey}\",\"amount\":$(printf %.0f "$CO_AMOUNT"),\"metadata\":{}}}}"

SIGN_PAYLOAD="${NOW}.${PAYLOAD}"
HMAC=$(echo -n "$SIGN_PAYLOAD" | openssl dgst -sha256 -hmac "$psp_secret" | awk '{print $NF}')
SIGNATURE="t=${NOW},v1=${HMAC}"

WH=$(curl -sS -X POST "$BASE/api/payment/webhook" \
  -H "stripe-signature: $SIGNATURE" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD")
WH_RECEIVED=$(echo "$WH" | python3 -c 'import sys,json; print(json.load(sys.stdin)["received"])' 2>/dev/null || echo "False")
assert_eq "webhook HMAC verified" "True" "$WH_RECEIVED"

info "bad signature → 401"
BAD_WH=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$BASE/api/payment/webhook" \
  -H "stripe-signature: t=9999999999,v1=0000000000000000" \
  -H 'Content-Type: application/json' \
  -d '{"id":"bad","type":"x","created":1,"data":{"object":{"id":"x"}}}')
assert_http "bad webhook signature → 401" "401" "$BAD_WH"

echo ""

# ── 11. WEBHOOK IDEMPOTENCY ──────────────────────────────────────
echo "── 11. PAYMENT: WEBHOOK IDEMPOTENCY ──"

WH2=$(curl -sS -X POST "$BASE/api/payment/webhook" \
  -H "stripe-signature: $SIGNATURE" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD")
WH2_DEDUP=$(echo "$WH2" | python3 -c 'import sys,json; print(json.load(sys.stdin)["deduplicated"])' 2>/dev/null || echo "False")
assert_eq "duplicate webhook is deduplicated" "True" "$WH2_DEDUP"

echo ""

# ── 12. E2E FULL FLOW → RESERVED ─────────────────────────────────
echo "── 12. E2E: WAIT FOR ASYNC RESERVATION ──"

info "waiting for outbox → RabbitMQ → seat consumer..."
RESERVED="no"
for i in $(seq 1 30); do
  sleep 1
  STATUS=$(curl -sS "$BASE/api/seats/" 2>/dev/null | python3 -c "
import sys, json
seats = json.load(sys.stdin)['seats']
seat = next(s for s in seats if s['id'] == '$SEAT_ID')
print(seat['status'])
" 2>/dev/null || echo "ERR")
  if [ "$STATUS" = "RESERVED" ]; then RESERVED="yes"; info "reserved at attempt $i"; break; fi
  if [ "$STATUS" != "HELD" ] && [ "$STATUS" != "RESERVED" ]; then info "state=$STATUS at attempt $i"; fi
done

if [ "$RESERVED" = "yes" ]; then
  pass "E2E: seat became RESERVED"
else
  fail "E2E: seat not RESERVED after 30s (outbox worker may need more time)"
fi

echo ""

# ── 13. RATE LIMITING ─────────────────────────────────────────────
echo "── 13. RATE LIMITING ──"

info "brute-forcing /api/auth/login (11 req in < 1min, limit=10)..."
RL_429=0
GOT_RETRY_AFTER=0
for i in $(seq 1 11); do
  RESP=$(curl -sS -D - -o /dev/null -X POST "$BASE/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"doesnotexist@x.com","password":"x"}' 2>/dev/null || echo "")
  CODE=$(echo "$RESP" | head -1 | awk '{print $2}')
  if [ "$CODE" = "429" ]; then
    RL_429=$((RL_429+1))
    if echo "$RESP" | grep -qi "retry-after"; then GOT_RETRY_AFTER=1; fi
  fi
done
assert_ge "rate limiting returns 429 after limit exceeded" 1 "$RL_429"
if [ "$GOT_RETRY_AFTER" = "1" ]; then pass "Retry-After header present on 429"; else fail "Retry-After header missing on 429"; fi

echo ""

# ── 14. METRICS ───────────────────────────────────────────────────
echo "── 14. METRICS ──"

for pair in "auth|$AUTH" "seat-reservation|$SEAT" "payment|$PAY"; do
  name="${pair%%|*}" url="${pair##*|}"
  METRICS=$(curl -sS "$url/metrics" 2>/dev/null || echo "")
  if echo "$METRICS" | grep -q "HELP\|TYPE"; then pass "$name /metrics responds"; else fail "$name /metrics no prometheus output (got ${#METRICS} bytes)"; fi
  HAS_COUNTER=$(echo "$METRICS" | grep -c "_total " || echo "0")
  if [ "$HAS_COUNTER" -gt 0 ]; then pass "$name has business counters ($HAS_COUNTER counters)"; else fail "$name missing business counters"; fi
done

echo ""

# ── 15. RT REUSE DETECTION ───────────────────────────────────────
echo "── 15. AUTH: RT REUSE DETECTION (THEFT) ──"

# Login fresh
LOGIN4=$(curl -sS -c /tmp/verify_cookies_rt -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
AT4=$(echo "$LOGIN4" | python3 -c 'import sys,json; print(json.load(sys.stdin)["accessToken"])' 2>/dev/null || echo "")

# Rotate once → old token still in cookie jar
curl -sS -b /tmp/verify_cookies_rt -c /tmp/verify_cookies_rt2 -X POST "$BASE/api/auth/refresh" > /dev/null 2>&1

# Wait for grace window to expire
info "waiting 2s for grace window to expire..."
sleep 2

# Reuse old rt (past grace) → should revoke entire family
REUSE=$(curl -sS -o /dev/null -w "%{http_code}" -b /tmp/verify_cookies_rt -X POST "$BASE/api/auth/refresh" \
  -H 'Content-Type: application/json')

if [ "$REUSE" = "401" ]; then
  pass "rt reuse past grace → 401 (family revoked)"
else
  fail "rt reuse past grace should be 401, got $REUSE"
fi

# The NEW token should also be revoked (family revocation)
AFTER_FAMILY_REVOKE=$(curl -sS -o /dev/null -w "%{http_code}" -b /tmp/verify_cookies_rt2 -X POST "$BASE/api/auth/refresh" \
  -H 'Content-Type: application/json')
if [ "$AFTER_FAMILY_REVOKE" = "401" ]; then
  pass "family revocation: rotated token also revoked"
else
  fail "family revocation: rotated token should be revoked, got $AFTER_FAMILY_REVOKE"
fi

echo ""

# ── CLEANUP ───────────────────────────────────────────────────────
rm -f /tmp/verify_cookies /tmp/verify_cookies2 /tmp/verify_cookies_rt /tmp/verify_cookies_rt2

# ── SUMMARY ───────────────────────────────────────────────────────
echo "============================================"
TOTAL=$((PASS + FAIL + WARN))
echo -e " Results: ${GREEN}$PASS pass${NC}, ${RED}$FAIL fail${NC}, ${YELLOW}$WARN warn${NC} / $TOTAL total"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}PRODUCTION NOT READY — $FAIL test(s) failed${NC}"
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo -e "${YELLOW}PRODUCTION READY WITH WARNINGS — review $WARN warning(s)${NC}"
  exit 0
else
  echo -e "${GREEN}PRODUCTION READY — all $PASS tests passed${NC}"
  exit 0
fi
