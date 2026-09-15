#!/usr/bin/env bash
# Generates two files from supabase/migrations/ + supabase/seed.sql:
#   supabase/bootstrap.sql        — schema + seed, for an empty database
#   supabase/reset_bootstrap.sql  — same, preceded by a full wipe of `public`
set -euo pipefail
cd "$(dirname "$0")/.."

emit_body() {
  for f in supabase/migrations/*.sql; do
    printf '\n-- ==== %s ============================================\n\n' "$(basename "$f")"
    cat "$f"
  done
  printf '\n-- ==== seed.sql ====================================================\n\n'
  cat supabase/seed.sql
  cat <<'TAIL'

-- ==== verification ================================================
-- The result grid below is the proof this worked. Expect:
--   rooms 19 | zones 6 | students 55 | pairings 68 | guides 5 | settings 12
select
  (select count(*) from rooms)                     as rooms,
  (select count(*) from zones)                     as zones,
  (select count(distinct match_name) from roster_seed) as students,
  (select count(*) from roster_seed)               as pairings,
  (select count(*) from preferred_names)           as guides,
  (select count(*) from settings)                  as settings;
TAIL
}

{
  cat <<'HDR'
-- ============================================================================
-- Campus Rooms — bootstrap for an EMPTY Supabase project.
--
-- Paste into the SQL Editor and Run. Every migration plus the seed, in order.
-- If you get "relation ... already exists", the database is not empty — use
-- reset_bootstrap.sql instead.
--
-- GENERATED FILE — do not edit. Regenerate: npm run build:bootstrap
-- ============================================================================
HDR
  emit_body
} > supabase/bootstrap.sql

{
  cat <<'HDR'
-- ============================================================================
-- Campus Rooms — RESET and bootstrap.
--
-- ⚠️  DESTRUCTIVE. The first statement drops the entire `public` schema and
-- everything in it: every table, every row, every function and policy. It also
-- removes this app's triggers on auth.users, which depend on those functions.
--
-- Use this ONLY on a project that has no data you care about — typically a
-- fresh project where an earlier run failed partway and left the schema half
-- built. It does NOT delete user accounts in auth.users; those survive, and
-- their profiles rows are rebuilt on next sign-in.
--
-- GENERATED FILE — do not edit. Regenerate: npm run build:bootstrap
-- ============================================================================

drop schema if exists public cascade;
create schema public;

-- Restore the grants Supabase sets up on a new project. These look permissive;
-- row-level security is what actually restricts access, and every table below
-- enables it.
grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on all tables    in schema public to postgres, anon, authenticated, service_role;
grant all on all routines  in schema public to postgres, anon, authenticated, service_role;
grant all on all sequences in schema public to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on routines  to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
HDR
  emit_body
} > supabase/reset_bootstrap.sql

echo "wrote supabase/bootstrap.sql       ($(wc -l < supabase/bootstrap.sql) lines)"
echo "wrote supabase/reset_bootstrap.sql ($(wc -l < supabase/reset_bootstrap.sql) lines)"
