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
