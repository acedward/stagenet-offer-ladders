#!/usr/bin/env bash
# Compile the generated stk token contracts with the pinned Compact toolchain.
#
# Adapted from acedward/mip-0018-midnight-contracts @ 7d9f659 scripts/compile.sh
# (Apache-2.0): the same flags, source root and --check logic, but it runs the
# SHA-256-pinned compactc 0.34.0 release binary directly (COMPACTC) instead of
# `compact compile +0.34.0`. Run it inside Docker through scripts/compile-docker.sh.
#
#   scripts/compile.sh                 compile every contract into contracts/managed/<name>/
#   scripts/compile.sh stkA            compile just one
#   scripts/compile.sh --check         compile into a temp tree and diff against the
#                                      committed one (keys, .bzkir and manifest included)
#   SKIP_ZK=true scripts/compile.sh    skip proving-key generation
#
# Contracts are compiled one at a time: key generation is the memory peak.
set -euo pipefail

COMPACTC="${COMPACTC:-/opt/compactc/compactc}"
EXPECTED_VERSION="0.34.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT/contracts"
OUT_DIR="$SRC_DIR/managed"

CONTRACTS=(
  "generated/stkA"
  "generated/stkB"
  "generated/stkC"
)

CHECK=0
SELECTED=()
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) SELECTED+=("generated/$arg") ;;
  esac
done
if [ "${#SELECTED[@]}" -gt 0 ]; then
  CONTRACTS=("${SELECTED[@]}")
fi

version="$("$COMPACTC" --version)"
if [ "$version" != "$EXPECTED_VERSION" ]; then
  echo "compactc $version found; this repository pins $EXPECTED_VERSION" >&2
  exit 1
fi
echo "== compactc $version (language $("$COMPACTC" --language-version), runtime $("$COMPACTC" --runtime-version))"

# The generated source map records the path from the target directory back to the
# sources; this is the value a compile into contracts/managed/<name>/ produces, so the
# output does not depend on where it was compiled.
SOURCE_ROOT='../../../'

FLAGS=()
if [ "${SKIP_ZK:-}" = "true" ]; then
  FLAGS+=(--skip-zk)
  echo "== SKIP_ZK=true: no proving keys will be generated"
fi

TARGET_ROOT="$OUT_DIR"
if [ "$CHECK" = "1" ]; then
  TARGET_ROOT="$(mktemp -d)"
  trap 'rm -rf "$TARGET_ROOT"' EXIT
  echo "== --check: compiling into $TARGET_ROOT"
fi

for name in "${CONTRACTS[@]}"; do
  src="$SRC_DIR/$name.compact"
  [ -f "$src" ] || { echo "missing source: $src" >&2; exit 1; }
  out="$TARGET_ROOT/$(basename "$name")"
  echo
  echo "== $name"
  if avail_mb=$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}') && [ -n "$avail_mb" ]; then
    echo "   memory: ${avail_mb} MiB available"
    if [ "${SKIP_ZK:-}" != "true" ] && [ "$avail_mb" -lt 1536 ]; then
      echo "   refusing to generate proving keys with less than 1.5 GiB available" >&2
      exit 3
    fi
  fi
  rm -rf "$out"
  mkdir -p "$out"
  "$COMPACTC" ${FLAGS[@]+"${FLAGS[@]}"} --sourceRoot "$SOURCE_ROOT" "$src" "$out"
done

if [ "$CHECK" = "1" ]; then
  echo
  status=0
  for name in "${CONTRACTS[@]}"; do
    base="$(basename "$name")"
    # keys/ and zkir/*.bzkir are committed here (they are small at k<=14, and
    # midnight-js' NodeZkConfigProvider verifies them against the compiler's
    # contract-manifest.json), so a full --check compares them too.
    excludes=()
    if [ "${SKIP_ZK:-}" = "true" ]; then excludes+=(-x keys -x '*.bzkir' -x contract-manifest.json); fi
    if diff -r -q ${excludes[@]+"${excludes[@]}"} "$OUT_DIR/$base" "$TARGET_ROOT/$base"; then
      echo "== $base: managed/ matches a fresh compile"
    else
      echo "== $base: managed/ DIFFERS from a fresh compile" >&2
      status=1
    fi
  done
  exit "$status"
fi

echo
echo "== done; artefacts in $OUT_DIR"
