#!/usr/bin/env bash
# One-time setup. Idempotent — safe to run again.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "→ Installing npm workspaces"
npm install

echo "→ Building the T3 contract"
bash scripts/build-contract.sh

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "ℹ  Created .env from .env.example."
  echo "   Edit .env and set T3N_API_KEY + DID before running any blindfold commands."
fi

echo
echo "✓ Setup complete. Next:"
echo "    1) Edit .env so T3N_API_KEY + DID are set."
echo "    2) (optional) set OPENAI_API_KEY in .env, then run:"
echo "          npm run blindfold -- register --name openai_api_key --from-env OPENAI_API_KEY"
echo "       …then DELETE OPENAI_API_KEY from .env."
echo "    3) npm run blindfold -- proxy --port 8787"
echo "    4) npm run demo"
