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
