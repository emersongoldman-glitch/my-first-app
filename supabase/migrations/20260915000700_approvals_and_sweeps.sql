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
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
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

revoke all on function run_sweeps() from public, anon, authenticated;


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
