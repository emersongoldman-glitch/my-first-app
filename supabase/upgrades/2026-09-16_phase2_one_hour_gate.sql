-- ============================================================================
-- Campus Rooms — UPGRADE: approval gate is now 1 hour; Slack approvals.
--
-- For a project that has already run 2026-09-15_phase1f_slack_directory.sql.
-- Paste the whole file into the SQL Editor and Run. Safe to re-run.
--
-- Bookings over 60 minutes need a guide. The guide is DM'd on Slack with
-- Approve / Decline buttons (needs the chat:write scope on the Slack app).
--
-- GENERATED from supabase/migrations/20260915001600_one_hour_gate.sql
-- ============================================================================

-- ==== 20260915001600_one_hour_gate.sql ============================================

-- ============================================================================
-- Approval gate moves from 2 hours to 1 hour.  PLAN.md D14
--
-- The RPCs read this setting at call time, so no function changes are needed.
-- Also records how the guide was notified so the UI can say "messaged Kent
-- on Slack" and the sweep can tell unanswered from unsent.
-- ============================================================================

update settings
   set value = '60',
       note  = 'Over this, a guide must approve (§6.1). Was 120; lowered 2026-09-16 (D14)'
 where key = 'max_self_serve_minutes';

alter table approvals
  add column if not exists notified_via text
    check (notified_via in ('slack', 'email', 'none'));

-- ==== verification ================================================
-- Expect: self_serve_minutes 60 | notified_via_column 1
select
  (select (value #>> '{}')::int from settings where key = 'max_self_serve_minutes') as self_serve_minutes,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'approvals' and column_name = 'notified_via') as notified_via_column;
