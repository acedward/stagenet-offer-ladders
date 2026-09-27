#!/usr/bin/env bash
# Local end-to-end test of the stock/USDC books (plan 00057 P2), on a throwaway `undeployed`
# chain (e2e/compose.local.yml). One two-sided pair (stand-in wStkA/wUSDC, the committed
# book's AASK and ABID ladders cut to E2E_LEVELS levels) with its own makers:
#
#   1. bootstrap: the funding wallet deploys two stand-in tokens and mints to itself;
#   2. makers:fund --dry-run, makers:fund, makers:fund again (moves nothing), and a
#      --check-balances dry run on an empty record file (every maker already holds);
#   3. the service (ladder:run) starts on a fresh journal: fresh-start acknowledgement, the
#      2 × E2E_LEVELS offers are stored, offers:verify PASSES on a copy of the state;
#   4. a taker (the funding wallet) BUYS the best ask and SELLS into the best bid
#      (offers:settle on a copy of the state while the service runs), both SucceedEntirely,
#      with exact balance deltas;
#   5. both slots re-offer from their makers' change; a restart builds nothing new;
#   6. makers:status shows the makers' balances; the stack is removed (down -v).
#
#   e2e/local-books.sh
#
# Environment:
#   E2E_DIR       run directory: secrets, state, logs, results.json [mktemp]; never in the repo
#   E2E_PROJECT   Compose project name [o57-e2e-<random>]
#   E2E_LEVELS    levels per side [2]
#   KEEP_STACK=1  leave the stack running at the end (debugging)
#
# The funding wallet and taker is Midnight's public dev test wallet (testkit's
# TEST_MNEMONIC: 23 × "abandon" + "diesel"), which the dev genesis prefunds with NIGHT and
# registered DUST. It is written to a mode-600 file in $E2E_DIR/secrets and is valid on this
# local chain only. The makers are fresh throwaway wallets. No other secret is read, and
# nothing under ~/.stagenet-offer-ladders or the repository is written.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/e2e/compose.local.yml"
BUN_IMAGE="oven/bun:1.3.11"
export E2E_PROJECT="${E2E_PROJECT:-o57-e2e-$RANDOM$RANDOM}"
export E2E_DIR="${E2E_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/o57-e2e.XXXXXX")}"
export E2E_REPO="$ROOT"
export E2E_NODE_VERSION="unknown"
export E2E_FRESH_START_ACK=""
LEVELS="${E2E_LEVELS:-2}"
LOGS="$E2E_DIR/logs"
NET="${E2E_PROJECT}_default"
STARTED=$(date +%s)

say() { echo "[$(date -u +%H:%M:%SZ)] $*" >&2; }
fail() { say "FAIL: $*"; exit 1; }
json() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {'d': d}))" "$@"; }

free_port() {
  python3 - <<'EOF'
import random, socket
for _ in range(200):
    port = random.randint(10000, 60000)
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            continue
        print(port)
        break
EOF
}

compose() { docker compose -p "$E2E_PROJECT" -f "$COMPOSE_FILE" --profile service "$@"; }

teardown() {
  local code=$?
  if compose ps -q ladder 2>/dev/null | grep -q .; then compose logs --no-color ladder >"$LOGS/ladder-final.log" 2>&1 || true; fi
  for id in $(docker ps -aq --filter "name=^${E2E_PROJECT}-cli-"); do docker rm -f "$id" >/dev/null 2>&1 || true; done
  if [ "${KEEP_STACK:-}" = "1" ]; then
    say "KEEP_STACK=1: stack $E2E_PROJECT left running (remove: docker compose -p $E2E_PROJECT -f $COMPOSE_FILE --profile service down -v)"
  else
    compose down -v --remove-orphans >"$LOGS/down.log" 2>&1 || true
    say "stack $E2E_PROJECT removed (down -v)"
  fi
  say "run directory: $E2E_DIR (exit $code, $(( $(date +%s) - STARTED )) s)"
}

