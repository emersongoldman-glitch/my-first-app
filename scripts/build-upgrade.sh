#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=supabase/upgrades/2026-09-15_phase1.sql
{
  sed -n '1,/^-- =*$/p' "$OUT" | head -14   # keep the existing header block
  for f in supabase/migrations/2026091500{0600,0700,0800,0900,1000}_*.sql; do
    printf '\n-- ==== %s ============================================\n\n' "$(basename "$f")"
    cat "$f"
  done
  sed -n '/^-- ==== verification/,$p' "$OUT"
} > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
echo "wrote $OUT ($(wc -l < "$OUT") lines)"
