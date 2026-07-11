#!/usr/bin/env bash
# Sync the canonical Blindfold agent skill to its other copies, so they can't
# drift. Canonical source: .claude/skills/blindfold/SKILL.md
set -euo pipefail
cd "$(dirname "$0")/.."

CANON=".claude/skills/blindfold/SKILL.md"
[ -f "$CANON" ] || { echo "✖ canonical skill missing: $CANON" >&2; exit 1; }

# Repo copies (tracked or gitignored) + the packaged asset + the user-global copy.
TARGETS=(
  ".opencode/skills/blindfold/SKILL.md"
  "packages/blindfold/assets/SKILL.md"
  "$HOME/.claude/skills/blindfold/SKILL.md"
)

for t in "${TARGETS[@]}"; do
  if [ -d "$(dirname "$t")" ] || mkdir -p "$(dirname "$t")" 2>/dev/null; then
    if cp "$CANON" "$t" 2>/dev/null; then echo "✓ synced $t"; else echo "· skipped $t (not writable)"; fi
  fi
done
echo "Done. Canonical: $CANON"
