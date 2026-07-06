#!/usr/bin/env bash
# Real, no-code walkthrough: seal a GitHub token and use it four ways without
# the plaintext ever entering this shell. Every step is a real T3 round-trip.
#
#   bash examples/github/demo.sh
#
# Prereq: GITHUB_TOKEN in .env (a fine-grained or classic PAT), plus real T3
# creds (T3N_API_KEY, DID). See ../../README.md.
set -euo pipefail
cd "$(dirname "$0")/../.."

SECRET="github_token"

echo "▶ 1. Seal the token into the enclave (reads GITHUB_TOKEN once, then drops it):"
npm run -s blindfold -- register --name "$SECRET" --from-env GITHUB_TOKEN
echo

echo "▶ 2. Authorize the contract to call GitHub (needed for the proxy path):"
npm run -s blindfold -- grant --host api.github.com
echo

echo "▶ 3. Quick auth check — release the token, hit /user, print only the status:"
npm run -s blindfold -- use --name "$SECRET" --url https://api.github.com/user
echo

echo "▶ 4. Run any command with the token injected into that child process only:"
npm run -s blindfold -- use --name "$SECRET" --as GITHUB_TOKEN -- \
  bash -c 'curl -s -H "Authorization: Bearer $GITHUB_TOKEN" -H "User-Agent: blindfold" https://api.github.com/user | grep -o "\"login\":[^,]*"'
echo

echo "▶ 5. The proxy path — the agent sends ONLY the sentinel, the enclave swaps the key:"
npx tsx examples/github/agent.ts
echo
echo "✓ Done. The GitHub token was never printed and never entered this shell —"
echo "  it lives only in the TDX enclave; each use is a just-in-time release."
