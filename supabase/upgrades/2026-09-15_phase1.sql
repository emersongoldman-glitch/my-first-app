-- ============================================================================
-- Campus Rooms — UPGRADE an existing project from Phase 0 to Phase 1.
--
-- For a database that already has migrations 0100–0500 applied (the original
-- bootstrap). Paste the whole file into the SQL Editor and Run. Safe to re-run:
-- everything is CREATE OR REPLACE, IF NOT EXISTS, or guarded.
--
-- Adds: booking RPCs, approvals + tokens, sweeps (pg_cron), grant hardening,
-- realtime publication.
--
-- GENERATED — regenerate with: bash scripts/build-upgrade.sh
-- ============================================================================

-- ==== 20260915000600_booking_rpcs.sql ============================================

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

-- ==== 20260915000700_approvals_and_sweeps.sql ============================================

-- ============================================================================
-- Approval decisions and the release sweeps.  PLAN.md §6.1, §6.4
-- ============================================================================

-- ---------------------------------------------------------------------------
-- pgcrypto wrappers.
--
-- Supabase installs pgcrypto into the `extensions` schema; a stock Postgres
-- puts it in `public`. Every function here runs with search_path = '' for
-- safety, so neither location resolves by bare name. These two wrappers pin a
-- search_path covering both, and everything else calls through them.
-- ---------------------------------------------------------------------------
create or replace function sha256_hex(p_text text)
returns text language sql immutable security definer
set search_path = extensions, public, pg_catalog as $$
  select encode(digest(p_text, 'sha256'), 'hex')
$$;

create or replace function random_token()
returns text language sql volatile security definer
set search_path = extensions, public, pg_catalog as $$
  select encode(gen_random_bytes(32), 'hex')
$$;

revoke all on function random_token() from public, anon, authenticated;


-- Which JWT role is calling — 'anon', 'authenticated', 'service_role', or
-- null when there is no JWT at all (SQL editor, migrations, pg_cron). Reads
-- both claim shapes PostgREST has used, the way Supabase's own auth.role() does.
create or replace function jwt_role()
returns text language sql stable set search_path = '' as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )
$$;


