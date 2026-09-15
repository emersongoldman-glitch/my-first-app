#!/usr/bin/env bash
# Concatenates every migration + the seed into supabase/bootstrap.sql, so a
# fresh project can be set up by pasting one file into the SQL Editor.
set -euo pipefail
cd "$(dirname "$0")/.."
{
  cat <<'HDR'
-- ============================================================================
-- Campus Rooms — one-shot bootstrap for a fresh Supabase project.
--
-- Paste the whole file into the SQL Editor and hit Run. It is every migration
-- in supabase/migrations/ plus supabase/seed.sql, concatenated in order.
--
-- GENERATED FILE — do not edit. Regenerate with: npm run build:bootstrap
-- For ongoing work use `supabase db push`; this exists so the first setup
-- needs no CLI login and no database password.
-- ============================================================================

HDR
  for f in supabase/migrations/*.sql; do
    printf '\n-- ==== %s ============================================\n\n' "$(basename "$f")"
    cat "$f"
  done
  printf '\n-- ==== seed.sql ====================================================\n\n'
  cat supabase/seed.sql
} > supabase/bootstrap.sql
echo "wrote supabase/bootstrap.sql ($(wc -l < supabase/bootstrap.sql) lines)"
