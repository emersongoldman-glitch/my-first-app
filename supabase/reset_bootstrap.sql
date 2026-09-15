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
