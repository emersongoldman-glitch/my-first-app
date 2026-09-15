-- ============================================================================
-- Campus Rooms — UPGRADE: Slack deep links ("Message on Slack").
--
-- For a project that has already run 2026-09-15_phase1d_roles.sql.
-- Paste the whole file into the SQL Editor and Run. Safe to re-run.
--
-- Adds two cache columns on profiles. The lookup itself happens server-side
-- and needs SLACK_BOT_TOKEN + NEXT_PUBLIC_SLACK_TEAM_ID (+ the service role
-- key) set on Vercel — see README "Slack".
--
-- GENERATED from supabase/migrations/20260915001400_slack.sql
-- ============================================================================

-- ==== 20260915001400_slack.sql ============================================

-- ============================================================================
-- Slack deep links.  PLAN.md §5.4 (People)
--
-- Students already talk on Slack; the app does not need its own chat. The
-- People page offers "Message on Slack", which opens a DM with that person.
-- That needs their Slack user id, looked up once by email through a Slack app
-- (server-side, bot token) and cached here.
--
-- Written only by the server route via the service role; RLS lets signed-in
-- users read it, which is fine — everyone is in the same workspace anyway.
-- ============================================================================

alter table profiles
  add column if not exists slack_user_id    text,
  add column if not exists slack_checked_at timestamptz;

comment on column profiles.slack_user_id is
  'Slack member id (U…), cached from users.lookupByEmail. Null = not looked up or not on Slack.';
comment on column profiles.slack_checked_at is
  'When slack_user_id was last looked up; re-checked after 7 days so renames/new accounts catch up.';

-- ==== verification ================================================
-- Expect: slack_columns 2
select count(*) as slack_columns
  from information_schema.columns
 where table_schema = 'public' and table_name = 'profiles'
   and column_name in ('slack_user_id', 'slack_checked_at');