# cli <label> [VAR=value …] -- <command> [flags…]: one CLI command in a throwaway container on
# the stack's network. stdout (the JSON result) → $LOGS/<label>.json, stderr → <label>.log.
cli() {
  local label=$1; shift
  local envs=()
  while [ "$1" != "--" ]; do envs+=(-e "$1"); shift; done
  shift
  docker run --rm --name "$E2E_PROJECT-cli-$label" --network "$NET" \
    -v "$ROOT":/work:ro -v "$E2E_DIR":/e2e -w /work \
    -e MN_NETWORK_ID=undeployed -e MN_NODE_URL=http://node:9944 \
    -e MN_INDEXER_URL=http://indexer:8088/api/v4/graphql -e MN_INDEXER_WS_URL=ws://indexer:8088/api/v4/graphql/ws \
    -e MN_PROOF_SERVER_URL=http://proof-server:6300 -e EXPECTED_NODE_VERSION="$E2E_NODE_VERSION" \
    -e TOKENS_FILE=/e2e/tokens.json -e MAKERS_FILE=/e2e/secrets/makers.json -e MAKERS_DIR_CHECK=false \
    -e FUNDING_WALLET_FILE=/e2e/secrets/funder -e STK_STATE_DIR=/e2e/funding-state \
    ${envs[@]+"${envs[@]}"} "$BUN_IMAGE" bun "$@" >"$LOGS/$label.json" 2>"$LOGS/$label.log"
}

status() { curl -fsS -m 10 "http://127.0.0.1:$E2E_STATUS_PORT/status"; }

