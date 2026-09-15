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
