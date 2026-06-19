#!/usr/bin/env bash
# Builds the Rust→WASM T3 contract. Run once after install, and after any
# change to contract/src or contract/wit.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v rustup >/dev/null 2>&1; then
  echo "✖ rustup is not installed. See https://rustup.rs" >&2
  exit 1
fi

echo "→ Ensuring wasm32-wasip2 target is installed"
rustup target add wasm32-wasip2 >/dev/null

echo "→ Building contract (release)"
(cd contract && cargo build --target wasm32-wasip2 --release)

ARTIFACT="contract/target/wasm32-wasip2/release/blindfold_proxy.wasm"
if [ ! -f "$ARTIFACT" ]; then
  echo "✖ Expected artifact not found: $ARTIFACT" >&2
  exit 1
fi

SIZE=$(wc -c <"$ARTIFACT" | tr -d ' ')
echo "✓ Built $ARTIFACT ($SIZE bytes)"
