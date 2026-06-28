#!/usr/bin/env bash
# Three real providers, three auth styles, one pattern — secrets never in your shell.
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "▶ Deepgram  (Authorization: Token):"
npm run -s blindfold -- use --name deepgram_api_key --as DG -- bash -c \
  'curl -s -w "  HTTP %{http_code}\n" -H "Authorization: Token $DG" https://api.deepgram.com/v1/projects | head -c 200; echo'
echo

echo "▶ Blogger   (?key= query param):"
npm run -s blindfold -- use --name blogger_api_key --as K -- bash -c \
  'curl -s "https://www.googleapis.com/blogger/v3/blogs/2399953?key=$K" | python3 -c "import sys,json;d=json.load(sys.stdin);print(\"  \",d[\"name\"],\"·\",d[\"posts\"][\"totalItems\"],\"posts ·\",d[\"url\"])" 2>/dev/null || echo "  (set a valid Blogger blog id / enable the Blogger API)"'
echo

echo "▶ Hostinger (Authorization: Bearer):"
npm run -s blindfold -- use --name hostinger_api_key --as TOK -- bash -c \
  'curl -s -w "  HTTP %{http_code}\n" -H "Authorization: Bearer $TOK" https://developers.hostinger.com/api/vps/v1/virtual-machines | head -c 200; echo'
echo
echo "✓ Done. None of these tokens were ever in your shell, history, or .env."
