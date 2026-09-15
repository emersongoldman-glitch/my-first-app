-- ============================================================================
-- Initial student → guide roster.  See PLAN.md §6.2–6.3.
--
-- THIS IS A STARTING VALUE, NOT A SOURCE OF TRUTH.
-- Guide pairings change every few weeks. Nothing here needs to be maintained:
-- once a student sends an approval request to a guide and that guide answers,
-- `guide_mru` takes over as their default forever (PLAN.md §6.2). This file
-- exists only so the very first request each student makes is pre-filled.
--
-- A student may have more than one guide — Chloe's 13 students are also Clay's.
-- Multiple guides are seeded as separate rows and surface as one-tap chips.
--
-- Safe to re-run. Never overwrites a learned pairing.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Guide addresses.
--
-- NOTE: Clay's address is dustin.hansford@ — his legal name. He goes by Clay.
-- The address is correct and confirmed; do not "fix" it to clay.*@ later.
-- `guide_name` below is the name students know, and is seeded into
-- profiles.display_name so the app never shows him a name he doesn't use.
-- ---------------------------------------------------------------------------
create temp table guide_emails (guide_name text primary key, email text not null);

insert into guide_emails (guide_name, email) values
  ('Emerson', 'emerson.goldman@alpha.school'),
  ('Emily',   'emily.findley@alpha.school'),
  ('Kent',    'kent.auslander@alpha.school'),
  ('Chloe',   'chloe.belvin@alpha.school'),
  ('Clay',    'dustin.hansford@alpha.school');  -- see note above


-- ---------------------------------------------------------------------------
-- Preferred names, applied whenever a guide signs in.
--
-- Google returns whatever name is on the account, which for Clay is his legal
-- name. Without this he appears as "Dustin Hansford" until he happens to find
-- the setting — on the People board, in approval emails, on every room card —
-- and students look for a name they don't recognise. Anyone can change their
-- own display_name later; this is only the starting value.
-- ---------------------------------------------------------------------------
create table if not exists preferred_names (
  email        text primary key check (email ilike '%@alpha.school'),
  display_name text not null
);

insert into preferred_names (email, display_name)
select email, guide_name from guide_emails
on conflict (email) do update set display_name = excluded.display_name;

-- Apply to guides who have already signed in...
update profiles p
   set display_name = pn.display_name
  from preferred_names pn
 where lower(p.email) = lower(pn.email)
   and p.display_name is distinct from pn.display_name;

-- ...and to anyone who signs in later.
create or replace function apply_preferred_name()
returns trigger language plpgsql security definer as $$
begin
  select display_name into new.display_name
    from preferred_names where lower(email) = lower(new.email);
  return new;
end $$;

drop trigger if exists set_preferred_name on profiles;
create trigger set_preferred_name
  before insert on profiles
  for each row execute function apply_preferred_name();


-- ---------------------------------------------------------------------------
-- The roster.
--
-- One row per (student, guide) pair, so a student can have several. `priority`
-- breaks the tie for which one pre-fills first, before anything is learned;
-- lower sorts first. Names are as given: first names, with a last initial only
-- where it was needed to tell two students apart.
-- ---------------------------------------------------------------------------
create table if not exists roster_seed (
  id          serial primary key,
  match_name  text not null,
  guide_name  text not null,
  guide_email text not null,
  priority    smallint not null default 1,
  user_id     uuid references profiles,  -- filled in once the account is linked
  linked_at   timestamptz,
  ambiguous   boolean not null default false,  -- needs a human to link
  unique (match_name, guide_name)
);