-- ---------------------------------------------------------------------------
-- mint_approval_token
--
-- Service-role only: called by the route that sends the email, never by a
-- browser. Returns the RAW token exactly once; only its SHA-256 is stored, so
-- a leaked database row cannot be used to approve anything.
--
-- Crucially, the student never sees this. If they could mint or read the token
-- for their own request they could approve it themselves, and the whole
-- 2-hour gate would be decorative.
-- ---------------------------------------------------------------------------
create or replace function mint_approval_token(p_booking_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_token text;
  v_ttl   interval := interval '14 days';
begin
  -- Only the service role (the send-email route) or a direct connection with
  -- no JWT (dashboard, cron) may mint. A signed-in user never can.
  if public.jwt_role() in ('anon', 'authenticated') then
    raise exception 'Not permitted.' using errcode = 'insufficient_privilege';
  end if;

  v_token := public.random_token();

  update public.approvals
     set token_hash    = public.sha256_hex(v_token),
         token_expires = least(now() + v_ttl,
                               (select lower(during) from public.bookings
                                 where id = p_booking_id)),
         sent_at       = now()
   where booking_id = p_booking_id;

  if not found then raise exception 'No approval request for that booking.'; end if;
  return v_token;
end $$;

revoke all on function mint_approval_token(uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Apply a decision. Shared by the emailed-link path and the in-app inbox.
-- ---------------------------------------------------------------------------
create or replace function apply_decision(
  p_booking_id uuid, p_decision text, p_decided_by uuid, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare a record; b record;
begin
  -- Belt and braces: EXECUTE is revoked from clients below, but a signed-in
  -- non-staff caller must fail here too, so a future grant slip cannot let a
  -- student approve their own request.
  if public.jwt_role() in ('anon', 'authenticated') and not public.is_staff() then
    raise exception 'Not permitted.' using errcode = 'insufficient_privilege';
  end if;

  select * into a from public.approvals where booking_id = p_booking_id;
  if not found then raise exception 'No approval request for that booking.'; end if;

  select * into b from public.bookings where id = p_booking_id;

  -- Already answered: report the standing decision rather than flipping it.
  -- Guides click these links twice; the second click must not undo the first.
  if a.decision is not null then
    return jsonb_build_object('booking_id', p_booking_id, 'decision', a.decision,
                              'already_decided', true);
  end if;

  if b.status <> 'pending_approval' then
    return jsonb_build_object('booking_id', p_booking_id, 'decision', null,
                              'already_decided', true, 'booking_status', b.status);
  end if;

  update public.approvals
     set decision = p_decision, decided_by = p_decided_by,
         decided_at = now(), reason = p_reason
   where booking_id = p_booking_id;

  -- 'declined' sits outside the exclusion constraint, so the room frees the
  -- instant this commits — no sweep needed (§7.1).
  update public.bookings
     set status = case when p_decision = 'approved' then 'reserved' else 'declined' end
   where id = p_booking_id;

  -- Only an answered request promotes a guide to the student's default (§12 D7).
  if p_decision is not null then
    update public.guide_mru
       set confirmed = true
     where user_id = b.user_id and guide_email = a.guide_email;
  end if;

  return jsonb_build_object('booking_id', p_booking_id, 'decision', p_decision,
                            'already_decided', false);
end $$;

-- Internal. Without this a signed-in student could call it directly via RPC
-- and approve their own request, bypassing the token entirely.
revoke all on function apply_decision(uuid, text, uuid, text) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- decide_by_token — the emailed link. No sign-in required, by design: a guide
-- answering from their phone between sessions will not stop to log in, and an
-- unanswered request holds a room.
-- ---------------------------------------------------------------------------
create or replace function decide_by_token(
  p_token text, p_decision text, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare a record;
begin
  if p_decision not in ('approved','declined') then
    raise exception 'Decision must be approved or declined.';
  end if;

  select * into a from public.approvals
   where token_hash = public.sha256_hex(p_token);

  if not found then
    raise exception 'That approval link is not valid.' using errcode = 'insufficient_privilege';
  end if;

  if a.token_expires is not null and now() > a.token_expires then
    raise exception 'That approval link has expired.' using errcode = 'insufficient_privilege';
  end if;

  return public.apply_decision(a.booking_id, p_decision, a.guide_id, p_reason);
end $$;

revoke all on function decide_by_token(text, text, text) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- decide_as_guide — the in-app inbox.
--
-- Any guide may answer any request, not only the one it was addressed to
-- (§12 D3): a room should not stay held because someone is out. Answering
-- for a colleague is logged.
-- ---------------------------------------------------------------------------
create or replace function decide_as_guide(
  p_booking_id uuid, p_decision text, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare a record; v_result jsonb;
begin
  if not public.is_staff() then
    raise exception 'Only guides can answer approval requests.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_decision not in ('approved','declined') then
    raise exception 'Decision must be approved or declined.';
  end if;

  select * into a from public.approvals where booking_id = p_booking_id;
  if not found then raise exception 'No approval request for that booking.'; end if;

  v_result := public.apply_decision(p_booking_id, p_decision, auth.uid(), p_reason);

  if a.guide_id is distinct from auth.uid() and not (v_result->>'already_decided')::boolean then
    insert into public.audit_log (actor_id, action, booking_id, detail)
    values (auth.uid(), 'override_approve', p_booking_id,
            jsonb_build_object('addressed_to', a.guide_email, 'decision', p_decision));
  end if;

  return v_result;
end $$;


-- ============================================================================
-- Sweeps. Run every minute by pg_cron.
-- ============================================================================

-- Release bookings nobody showed up for (§6.4). This is the rule that keeps
-- the board honest: a room that reads as taken but sits empty is worse than
-- having no booking system at all.
create or replace function release_no_shows()
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  with released as (
    update public.bookings
       set status = 'no_show'
     where status = 'reserved'
       and now() > lower(during) + (public.setting_int('no_show_minutes') || ' minutes')::interval
    returning 1
  ) select count(*) into n from released;
  return n;
end $$;

-- An unanswered request cannot hold a room past the time it was for (§6.1).
create or replace function expire_pending_approvals()
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  with expired as (
    update public.bookings
       set status = 'expired'
     where status = 'pending_approval' and now() >= lower(during)
    returning id
  )
  update public.approvals a set decided_at = now()
    from expired e where a.booking_id = e.id and a.decision is null;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function complete_finished_bookings()
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  with done as (
    update public.bookings set status = 'completed'
     where status = 'checked_in' and now() > upper(during)
    returning 1
  ) select count(*) into n from done;
  return n;
end $$;

create or replace function run_sweeps()
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'no_shows',  public.release_no_shows(),
    'expired',   public.expire_pending_approvals(),
    'completed', public.complete_finished_bookings()
  )
$$;

revoke all on function run_sweeps()                  from public, anon, authenticated;
revoke all on function release_no_shows()            from public, anon, authenticated;
revoke all on function expire_pending_approvals()    from public, anon, authenticated;
revoke all on function complete_finished_bookings()  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Schedule it. pg_cron may not exist on every plan; the app also exposes a
-- /api/cron route so an external scheduler can drive the same function.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('campus-rooms-sweeps', '* * * * *', 'select public.run_sweeps()');
  else
    raise notice 'pg_cron unavailable — drive /api/cron externally instead.';
  end if;
exception when others then
  raise notice 'Could not schedule sweeps (%). Drive /api/cron externally.', sqlerrm;
end $$;

-- ==== 20260915000800_fix_role_guard.sql ============================================

-- ============================================================================
-- Fix: the role-change guard blocked bootstrapping the first admin.
--
-- guard_role_change() refused any role change unless is_admin() — but with no
-- admins yet, nothing could make one. The SQL Editor, migrations, and the
-- service role all run without a user JWT, so auth.uid() is null there.
-- Treat "no signed-in user" as trusted; keep blocking signed-in non-admins.
-- ============================================================================
create or replace function guard_role_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null        -- a real API user, not dashboard/service role
     and not public.is_admin() then
    raise exception 'Only an admin can change a role.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- ==== 20260915000900_harden_grants.sql ============================================

-- ============================================================================
-- Functions a client must never call directly.
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and PostgREST
-- exposes every public function as an RPC. Anything SECURITY DEFINER that is
-- not meant as an entry point has to be revoked explicitly or it is an
-- unauthenticated back door.
-- ============================================================================

-- Links a roster row to any user id you pass. Admin-only via a future wrapper.
revoke all on function link_roster_student(uuid, text) from public, anon, authenticated;

-- Pure helpers; harmless, but no reason to expose them as RPCs either.
revoke all on function sha256_hex(text) from public, anon, authenticated;
revoke all on function setting_int(text) from public, anon, authenticated;

-- Sanity check, so a future migration cannot quietly regress this.
-- Every SECURITY DEFINER function in public that anon/authenticated CAN
-- execute must be on this allow-list of intended entry points.
do $$
declare
  v_bad text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and p.prorettype <> 'trigger'::regtype
     and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
          or has_function_privilege('anon', p.oid, 'EXECUTE'))
     and p.proname not in (
       -- intended client entry points
       'create_booking', 'check_in', 'cancel_booking', 'extend_booking',
       'decide_as_guide',
       -- read-only role/display helpers used by RLS policies and views
       'is_staff', 'is_admin', 'current_role_is', 'display_of',
       'assert_booking_window'
     );
  if v_bad is not null then
    raise exception 'SECURITY DEFINER functions exposed to clients without review: %', v_bad;
  end if;
end $$;

-- ==== 20260915001000_realtime.sql ============================================

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

-- ==== verification ================================================
-- Expect: rpcs_installed 8 | realtime_tables 2 | pg_cron_enabled 1 | exposed_internals 0
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('create_booking','check_in','cancel_booking','extend_booking',
       'mint_approval_token','decide_by_token','decide_as_guide','run_sweeps')) as rpcs_installed,
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename in ('bookings','presence'))   as realtime_tables,
  (select count(*) from pg_extension where extname = 'pg_cron')                    as pg_cron_enabled,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('apply_decision','mint_approval_token','decide_by_token','run_sweeps','link_roster_student')
      and has_function_privilege('authenticated', p.oid, 'EXECUTE'))               as exposed_internals;
