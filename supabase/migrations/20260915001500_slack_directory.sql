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