# wait_status <python condition on d> <seconds> <what>
wait_status() {
  local deadline=$(( $(date +%s) + $2 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if status >"$LOGS/status.last.json" 2>/dev/null && [ "$(json "$LOGS/status.last.json" "bool($1)")" = "True" ]; then return 0; fi
    sleep 5
  done
  fail "timed out waiting for: $3"
}

# copy_state <name>: a copy of the service's journal and outbox (offers:verify / offers:settle
# take service.lock and must not touch the live state while the service runs).
copy_state() {
  rm -rf "$E2E_DIR/$1" && mkdir -p "$E2E_DIR/$1"
  cp -R "$E2E_DIR/state/ladder.books.journal.json" "$E2E_DIR/state/outbox-books" "$E2E_DIR/$1/"
}
copy_env() { echo "STATE_DIR=/e2e/$1" "JOURNAL_FILE=/e2e/$1/ladder.books.journal.json" "OUTBOX_DIR=/e2e/$1/outbox-books"; }

# ── preflight ────────────────────────────────────────────────────────────────────────────────
for image in "midnightntwrk/midnight-node@sha256:caf93d6f9fb3630c906ef3e714c151655377f3d28f907d17545de1870514da2e" \
  "${E2E_INDEXER_IMAGE:-midnight-2-offers/indexer:local}" \
  "midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b" "$BUN_IMAGE"; do
  docker image inspect "$image" >/dev/null 2>&1 || fail "image $image is not local (this harness never pulls)"
done
mkdir -p "$LOGS" "$E2E_DIR/secrets" "$E2E_DIR/state" "$E2E_DIR/funding-state"
chmod 700 "$E2E_DIR" "$E2E_DIR/secrets" "$E2E_DIR/funding-state"
export E2E_NODE_PORT="$(free_port)" E2E_INDEXER_PORT="$(free_port)" E2E_STATUS_PORT="$(free_port)"
trap teardown EXIT INT TERM
say "project $E2E_PROJECT, run directory $E2E_DIR, ports node $E2E_NODE_PORT indexer $E2E_INDEXER_PORT status $E2E_STATUS_PORT"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' >"$LOGS/docker-stats-before.txt" 2>&1 || true

# ── 0. the local chain ───────────────────────────────────────────────────────────────────────
T0=$(date +%s)
compose up -d --wait node >"$LOGS/up-node.log" 2>&1 || fail "node did not become healthy (see $LOGS/up-node.log)"
compose up -d indexer proof-server >"$LOGS/up.log" 2>&1
for _ in $(seq 1 120); do
  height=$(curl -fsS -m 5 -H 'content-type: application/json' -d '{"query":"{ block { height } }"}' \
    "http://127.0.0.1:$E2E_INDEXER_PORT/api/v4/graphql" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["block"]["height"])' 2>/dev/null || echo 0)
  [ "${height:-0}" -ge 2 ] && break
  sleep 3
done
[ "${height:-0}" -ge 2 ] || fail "the indexer did not serve blocks"
E2E_NODE_VERSION=$(curl -fsS -m 5 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"system_version","params":[]}' \
  "http://127.0.0.1:$E2E_NODE_PORT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"])')
export E2E_NODE_VERSION
T_CHAIN=$(( $(date +%s) - T0 ))
say "chain up in ${T_CHAIN}s: node $E2E_NODE_VERSION, indexer at block $height"

# ── 1. wallets and stand-in tokens ───────────────────────────────────────────────────────────
umask 077
printf '%s\n' "$(printf 'abandon %.0s' $(seq 1 23))diesel" >"$E2E_DIR/secrets/funder"
umask 022
chmod 600 "$E2E_DIR/secrets/funder"
cli generate -- src/cli.ts wallets:generate --count $((2 * LEVELS)) --ladders AB --network undeployed --makers-file /e2e/secrets/makers.json \
  || fail "wallets:generate"
T0=$(date +%s)
cli bootstrap E2E_DIR=/e2e -- e2e/bootstrap-local.ts --levels "$LEVELS" --stock 2500 --usdc 10 || fail "bootstrap (see $LOGS/bootstrap.log)"
T_BOOTSTRAP=$(( $(date +%s) - T0 ))
cli addresses -- src/cli.ts wallets:addresses --makers-file /e2e/secrets/makers.json --ladder-file /e2e/book.local.json \
  --public-json /e2e/makers.public.json || fail "wallets:addresses"
STANDINS=$(json "$E2E_DIR/tokens.json" "' '.join(k + '=' + d[k]['colour'][:12] for k in d)")
say "bootstrap ${T_BOOTSTRAP}s: stand-ins $STANDINS"

# ── 2. makers:fund ───────────────────────────────────────────────────────────────────────────
FUND=(src/cli.ts makers:fund --ladder-file /e2e/book.local.json --public-json /e2e/makers.public.json --batch-size 5)
cli fund-dry STATE_DIR=/e2e/state -- "${FUND[@]}" --dry-run || fail "makers:fund --dry-run"
[ "$(json "$LOGS/fund-dry.json" "[r['action'] for r in d['results']].count('send')")" = "$((2 * LEVELS))" ] || fail "dry run: not every maker planned"
T0=$(date +%s)
cli fund STATE_DIR=/e2e/state -- "${FUND[@]}" || fail "makers:fund (see $LOGS/fund.log)"
T_FUND=$(( $(date +%s) - T0 ))
[ "$(json "$LOGS/fund.json" "all(r['action'] == 'sent' for r in d['results'])")" = "True" ] || fail "makers:fund: not all sent"
cli fund-again STATE_DIR=/e2e/state -- "${FUND[@]}" || fail "makers:fund (second run)"
[ "$(json "$LOGS/fund-again.json" "all(r['action'] == 'skip-already-sent' for r in d['results']) and d['batches'] == 0")" = "True" ] \
  || fail "the second makers:fund run was not a no-op"
mkdir -p "$E2E_DIR/state-check"
cli fund-check STATE_DIR=/e2e/state-check -- "${FUND[@]}" --dry-run --check-balances || fail "makers:fund --check-balances"
[ "$(json "$LOGS/fund-check.json" "all(r['action'] == 'skip-already-holds' for r in d['results'])")" = "True" ] \
  || fail "--check-balances: a maker does not hold its inventory"
say "makers funded in ${T_FUND}s ($(json "$LOGS/fund.json" "d['batches']") batches); second run and balance check pass"

# ── 3. the service on a fresh journal ────────────────────────────────────────────────────────
T0=$(date +%s)
compose up -d ladder >"$LOGS/up-ladder.log" 2>&1
wait_status "d['freshStartUnacknowledged'] and d['freshStartToken']" 600 "the fresh-start token"
E2E_FRESH_START_ACK=$(json "$LOGS/status.last.json" "d['freshStartToken']")
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$E2E_STATUS_PORT/health")" = "503" ] || fail "/health must fail before the ack"
compose logs --no-color ladder >"$LOGS/ladder-1-unacknowledged.log" 2>&1
export E2E_FRESH_START_ACK
compose up -d ladder >>"$LOGS/up-ladder.log" 2>&1
wait_status "d['states']['stored'] == $((2 * LEVELS))" 900 "all offers stored"
T_BUILD=$(( $(date +%s) - T0 ))
compose logs --no-color ladder >"$LOGS/ladder-2-acknowledged.log" 2>&1
export E2E_FRESH_START_ACK=""
compose up -d ladder >>"$LOGS/up-ladder.log" 2>&1
wait_status "d['states']['stored'] == $((2 * LEVELS)) and d['lastTickEndedAt'] is not None and not d['freshStartUnacknowledged']" 600 "the restarted service"
status >"$LOGS/status-stored.json"
BUILT_BEFORE=$(json "$LOGS/status-stored.json" "d['offersBuilt']")
[ "$BUILT_BEFORE" = "$((2 * LEVELS))" ] || fail "the ack-clearing restart built again ($BUILT_BEFORE offers)"
copy_state copy-1
cli verify-1 $(copy_env copy-1) -- src/cli.ts offers:verify --ladder-file /e2e/book.local.json || fail "offers:verify (see $LOGS/verify-1.json)"
[ "$(json "$LOGS/verify-1.json" "d['books'][0]['bestAsk'] == '0.0104' and d['books'][0]['bestBid'] == '0.0096' and not d['books'][0]['crossed']")" = "True" ] \
  || fail "the book's best ask / best bid"
