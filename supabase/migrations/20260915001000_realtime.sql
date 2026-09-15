-- ============================================================================
-- Realtime. The board subscribes to changes on bookings and presence so two
-- students never both see a pod as open (PLAN.md §8).
--
-- Supabase only broadcasts tables in the `supabase_realtime` publication, and
-- new tables are not in it by default. RLS still applies to the events a
-- client receives, so the existing read policies are what gate them.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bookings'
    ) then
      alter publication supabase_realtime add table public.bookings;
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'presence'
    ) then
      alter publication supabase_realtime add table public.presence;
    end if;
  else
    raise notice 'No supabase_realtime publication (local test database) — skipping.';
  end if;
end $$;

-- Realtime needs the full old row to evaluate RLS on UPDATE/DELETE events.
alter table bookings replica identity full;
alter table presence replica identity full;
