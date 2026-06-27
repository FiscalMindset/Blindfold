#!/usr/bin/env bash
# No-code demo: use a sealed secret with real CLI tools.
# The plaintext github_token never enters this shell — Blindfold injects it
# into each child process only, and prints only byte-lengths.
set -euo pipefail
cd "$(dirname "$0")/../.."

SECRET="${1:-github_token}"

echo "▶ 1. Quick auth check (no command, just --url):"
npm run -s blindfold -- use --name "$SECRET" --url https://api.github.com/user
echo

if command -v gh >/dev/null 2>&1; then
  echo "▶ 2. Run the GitHub CLI authenticated by the sealed token:"
  npm run -s blindfold -- use --name "$SECRET" --as GH_TOKEN -- gh api user --jq '"   authenticated as: " + .login'
else
  echo "▶ 2. (skipped — install the GitHub CLI \`gh\` to see this)"
fi
echo

echo "▶ 3. Same token, raw curl, no env leak:"
npm run -s blindfold -- use --name "$SECRET" --as TOK -- bash -c \
  'curl -s -H "Authorization: Bearer $TOK" -H "User-Agent: blindfold" https://api.github.com/rate_limit | head -c 120; echo'
echo
echo "✓ Done. \$$ ($SECRET) was never in your shell — only inside each child command."