say "offers stored in ${T_BUILD}s; offers:verify PASS; best ask 0.0104, best bid 0.0096"

# ── 4. the taker buys the best ask and sells into the best bid ───────────────────────────────
mkdir -p "$E2E_DIR/taker-state"
colour() { json "$E2E_DIR/tokens.json" "d['$1']['colour']"; }
A=$(colour wStkA)
U=$(colour wUSDC)
balance() { json "$LOGS/$1.json" "int(d['shielded'].get('$2', {}).get('value', 0))"; }
largest() { json "$LOGS/$1.json" "max((c for c in d['coins'] if c['colour'] == '$2'), key=lambda c: int(c['value']))['nonce']"; }
cli taker-0 STATE_DIR=/e2e/taker-state -- src/cli.ts funding:status || fail "funding:status"
T0=$(date +%s)
copy_state copy-2
cli settle-ask $(copy_env copy-2) -- src/cli.ts offers:settle --ladder-file /e2e/book.local.json --slot AASK-01 --pay-with "$(largest taker-0 "$U")" \
  || fail "buying AASK-01 (see $LOGS/settle-ask.log)"
cli taker-1 STATE_DIR=/e2e/taker-state -- src/cli.ts funding:status || fail "funding:status"
copy_state copy-3
cli settle-bid $(copy_env copy-3) -- src/cli.ts offers:settle --ladder-file /e2e/book.local.json --slot ABID-01 --pay-with "$(largest taker-1 "$A")" \
  || fail "selling into ABID-01 (see $LOGS/settle-bid.log)"
