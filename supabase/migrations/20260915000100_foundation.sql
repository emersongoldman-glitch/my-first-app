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