insert into roster_seed (match_name, guide_name, guide_email, priority, ambiguous)
select r.match_name, r.guide_name, g.email, r.priority, r.ambiguous
from (values
  -- Emerson (14)
  ('Aarya',     'Emerson', 1, false),
  ('Adrienne',  'Emerson', 1, false),
  ('Aheli',     'Emerson', 1, false),
  ('Aydin',     'Emerson', 1, false),
  ('Fynn',      'Emerson', 1, false),
  ('Gus',       'Emerson', 1, false),
  ('Harley',    'Emerson', 1, false),
  ('Jaiden',    'Emerson', 1, false),
  ('Jessica',   'Emerson', 1, false),
  ('Kanhai',    'Emerson', 1, false),
  ('Kavin',     'Emerson', 1, false),
  ('Oz',        'Emerson', 1, false),
  ('Rhett',     'Emerson', 1, false),
  ('Stella C',  'Emerson', 1, true),   -- ambiguous: Stella G, Estella

  -- Emily (14)
  ('Airy',      'Emily',   1, false),
  ('Aoife',     'Emily',   1, false),
  ('Armaan',    'Emily',   1, false),
  ('Austin L',  'Emily',   1, true),   -- last initial given; may be >1 Austin
  ('Branson',   'Emily',   1, false),
  ('Eva',       'Emily',   1, true),   -- ambiguous: Evan
  ('Greyson',   'Emily',   1, false),
  ('Henry',     'Emily',   1, false),
  ('Jacob',     'Emily',   1, false),
  ('Layla',     'Emily',   1, false),
  ('Leo',       'Emily',   1, false),
  ('Reece',     'Emily',   1, false),
  ('Teresa',    'Emily',   1, false),
  ('Valentina', 'Emily',   1, false),

  -- Kent (14)
  ('AJ',        'Kent',    1, false),
  ('Ali',       'Kent',    1, true),   -- ambiguous: Allegra
  ('Arjun',     'Kent',    1, false),
  ('Artemis',   'Kent',    1, false),
  ('Atticus',   'Kent',    1, false),
  ('Dorian',    'Kent',    1, false),
  ('Emma',      'Kent',    1, false),
  ('Grady',     'Kent',    1, false),
  ('Gwen',      'Kent',    1, false),
  ('Izzy',      'Kent',    1, false),
  ('Liam',      'Kent',    1, false),
  ('Mollie',    'Kent',    1, false),
  ('Said',      'Kent',    1, false),
  ('Estella',   'Kent',    1, true),   -- ambiguous: Stella C, Stella G

  -- Chloe (13) — these students are shared with Clay, seeded below
  ('Allegra',   'Chloe',   1, true),   -- ambiguous: Ali
  ('Anya',      'Chloe',   1, false),
  ('Benny',     'Chloe',   1, false),
  ('Erika',     'Chloe',   1, false),
  ('Evan',      'Chloe',   1, true),   -- ambiguous: Eva
  ('Hudson',    'Chloe',   1, false),
  ('Jackson',   'Chloe',   1, false),
  ('Jaya',      'Chloe',   1, false),
  ('Lulu',      'Chloe',   1, false),
  ('Michael',   'Chloe',   1, false),
  ('Roarke',    'Chloe',   1, false),
  ('Stella G',  'Chloe',   1, true),   -- ambiguous: Stella C, Estella
  ('Zayen',     'Chloe',   1, false),

  -- Clay (13) — same 13 students as Chloe, second chip
  ('Allegra',   'Clay',    2, true),
  ('Anya',      'Clay',    2, false),
  ('Benny',     'Clay',    2, false),
  ('Erika',     'Clay',    2, false),
  ('Evan',      'Clay',    2, true),
  ('Hudson',    'Clay',    2, false),
  ('Jackson',   'Clay',    2, false),
  ('Jaya',      'Clay',    2, false),
  ('Lulu',      'Clay',    2, false),
  ('Michael',   'Clay',    2, false),
  ('Roarke',    'Clay',    2, false),
  ('Stella G',  'Clay',    2, true),
  ('Zayen',     'Clay',    2, false)
) as r(match_name, guide_name, priority, ambiguous)
join guide_emails g on g.guide_name = r.guide_name
on conflict (match_name, guide_name) do update
  set guide_email = excluded.guide_email,
      priority    = excluded.priority;

-- Sanity check: 55 distinct students, 68 pairings (55 + Clay's 13).
do $$
declare n_students int; n_rows int;
begin
  select count(distinct match_name), count(*) into n_students, n_rows from roster_seed;
  if n_students <> 55 or n_rows <> 68 then
    raise exception 'Expected 55 students / 68 pairings, found % / %', n_students, n_rows;
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- Seed guide_mru from the roster when an account is linked.
--
-- Seeded rows are confirmed = false, which is what keeps them BELOW anything
-- the student has actually used (PLAN.md §6.2). The moment a real request gets
-- answered, the learned pairing outranks these permanently.
--
-- `on conflict do nothing` means re-running this file can never clobber a
-- learned pairing. Students with two guides get both rows; `priority` decides
-- which pre-fills until the student's own behaviour settles it.
-- ---------------------------------------------------------------------------
create or replace function link_roster_student(p_user_id uuid, p_match_name text)
returns void language plpgsql security definer as $$
begin
  update roster_seed
     set user_id = p_user_id, linked_at = now()
   where match_name = p_match_name;

  -- The roster name is the name this student actually goes by — several are
  -- nicknames (Gus, Izzy, Lulu, Oz, AJ, Benny). Google gives us the legal name.
  -- Seed it as their display name unless they've already chosen one.
  update profiles
     set display_name = p_match_name
   where id = p_user_id
     and display_name is null;

  insert into guide_mru (user_id, guide_email, guide_id, confirmed, seed_priority, last_used_at)
  select p_user_id, rs.guide_email, p.id, false, rs.priority, now()
    from roster_seed rs
    left join profiles p on lower(p.email) = lower(rs.guide_email)
   where rs.match_name = p_match_name
  on conflict (user_id, guide_email) do nothing;
end $$;


-- ---------------------------------------------------------------------------
-- Auto-link unambiguous names on first sign-in.
--
-- Only ever links on an EXACT first-name match to a single non-ambiguous
-- student. Anything else is left for the admin "Link students" screen.
-- Guessing between two candidates is worse than leaving it blank: a wrong
-- prefill sends a request to the wrong guide and the student won't notice.
-- ---------------------------------------------------------------------------
create or replace function try_autolink_new_profile()
returns trigger language plpgsql security definer as $$
declare
  v_match text;
  v_count int;
begin
  select count(distinct match_name), min(match_name) into v_count, v_match
    from roster_seed
   where user_id is null
     and not ambiguous
     and lower(match_name) = lower(split_part(new.full_name, ' ', 1));

  if v_count = 1 then
    perform link_roster_student(new.id, v_match);
  end if;

  return new;
end $$;

drop trigger if exists autolink_roster on profiles;
create trigger autolink_roster
  after insert on profiles
  for each row execute function try_autolink_new_profile();


-- ---------------------------------------------------------------------------
-- Admin view: who still needs linking by hand.
-- Expect the 7 ambiguous students plus anyone whose Google name doesn't match
-- their roster name (nicknames: Gus, Izzy, Lulu, Oz, AJ, Benny...).
-- ---------------------------------------------------------------------------
create or replace view roster_unlinked as
  select match_name,
         string_agg(guide_name, ' / ' order by priority) as guides,
         bool_or(ambiguous) as ambiguous
    from roster_seed
   where user_id is null
   group by match_name
   order by bool_or(ambiguous) desc, match_name;
