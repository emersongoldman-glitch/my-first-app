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
