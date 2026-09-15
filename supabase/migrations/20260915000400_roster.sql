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
