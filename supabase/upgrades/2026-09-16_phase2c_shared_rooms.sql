-- ============================================================================
-- Campus Rooms — UPGRADE: conference rooms booked by seat; upstairs; new sizes.
--
-- For a project that has already run 2026-09-16_phase2b_staff_early_open.sql.
-- Paste the whole file into the SQL Editor and Run. Safe to re-run.
--
-- Conference rooms become "shared": several people can book at once until
-- the seats run out, enforced in the database. Conf 1 & 2 = 4 seats,
-- Conf 3 = 8, Conf 4 stays 6. The Conference zone moves to the 2nd floor.
--
-- GENERATED from supabase/migrations/20260915001800_shared_rooms.sql
-- ============================================================================

-- ==== 20260915001800_shared_rooms.sql ============================================

-- ============================================================================
-- Shared rooms: several people can book the same room at once, by seat.
-- PLAN.md D17
--
-- Pods stay exclusive (one booking at a time). A room marked `shared` is
-- booked by seats: overlapping bookings are fine until the seats run out.
-- The seat count is enforced in the database under a per-room lock, so two
-- people cannot both take the last seat — the same guarantee the exclusion
-- constraint gives pods (§7.1).
-- ============================================================================

alter table rooms    add column if not exists shared    boolean  not null default false;
alter table bookings add column if not exists seats     smallint not null default 1 check (seats >= 1);
alter table bookings add column if not exists exclusive boolean  not null default true;

comment on column rooms.shared is 'Booked by seat (overlapping bookings allowed up to capacity) rather than exclusively.';
comment on column bookings.exclusive is 'Copied from rooms.shared at write time; the exclusion constraint applies only when true.';


-- ---------------------------------------------------------------------------
-- 1. Copy the room's mode onto the booking. Named with a leading "a_" so it
--    fires before the capacity check (triggers fire alphabetically).
-- ---------------------------------------------------------------------------
create or replace function a_bookings_set_exclusive()
returns trigger language plpgsql set search_path = '' as $$
begin
  select not shared into new.exclusive from public.rooms where id = new.room_id;
  if new.exclusive is null then new.exclusive := true; end if;
  return new;
end $$;

drop trigger if exists a_bookings_set_exclusive on bookings;
create trigger a_bookings_set_exclusive
  before insert or update of room_id on bookings
  for each row execute function a_bookings_set_exclusive();


-- ---------------------------------------------------------------------------
-- 2. Seat capacity for shared rooms.
--
-- The advisory lock serialises writers for one room inside the transaction,
-- so the sum below cannot race: the second writer waits, then sees the first
-- writer's committed row.
-- ---------------------------------------------------------------------------
create or replace function b_bookings_check_capacity()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_cap   int;
  v_taken int;
begin
  if new.exclusive or new.status not in ('pending_approval','reserved','checked_in') then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('room-seats'), new.room_id);

  select capacity into v_cap from public.rooms where id = new.room_id;
  if new.seats > v_cap then
    raise exception 'That room only has % seats.', v_cap;
  end if;

  select coalesce(sum(seats), 0) into v_taken
    from public.bookings b
   where b.room_id = new.room_id
     and b.id <> new.id
     and b.status in ('pending_approval','reserved','checked_in')
     and b.during && new.during;

  if v_taken + new.seats > v_cap then
    raise exception 'Only % of % seats are free then.', v_cap - v_taken, v_cap
      using errcode = 'exclusion_violation';   -- 23P01, same class as a pod clash
  end if;
  return new;
end $$;

drop trigger if exists b_bookings_check_capacity on bookings;
create trigger b_bookings_check_capacity
  before insert or update of during, seats, status, room_id on bookings
  for each row execute function b_bookings_check_capacity();


-- ---------------------------------------------------------------------------
-- 3. The exclusion constraint now applies to exclusive bookings only.
-- ---------------------------------------------------------------------------
alter table bookings drop constraint if exists bookings_no_overlap;
alter table bookings add constraint bookings_no_overlap
  exclude using gist (room_id with =, during with &&)
  where (status in ('pending_approval','reserved','checked_in') and exclusive);


-- ---------------------------------------------------------------------------
-- 4. create_booking takes seats. The old 6-argument signature must go, or
--    PostgREST sees two overloads and refuses to pick one.
-- ---------------------------------------------------------------------------
drop function if exists create_booking(int, timestamptz, timestamptz, text, text, uuid);

