-- ============================================================================
-- Campus Rooms — UPGRADE: Slack workspace directory for People search.
--
-- For a project that has already run 2026-09-15_phase1e_slack.sql.
-- Paste the whole file into the SQL Editor and Run. Safe to re-run.
--
-- People search now finds anyone in the campus Slack, not only people who
-- have signed into the app. The server caches users.list here (no emails
-- stored) and refreshes it when older than ~6 hours.
--
-- GENERATED from supabase/migrations/20260915001500_slack_directory.sql
-- ============================================================================

-- ==== 20260915001500_slack_directory.sql ============================================

-- ============================================================================
-- Slack workspace directory.  PLAN.md §5.4, D12
--
-- People search should find anyone in the campus Slack, not only people who
-- have signed into this app. The server pulls users.list, matches members to
-- profiles by email, and caches the result here. Refreshed when older than
-- ~6 hours, on demand from the search route.
--
-- No emails are stored: matching happens at sync time and only the resulting
-- profile_id is kept. Bots, apps, and deactivated accounts are excluded.
-- ============================================================================

create table if not exists slack_directory (
  slack_user_id text primary key,
  real_name     text not null,
  display_name  text,
  title         text,
  avatar_url    text,
  profile_id    uuid references profiles on delete set null,
  updated_at    timestamptz not null default now()
);

create index if not exists slack_directory_profile_idx on slack_directory (profile_id);
create index if not exists slack_directory_name_idx on slack_directory (lower(real_name));

alter table slack_directory enable row level security;

-- The same people can already see each other in Slack itself.
create policy slack_directory_read on slack_directory
  for select to authenticated using (true);
-- Writes happen only through the service role (the sync in /api/slack/search).

-- ==== verification ================================================
-- Expect: table_exists 1 | rls_on true | read_policy 1
select
  (select count(*) from information_schema.tables where table_schema='public' and table_name='slack_directory') as table_exists,
  (select relrowsecurity from pg_class where relname='slack_directory')                                            as rls_on,
  (select count(*) from pg_policies where tablename='slack_directory')                                            as read_policy;
