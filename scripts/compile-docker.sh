#!/usr/bin/env bash
# Host wrapper: fetch the pinned compactc 0.34.0 release archive (verified by SHA-256),
# then run scripts/compile.sh inside node:22-bookworm (bash + CA certificates: zkir downloads
# missing proving-key parameters over HTTPS, and oven/bun has no CA store) with the checkout
# mounted at /work. The compiler is a static musl binary; no Node or Bun code runs.
#
#   scripts/compile-docker.sh [compile.sh arguments…]
#
# Archive cache: $STK_TOOLCHAIN_DIR (default $HOME/.cache/stagenet-offer-ladders/toolchain).
# Proving-key parameters: $MIDNIGHT_ZK_PARAMS_DIR (default $HOME/.cache/midnight/zk-params),
# mounted into the container so repeated compiles do not download them again.
set -euo pipefail

VERSION="0.34.0"
case "$(uname -m)" in
  arm64 | aarch64)
    ASSET="compactc_v${VERSION}_aarch64-unknown-linux-musl.zip"
    SHA256="d3e292c4f48e257dcd6b3d3e3e4743d7d8ea0729f48953eab91a366d44cd026d"
    ;;
  x86_64 | amd64)
    ASSET="compactc_v${VERSION}_x86_64-unknown-linux-musl.zip"
    SHA256="775ccddf5a71399835329bbf7471ba5a8c54fcc825d372c75e19ba7042069584"
    ;;
  *) echo "unsupported host architecture $(uname -m)" >&2; exit 1 ;;
esac
URL="https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v${VERSION}/${ASSET}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLCHAIN_DIR="${STK_TOOLCHAIN_DIR:-$HOME/.cache/stagenet-offer-ladders/toolchain}"
PARAMS_DIR="${MIDNIGHT_ZK_PARAMS_DIR:-$HOME/.cache/midnight/zk-params}"
IMAGE="${STK_COMPILE_IMAGE:-node:22-bookworm}"
UNPACKED="$TOOLCHAIN_DIR/compactc-$VERSION-$SHA256"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }

mkdir -p "$TOOLCHAIN_DIR" "$PARAMS_DIR"
if [ ! -x "$UNPACKED/compactc" ]; then
  archive="$TOOLCHAIN_DIR/$ASSET"
  if [ ! -f "$archive" ] || [ "$(sha256 "$archive")" != "$SHA256" ]; then
    echo "== downloading $URL"
    curl -fsSL -o "$archive.part" "$URL"
    mv "$archive.part" "$archive"
  fi
  actual="$(sha256 "$archive")"
  if [ "$actual" != "$SHA256" ]; then
    echo "SHA-256 mismatch for $ASSET: got $actual, expected $SHA256" >&2
    exit 1
  fi
  echo "== $ASSET SHA-256 OK ($SHA256)"
  rm -rf "$UNPACKED.tmp"
  mkdir -p "$UNPACKED.tmp"
  unzip -q "$archive" -d "$UNPACKED.tmp"
  mv "$UNPACKED.tmp" "$UNPACKED"
fi

exec docker run --rm \
  --name "stk-compile-$$" \
  -v "$ROOT":/work \
  -v "$UNPACKED":/opt/compactc:ro \
  -v "$PARAMS_DIR":/root/.cache/midnight/zk-params \
  -w /work \
  "$IMAGE" \
  bash scripts/compile.sh "$@"
