# Campus Rooms — Pod & Conference Room Reservations

A booking and presence app for Alpha High School campus. Students reserve pods and
conference rooms, and everyone — students and guides — can see who is where, right now.

---

## 1. The problem

Two problems, one app:

1. **Reservations.** 19 pods and conference rooms with no booking system. Students
   walk to a pod, find it occupied, walk to the next one. Conference rooms get
   squatted on. There is no way to hold a room for a scheduled call or group session.
2. **Findability.** Nobody knows where anyone is. A student who needs their guide
   wanders the building. A student who wants to work with a peer has no idea which
   pod they're in. The campus is spread across an underpass, a hallway, an atrium,
   and an upstairs — enough physical separation that "just look around" doesn't work.

The second problem is the one that makes this worth building. A reservation system
alone is a scheduling tool; a reservation system that doubles as a live campus
directory is something people open every day.

## 2. Goals

- A student can book an open pod in **under 10 seconds** on a phone, standing in a hallway.
- Anyone can answer **"where is ___ right now?"** in one glance.
- Double-booking is **structurally impossible**, not merely discouraged.
- Zero admin overhead for guides in the normal case.

### Non-goals for v1

- Recurring/repeating reservations (v2).
- Room resources (whiteboards, monitors, AV) — nice, not load-bearing.
- Native mobile apps. This is a mobile-first web app installable as a PWA.
- Attendance tracking or anything that reads as surveillance. See §9.

## 3. Users and roles

| Role | Who | Can |
|---|---|---|
| `student` | Any `@alpha.school` student | Book, cancel own bookings, check in/out, view board |
| `guide` | Staff | Everything a student can + set own status/location, book on behalf of a student, override any booking |
| `admin` | You + designated staff | Manage rooms, hours, quotas, blackout windows; view usage reports |

Role is stored on the user profile and assigned by an admin. First run: seed your own
account as `admin` directly in the database.

## 4. Room inventory

19 rooms, grouped by zone. Zone is the primary organizing concept in the UI — students
think "I'm upstairs, what's free upstairs?"

| Zone | Room | Slug | Capacity | Type |
|---|---|---|---|---|
| Underpass | Underpass Pod 1 | `underpass-1` | 1 | pod |
| Underpass | Underpass Pod 2 | `underpass-2` | 1 | pod |
| Underpass | Underpass Pod 3 | `underpass-3` | 1 | pod |
| Atrium | Atrium Double Pod | `atrium-double` | 2 | pod |
| Hallway | Hallway Pod 1 | `hallway-1` | 1 | pod |
| Hallway | Hallway Pod 2 | `hallway-2` | 1 | pod |
| Hallway | Hallway Pod 3 | `hallway-3` | 1 | pod |
| Hallway | Hallway Pod 4 | `hallway-4` | 1 | pod |
| Hallway | Hallway Pod 5 | `hallway-5` | 1 | pod |
| Hallway | Hallway Pod 6 | `hallway-6` | 1 | pod |
| Pomodoro Room | Pomodoro Pod | `pomodoro` | 1 | pod |
| Upstairs | Upstairs Pod 1 | `upstairs-1` | 1 | pod |
| Upstairs | Upstairs Pod 2 | `upstairs-2` | 1 | pod |
| Upstairs | Upstairs 4-Seater Pod | `upstairs-4seater` | 4 | pod |
| *TBC* | Conference Room 1 | `conf-1` | 6 | conference |
| *TBC* | Conference Room 2 | `conf-2` | 6 | conference |
| *TBC* | Conference Room 3 | `conf-3` | 6 | conference |
| *TBC* | Conference Room 4 | `conf-4` | 6 | conference |
| Upstairs | Upstairs Podcast Room | `upstairs-podcast` | 3 | special |

**Confirmed:** The Pomodoro Pod sits in its own zone, the Pomodoro Room. Despite the
name it has **no set timer** — no forced 25-minute blocks, no special cadence. It books
exactly like any other single pod. This is worth writing down because the name invites
the opposite assumption from anyone who picks up the code later.

**Assumptions to confirm before seeding** (marked *TBC* above):
- Which zone the four conference rooms live in, and whether they're co-located.
- Real capacities — the numbers above are inferred from the names.
- Whether the Podcast Room needs different rules (longer blocks, booking further out).

These live in one seed file (`supabase/seed.sql`) so corrections are a one-line edit
and a re-seed, not a code change.

