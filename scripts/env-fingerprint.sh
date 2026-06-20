#!/usr/bin/env bash
# Print a SAFE fingerprint of every KEY=VALUE line in .env (or any file
# you pass). No full values. Output is safe to paste into chat, share
# with a coding agent, log to CI, etc.
#
#   ./scripts/env-fingerprint.sh                # uses .env
#   ./scripts/env-fingerprint.sh some.env       # any path
#
# Format per line:  <KEY> = <first3>…<last2>  (<n> bytes)
# - keys whose value is <= 8 bytes are shown as "<N bytes>" (no edges) to avoid revealing the whole value
# - empty / comment lines are skipped
# - this is what you give to me (Claude) instead of pasting raw values

set -euo pipefail

ENVFILE="${1:-.env}"
if [ ! -f "$ENVFILE" ]; then
  echo "✖ $ENVFILE not found" >&2
  exit 1
fi

awk -F= '
  /^[[:space:]]*$/ { next }
  /^[[:space:]]*#/ { next }
  /=/ {
    key = $1
    val = substr($0, length(key) + 2)
    # strip surrounding quotes
    gsub(/^"|"$/, "", val)
    gsub(/^'\''|'\''$/, "", val)
    n = length(val)
    if (n == 0) {
      printf "  %-20s = (empty)\n", key
    } else if (n <= 8) {
      printf "  %-20s = <%d bytes>\n", key, n
    } else {
      printf "  %-20s = %s…%s  (%d bytes)\n", key, substr(val,1,3), substr(val,n-1), n
    }
  }
' "$ENVFILE"
