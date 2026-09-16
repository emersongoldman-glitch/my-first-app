-- ============================================================================
-- Campus Rooms — RESET and bootstrap.
--
-- ⚠️  DESTRUCTIVE. The first statement drops the entire `public` schema and
-- everything in it: every table, every row, every function and policy. It also
-- removes this app's triggers on auth.users, which depend on those functions.
--
-- Use this ONLY on a project that has no data you care about — typically a
-- fresh project where an earlier run failed partway and left the schema half
-- built. It does NOT delete user accounts in auth.users; those survive, and
-- their profiles rows are rebuilt on next sign-in.
--
-- GENERATED FILE — do not edit. Regenerate: npm run build:bootstrap
-- ============================================================================

drop schema if exists public cascade;
create schema public;

-- Restore the grants Supabase sets up on a new project. These look permissive;
-- row-level security is what actually restricts access, and every table below
-- enables it.
grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on all tables    in schema public to postgres, anon, authenticated, service_role;
grant all on all routines  in schema public to postgres, anon, authenticated, service_role;
grant all on all sequences in schema public to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on routines  to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;

-- ==== 20260915000100_foundation.sql ============================================

-- ============================================================================
-- Foundation: extensions, profiles, and the @alpha.school boundary.
-- PLAN.md §7, §8 (Auth)
-- ============================================================================

create extension if not exists btree_gist;   -- required by the bookings exclusion constraint
create extension if not exists pgcrypto;     -- gen_random_uuid, digest


-- ---------------------------------------------------------------------------
-- profiles: one row per authenticated user.
--
-- display_name exists because Google returns whatever name is on the account,
-- which is not always the name people use (PLAN.md §12 D9). Every surface that
-- renders a person reads display_name first.
-- ---------------------------------------------------------------------------
create table profiles (
  id            uuid primary key references auth.users on delete cascade,
  email         text not null unique,
  full_name     text not null,
  display_name  text,
  avatar_url    text,
  role          text not null default 'student'
                  check (role in ('student','guide','admin')),
  visible       boolean not null default true,   -- opt out of the People board (§9)
  created_at    timestamptz not null default now()
);

comment on column profiles.display_name is
  'Preferred name. Overrides full_name everywhere in the UI. Seeded, not opt-in.';

-- The name to show, everywhere. Never render full_name directly.
create or replace function display_of(p profiles)
returns text language sql immutable as $$
  select coalesce(nullif(trim(p.display_name), ''), p.full_name)
$$;


-- ---------------------------------------------------------------------------
-- Preferred names, applied on sign-in before anyone has to find a setting.
-- Populated by the seed; see supabase/seed.sql.
-- ---------------------------------------------------------------------------
create table preferred_names (
  email        text primary key check (email ilike '%@alpha.school'),
  display_name text not null
);


-- ---------------------------------------------------------------------------
-- The domain boundary.
--
-- The OAuth `hd=alpha.school` parameter is a client-side hint and is trivially
-- spoofable. This trigger is the actual check (PLAN.md §12 D4). It runs before
-- any row reaches auth.users, so a non-school Google account cannot create an
-- account at all.
-- ---------------------------------------------------------------------------
create or replace function enforce_school_domain()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.email is null or lower(new.email) not like '%@alpha.school' then
    raise exception 'Sign-in is limited to @alpha.school accounts.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists enforce_school_domain_on_signup on auth.users;
create trigger enforce_school_domain_on_signup
  before insert on auth.users
  for each row execute function enforce_school_domain();


-- ---------------------------------------------------------------------------
-- Mirror a new auth.users row into profiles, applying any preferred name.
-- ---------------------------------------------------------------------------
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_full    text;
  v_display text;