## 5. Screens

### 5.1 Now (home)
The default screen and the heart of the app. A live list of all 19 rooms grouped by
zone, each showing one of:

- **Open** — green, with a one-tap `Book 30m` / `Book 1h` button.
- **Booked until 2:15 — Maya R.** — amber, with who and until when.
- **Open, but reserved at 2:30** — the honest middle case; shows how long you have.
- **Held — awaiting guide approval** — grey, showing who requested it and until when the
  hold lasts. Distinct from a confirmed booking so nobody reads a pending request as a
  done deal, and so a student can see the room may free up.

Sorting: the zone you were last in floats to the top. Open rooms before occupied ones
within a zone. Updates live over Supabase Realtime — no refresh, no pull-to-refresh.

### 5.2 Map
The same data on a floor layout: Underpass, Hallway, Atrium, Upstairs as labeled
regions with rooms as tappable shapes, color-coded by availability. Ships as a
hand-authored SVG with one `<g id="room-slug">` per room, so the data layer is just
`fill` swaps driven by the same state as the Now screen. Two floors = a segmented
toggle (Main / Upstairs).

This is the "where is everyone" screen for people who think spatially.

### 5.3 Room detail
One room, today's timeline as a vertical strip of slots. Tap a slot, adjust the end
time, confirm. Shows the next 7 days via a date picker.

### 5.4 People
Searchable directory of who's on campus and where.

