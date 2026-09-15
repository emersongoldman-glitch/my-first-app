-- ============================================================================
-- Booking operations.  PLAN.md §6, §7.1
--
-- Every write to bookings goes through these. They are SECURITY DEFINER and
-- the tables have no direct write policies, so a client cannot insert a
-- booking that skips the quota, hours, or duration rules.
--
-- Validation here is advisory; bookings_no_overlap is the wall (§7.1).
-- ============================================================================

-- Approval tokens are minted server-side AFTER the booking exists, by the
-- route that sends the email. A student must never be able to supply or learn
-- the token for their own request — that would let them approve it themselves.
alter table approvals alter column token_hash drop not null;
alter table approvals alter column token_expires drop not null;
alter table approvals add column if not exists sent_at timestamptz;


-- ---------------------------------------------------------------------------
-- Shared validation. Raises on anything the rules forbid.
-- ---------------------------------------------------------------------------
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

  if p_start < now() - interval '5 minutes' then
    raise exception 'That start time is in the past.';
  end if;

  if p_start > now() + (public.setting_int('booking_horizon_days') || ' days')::interval then
    raise exception 'You can only book % days ahead.', public.setting_int('booking_horizon_days');
  end if;

  if not exists (select 1 from public.rooms where id = p_room_id and bookable) then
    raise exception 'That room is not bookable.';
  end if;

  select (value #>> '{}')::time into v_open  from public.settings where key = 'campus_open';
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


-- ---------------------------------------------------------------------------
-- create_booking
--
-- Returns the booking id and whether it needs approval. When it does, the
-- booking is created as 'pending_approval' — which the exclusion constraint
-- treats as occupying the room (§12 D1) — and an approvals row is created with
-- NO token. The token is minted separately by the send-email route.
-- ---------------------------------------------------------------------------
create or replace function create_booking(
  p_room_id     int,
  p_start       timestamptz,
  p_end         timestamptz,
  p_purpose     text default null,
  p_guide_email text default null,
  p_for_user    uuid default null
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
           and upper(during) > now()) >= public.setting_int('max_concurrent_bookings')
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

  insert into public.bookings (room_id, user_id, booked_by, during, purpose, status)
  values (p_room_id, v_user, v_actor, tstzrange(p_start, p_end, '[)'), p_purpose,
          case when v_needs then 'pending_approval' else 'reserved' end)
  returning id into v_id;

  if v_needs then
    insert into public.approvals (booking_id, guide_email, guide_id)
    select v_id, lower(p_guide_email), p.id
      from (select 1) x
      left join public.profiles p on lower(p.email) = lower(p_guide_email);

    -- Remember who they asked, so it pre-fills next time (§6.2). Unconfirmed
    -- until the guide actually answers, so a typo never becomes their default.
    insert into public.guide_mru (user_id, guide_email, guide_id, last_used_at)
    select v_user, lower(p_guide_email), p.id, now()
      from (select 1) x
      left join public.profiles p on lower(p.email) = lower(p_guide_email)
    on conflict (user_id, guide_email) do update
      set use_count = public.guide_mru.use_count + 1, last_used_at = now();
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
-- check_in — opens early, closes at the no-show cutoff (§6.4).
-- ---------------------------------------------------------------------------
create or replace function check_in(p_booking_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare b record;
begin
  select * into b from public.bookings where id = p_booking_id;
  if not found then raise exception 'No such booking.'; end if;

  if b.user_id <> auth.uid() and not public.is_staff() then
    raise exception 'That is not your booking.' using errcode = 'insufficient_privilege';
  end if;

  if b.status = 'checked_in' then return; end if;

  if b.status <> 'reserved' then
    raise exception 'That booking is %, so it cannot be checked in.', b.status;
  end if;

  if now() < lower(b.during) - (public.setting_int('checkin_opens_minutes') || ' minutes')::interval then
    raise exception 'Check-in opens % minutes before the start.',
      public.setting_int('checkin_opens_minutes');
  end if;

  if now() > lower(b.during) + (public.setting_int('no_show_minutes') || ' minutes')::interval then
    raise exception 'That booking was released — it was not checked in within % minutes.',
      public.setting_int('no_show_minutes');
  end if;

  update public.bookings
     set status = 'checked_in', checked_in_at = now()
   where id = p_booking_id;
end $$;


-- ---------------------------------------------------------------------------
-- cancel_booking — owner, or staff override (logged).
-- ---------------------------------------------------------------------------
create or replace function cancel_booking(p_booking_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare b record;
begin
  select * into b from public.bookings where id = p_booking_id;
  if not found then raise exception 'No such booking.'; end if;

  if b.user_id <> auth.uid() and not public.is_staff() then
    raise exception 'That is not your booking.' using errcode = 'insufficient_privilege';
  end if;

  if b.status in ('cancelled','completed','no_show','declined','expired') then
    return;  -- already released; nothing to do
  end if;

  update public.bookings set status = 'cancelled' where id = p_booking_id;

  if b.user_id <> auth.uid() then
    insert into public.audit_log (actor_id, action, booking_id, detail)
    values (auth.uid(), 'force_cancel', p_booking_id, jsonb_build_object('reason', p_reason));
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- extend_booking
--
-- Re-checks the 2-hour gate against the NEW TOTAL length, not the added time
-- (§12 D2). Without that, repeated 30-minute extensions walk straight around
-- the approval requirement.
-- ---------------------------------------------------------------------------
create or replace function extend_booking(p_booking_id uuid, p_new_end timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b        record;
  v_total  int;
  v_selfmax int := public.setting_int('max_self_serve_minutes');
begin
  select * into b from public.bookings where id = p_booking_id;
  if not found then raise exception 'No such booking.'; end if;

  if b.user_id <> auth.uid() and not public.is_staff() then
    raise exception 'That is not your booking.' using errcode = 'insufficient_privilege';
  end if;

  if b.status not in ('reserved','checked_in') then
    raise exception 'That booking is % and cannot be extended.', b.status;
  end if;

  if p_new_end <= upper(b.during) then
    raise exception 'The new end time must be later than the current one.';
  end if;

  v_total := ceil(extract(epoch from (p_new_end - lower(b.during))) / 60)::int;
  perform public.assert_booking_window(b.room_id, lower(b.during), p_new_end, v_total);

  if v_total > v_selfmax and not public.is_staff() then
    raise exception
      'Extending to % minutes would pass the % minute limit — book a new slot with guide approval instead.',
      v_total, v_selfmax;
  end if;

  -- If the room is taken later, the exclusion constraint rejects this.
  update public.bookings
     set during = tstzrange(lower(during), p_new_end, '[)')
   where id = p_booking_id;

  return jsonb_build_object('booking_id', p_booking_id, 'minutes', v_total);
end $$;
