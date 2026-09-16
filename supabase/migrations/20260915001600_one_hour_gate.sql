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
