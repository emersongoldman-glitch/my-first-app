-- ============================================================================
-- Campus Rooms — UPGRADE: staff can manage rooms and zones.
--
-- For a project that has already run 2026-09-15_phase1b_horizon.sql.
-- Paste the whole file into the SQL Editor and Run. Safe to re-run.
--
-- Guides and admins can now rename, add, regroup, and retire rooms and zones
-- from the Manage rooms page, so other campuses can set up their own layout.
--
-- GENERATED from supabase/migrations/20260915001200_staff_manage_rooms.sql
-- ============================================================================

-- ==== 20260915001200_staff_manage_rooms.sql ============================================

-- ============================================================================
-- Staff can manage rooms and zones.  PLAN.md §5.7
--
-- Other campuses have different rooms — more pods, no pods, different names.
-- Guides need to rename, add, retire, and regroup them without a developer.
-- Previously admin-only; now any staff member (guide or admin).
--
-- Deleting a room that has bookings is blocked by the FK from bookings; the
-- UI offers "retire" (bookable = false) for that case, which keeps history.
-- ============================================================================

drop policy if exists rooms_admin on rooms;
drop policy if exists zones_admin on zones;

create policy rooms_staff on rooms
  for all to authenticated using (is_staff()) with check (is_staff());

create policy zones_staff on zones
  for all to authenticated using (is_staff()) with check (is_staff());

-- Zones need stable ordering when staff add new ones; default sort to "last".
create or replace function next_zone_sort()
returns smallint language sql stable set search_path = '' as $$
  select coalesce(max(sort), 0) + 10 from public.zones
$$;
alter table zones alter column sort set default next_zone_sort();

create or replace function next_room_sort(p_zone_id int)
returns smallint language sql stable set search_path = '' as $$
  select coalesce(max(sort), 0) + 10 from public.rooms where zone_id = p_zone_id
$$;

-- ==== verification ================================================
-- Expect: staff_policies 2 | admin_only_policies 0 | sort_helpers 2
select
  (select count(*) from pg_policies where policyname in ('rooms_staff','zones_staff'))  as staff_policies,
  (select count(*) from pg_policies where policyname in ('rooms_admin','zones_admin'))  as admin_only_policies,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('next_zone_sort','next_room_sort'))   as sort_helpers;
