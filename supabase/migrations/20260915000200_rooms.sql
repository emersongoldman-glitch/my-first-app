-- ============================================================================
-- Zones, rooms, and configurable settings.  PLAN.md §4, §6
-- ============================================================================

create table zones (
  id    serial primary key,
  name  text not null unique,
  floor smallint not null default 1,
  sort  smallint not null default 0
);

create table rooms (
  id          serial primary key,
  slug        text not null unique,
  name        text not null,
  zone_id     int  not null references zones,
  capacity    smallint not null default 1,
  kind        text not null default 'pod'
                check (kind in ('pod','conference','special')),
  max_minutes smallint,        -- null => fall back to the global setting
  bookable    boolean not null default true,
  sort        smallint not null default 0
);

create index on rooms (zone_id, sort);


-- ---------------------------------------------------------------------------
-- Booking rules live here, not in code, so they can be tuned without a deploy
-- (PLAN.md §6). The 5-minute no-show window in particular is expected to need
-- adjusting after the pilot.
-- ---------------------------------------------------------------------------
create table settings (
  key   text primary key,
  value jsonb not null,
  note  text
);

insert into settings (key, value, note) values
  ('slot_minutes',            '15',    'Booking granularity'),
  ('min_booking_minutes',     '15',    null),
  ('max_self_serve_minutes',  '120',   'Over this, a guide must approve (§6.1)'),
  ('max_approved_minutes',    '480',   'Ceiling even with approval'),
  ('booking_horizon_days',    '7',     null),
  ('max_concurrent_bookings', '2',     'Per student'),
  ('max_daily_hours',         '4',     'Per student; approved bookings are exempt'),
  ('checkin_opens_minutes',   '10',    'Minutes BEFORE start that check-in opens'),
  ('no_show_minutes',         '5',     'Auto-release this long after start (§6.4)'),
  ('campus_open',             '"08:00"', null),
  ('campus_close',            '"17:00"', null),
  ('campus_days',             '[1,2,3,4,5]', 'ISO weekdays; Mon=1');

create or replace function setting_int(p_key text)
returns int language sql stable security definer set search_path = '' as $$
  select (value #>> '{}')::int from public.settings where key = p_key
$$;
