-- ============================================================================
-- Campus Rooms — UPGRADE: guides can book (and check in) from 07:30.
--
-- For a project that has already run 2026-09-16_phase2_one_hour_gate.sql.
-- Paste the whole file into the SQL Editor and Run. Safe to re-run.
--
-- Students still start at 08:00. One setting (staff_campus_open) and the
-- hours check reads it for staff only.
--
-- GENERATED from supabase/migrations/20260915001700_staff_early_open.sql
-- ============================================================================

-- ==== 20260915001700_staff_early_open.sql ============================================

-- ============================================================================
-- Staff can book (and so check in) from 07:30; students still from 08:00.
-- PLAN.md D16
--
-- One new setting, and assert_booking_window reads it for staff. Re-declared
-- from 1100 with only that change, because 1100 is already applied live.
-- ============================================================================

insert into settings (key, value, note) values
  ('staff_campus_open', '"07:30"', 'Guides/admins may start bookings from here; students use campus_open (D16)')
on conflict (key) do update set value = excluded.value, note = excluded.note;

-- ==== assert_booking_window (staff open time) ====
create or replace function assert_booking_window(
  p_room_id int, p_start timestamptz, p_end timestamptz, p_minutes int
) returns void language plpgsql stable security definer set search_path = '' as $$
declare
  v_open   time;
  v_close  time;
  v_days   int[];
  v_slot   int := public.setting_int('slot_minutes');
  v_min    int := public.setting_int('min_booking_minutes');
  v_days_j jsonb;
begin
  if p_end <= p_start then
    raise exception 'The end time must be after the start time.';
  end if;

  if p_minutes < v_min then
    raise exception 'Bookings are at least % minutes.', v_min;
  end if;

  if p_minutes % v_slot <> 0 then
    raise exception 'Bookings must be in % minute steps.', v_slot;
  end if;

  if p_start < public.app_now() - interval '5 minutes' then
    raise exception 'That start time is in the past.';
  end if;

  -- Students book when they need a room, not days out (D10). Staff are exempt
  -- so a guide can still hold a conference room for a scheduled session.
  if not public.is_staff()
     and p_start > public.app_now() + make_interval(mins => public.setting_int('booking_horizon_minutes')) then
    raise exception 'You can book up to % hours ahead.',
      public.setting_int('booking_horizon_minutes') / 60;
  end if;

  if not exists (select 1 from public.rooms where id = p_room_id and bookable) then
    raise exception 'That room is not bookable.';
  end if;

  -- Staff may start earlier than students (D16): 07:30 vs 08:00 by default.
  select (value #>> '{}')::time into v_open
    from public.settings
   where key = case when public.is_staff() then 'staff_campus_open' else 'campus_open' end;
  if v_open is null then
    select (value #>> '{}')::time into v_open from public.settings where key = 'campus_open';
  end if;
  select (value #>> '{}')::time into v_close from public.settings where key = 'campus_close';
  select value into v_days_j from public.settings where key = 'campus_days';
  select array(select jsonb_array_elements_text(v_days_j)::int) into v_days;

  -- A booking must sit inside one campus day. Times are compared in the
  -- campus's own timezone, not UTC, or an afternoon booking reads as next day.
  if extract(isodow from p_start at time zone 'America/Chicago')::int <> all(v_days) then
    raise exception 'Campus is closed that day.';
  end if;

  if (p_start at time zone 'America/Chicago')::time < v_open
     or (p_end at time zone 'America/Chicago')::time > v_close then
    raise exception 'Bookings must be between % and %.', v_open, v_close;
  end if;

  if (p_start at time zone 'America/Chicago')::date
     <> (p_end at time zone 'America/Chicago' - interval '1 microsecond')::date then
    raise exception 'A booking cannot span two days.';
  end if;
end $$;

-- ==== verification ================================================
-- Expect: staff_open "07:30" | student_open "08:00"
select
  (select value #>> '{}' from settings where key = 'staff_campus_open') as staff_open,
  (select value #>> '{}' from settings where key = 'campus_open')       as student_open;
