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
