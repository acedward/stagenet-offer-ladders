#!/usr/bin/env bash
# Run one of this repository's Bun scripts against stagenet with a local proof server, then
# remove the proof server.
#
#   FUNDING_WALLET_FILE_HOST=/path/to/mnemonic-file scripts/stagenet-run.sh scripts/deploy-tokens.ts [args…]
#
# - The proof server is midnightntwrk/proof-server:9.0.0-rc.6, pinned by digest, published only
#   on 127.0.0.1 at a random free port >= 10000 (for the health check). The script's container
#   joins the proof server's network namespace and reaches it at http://127.0.0.1:6300.
# - The mnemonic file is mounted READ-ONLY at /secrets/stagenet; only that path is passed
#   (FUNDING_WALLET_FILE). The phrase never appears on a command line or in the environment.
# - Private state ($STK_STATE_DIR_HOST, default $HOME/.stagenet-offer-ladders, mode 700) is
#   mounted at /state (maintenance signing keys, the funding-wallet lock).
# - Both containers are removed on exit, whatever happens.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WALLET_FILE="${FUNDING_WALLET_FILE_HOST:?set FUNDING_WALLET_FILE_HOST to the mnemonic file path}"
STATE_HOST="${STK_STATE_DIR_HOST:-$HOME/.stagenet-offer-ladders}"
PROOF_IMAGE="midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b"
BUN_IMAGE="${STK_BUN_IMAGE:-oven/bun:1.3.11}"
TAG="${STK_RUN_TAG:-$$}"
PROOF_NAME="stk-proof-server-$TAG"
RUN_NAME="stk-run-$TAG"

[ -f "$WALLET_FILE" ] || { echo "no mnemonic file at the given path" >&2; exit 2; }
mkdir -p "$STATE_HOST/maintenance"
chmod 700 "$STATE_HOST" "$STATE_HOST/maintenance"

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
PORT="$(free_port)"

cleanup() {
  docker rm -f "$RUN_NAME" >/dev/null 2>&1 || true
  docker rm -f "$PROOF_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "== proof server $PROOF_NAME on 127.0.0.1:$PORT" >&2
docker run -d --name "$PROOF_NAME" -p "127.0.0.1:$PORT:6300" "$PROOF_IMAGE" >/dev/null
for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null || { echo "proof server did not become healthy" >&2; docker logs --tail 50 "$PROOF_NAME" >&2; exit 1; }
echo "== proof server version $(curl -fsS "http://127.0.0.1:$PORT/version")" >&2

docker run --rm --name "$RUN_NAME" \
  --network "container:$PROOF_NAME" \
  -v "$ROOT":/work \
  -v "$WALLET_FILE":/secrets/stagenet:ro \
  -v "$STATE_HOST":/state \
  -e FUNDING_WALLET_FILE=/secrets/stagenet \
  -e STK_STATE_DIR=/state \
  -e MN_PROOF_SERVER_URL=http://127.0.0.1:6300 \
  -w /work \
  "$BUN_IMAGE" \
  bun "$@"