T_SETTLE=$(( $(date +%s) - T0 ))
cli taker-2 STATE_DIR=/e2e/taker-state -- src/cli.ts funding:status || fail "funding:status"
for side in ask bid; do
  [ "$(json "$LOGS/settle-$side.json" "d['settlement']['status']")" = "SucceedEntirely" ] || fail "settle-$side is not SucceedEntirely"
done
ASK_WANT=$(json "$E2E_DIR/copy-2/ladder.books.journal.json" "d['slots']['AASK-01']['wantAmount']")
ASK_GIVE=$(json "$E2E_DIR/copy-2/ladder.books.journal.json" "d['slots']['AASK-01']['giveAmount']")
BID_WANT=$(json "$E2E_DIR/copy-3/ladder.books.journal.json" "d['slots']['ABID-01']['wantAmount']")
BID_GIVE=$(json "$E2E_DIR/copy-3/ladder.books.journal.json" "d['slots']['ABID-01']['giveAmount']")
# Exact taker deltas: buying pays the ask's want (wUSDC) and receives its give (wStkA); selling
# pays the bid's want (wStkA) and receives its give (wUSDC). Fees are DUST only.
[ $(( $(balance taker-1 "$U") - $(balance taker-0 "$U") )) = $(( -ASK_WANT )) ] || fail "buy: wUSDC delta"
[ $(( $(balance taker-1 "$A") - $(balance taker-0 "$A") )) = "$ASK_GIVE" ] || fail "buy: wStkA delta"
[ $(( $(balance taker-2 "$A") - $(balance taker-1 "$A") )) = $(( -BID_WANT )) ] || fail "sell: wStkA delta"
[ $(( $(balance taker-2 "$U") - $(balance taker-1 "$U") )) = "$BID_GIVE" ] || fail "sell: wUSDC delta"
say "bought AASK-01 (paid $ASK_WANT wUSDC, got $ASK_GIVE wStkA) and sold into ABID-01 (paid $BID_WANT wStkA, got $BID_GIVE wUSDC) in ${T_SETTLE}s; deltas exact"

# ── 5. re-offer from the change, then a restart that builds nothing ──────────────────────────
T0=$(date +%s)
wait_status "all(s['state'] == 'stored' and s['offersBuilt'] == 2 for s in d['slots'] if s['slot'] in ('AASK-01', 'ABID-01'))" 600 "both slots re-offered"
T_REOFFER=$(( $(date +%s) - T0 ))
status >"$LOGS/status-reoffered.json"
copy_state copy-4
cli verify-2 $(copy_env copy-4) -- src/cli.ts offers:verify --ladder-file /e2e/book.local.json || fail "offers:verify after the fills"
J4="$E2E_DIR/copy-4/ladder.books.journal.json"
[ "$(json "$J4" "d['slots']['AASK-01']['current']['coinValue']")" = "900000000" ] || fail "AASK-01 did not re-offer from its 900 wStkA change"
[ "$(json "$J4" "d['slots']['ABID-01']['current']['coinValue']")" = "1000000" ] || fail "ABID-01 did not re-offer from its 1 wUSDC change"
[ "$(json "$J4" "[h['outcome'] for h in d['slots']['AASK-01']['history']] == ['consumed'] and [h['outcome'] for h in d['slots']['ABID-01']['history']] == ['consumed']")" = "True" ] \
  || fail "the filled offers are not recorded as consumed"
OUTBOX_BEFORE=$(ls "$E2E_DIR/state/outbox-books" | wc -l | tr -d ' ')
BUILT_BEFORE=$(json "$LOGS/status-reoffered.json" "d['offersBuilt']")
compose logs --no-color ladder >"$LOGS/ladder-3-before-restart.log" 2>&1
compose restart -t 120 ladder >>"$LOGS/up-ladder.log" 2>&1
sleep 5
wait_status "d['lastTickEndedAt'] is not None and d['states']['stored'] == $((2 * LEVELS))" 600 "the service after the restart"
sleep 25  # a few more reconcile ticks (10 s)
status >"$LOGS/status-after-restart.json"
BUILT_AFTER=$(json "$LOGS/status-after-restart.json" "d['offersBuilt']")
OUTBOX_AFTER=$(ls "$E2E_DIR/state/outbox-books" | wc -l | tr -d ' ')
[ "$BUILT_AFTER" = "$BUILT_BEFORE" ] && [ "$OUTBOX_AFTER" = "$OUTBOX_BEFORE" ] || fail "the restart built again ($BUILT_BEFORE → $BUILT_AFTER offers, $OUTBOX_BEFORE → $OUTBOX_AFTER outbox entries)"
say "both slots re-offered from their change in ${T_REOFFER}s; restart: $BUILT_AFTER offers, $OUTBOX_AFTER outbox entries, unchanged"