- **Guides first**, with their current status: `In Conference Room 2`, `Roaming`,
  `Off campus`, `Do not disturb`, plus an optional free-text note ("in the atrium
  until 1pm"). Guides set this themselves; it is never inferred.
- **Students** below, showing only those with an active booking or check-in, and only
  the room they're in. Opt-out available in settings.

### 5.5 My bookings
Upcoming and past. Cancel, extend (if the room is still free after), or check in.

### 5.6 Approvals (guides)
A guide's inbox of pending requests, badged in the nav so it can't be missed. Each card:
student, room, requested window, duration, purpose, and `Approve` / `Decline` with an
optional reason. Sorted by how soon the booking starts, since those expire first.

Guides can also act on requests addressed to a *different* guide — if a colleague is out,
the room shouldn't stay held. Cross-guide decisions are logged to `audit_log`.

Students see a read-only version under My Bookings: what they requested, who they asked,
and whether it's still waiting.

### 5.7 Admin
Rooms CRUD, campus hours, quota settings, blackout windows (assemblies, testing),
and a usage report: bookings per room per week, no-show rate, peak hours, and
**unanswered approval requests per guide**. The usage report is the artifact that
justifies "we need more pods" to whoever buys pods; the unanswered-request count is what
tells you whether the approval gate is working or quietly eating students' bookings.

## 6. Booking rules

Rules are **configuration, not code** — a `settings` table with sensible defaults, so
they can be tuned in week two without a deploy.

| Rule | Default | Why |
|---|---|---|
| Slot granularity | 15 min | Fine enough to be useful, coarse enough to scan |
| Min booking | 15 min | — |
| **Max booking without approval** | **2 h** | **Any room, any student. Over 2 h needs a guide — see §6.1** |
| Max booking with guide approval | 8 h | Effectively a full day; the guide is the judgment |
| **Booking horizon** | **2 h ahead** (students); staff exempt | Rooms get booked when needed, not squatted days out. See D10 |
| Concurrent bookings per student | 2 | One now, one later |
| Total booked hours/day per student | 4 h | Backstop against hoarding; approved bookings exempt |
| Campus hours | 8:00–17:00, Mon–Fri | Configurable; no bookings outside |
| Check-in window | opens 10 min before start | — |
| **No-show release** | **5 min after start** | **The single most important rule — see §6.4** |
| Pending-approval expiry | at booking start time | An unanswered request can't hold a room forever |

### 6.1 Bookings over 2 hours require guide approval

Two hours is the ceiling a student can take on their own, for **every room** — pods and
conference rooms alike. A single number is easier to remember than a per-room matrix,
and the interesting case (a student wants a conference room all afternoon) is exactly
the one a guide should see.

**The flow:**

1. Student drags the end time past 2 hours. The UI changes in place — the button
   becomes `Request approval`, and a field appears: **guide's email**, with a note
   explaining the room is held until the guide answers.
2. The field is **pre-filled with the guide this student last used** (§6.3), shown as a
   chip they can tap to accept or clear to change. It autocompletes against known
   `@alpha.school` guide accounts but accepts any `@alpha.school` address, so a guide
   who hasn't signed in yet still works. Non-school domains are rejected.
3. The booking is created with status `pending_approval`. **It holds the room** — see
   the note below on why.
4. The guide gets an email: who, which room, when, how long, the stated purpose, and
   two buttons — **Approve** / **Decline**. Each is a signed, single-use, expiring link
   that works without signing in. Guides act on these from their phone between sessions;
   anything requiring a login gets ignored, and an ignored request is a held room.
5. The same request appears in the guide's in-app **Approvals** inbox, so nothing is
   lost to a spam filter.
6. On approve: status → `reserved`, student notified, room stays held. On decline:
   status → `declined`, the hold releases immediately, student notified with the guide's
   optional one-line reason.
7. If nobody answers by the booking's start time, it expires and the room reopens. The
   student is told, and can rebook at 2 hours with no approval needed. Because students
   book at most 2 hours ahead (D10), a guide has **under two hours** to answer — the
   in-app inbox badge and the email both matter.

**Why pending requests hold the room:** the alternative is that a student gets approval
for a room someone else took in the meantime, which makes the approval worthless. The
expiry at start time is what keeps the hold from being abusable — the worst case is one
room held for a few hours by a request nobody answered, and that shows up in the admin
report as an unanswered-request count. If that number is ever non-trivial, the fix is
nagging guides, not shortening the hold.

**Guide override:** any user with the `guide` role can approve their own long bookings
with no request step, approve a request addressed to a different guide, book on a
student's behalf at any length, and cancel or shorten any booking. Every override is
written to an audit trail with who did it and when.

### 6.2 Guides are remembered, not assigned

There are 55 students across 4 guides today (§6.4), **and those pairings change every few
weeks.** Any design where the guide assignment is authoritative data becomes a
re-upload chore forever, and goes silently wrong the moment someone forgets. So the
roster is only a *starting value*, and the real source of truth is what students actually
type.

**Prefill order**, first match wins:

1. The guide this student most recently sent a request to **that was answered**.
2. The guide they most recently sent a request to, answered or not.
3. Their seeded roster guide (§6.3), lowest `priority` first where they have several.
4. Empty — they type one.

Rule 1 sitting above rule 2 is what keeps a typo from becoming permanent. An address
nobody ever replies from never gets promoted to the student's default; the last address
that actually worked stays the prefill. That matters because a mistyped
`@alpha.school` address fails silently — it's a real domain, the mail just goes nowhere.

**When guides reshuffle, nobody does anything.** The first time a student sends a request
to their new guide and that guide answers, the new pairing becomes the default from then
on. The roster ages out on its own. No admin screen, no re-upload, no stale column.

**Several guides per student is the normal case, not an edge case.** Chloe's 13 students
are also Clay's. So the prefill is a default, never a constraint: students see their
**last 3 distinct guides** as one-tap chips and can always type someone else.

```sql
-- most-recently-used guides per student; the learned replacement for a static roster
create table guide_mru (
  user_id       uuid not null references profiles on delete cascade,
  guide_email   text not null,
  guide_id      uuid references profiles,
  use_count     int  not null default 1,
  last_used_at  timestamptz not null default now(),
  confirmed     boolean not null default false,  -- true once a request here was answered
  seed_priority smallint,                        -- from the roster; null once learned
  primary key (user_id, guide_email)
);

create index on guide_mru (user_id, confirmed desc, last_used_at desc);
```

`create_booking` upserts a row here on every request; `decide_approval` flips `confirmed`
to true. Prefill is one indexed read:

```sql
select guide_email from guide_mru
where user_id = auth.uid()
order by confirmed desc, last_used_at desc, seed_priority asc nulls last
limit 1;
```

**This is a separate table on purpose, not a query over `approvals`.** The retention policy
in §9 deletes booking rows after 90 days, which would wipe a derived MRU every summer
and quietly reset every student to a roster that's months out of date. `guide_mru` holds
no booking details — just a student, a guide, and a timestamp — so it survives the purge
without holding onto anything the purge exists to remove.

### 6.3 Initial roster

55 students and 5 guides, seeded as the *starting* prefill only (rule 3 above).
68 pairings, because Chloe's 13 students are shared with Clay.

| Guide | Email | Students | Count |
|---|---|---|---|
| **Emerson** | `emerson.goldman@alpha.school` | Aarya, Adrienne, Aheli, Aydin, Fynn, Gus, Harley, Jaiden, Jessica, Kanhai, Kavin, Oz, Rhett, Stella C | 14 |
| **Emily** | `emily.findley@alpha.school` | Airy, Aoife, Armaan, Austin L, Branson, Eva, Greyson, Henry, Jacob, Layla, Leo, Reece, Teresa, Valentina | 14 |
| **Kent** | `kent.auslander@alpha.school` | AJ, Ali, Arjun, Artemis, Atticus, Dorian, Emma, Grady, Gwen, Izzy, Liam, Mollie, Said, Estella | 14 |
| **Chloe** | `chloe.belvin@alpha.school` | Allegra, Anya, Benny, Erika, Evan, Hudson, Jackson, Jaya, Lulu, Michael, Roarke, Stella G, Zayen | 13 |
| **Clay** | `dustin.hansford@alpha.school` | *(same 13 as Chloe)* | 13 |

Written to [`seed_roster.sql`](seed_roster.sql) and ready to run.

**Clay's address doesn't follow the pattern** — `dustin.hansford@`, not `clay.*@`. That's
correct and confirmed, and it's noted in the seed file so nobody "corrects" it later.
His **display name is Clay** everywhere a student sees it: students search for the
person they know, not the mailbox.

**Matching roster names to real accounts.** Students arrive via Google sign-in with a full
name and an email; the roster has first names only. Matching is done on first name, and
**8 of the 55 are genuinely ambiguous**: Stella C / Stella G / Estella are mutually
confusable, as are Ali / Allegra and Eva / Evan, and Austin L's last initial implies a
second Austin. So:

- Exact first-name match on a single candidate → link automatically.
- Anything ambiguous or unmatched → an admin **Link students** screen, one dropdown per
  person. With 55 students this is a few minutes of work, once.
- Never guess between two candidates. Linking Stella C's account to Stella G's guide is
  worse than leaving it blank, because the student won't notice a wrong prefill until
  their request goes to the wrong person.

**A wrong or missing seed is low-stakes**, which is the point of the design: worst case a
student gets a wrong prefill once, clears the chip, types the right guide, and §6.3 learns
it permanently. The system converges on correct regardless of how good the roster is —
so it's not worth much effort to get perfect.

### 6.4 No-shows: 5-minute auto-release

A reservation nobody shows up for is worse than no reservation system at all: the room
looks taken and sits empty. So:

- A booking must be **checked in** within **5 minutes** of its start.
- Check-in opens 10 minutes *before* the start time, so a student who arrives early
  claims the room rather than racing a deadline.
- Check-in is a tap in the app (v1: honor system; v2: optional QR code taped inside
  each pod).
- Un-checked-in bookings **auto-release at start + 5 min**. Status flips to `no_show`,
  the room flips to Open on the board, and the slot is immediately bookable by anyone.
- The student gets a push notification at start time — *"Check in now or Hallway Pod 3
  opens up in 5 minutes"* — and a second when it releases. Nothing punitive; 5 minutes
  is tight enough that the warning has to actually arrive for the rule to feel fair.
- **A released booking is gone, not paused.** The student who let it lapse can rebook
  if the room is still free, with no priority.

A 5-minute window makes the board accurate but leaves little room for a student stuck
talking to a guide. The mitigating pieces are the early check-in window and the
notification at start. Watch the no-show rate during the pilot — if it's high but the
rooms are actually in use, the window is too tight and 10 minutes is the right number.
It's one row in `settings`, changeable without a deploy.

**Approved long bookings release the same way.** A 4-hour conference room a guide signed
off on still auto-releases 5 minutes in if nobody shows. The approval authorizes the
length; it doesn't exempt anyone from turning up.

**Repeat no-shows:** three in a rolling 14 days drops the student's concurrent limit to
1 for a week, shown in their profile with a plain explanation. This is the only
enforcement mechanism and it should be the last thing built — ship without it and add
it only if squatting turns out to be real.

### Walk-ups

Most pod use will be spontaneous. A student walking up to an open pod taps `Book 30m`
and is checked in immediately — one tap, no form. This path has to be fast or people
will route around the app entirely and the board goes stale.

## 7. Data model

Postgres via Supabase. The schema is small; the interesting part is §7.1.

```sql
-- profiles: one row per authed user, keyed to auth.users
create table profiles (
  id          uuid primary key references auth.users on delete cascade,
  email       text not null unique,
  full_name   text not null,             -- from Google; may be a legal name
  display_name text,                     -- preferred name, overrides full_name in all UI
  avatar_url  text,
  role        text not null default 'student'
                check (role in ('student','guide','admin')),
  visible     boolean not null default true,  -- opt out of the People board
  created_at  timestamptz not null default now()
);
```

`display_name` exists because Google hands back whatever name is on the account, which
isn't always the name people use. **Clay's account is Dustin Hansford**, his legal name;
students know him as Clay. Several students are in the same position — Gus, Izzy, Lulu,
Oz, AJ and Benny all look like names that won't match a Google account.

So every surface that shows a person reads `coalesce(display_name, full_name)`, and
preferred names are **seeded, not left for people to discover a setting**: guides from
`preferred_names` in the seed file, students from their roster name when their account is
linked. Anyone can change their own afterward.

Getting this wrong isn't cosmetic. A People board listing "Dustin Hansford" is a board
where students can't find their guide, which is the problem this app exists to solve.
And a name someone doesn't use is worth avoiding on its own terms.

```sql
create table zones (
  id    serial primary key,
  name  text not null unique,           -- Underpass, Hallway, Atrium, Pomodoro Room, Upstairs
  floor smallint not null default 1,
  sort  smallint not null default 0
);

create table rooms (
  id           serial primary key,
  slug         text not null unique,
  name         text not null,
  zone_id      int  not null references zones,
  capacity     smallint not null default 1,
  kind         text not null default 'pod'
                 check (kind in ('pod','conference','special')),
  max_minutes  smallint,                -- null => fall back to settings default
  bookable     boolean not null default true,
  sort         smallint not null default 0
);

create table bookings (
  id          uuid primary key default gen_random_uuid(),
  room_id     int  not null references rooms,
  user_id     uuid not null references profiles,
  booked_by   uuid not null references profiles,  -- differs when a guide books for a student
  during      tstzrange not null,
  purpose     text,
  status      text not null default 'reserved'
                check (status in ('pending_approval','reserved','checked_in',
                                  'completed','cancelled','declined','expired','no_show')),
  checked_in_at timestamptz,
  created_at  timestamptz not null default now()
);

-- one row per long booking needing a guide's sign-off (§6.1)
create table approvals (
  booking_id    uuid primary key references bookings on delete cascade,
  guide_email   text not null check (guide_email ilike '%@alpha.school'),
  guide_id      uuid references profiles,       -- resolved if that guide has an account
  token_hash    text not null,                  -- sha256 of the emailed single-use token
  token_expires timestamptz not null,
  decision      text check (decision in ('approved','declined')),
  decided_by    uuid references profiles,       -- may differ from guide_id on override
  decided_at    timestamptz,
  reason        text,                           -- guide's optional one-liner on decline
  requested_at  timestamptz not null default now()
);

-- every guide override, for accountability (§6.1)
create table audit_log (
  id         bigserial primary key,
  actor_id   uuid not null references profiles,
  action     text not null,                     -- override_approve, force_cancel, book_for, shorten
  booking_id uuid references bookings,
  detail     jsonb,
  created_at timestamptz not null default now()
);

-- guide presence, set manually — never inferred from location data
create table presence (
  user_id    uuid primary key references profiles on delete cascade,
  status     text not null default 'roaming'
               check (status in ('roaming','in_room','off_campus','dnd')),
  room_id    int references rooms,
  note       text,
  updated_at timestamptz not null default now()
);

create table settings (
  key   text primary key,
  value jsonb not null
);
```

### 7.1 Double-booking is impossible by construction

The one thing this app must never do is hand two students the same room. Application-level
"check then insert" loses to a race every time — two students tapping the same open pod
a half-second apart both see it free.

Push it into the database:

```sql
create extension if not exists btree_gist;

alter table bookings add constraint bookings_no_overlap
  exclude using gist (
    room_id with =,
    during  with &&
  ) where (status in ('pending_approval','reserved','checked_in'));
```

Postgres now rejects any overlapping reservation for the same room, atomically, no
matter how the write arrives — API, admin panel, or someone poking the table by hand.
The second student gets a clean "just taken, here are three open pods nearby" instead
of a silent conflict. Everything else in the system can be sloppy; this cannot.

**`pending_approval` is inside the constraint on purpose.** That's what makes a pending
request hold the room (§6.1) — the hold and the double-booking guarantee are the same
mechanism, so there's no way for them to disagree. `declined`, `expired`, `no_show`,
and `cancelled` all fall outside it, which means every release path — a guide declining,
a request timing out, the 5-minute no-show sweep — is a single status update and the
slot is instantly bookable by anyone.

All writes go through `SECURITY DEFINER` Postgres functions that enforce quotas, hours,
and duration, then insert:

| Function | Enforces |
|---|---|
| `create_booking` | ≤ 2 h self-serve, or creates `pending_approval` + approval row above that |
| `decide_approval` | Valid unexpired token or guide role; flips to `reserved` / `declined` |
| `check_in` | Within the check-in window, by the booking's owner |
| `extend_booking` | Re-runs the 2-hour gate on the **new total** length, not the delta |
| `cancel_booking` | Owner, or guide (logged to `audit_log`) |

Quota and duration checks are advisory; the exclusion constraint is the wall.

The `extend_booking` rule matters: without it, a student books 2 hours and extends by 30
minutes repeatedly to route around the approval gate entirely.

### 7.2 Row-level security

RLS on from the first migration, not bolted on later:

- `profiles` — everyone reads name/avatar/role; only the owner updates their own row; only admins change `role`.
- `bookings` — everyone reads (the board is public within the school); insert/update only via the RPCs above; owner or guide can cancel.
- `approvals` — readable by the requesting student, the named guide, and admins. **`token_hash` is never exposed to any client**; the decision endpoint is a server route that hashes the incoming token and compares server-side. Writes only via `decide_approval`.
- `audit_log` — admins read; nobody writes directly, only the RPCs.
- `presence` — everyone reads; only the owner writes their own.
- `rooms` / `zones` / `settings` — everyone reads; only admins write.

## 8. Stack

- **Next.js 15** (App Router, TypeScript) — server components for the initial board
  render so the page is useful before JS hydrates.
- **Supabase** — Postgres, Auth (Google OAuth), Realtime, RLS.
- **Tailwind CSS** + **shadcn/ui**.
- **Vercel** for hosting. Free tier is comfortably enough for a few hundred students.
- **Resend** for transactional email — the approval requests to guides. Needs a verified
  sending domain; if IT won't delegate DNS for `alpha.school`, a subdomain like
  `rooms.alpha.school` is the usual compromise. **Sort this out in Phase 0** — it's the
  one dependency with an external lead time, and the approval flow is dead without it.
- **pg_cron** (Supabase), every minute, running three sweeps: 5-minute no-show release,
  expiry of unanswered approval requests at their start time, and marking finished
  bookings `completed`.

### Auth

Google sign-in, restricted to the `alpha.school` hosted domain. Two layers:

1. `hd=alpha.school` parameter on the OAuth request (a hint, not a guarantee — trivially spoofable client-side).
2. A Postgres trigger on `auth.users` that rejects any signup whose email doesn't end in `@alpha.school`. This is the real check.

Name and avatar come from the Google profile, so the People board is populated with
real names on day one and nobody types anything.

### Realtime

Subscribe to `postgres_changes` on `bookings` and `presence`, filtered to today.
Board state lives in one client store; every screen (Now, Map, People) reads from it,
so all three stay in sync from a single subscription. Fall back to a 30-second poll
if the socket drops.

### Branding

Alpha High visual identity — navy, the wolf mark, the real typography — via the
`alpha-high-brand-guide` skill during implementation. It ships a favicon set ready to
drop in. Worth doing at the end of Phase 2, when there are screens to brand.

### Repo layout

```
campus-rooms/
├── app/
│   ├── (auth)/login/
│   ├── (app)/
│   │   ├── page.tsx              # Now board
│   │   ├── map/
│   │   ├── rooms/[slug]/
│   │   ├── people/
│   │   ├── bookings/
│   │   ├── approvals/            # guide inbox
│   │   └── admin/
│   ├── approve/[token]/          # tokenless-auth decision page from the email
│   └── api/
│       ├── approvals/decide/     # verifies token server-side, calls decide_approval
│       └── cron/                 # sweep endpoints (also callable by pg_cron)
├── components/
│   ├── room-card.tsx
│   ├── campus-map.tsx            # the SVG + fill logic
│   ├── booking-sheet.tsx         # incl. the >2h approval-request branch
│   ├── approval-card.tsx
│   └── ui/                       # shadcn
├── emails/
│   └── approval-request.tsx      # React Email template
├── lib/
│   ├── supabase/                 # browser + server clients
│   ├── bookings.ts               # RPC wrappers
│   └── realtime.ts
├── supabase/
│   ├── migrations/
│   └── seed.sql                  # the 19 rooms + zones + settings
└── types/database.ts             # generated from the schema
```

## 9. Privacy

This app knows where minors are during the school day. That deserves deliberate limits,
and getting them right is also what keeps students willing to use it — a tool that feels
like monitoring gets routed around.

- Location is shown **only** as "has a booking in room X." No GPS, no wifi triangulation, no history.
- Guide status is **self-reported**. Guides set it; the app never infers it.
- Students can set `visible = false` and disappear from the People board while still booking normally.
- Booking history is visible to the student, guides, and admins — not to other students. The People board is present-tense only.
- Retain booking rows 90 days, then aggregate into counts and delete the rows. The
  usage report needs totals, not a permanent record of where each kid sat in October.
- Run the whole thing past whoever owns student data policy at Alpha before launch.

## 10. Build order

**Phase 0 — Foundation (day 1)**
Next.js + Supabase project, Google auth with the domain trigger, schema migration,
seed all 19 rooms, deploy a signed-in "hello" page to Vercel. **Start the Resend domain
verification today** — it needs DNS records from IT and blocks Phase 2.
Ends with auth working end-to-end on a real URL.

**Phase 1 — Booking core (days 2–4)**
The exclusion constraint and the RPCs. Now board (list only, no map). Room detail with
today's timeline. Book, cancel, my bookings. Realtime subscription. The 2-hour cap
enforced as a **hard limit** for now — no approval path yet, students just can't exceed it.
*Ships as a usable product.*

**Phase 2 — Check-in and approvals (days 5–7)**
Check-in, the 5-minute no-show sweep via pg_cron, and the full approval flow: request
form, signed token emails, the tokenless decision page, guide inbox, expiry sweep, guide
override + audit log. Plus `guide_mru`, the roster seed, auto-linking, and the admin
**Link students** screen. Roughly half this phase is the approval flow — it's the single
biggest piece of new surface, and the only one with an external dependency.

**Phase 3 — Presence (days 8–9)**
Guide status setter, People board, Alpha High branding pass.
*This is where it starts solving the findability problem.*

**Phase 4 — Map (days 10–11)**
Author the floor SVG, wire fills to board state, floor toggle. Needs a walk of the
building with a notebook — worth doing, not worth blocking earlier phases on.

**Phase 5 — Admin & polish (days 12–13)**
Admin panel, usage report, PWA manifest + install prompt, empty/error/offline states,
push notifications for check-in reminders.

**Phase 6 — Pilot**
One group of ~20 students and 2–3 guides for a week. Three numbers to watch:

1. **Walk-up booking rate** — do students book pods they're standing in front of? If not,
   the one-tap flow is too slow and the board will never be trustworthy.
2. **No-show rate at 5 minutes** — is the window fair, or is it punishing students who got
   held up? One `settings` row to relax.
3. **Approval response time** — how long guides take to answer, and how many requests
   expire unanswered. If expiries are common the gate is a dead end, and the fix is either
   nagging guides or auto-approving after N hours instead of expiring.

## 11. Open questions

**Blocking the room seed:**

1. Zone for Conference Rooms 1–4 — and are they co-located?
2. Real capacities, especially the conference rooms and podcast room.
3. Campus hours, and any standing blackout windows (all-school meetings, testing).

**Blocking the approval flow (Phase 2):**

4. **Can you get DNS records added for `alpha.school` (or a `rooms.` subdomain)?** Everything in §6.1 depends on email actually landing in guides' inboxes. This is the one item with an external lead time — worth an email to IT today.
5. For Chloe/Clay's 13 shared students, should the prefill favour one of them, or just offer both chips? Currently Chloe pre-fills and Clay is one tap away, purely because she was named first — the MRU overwrites this on first use either way.
6. What happens to a request the student's guide *declines* — can they ask a different guide, or is that final? Currently final; they can rebook at ≤ 2 h.
7. Do any of Emerson's, Emily's, or Kent's students also have a second guide? Only the Chloe/Clay pairing was given, and a missing second guide is a chip a student won't see.

**Non-blocking:**

8. How many students total? Changes nothing architecturally under ~2,000, but sets quota defaults.
9. Who are the admins besides you?
10. Is there an existing student roster or Google Group to sync against, or is first-sign-in enough? A guide roster would make the email autocomplete in §6.1 reliable on day one.
11. Does the school already use Google Calendar for conference rooms? If so, a two-way sync is worth scoping — otherwise there will be two sources of truth for the same four rooms.

**Resolved:** Pomodoro Pod is in the Pomodoro Room zone, with no set timer and no special
booking rules. Conference rooms are first-come like pods, with the same 2-hour approval
gate rather than a room-specific one.

## 12. Decisions log

Settled, with the reasoning, so they don't get reopened mid-build.

| # | Decision | Date | Rationale |
|---|---|---|---|
| D1 | **Pending approval requests hold the room.** `pending_approval` sits inside the exclusion constraint, so the hold and the double-booking guarantee are the same mechanism. Holds expire at the booking's start time. | 2026-09-15 | Approving a room someone else took in the meantime makes approval worthless. Expiry caps the downside. |
| D2 | **`extend_booking` re-checks the new total length against the 2-hour gate, not the delta.** | 2026-09-15 | Otherwise a student books 2 h and extends 30 min at a time, routing around approval entirely. |
| D3 | **Any guide can approve any student's request**, not only that student's own guide. Cross-guide decisions are written to `audit_log`. | 2026-09-15 | A room shouldn't stay held because one guide is out. The audit trail keeps it accountable. |
| D4 | Google sign-in restricted to `@alpha.school`, enforced by a database trigger rather than the OAuth `hd` hint. | 2026-09-15 | The `hd` parameter is client-side and spoofable; the trigger is the real boundary. |
| D5 | Pomodoro Pod has no set timer and no special rules. | 2026-09-15 | Confirmed on campus; the name is misleading and this needs to be written down. |
| D6 | **Guide pairings are learned from use, not maintained.** The 55-student roster seeds the first prefill only; `guide_mru` takes over permanently once a request is answered. | 2026-09-15 | Pairings change every few weeks. Authoritative roster data = a re-upload chore forever, and silent staleness when someone forgets. |
| D7 | Only a **confirmed** (answered) request promotes a guide to a student's default. | 2026-09-15 | A mistyped `@alpha.school` address fails silently — real domain, mail goes nowhere — and would otherwise become sticky. |
| D8 | **A student can have several guides**, modelled as multiple rows rather than one column. Chloe's 13 are also Clay's. | 2026-09-15 | Found on the first real roster, so it's the normal case. A single `guide_id` column would have needed migrating out within the week. |
| D10 | **Students may book at most 2 hours ahead.** Staff are exempt so a guide can hold a conference room for a scheduled session. Replaces the 7-day horizon. | 2026-09-15 | Pods are for the next hour, not next Tuesday. A long horizon fills the board with plans that don't happen, which is the same failure as no-shows. Consequence: a >2h approval request must be made within 2h of its start, so the guide has under two hours to answer before it expires. |
| D9 | **Preferred names are seeded, not opt-in.** `display_name` on `profiles`, pre-filled for guides and for students from their roster name; everyone can change their own. Clay's account is `dustin.hansford@` (legal name); he goes by Clay. | 2026-09-15 | Google returns account names, not used names. A People board showing names students don't recognise defeats the app's whole purpose — and leaving people to find a settings toggle means most never will. |

Question 6 in §11 (can a student re-ask a different guide after a decline) stays open —
the current answer is no.

## 13. Success criteria

Six weeks after campus-wide launch:

- **>60% of pod occupancy is booked**, not walk-in-unbooked. This is the one that matters — it means the board reflects reality, which is what makes every other feature true.
- **<15% no-show rate** under the 5-minute release.
- **Median time-to-book under 10 seconds** from app open.
- **>80% of approval requests answered before they expire**, median response under 2 hours. Below that, the gate is blocking students rather than governing them.
- Students report they can find their guide without walking the building. Ask them directly; don't infer it from analytics.