begin
  v_full := coalesce(
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    split_part(new.email, '@', 1)
  );

  select pn.display_name into v_display
    from public.preferred_names pn
   where lower(pn.email) = lower(new.email);

  insert into public.profiles (id, email, full_name, display_name, avatar_url)
  values (
    new.id,
    lower(new.email),
    v_full,
    v_display,
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();


-- ---------------------------------------------------------------------------
-- Role helpers, used throughout the RLS policies.
-- ---------------------------------------------------------------------------
create or replace function current_role_is(p_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and role = any(p_roles)
  )
$$;

-- These are called from inside SECURITY DEFINER functions that set an empty
-- search_path, and that empty path propagates into whatever they call. So the
-- call below MUST be schema-qualified and these must pin their own path too —
-- otherwise the name fails to resolve at runtime, not at creation time.
create or replace function is_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.current_role_is(array['guide','admin'])
$$;

create or replace function is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.current_role_is(array['admin'])
$$;

-- ==== 20260915000200_rooms.sql ============================================

-- ============================================================================
-- Zones, rooms, and configurable settings.  PLAN.md §4, §6
-- ============================================================================

create table zones (
  id    serial primary key,
  name  text not null unique,
  floor smallint not null default 1,
  sort  smallint not null default 0
);

create table rooms (
  id          serial primary key,
  slug        text not null unique,
  name        text not null,
  zone_id     int  not null references zones,
  capacity    smallint not null default 1,
  kind        text not null default 'pod'
                check (kind in ('pod','conference','special')),
  max_minutes smallint,        -- null => fall back to the global setting
  bookable    boolean not null default true,
  sort        smallint not null default 0
);

create index on rooms (zone_id, sort);


-- ---------------------------------------------------------------------------
-- Booking rules live here, not in code, so they can be tuned without a deploy
-- (PLAN.md §6). The 5-minute no-show window in particular is expected to need
-- adjusting after the pilot.
-- ---------------------------------------------------------------------------
create table settings (
  key   text primary key,
  value jsonb not null,
  note  text
);

insert into settings (key, value, note) values
  ('slot_minutes',            '15',    'Booking granularity'),
  ('min_booking_minutes',     '15',    null),
  ('max_self_serve_minutes',  '120',   'Over this, a guide must approve (§6.1)'),
  ('max_approved_minutes',    '480',   'Ceiling even with approval'),
  ('booking_horizon_days',    '7',     null),
  ('max_concurrent_bookings', '2',     'Per student'),
  ('max_daily_hours',         '4',     'Per student; approved bookings are exempt'),
  ('checkin_opens_minutes',   '10',    'Minutes BEFORE start that check-in opens'),
  ('no_show_minutes',         '5',     'Auto-release this long after start (§6.4)'),
  ('campus_open',             '"08:00"', null),
  ('campus_close',            '"17:00"', null),
  ('campus_days',             '[1,2,3,4,5]', 'ISO weekdays; Mon=1');

create or replace function setting_int(p_key text)
returns int language sql stable security definer set search_path = '' as $$
  select (value #>> '{}')::int from public.settings where key = p_key
$$;

-- ==== 20260915000300_bookings.sql ============================================

-- ============================================================================
-- Bookings, approvals, presence.  PLAN.md §7.1, §6.1
-- ============================================================================

create table bookings (
  id            uuid primary key default gen_random_uuid(),
  room_id       int  not null references rooms,
  user_id       uuid not null references profiles,
  booked_by     uuid not null references profiles,  -- differs when a guide books for a student
  during        tstzrange not null,
  purpose       text,
  status        text not null default 'reserved'
                  check (status in ('pending_approval','reserved','checked_in',
                                    'completed','cancelled','declined',
                                    'expired','no_show')),
  checked_in_at timestamptz,
  created_at    timestamptz not null default now(),

  constraint booking_not_empty check (not isempty(during)),
  constraint booking_bounded   check (lower(during) is not null
                                      and upper(during) is not null)
);


-- ---------------------------------------------------------------------------
-- The one guarantee this app cannot get wrong.
--
-- Checking for a clash in application code loses the race every time: two
-- students tapping the same open pod a half-second apart both read it as free.
-- Postgres rejects the second write atomically instead, however it arrives —
-- API, admin panel, or psql.
--
-- 'pending_approval' is INSIDE this list on purpose (PLAN.md §12 D1): that is
-- what makes an unanswered request hold the room, so the hold and the
-- no-double-booking guarantee are the same mechanism and cannot disagree.
--
-- Every release path — declined, expired, cancelled, no_show — falls outside
-- the list, so releasing a room is a single status update.
-- ---------------------------------------------------------------------------
alter table bookings add constraint bookings_no_overlap
  exclude using gist (
    room_id with =,
    during  with &&
  ) where (status in ('pending_approval','reserved','checked_in'));

create index on bookings (user_id, created_at desc);
create index on bookings using gist (during) where status in ('reserved','checked_in');
create index on bookings (status, (lower(during)))
  where status in ('pending_approval','reserved');


-- ---------------------------------------------------------------------------
-- Approval requests for bookings over the self-serve limit (§6.1).
--
-- token_hash is a SHA-256 of the token that goes out in the email; the raw
-- token is never stored and never leaves the send path. The decision endpoint
-- hashes what it receives and compares server-side, so a leaked database row
-- does not let anyone approve anything.
-- ---------------------------------------------------------------------------
create table approvals (
  booking_id    uuid primary key references bookings on delete cascade,
  guide_email   text not null check (guide_email ilike '%@alpha.school'),
  guide_id      uuid references profiles,
  token_hash    text not null,
  token_expires timestamptz not null,
  decision      text check (decision in ('approved','declined')),
  decided_by    uuid references profiles,
  decided_at    timestamptz,
  reason        text,
  requested_at  timestamptz not null default now()
);

create index on approvals (guide_email) where decision is null;
create index on approvals (guide_id)    where decision is null;


-- ---------------------------------------------------------------------------
-- Most-recently-used guides per student — the learned replacement for a
-- roster that goes stale every few weeks (PLAN.md §6.2, §12 D6).
--
-- Deliberately NOT derived from approvals: the retention policy in §9 deletes
-- booking rows after 90 days, which would silently reset every student to a
-- months-old roster. This table holds no booking details, so it survives the
-- purge without keeping what the purge exists to remove.
-- ---------------------------------------------------------------------------
create table guide_mru (
  user_id       uuid not null references profiles on delete cascade,
  guide_email   text not null,
  guide_id      uuid references profiles,
  use_count     int  not null default 1,
  last_used_at  timestamptz not null default now(),
  confirmed     boolean not null default false,  -- a request here was actually answered
  seed_priority smallint,                        -- from the roster; breaks ties pre-learning
  primary key (user_id, guide_email)
);

-- Ordering here IS the prefill rule (§6.2): confirmed beats merely-used, which
-- beats the roster seed. Keeps a silent typo from becoming someone's default.
create index on guide_mru (user_id, confirmed desc, last_used_at desc);


-- ---------------------------------------------------------------------------
-- Guide presence. Self-reported, always (PLAN.md §9).
-- ---------------------------------------------------------------------------
create table presence (
  user_id    uuid primary key references profiles on delete cascade,
  status     text not null default 'roaming'
               check (status in ('roaming','in_room','off_campus','dnd')),
  room_id    int references rooms,
  note       text,
  updated_at timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- Guide overrides, for accountability (§6.1).
-- ---------------------------------------------------------------------------
create table audit_log (
  id         bigserial primary key,
  actor_id   uuid not null references profiles,
  action     text not null,
  booking_id uuid references bookings,
  detail     jsonb,
  created_at timestamptz not null default now()
);

create index on audit_log (created_at desc);

-- ==== 20260915000400_roster.sql ============================================

-- ============================================================================
-- The student roster.  PLAN.md §6.2-6.3
--
-- A STARTING VALUE, NOT A SOURCE OF TRUTH. Guide pairings change every few
-- weeks; nothing here needs maintaining. Once a student sends a request that a
-- guide answers, guide_mru outranks this permanently and the roster ages out
-- on its own.
-- ============================================================================

create table roster_seed (
  id          serial primary key,
  match_name  text not null,
  guide_name  text not null,
  guide_email text not null,
  priority    smallint not null default 1,   -- ties before anything is learned
  user_id     uuid references profiles,
  linked_at   timestamptz,
  ambiguous   boolean not null default false,
  unique (match_name, guide_name)
);

create index on roster_seed (user_id) where user_id is null;


-- ---------------------------------------------------------------------------
-- Link a roster entry to a real account.
--
-- Seeds guide_mru with confirmed = false, which keeps roster rows BELOW
-- anything the student has actually used. `on conflict do nothing` means this
-- can never clobber a learned pairing, so it is safe to re-run.
-- ---------------------------------------------------------------------------
create or replace function link_roster_student(p_user_id uuid, p_match_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.roster_seed
     set user_id = p_user_id, linked_at = now()
   where match_name = p_match_name;

  -- Roster names are the names people actually go by; several are nicknames
  -- (Gus, Izzy, Lulu, Oz, AJ, Benny) that Google will not return.
  update public.profiles
     set display_name = p_match_name
   where id = p_user_id
     and display_name is null;

  insert into public.guide_mru
    (user_id, guide_email, guide_id, confirmed, seed_priority, last_used_at)
  select p_user_id, rs.guide_email, p.id, false, rs.priority, now()
    from public.roster_seed rs
    left join public.profiles p on lower(p.email) = lower(rs.guide_email)
   where rs.match_name = p_match_name
  on conflict (user_id, guide_email) do nothing;
end $$;


-- ---------------------------------------------------------------------------
-- Auto-link on first sign-in, but only when it is unambiguous.
--
-- Never guesses between two candidates. Linking Stella C to Stella G's guide
-- is worse than leaving it blank: the student won't find out until a request
-- reaches the wrong person. Everything else goes to the admin Link screen.
-- ---------------------------------------------------------------------------
create or replace function try_autolink_new_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_match text;
  v_count int;
begin
  select count(distinct match_name), min(match_name)
    into v_count, v_match
    from public.roster_seed
   where user_id is null
     and not ambiguous
     and lower(match_name) = lower(split_part(new.full_name, ' ', 1));

  if v_count = 1 then
    perform public.link_roster_student(new.id, v_match);
  end if;

  return new;
end $$;

drop trigger if exists autolink_roster on profiles;
create trigger autolink_roster
  after insert on profiles
  for each row execute function try_autolink_new_profile();


-- Admin view: who still needs linking by hand.
create or replace view roster_unlinked as
  select match_name,
         string_agg(guide_name, ' / ' order by priority) as guides,
         bool_or(ambiguous) as ambiguous
    from roster_seed
   where user_id is null
   group by match_name
   order by bool_or(ambiguous) desc, match_name;

-- ==== 20260915000500_rls.sql ============================================

-- ============================================================================
-- Row-level security.  PLAN.md §7.2
--
-- On from the first migration rather than bolted on later. Writes to bookings
-- and approvals go exclusively through SECURITY DEFINER functions (Phase 1),
-- so there are deliberately no INSERT/UPDATE policies for them here.
-- ============================================================================

alter table profiles        enable row level security;
alter table preferred_names enable row level security;
alter table zones           enable row level security;
alter table rooms           enable row level security;
alter table settings        enable row level security;
alter table bookings        enable row level security;
alter table approvals       enable row level security;
alter table guide_mru       enable row level security;
alter table presence        enable row level security;
alter table audit_log       enable row level security;
alter table roster_seed     enable row level security;


-- --- profiles --------------------------------------------------------------
-- Names and avatars are visible school-wide; that is the People board.
create policy profiles_read on profiles
  for select to authenticated using (true);

create policy profiles_update_own on profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy profiles_admin_write on profiles
  for all to authenticated
  using (is_admin()) with check (is_admin());

-- Role escalation guard: only an admin may change a role. A student updating
-- their own row (display_name, visible) must leave role untouched.
create or replace function guard_role_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.role is distinct from old.role and not public.is_admin() then
    raise exception 'Only an admin can change a role.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists guard_profile_role on profiles;
create trigger guard_profile_role
  before update on profiles
  for each row execute function guard_role_change();


-- --- reference data --------------------------------------------------------
create policy zones_read    on zones    for select to authenticated using (true);
create policy rooms_read    on rooms    for select to authenticated using (true);
create policy settings_read on settings for select to authenticated using (true);

create policy zones_admin    on zones    for all to authenticated using (is_admin()) with check (is_admin());
create policy rooms_admin    on rooms    for all to authenticated using (is_admin()) with check (is_admin());
create policy settings_admin on settings for all to authenticated using (is_admin()) with check (is_admin());

create policy preferred_names_read  on preferred_names for select to authenticated using (true);
create policy preferred_names_admin on preferred_names for all to authenticated using (is_admin()) with check (is_admin());


-- --- bookings --------------------------------------------------------------
-- The board is public within the school: everyone can see what is booked and
-- by whom. Writes are RPC-only, so no write policies exist.
create policy bookings_read on bookings
  for select to authenticated using (true);


-- --- approvals -------------------------------------------------------------
-- Readable by the student who asked, the guide who was asked, and staff.
-- token_hash is never exposed: the decision route hashes the incoming token
-- and compares server-side with the service role.
create policy approvals_read on approvals
  for select to authenticated using (
    is_staff()
    or guide_id = auth.uid()
    or exists (
      select 1 from bookings b
       where b.id = approvals.booking_id and b.user_id = auth.uid()
    )
  );


-- --- guide_mru -------------------------------------------------------------
-- A student's own list only. Who someone asks for approval is not board data.
create policy guide_mru_own on guide_mru
  for select to authenticated using (user_id = auth.uid() or is_staff());


-- --- presence --------------------------------------------------------------
create policy presence_read on presence
  for select to authenticated using (true);

create policy presence_write_own on presence
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());


-- --- audit log & roster ----------------------------------------------------
create policy audit_admin on audit_log
  for select to authenticated using (is_admin());

create policy roster_staff_read on roster_seed
  for select to authenticated using (is_staff());

create policy roster_admin_write on roster_seed
  for all to authenticated using (is_admin()) with check (is_admin());

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

-- ==== 20260915001100_booking_horizon.sql ============================================

-- ============================================================================
-- Booking horizon: students may book at most 2 hours ahead.  PLAN.md §6, D10
--
-- Also introduces app_now(): the clock every time-based rule reads. In
-- production it is now(). In tests, set_config('app.fake_now', ...) freezes it,
-- so "3 hours ahead is refused" and "released after 5 minutes" are exact
-- assertions instead of wall-clock-dependent ones.
--
-- The functions below are the ones from 0600/0700 with now() → app_now() and
-- the horizon check added. Re-declared here rather than edited in place
-- because those migrations are already applied to the live project.
-- ============================================================================

create or replace function app_now()
returns timestamptz language sql stable set search_path = '' as $$
  select coalesce(
    nullif(current_setting('app.fake_now', true), '')::timestamptz,
    now()
  )
$$;

-- Replace the 7-day horizon with a 2-hour one.
delete from settings where key = 'booking_horizon_days';
insert into settings (key, value, note) values
  ('booking_horizon_minutes', '120', 'Students may book at most this far ahead; staff exempt (D10)')
on conflict (key) do update set value = excluded.value, note = excluded.note;


-- ==== assert_booking_window (horizon + app_now) ====
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

-- ==== create_booking (app_now) ====
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

-- ==== check_in (app_now) ====
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

  if public.app_now() < lower(b.during) - (public.setting_int('checkin_opens_minutes') || ' minutes')::interval then
    raise exception 'Check-in opens % minutes before the start.',
      public.setting_int('checkin_opens_minutes');
  end if;

  if public.app_now() > lower(b.during) + (public.setting_int('no_show_minutes') || ' minutes')::interval then
    raise exception 'That booking was released — it was not checked in within % minutes.',
      public.setting_int('no_show_minutes');
  end if;

  update public.bookings
     set status = 'checked_in', checked_in_at = public.app_now()
   where id = p_booking_id;
end $$;

-- ==== extend_booking (app_now) ====
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

-- ==== mint_approval_token (app_now) ====
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
         token_expires = least(public.app_now() + v_ttl,
                               (select lower(during) from public.bookings
                                 where id = p_booking_id)),
         sent_at       = public.app_now()
   where booking_id = p_booking_id;

  if not found then raise exception 'No approval request for that booking.'; end if;
  return v_token;
end $$;

-- ==== decide_by_token (app_now) ====
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

  if a.token_expires is not null and public.app_now() > a.token_expires then
    raise exception 'That approval link has expired.' using errcode = 'insufficient_privilege';
  end if;

  return public.apply_decision(a.booking_id, p_decision, a.guide_id, p_reason);
end $$;

-- ==== release_no_shows (app_now) ====
create or replace function release_no_shows()
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  with released as (
    update public.bookings
       set status = 'no_show'
     where status = 'reserved'
       and public.app_now() > lower(during) + (public.setting_int('no_show_minutes') || ' minutes')::interval
    returning 1
  ) select count(*) into n from released;
  return n;
end $$;

-- ==== expire_pending_approvals (app_now) ====
create or replace function expire_pending_approvals()
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  with expired as (
    update public.bookings
       set status = 'expired'
     where status = 'pending_approval' and public.app_now() >= lower(during)
    returning id
  )
  update public.approvals a set decided_at = public.app_now()
    from expired e where a.booking_id = e.id and a.decision is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- ==== complete_finished_bookings (app_now) ====
create or replace function complete_finished_bookings()
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  with done as (
    update public.bookings set status = 'completed'
     where status = 'checked_in' and public.app_now() > upper(during)
    returning 1
  ) select count(*) into n from done;
  return n;
end $$;

-- CREATE OR REPLACE keeps existing grants, but state it so a reader need not check.
revoke all on function mint_approval_token(uuid)            from public, anon, authenticated;
revoke all on function decide_by_token(text, text, text)    from public, anon, authenticated;
revoke all on function release_no_shows()                   from public, anon, authenticated;
revoke all on function expire_pending_approvals()           from public, anon, authenticated;
revoke all on function complete_finished_bookings()         from public, anon, authenticated;

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

-- ==== 20260915001300_role_confirmation.sql ============================================

-- ============================================================================
-- Role confirmation at first sign-in.  PLAN.md D11
--
-- Everyone picks "guide" or "student" once. Picking guide is a CLAIM: it is
-- granted only if the email they type matches the account they signed in
-- with AND is on staff_allowlist. Otherwise anyone could hand themselves
-- override and room-management powers.
-- ============================================================================

alter table profiles add column if not exists role_confirmed boolean not null default false;

-- People already holding staff roles were set up by hand; don't make them
-- re-confirm. Students confirm once on their next visit.
update profiles set role_confirmed = true where role in ('guide', 'admin');


-- ---------------------------------------------------------------------------
-- Who may become a guide. Staff maintain this for their own campus.
-- ---------------------------------------------------------------------------
create table if not exists staff_allowlist (
  email     text primary key,
  added_by  uuid references profiles,
  added_at  timestamptz not null default now(),
  constraint staff_allowlist_lower check (email = lower(email))
);

alter table staff_allowlist enable row level security;

create policy staff_allowlist_staff on staff_allowlist
  for all to authenticated using (is_staff()) with check (is_staff());

-- Seed from the guides already known to the system.
insert into staff_allowlist (email)
select lower(email) from preferred_names
on conflict (email) do nothing;

insert into staff_allowlist (email)
select lower(email) from profiles where role in ('guide', 'admin')
on conflict (email) do nothing;


-- ---------------------------------------------------------------------------
-- The role guard blocks non-admins changing roles. confirm_role is the one
-- sanctioned path, so it sets a transaction-local flag the guard honours.
-- Clients cannot set it: set_config is not exposed as an RPC.
-- ---------------------------------------------------------------------------
create or replace function guard_role_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null
     and not public.is_admin()
     and current_setting('app.role_change_ok', true) is distinct from '1' then
    raise exception 'Only an admin can change a role.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;


-- ---------------------------------------------------------------------------
-- confirm_role('student') or confirm_role('guide', 'me@alpha.school')
-- ---------------------------------------------------------------------------
create or replace function confirm_role(p_choice text, p_email text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me   public.profiles;
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.' using errcode = 'insufficient_privilege';
  end if;
  select * into v_me from public.profiles where id = auth.uid();

  if p_choice = 'student' then
    -- Admins stay admins; nobody demotes themselves by tapping the wrong button.
    v_role := case when v_me.role = 'admin' then 'admin' else 'student' end;

  elsif p_choice = 'guide' then
    if p_email is null or lower(trim(p_email)) <> lower(v_me.email) then
      raise exception 'That email doesn''t match the account you signed in with (%).', v_me.email;
    end if;
    if not exists (select 1 from public.staff_allowlist where email = lower(v_me.email)) then
      raise exception 'That email isn''t on the guide list. Ask a guide to add you, or continue as a student.'
        using errcode = 'insufficient_privilege';
    end if;
    v_role := case when v_me.role = 'admin' then 'admin' else 'guide' end;

  else
    raise exception 'Choice must be guide or student.';
  end if;

  perform set_config('app.role_change_ok', '1', true);
  update public.profiles
     set role = v_role, role_confirmed = true
   where id = auth.uid();

  return jsonb_build_object('role', v_role, 'confirmed', true);
end $$;

-- confirm_role is an intended client entry point (see the allow-list note in
-- 0900). The guard above and the allowlist check are what make it safe.


-- ---------------------------------------------------------------------------
-- Being promoted by an admin IS confirmation. Without this, someone made a
-- guide by hand would still be bounced to the welcome screen and could only
-- "confirm" if they also happened to be on the allowlist.
-- ---------------------------------------------------------------------------
create or replace function confirm_on_promotion()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.role is distinct from old.role then
    if new.role in ('guide', 'admin') then
      new.role_confirmed := true;
      -- Keep the allowlist in step so the Manage guides page reflects reality.
      insert into public.staff_allowlist (email, added_by)
      values (lower(new.email), auth.uid())
      on conflict (email) do nothing;
    elsif new.role = 'student' then
      -- Demotion must also leave the allowlist, or the person could call
      -- confirm_role('guide') and promote themselves straight back.
      delete from public.staff_allowlist where email = lower(new.email);
    end if;
  end if;
  return new;
end $$;

drop trigger if exists confirm_on_promotion on profiles;
create trigger confirm_on_promotion
  before update of role on profiles
  for each row execute function confirm_on_promotion();

-- ==== 20260915001400_slack.sql ============================================

-- ============================================================================
-- Slack deep links.  PLAN.md §5.4 (People)
--
-- Students already talk on Slack; the app does not need its own chat. The
-- People page offers "Message on Slack", which opens a DM with that person.
-- That needs their Slack user id, looked up once by email through a Slack app
-- (server-side, bot token) and cached here.
--
-- Written only by the server route via the service role; RLS lets signed-in
-- users read it, which is fine — everyone is in the same workspace anyway.
-- ============================================================================

alter table profiles
  add column if not exists slack_user_id    text,
  add column if not exists slack_checked_at timestamptz;

comment on column profiles.slack_user_id is
  'Slack member id (U…), cached from users.lookupByEmail. Null = not looked up or not on Slack.';
comment on column profiles.slack_checked_at is
  'When slack_user_id was last looked up; re-checked after 7 days so renames/new accounts catch up.';

-- ==== 20260915001500_slack_directory.sql ============================================

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

-- ==== seed.sql ====================================================

-- ============================================================================
-- Seed data: zones, the 19 rooms, guides, and the student roster.
-- Table definitions live in supabase/migrations/. This file is data only.
--
-- Safe to re-run. Never clobbers a learned guide pairing (PLAN.md §6.2).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Zones.
--
-- TBC: "Conference" is a placeholder. The zone for Conference Rooms 1-4 has
-- not been confirmed, and they may not be co-located (PLAN.md §11 Q1). Fixing
-- this later is an UPDATE on 4 rows, not a code change.
-- ---------------------------------------------------------------------------
insert into zones (name, floor, sort) values
  ('Underpass',     1, 10),
  ('Hallway',       1, 20),
  ('Atrium',        1, 30),
  ('Pomodoro Room', 1, 40),
  ('Conference',    1, 50),   -- TBC
  ('Upstairs',      2, 60)
on conflict (name) do update set floor = excluded.floor, sort = excluded.sort;


-- ---------------------------------------------------------------------------
-- The 19 rooms.
--
-- Capacities marked TBC are inferred from the room names (PLAN.md §11 Q2).
-- The Pomodoro Pod has NO set timer despite the name: it books like any other
-- single pod (PLAN.md §12 D5). Do not add 25-minute logic for it.
-- ---------------------------------------------------------------------------
insert into rooms (slug, name, zone_id, capacity, kind, sort)
select r.slug, r.name, z.id, r.capacity, r.kind::text, r.sort
from (values
  ('underpass-1',      'Underpass Pod 1',       'Underpass',     1, 'pod',         10),
  ('underpass-2',      'Underpass Pod 2',       'Underpass',     1, 'pod',         20),
  ('underpass-3',      'Underpass Pod 3',       'Underpass',     1, 'pod',         30),
  ('hallway-1',        'Hallway Pod 1',         'Hallway',       1, 'pod',         10),
  ('hallway-2',        'Hallway Pod 2',         'Hallway',       1, 'pod',         20),
  ('hallway-3',        'Hallway Pod 3',         'Hallway',       1, 'pod',         30),
  ('hallway-4',        'Hallway Pod 4',         'Hallway',       1, 'pod',         40),
  ('hallway-5',        'Hallway Pod 5',         'Hallway',       1, 'pod',         50),
  ('hallway-6',        'Hallway Pod 6',         'Hallway',       1, 'pod',         60),
  ('atrium-double',    'Atrium Double Pod',     'Atrium',        2, 'pod',         10),
  ('pomodoro',         'Pomodoro Pod',          'Pomodoro Room', 1, 'pod',         10),
  ('conf-1',           'Conference Room 1',     'Conference',    6, 'conference',  10),  -- capacity TBC
  ('conf-2',           'Conference Room 2',     'Conference',    6, 'conference',  20),  -- capacity TBC
  ('conf-3',           'Conference Room 3',     'Conference',    6, 'conference',  30),  -- capacity TBC
  ('conf-4',           'Conference Room 4',     'Conference',    6, 'conference',  40),  -- capacity TBC
  ('upstairs-1',       'Upstairs Pod 1',        'Upstairs',      1, 'pod',         10),
  ('upstairs-2',       'Upstairs Pod 2',        'Upstairs',      1, 'pod',         20),
  ('upstairs-4seater', 'Upstairs 4-Seater Pod', 'Upstairs',      4, 'pod',         30),
  ('upstairs-podcast', 'Upstairs Podcast Room', 'Upstairs',      3, 'special',     40)   -- capacity TBC
) as r(slug, name, zone_name, capacity, kind, sort)
join zones z on z.name = r.zone_name
on conflict (slug) do update
  set name     = excluded.name,
      zone_id  = excluded.zone_id,
      capacity = excluded.capacity,
      kind     = excluded.kind,
      sort     = excluded.sort;

do $$
declare n int;
begin
  select count(*) into n from rooms;
  if n <> 19 then raise exception 'Expected 19 rooms, found %', n; end if;
end $$;


-- ---------------------------------------------------------------------------
-- Guides.
--
-- NOTE: Clay's address is dustin.hansford@ — his legal name. He goes by Clay.
-- The address is correct and confirmed; do not "fix" it to clay.*@ later.
-- The display name is what students see everywhere (PLAN.md §12 D9).
-- ---------------------------------------------------------------------------
create temp table _guides (guide_name text primary key, email text not null) on commit drop;

insert into _guides (guide_name, email) values
  ('Emerson', 'emerson.goldman@alpha.school'),
  ('Emily',   'emily.findley@alpha.school'),
  ('Kent',    'kent.auslander@alpha.school'),
  ('Chloe',   'chloe.belvin@alpha.school'),
  ('Clay',    'dustin.hansford@alpha.school');

insert into preferred_names (email, display_name)
select email, guide_name from _guides
on conflict (email) do update set display_name = excluded.display_name;

-- Apply to any guide who has already signed in.
update profiles p
   set display_name = pn.display_name
  from preferred_names pn
 where lower(p.email) = lower(pn.email)
   and p.display_name is distinct from pn.display_name;

-- Mark them as guides.
update profiles p
   set role = 'guide'
  from _guides g
 where lower(p.email) = lower(g.email)
   and p.role = 'student';

-- They may confirm themselves as guides at first sign-in (D11).
insert into staff_allowlist (email)
select lower(email) from _guides
on conflict (email) do nothing;


-- ---------------------------------------------------------------------------
-- The roster: 55 students, 68 pairings.
--
-- Chloe's 13 students are also Clay's, so those students get two rows.
-- `priority` decides which pre-fills before the student has used either.
-- `ambiguous` means first-name matching cannot safely pick this person; they
-- go to the admin Link screen instead of being guessed at.
-- ---------------------------------------------------------------------------
insert into roster_seed (match_name, guide_name, guide_email, priority, ambiguous)
select r.match_name, r.guide_name, g.email, r.priority, r.ambiguous
from (values
  -- Emerson (14)
  ('Aarya','Emerson',1,false), ('Adrienne','Emerson',1,false), ('Aheli','Emerson',1,false),
  ('Aydin','Emerson',1,false), ('Fynn','Emerson',1,false),     ('Gus','Emerson',1,false),
  ('Harley','Emerson',1,false),('Jaiden','Emerson',1,false),   ('Jessica','Emerson',1,false),
  ('Kanhai','Emerson',1,false),('Kavin','Emerson',1,false),    ('Oz','Emerson',1,false),
  ('Rhett','Emerson',1,false),
  ('Stella C','Emerson',1,true),      -- ambiguous: Stella G, Estella

  -- Emily (14)
  ('Airy','Emily',1,false),    ('Aoife','Emily',1,false),   ('Armaan','Emily',1,false),
  ('Branson','Emily',1,false), ('Greyson','Emily',1,false), ('Henry','Emily',1,false),
  ('Jacob','Emily',1,false),   ('Layla','Emily',1,false),   ('Leo','Emily',1,false),
  ('Reece','Emily',1,false),   ('Teresa','Emily',1,false),  ('Valentina','Emily',1,false),
  ('Austin L','Emily',1,true), -- last initial given; may be more than one Austin
  ('Eva','Emily',1,true),      -- ambiguous: Evan

  -- Kent (14)
  ('AJ','Kent',1,false),      ('Arjun','Kent',1,false),   ('Artemis','Kent',1,false),
  ('Atticus','Kent',1,false), ('Dorian','Kent',1,false),  ('Emma','Kent',1,false),
  ('Grady','Kent',1,false),   ('Gwen','Kent',1,false),    ('Izzy','Kent',1,false),
  ('Liam','Kent',1,false),    ('Mollie','Kent',1,false),  ('Said','Kent',1,false),
  ('Ali','Kent',1,true),      -- ambiguous: Allegra
  ('Estella','Kent',1,true),  -- ambiguous: Stella C, Stella G

  -- Chloe (13)
  ('Anya','Chloe',1,false),    ('Benny','Chloe',1,false),   ('Erika','Chloe',1,false),
  ('Hudson','Chloe',1,false),  ('Jackson','Chloe',1,false), ('Jaya','Chloe',1,false),
  ('Lulu','Chloe',1,false),    ('Michael','Chloe',1,false), ('Roarke','Chloe',1,false),
  ('Zayen','Chloe',1,false),
  ('Allegra','Chloe',1,true),  -- ambiguous: Ali
  ('Evan','Chloe',1,true),     -- ambiguous: Eva
  ('Stella G','Chloe',1,true), -- ambiguous: Stella C, Estella

  -- Clay (13) — the same students as Chloe, offered as a second chip
  ('Anya','Clay',2,false),    ('Benny','Clay',2,false),   ('Erika','Clay',2,false),
  ('Hudson','Clay',2,false),  ('Jackson','Clay',2,false), ('Jaya','Clay',2,false),
  ('Lulu','Clay',2,false),    ('Michael','Clay',2,false), ('Roarke','Clay',2,false),
  ('Zayen','Clay',2,false),   ('Allegra','Clay',2,true),  ('Evan','Clay',2,true),
  ('Stella G','Clay',2,true)
) as r(match_name, guide_name, priority, ambiguous)
join _guides g on g.guide_name = r.guide_name
on conflict (match_name, guide_name) do update
  set guide_email = excluded.guide_email,
      priority    = excluded.priority,
      ambiguous   = excluded.ambiguous;

do $$
declare n_students int; n_rows int;
begin
  select count(distinct match_name), count(*) into n_students, n_rows from roster_seed;
  if n_students <> 55 or n_rows <> 68 then
    raise exception 'Expected 55 students / 68 pairings, found % / %', n_students, n_rows;
  end if;
end $$;

commit;

-- ==== verification ================================================
-- The result grid below is the proof this worked. Expect:
--   rooms 19 | zones 6 | students 55 | pairings 68 | guides 5 | settings 12
select
  (select count(*) from rooms)                     as rooms,
  (select count(*) from zones)                     as zones,
  (select count(distinct match_name) from roster_seed) as students,
  (select count(*) from roster_seed)               as pairings,
  (select count(*) from preferred_names)           as guides,
  (select count(*) from settings)                  as settings;