create or replace function create_booking(
  p_room_id     int,
  p_start       timestamptz,
  p_end         timestamptz,
  p_purpose     text default null,
  p_guide_email text default null,
  p_for_user    uuid default null,
  p_seats       int  default 1
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor    uuid := auth.uid();
  v_user     uuid;
  v_minutes  int;
  v_selfmax  int := public.setting_int('max_self_serve_minutes');
  v_appmax   int := public.setting_int('max_approved_minutes');
  v_needs    boolean;
  v_id       uuid;
  v_daily    int;
  v_staff    boolean;
begin
  if v_actor is null then
    raise exception 'You must be signed in.' using errcode = 'insufficient_privilege';
  end if;

  v_staff := public.is_staff();
  v_user  := coalesce(p_for_user, v_actor);

  -- Only staff may book on someone else's behalf.
  if v_user <> v_actor and not v_staff then
    raise exception 'You can only book for yourself.' using errcode = 'insufficient_privilege';
  end if;

  if p_seats is null or p_seats < 1 then
    raise exception 'Seats must be at least 1.';
  end if;

  v_minutes := ceil(extract(epoch from (p_end - p_start)) / 60)::int;
  perform public.assert_booking_window(p_room_id, p_start, p_end, v_minutes);

  -- Guides are trusted with length; students are not (§6.1).
  v_needs := (v_minutes > v_selfmax) and not v_staff;

  if v_minutes > v_appmax then
    raise exception 'The longest possible booking is % hours.', v_appmax / 60;
  end if;

  if v_needs and (p_guide_email is null or p_guide_email !~* '@alpha\.school$') then
    raise exception 'Bookings over % minutes need a guide''s approval — enter their @alpha.school email.', v_selfmax;
  end if;

  -- Quotas apply to students only, and only to bookings they hold themselves.
  if not v_staff then
    if (select count(*) from public.bookings
         where user_id = v_user
           and status in ('pending_approval','reserved','checked_in')
           and upper(during) > public.app_now()) >= public.setting_int('max_concurrent_bookings')
    then
      raise exception 'You already have % upcoming bookings.',
        public.setting_int('max_concurrent_bookings');
    end if;

    select coalesce(sum(extract(epoch from (upper(during) - lower(during))) / 3600), 0)::int
      into v_daily
      from public.bookings
     where user_id = v_user
       and status in ('reserved','checked_in')
       and (lower(during) at time zone 'America/Chicago')::date
           = (p_start at time zone 'America/Chicago')::date;

    if v_daily + (v_minutes / 60.0) > public.setting_int('max_daily_hours') and not v_needs then
      raise exception 'That would put you over % booked hours for the day.',
        public.setting_int('max_daily_hours');
    end if;
  end if;

  insert into public.bookings (room_id, user_id, booked_by, during, purpose, status, seats)
  values (p_room_id, v_user, v_actor, tstzrange(p_start, p_end, '[)'), p_purpose,
          case when v_needs then 'pending_approval' else 'reserved' end, p_seats)
  returning id into v_id;

  if v_needs then
    insert into public.approvals (booking_id, guide_email, guide_id)
    select v_id, lower(p_guide_email), p.id
      from (select 1) x
      left join public.profiles p on lower(p.email) = lower(p_guide_email);

    -- Remember who they asked, so it pre-fills next time (§6.2). Unconfirmed
    -- until the guide actually answers, so a typo never becomes their default.
    insert into public.guide_mru (user_id, guide_email, guide_id, last_used_at)
    select v_user, lower(p_guide_email), p.id, public.app_now()
      from (select 1) x
      left join public.profiles p on lower(p.email) = lower(p_guide_email)
    on conflict (user_id, guide_email) do update
      set use_count = public.guide_mru.use_count + 1, last_used_at = public.app_now();
  end if;

  if v_actor <> v_user then
    insert into public.audit_log (actor_id, action, booking_id, detail)
    values (v_actor, 'book_for', v_id, jsonb_build_object('for_user', v_user));
  end if;

  return jsonb_build_object(
    'booking_id', v_id,
    'needs_approval', v_needs,
    'status', case when v_needs then 'pending_approval' else 'reserved' end
  );
end $$;


-- ---------------------------------------------------------------------------
-- 5. Alpha's conference rooms: shared, upstairs, real seat counts.
--    Room 4 was not specified; left at 6.
-- ---------------------------------------------------------------------------
update rooms set shared = true where kind = 'conference';
update rooms set capacity = 4 where slug in ('conf-1', 'conf-2');
update rooms set capacity = 8 where slug = 'conf-3';
update zones set floor = 2 where name = 'Conference';

-- ==== verification ================================================
-- Expect: shared_rooms 4 | conf3_seats 8 | conf1_seats 4 | conference_floor 2 | create_booking_overloads 1
select
  (select count(*) from rooms where shared)                                        as shared_rooms,
  (select capacity from rooms where slug = 'conf-3')                               as conf3_seats,
  (select capacity from rooms where slug = 'conf-1')                               as conf1_seats,
  (select floor from zones where name = 'Conference')                              as conference_floor,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_booking')                   as create_booking_overloads;