# ── 6. the makers' balances (service stopped: one wallet facade per seed) ────────────────────
compose logs --no-color ladder >"$LOGS/ladder-4-after-restart.log" 2>&1
compose stop -t 120 ladder >>"$LOGS/up-ladder.log" 2>&1
ASK_MAKER=$(json "$J4" "d['slots']['AASK-01']['walletId']")
BID_MAKER=$(json "$J4" "d['slots']['ABID-01']['walletId']")
cli makers STATE_DIR=/e2e/state -- src/cli.ts makers:status --slots "$ASK_MAKER,$BID_MAKER" --stagger-ms 0 || fail "makers:status"
maker() { json "$LOGS/makers.json" "int(next(m for m in d['makers'] if m['slot'] == '$1')['shielded'].get('$2', {}).get('value', 0))"; }
[ "$(maker "$ASK_MAKER" "$A")" = "900000000" ] && [ "$(maker "$ASK_MAKER" "$U")" = "$ASK_WANT" ] || fail "ask maker balances"
[ "$(maker "$BID_MAKER" "$U")" = "1000000" ] && [ "$(maker "$BID_MAKER" "$A")" = "$BID_WANT" ] || fail "bid maker balances"
say "makers: $ASK_MAKER holds 900 wStkA + $ASK_WANT wUSDC; $BID_MAKER holds 1 wUSDC + $BID_WANT wStkA"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' >"$LOGS/docker-stats-end.txt" 2>&1 || true

python3 - "$E2E_DIR" <<EOF
import json, sys
d = sys.argv[1]
load = lambda n: json.load(open(f"{d}/logs/{n}.json"))
result = {
    "result": "PASS",
    "project": "$E2E_PROJECT",
    "node": "$E2E_NODE_VERSION",
    "levels": $LEVELS,
    "seconds": {"chain": $T_CHAIN, "bootstrap": $T_BOOTSTRAP, "fund": $T_FUND, "firstOffers": $T_BUILD, "settleBoth": $T_SETTLE, "reoffer": $T_REOFFER},
    "tokens": json.load(open(f"{d}/tokens.json")),
    "fund": {"batches": load("fund")["batches"], "totals": load("fund")["totals"], "results": [{k: r.get(k) for k in ("slot", "walletId", "symbol", "amount", "action", "batch", "txHash", "blockHeight")} for r in load("fund")["results"]]},
    "books": load("verify-1")["books"],
    "settlements": {s: {k: load(f"settle-{s}")["settlement"][k] for k in ("status", "txHash", "blockHeight")} | {"slot": load(f"settle-{s}")["slot"]} for s in ("ask", "bid")},
    "reoffered": {s: next({k: r[k] for k in ("state", "offersBuilt", "offerId")} for r in load("status-reoffered")["slots"] if r["slot"] == s) for s in ("AASK-01", "ABID-01")},
    "restart": {"offersBuilt": $BUILT_AFTER, "outboxEntries": $OUTBOX_AFTER},
    "makers": {m["slot"]: m["shielded"] for m in load("makers")["makers"]},
}
json.dump(result, open(f"{d}/results.json", "w"), indent=2)
print(json.dumps({k: result[k] for k in ("result", "seconds", "settlements", "restart")}, indent=2))
EOF
say "PASS"
