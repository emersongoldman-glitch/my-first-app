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
