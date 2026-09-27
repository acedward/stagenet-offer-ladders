#!/usr/bin/env bash
# Run a ladder-service command (bun src/cli.ts …) in Docker against stagenet, with a
# proof server.
#
#   scripts/ladder-run.sh <command> [--flags …]
#
# Environment:
#   FUNDING_WALLET_FILE_HOST  mnemonic file of the funding wallet (single-wallet mode,
#                             offers:settle, funding:status); mounted READ-ONLY, only its
#                             path is passed. Never put the phrase itself in the environment.
#   STATE_HOST                private directory [$HOME/.stagenet-offer-ladders] (makers.json,
#                             00052's funding.lock and maintenance keys)
#   STATE_SUBDIR              journal + outbox + service.lock directory under it [state]; the
#                             same host directory Compose mounts at /data (audit C4)
#   Mounts: $STATE_HOST/makers.json read-only; $STATE_HOST/$STATE_SUBDIR at /data; the whole
#   $STATE_HOST only when the funding wallet is used (to take funding.lock) (audit C14).
#   PROOF_CONTAINER           join this running proof server instead of starting one
#   RUN_NAME                  container name [o53-run-$$]
#   Passed through when set: LADDER_FILE MODE ZSWAP_API OFFER_TTL_MINUTES RECONCILE_SECONDS
#     EXPIRY_GRACE_SECONDS RETRY_BASE_SECONDS MAX_BUILDS_PER_TICK FUNDING_LOCK_HELD
#     STATUS_PORT JOURNAL_RESET WALLET_STAGGER_MS JOURNAL_FILE OUTBOX_DIR (container paths,
#     e.g. /data/ladder.books.journal.json)
#
# The proof server (midnightntwrk/proof-server:9.0.0-rc.6, pinned by digest) is published
# only on 127.0.0.1 at a random free port >= 10000; the command's container joins its
# network namespace. Containers this script starts are removed on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_HOST="${STATE_HOST:-$HOME/.stagenet-offer-ladders}"
STATE_SUBDIR="${STATE_SUBDIR:-state}"
PROOF_IMAGE="midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b"
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1.3.11}"
RUN_NAME="${RUN_NAME:-o53-run-$$}"
OWN_PROOF=""

[ -d "$STATE_HOST" ] || { echo "no state directory $STATE_HOST" >&2; exit 2; }
chmod 700 "$STATE_HOST"

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

cleanup() {
  docker rm -f "$RUN_NAME" >/dev/null 2>&1 || true
  if [ -n "$OWN_PROOF" ]; then docker rm -f "$OWN_PROOF" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM

PROOF="${PROOF_CONTAINER:-}"
if [ -z "$PROOF" ]; then
  PORT="$(free_port)"
  OWN_PROOF="o53-proof-$$"
  PROOF="$OWN_PROOF"
  echo "== proof server $PROOF on 127.0.0.1:$PORT" >&2
  docker run -d --name "$PROOF" -p "127.0.0.1:$PORT:6300" "$PROOF_IMAGE" >/dev/null
  for _ in $(seq 1 120); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null || { echo "proof server did not become healthy" >&2; exit 1; }
fi

mkdir -p "$STATE_HOST/$STATE_SUBDIR"
args=(docker run --rm --name "$RUN_NAME" --network "container:$PROOF"
  -v "$ROOT":/work -w /work
  -v "$STATE_HOST/$STATE_SUBDIR":/data -e STATE_DIR=/data
  -e MN_PROOF_SERVER_URL=http://127.0.0.1:6300)
if [ -f "$STATE_HOST/makers.json" ]; then
  args+=(-v "$STATE_HOST/makers.json":/secrets/makers.json:ro -e MAKERS_FILE=/secrets/makers.json -e MAKERS_DIR_CHECK=false)
fi
if [ -n "${FUNDING_WALLET_FILE_HOST:-}" ]; then
  [ -f "$FUNDING_WALLET_FILE_HOST" ] || { echo "no mnemonic file at the given path" >&2; exit 2; }
  args+=(-v "$FUNDING_WALLET_FILE_HOST":/secrets/stagenet:ro -e FUNDING_WALLET_FILE=/secrets/stagenet
    -v "$STATE_HOST":/funding-state -e STK_STATE_DIR=/funding-state)
fi
for var in LADDER_FILE MODE ZSWAP_API OFFER_TTL_MINUTES RECONCILE_SECONDS EXPIRY_GRACE_SECONDS RETRY_BASE_SECONDS \
  MAX_BUILDS_PER_TICK FUNDING_LOCK_HELD STATUS_PORT JOURNAL_RESET WALLET_STAGGER_MS ROOT_WINDOW_MINUTES \
  SUBMIT_CONFIRM_SECONDS BUILD_TIMEOUT_SECONDS EXPECTED_NODE_VERSION WATCHDOG_SECONDS FRESH_START_ACK BREAK_LOCK \
  JOURNAL_FILE OUTBOX_DIR; do
  if [ -n "${!var:-}" ]; then args+=(-e "$var=${!var}"); fi
done
args+=("$BUN_IMAGE" bun src/cli.ts "$@")
"${args[@]}"
