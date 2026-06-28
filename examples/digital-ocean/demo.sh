#!/usr/bin/env bash
# Use a sealed DigitalOcean token against the real DO API — token never in your shell.
set -euo pipefail
cd "$(dirname "$0")/../.."

SECRET="${1:-digital_ocean_api_key}"

echo "▶ 1. Health check (no command, just --url):"
npm run -s blindfold -- use --name "$SECRET" --url https://api.digitalocean.com/v2/account
echo

echo "▶ 2. Real account info via curl (token injected into the child only):"
npm run -s blindfold -- use --name "$SECRET" --as TOK -- bash -c \
  'curl -s -H "Authorization: Bearer $TOK" https://api.digitalocean.com/v2/account | head -c 220; echo'
echo

if command -v doctl >/dev/null 2>&1; then
  echo "▶ 3. doctl CLI (auto-mapped to DIGITALOCEAN_ACCESS_TOKEN):"
  npm run -s blindfold -- use --name "$SECRET" -- doctl account get
else
  echo "▶ 3. (skipped — install \`doctl\` to manage droplets with the sealed token)"
fi
echo
echo "✓ Done. The DigitalOcean token was never in your shell or .env — only inside each child command."
