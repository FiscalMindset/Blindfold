#!/usr/bin/env bash
# Real demo: seal a Discord webhook URL and post to the channel without the URL
# ever entering this shell. Every step is a real T3 round-trip.
#
#   bash examples/discord-webhook/demo.sh
#
# Prereq: webhook_discord_url in .env + real T3 creds (T3N_API_KEY, DID).
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "▶ 1. Seal the webhook URL into the enclave (read once, then dropped):"
npm run -s blindfold -- register --name webhook_discord_url --from-env webhook_discord_url | grep -E 'Registered|registered' || true
echo

echo "▶ 2. Post a real message — URL injected into this one command only:"
npm run -s blindfold -- use --name webhook_discord_url --as HOOK -- \
  sh -c 'code=$(curl -s -o /dev/null -w "%{http_code}" -H "Content-Type: application/json" \
    -d "{\"content\":\"posted via Blindfold — the agent never saw the webhook URL\"}" "$HOOK"); \
    echo "  Discord HTTP $code ($([ "$code" = "204" ] && echo delivered || echo "response $code"))"'
echo
echo "✓ Done. The webhook URL was never printed and never entered your shell —"
echo "  it lives only in the TDX enclave; each use is a just-in-time release."
