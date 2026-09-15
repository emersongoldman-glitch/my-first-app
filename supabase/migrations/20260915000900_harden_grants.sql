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
