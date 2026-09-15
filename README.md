# Campus Rooms

Pod and conference room reservations for Alpha High School — plus a live board showing
who's where, so students can actually find their guides and each other.

**Status:** Phase 1 complete and live — booking, check-in, approvals, sweeps, a live map/list
board with a next-2-hours view per room, People search, guide/student confirmation at sign-in,
staff-managed rooms and guides, and Slack deep links. Databases set up earlier apply the files in
[`supabase/upgrades/`](supabase/upgrades/) in order, each pasted into the SQL Editor once.

## Start here

- **[PLAN.md](PLAN.md)** — the full design: rooms, booking rules, schema, build order,
  and a decisions log (§12) recording what's settled and why.
- **[supabase/migrations/](supabase/migrations/)** — the schema.
- **[supabase/seed.sql](supabase/seed.sql)** — 19 rooms, 5 guides, 55 students.

## The two rules that matter most

1. **Bookings over 2 hours need a guide's approval** — the student names a guide, who
   approves or declines from a link in an email, no sign-in required (PLAN.md §6.1).
2. **Un-checked-in bookings auto-release 5 minutes after they start** (§6.4). A room that
   looks taken but sits empty is worse than having no system at all.

## Live

**https://campus-rooms-eight.vercel.app** — production, on Vercel (project
`alpha-high-school-austin/campus-rooms`). Every `git push` to `main` does not yet auto-deploy;
run `npx vercel --prod` to ship. Env vars live on Vercel, not in the repo.
Note: `campus-rooms.vercel.app` (no suffix) is someone else's project.

## Running it

Node lives at `~/.local/node` (no admin rights needed) and is on your PATH via `~/.zshrc`.

```bash
npm install
cp .env.example .env.local   # then fill in the Supabase values
npm run dev
```

| Command | What it does |
|---|---|
| `npm run dev` | Dev server at http://localhost:3000 |
| `npm run build` | Production build |
| `npm run verify` | Everything below, in sequence. |
| `npm run verify:lib` | 19 checks on the pure helpers — notably that Postgres timestamps like `15:00:00+00` parse (they once didn't, and took down /people). |
| `npm run verify:schema` | Every migration + seed against a throwaway Postgres; 51 checks on constraints, auth, roster, RLS, room management, role confirmation. **No Docker needed.** |
| `npm run verify:rpcs` | 57 checks on the booking RPCs against a frozen clock: the 2-hour gate, horizon, quotas, check-in window, tokens, overrides, sweeps, grant boundaries. |
| `npm run verify:bootstrap` | The pasteable setup files apply cleanly, and the reset recovers a half-built database. |

`npm run verify:schema` is the one to run after touching any SQL. It proves, among other
things, that the database itself rejects a double-booking — the guarantee the whole app
rests on.

## Setting up Supabase

Phase 0 is code-complete but needs a Supabase project to point at. That requires signing
in, so it's yours to do:

1. Create a project at [supabase.com](https://supabase.com) (free tier is plenty).
2. Copy the project URL and anon key from **Project Settings → API** into `.env.local`.
3. Link and push the schema:
   ```bash
   npx supabase link --project-ref YOUR-PROJECT-REF
   npx supabase db push
   npx supabase db seed
   ```
4. In **Authentication → Providers → Google**, enable Google and paste in a client ID
   and secret from a Google Cloud OAuth consent screen. Set the redirect URL to
   `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`.
5. Sign in once, then promote yourself to admin:
   ```sql
   update profiles set role = 'admin' where email = 'emerson.goldman@alpha.school';
   ```

## Slack — "Message on Slack"

The People page can open a Slack DM with anyone listed. No in-app chat: students already use
Slack, and a messaging surface for minors is moderation we don't want to own. To turn it on:

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) → **From scratch**, in the
   school workspace. Under **OAuth & Permissions → Bot Token Scopes** add `users:read` and
   `users:read.email`. **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-…`).
2. Find the **team id**: the `T…` segment in any Slack URL, e.g. `https://app.slack.com/client/T0123ABCD/…`.
3. On Vercel → Project → **Settings → Environment Variables**, add for Production:
   - `NEXT_PUBLIC_SLACK_TEAM_ID` = the team id (plain config)
   - `SLACK_BOT_TOKEN` = the bot token (**sensitive**)
   - `SUPABASE_SERVICE_ROLE_KEY` = from Supabase → Project Settings → API (**sensitive**; the
     lookup route needs it to cache ids for other people's profiles)
4. Redeploy. A **Slack** button appears next to each person on the People page.

Lookups go through `/api/slack/lookup`, server-side only, and are cached on `profiles` for 7 days.

## Live board views

**Map** draws itself from the rooms table — zones as areas, rooms as tiles sized by seats and
coloured by state (open / booked / yours / held), floor switch when a campus has more than one.
It needs no hand-drawn floor plan, so renaming or adding rooms updates it automatically.
**List** is the same data as rows. Tapping a room shows who has it for the next two hours.

## Open items

- [ ] DNS records for a sending domain (`rooms.alpha.school` or similar) so approval
      emails arrive. **External lead time — start this first.** Blocks Phase 2.
- [ ] Confirm the zone and real capacities for Conference Rooms 1–4 (PLAN.md §11 Q1–Q2).
- [ ] Confirm campus hours and any standing blackout windows.
- [ ] Link the 8 students whose first names are ambiguous, once they've signed in
      (`select * from roster_unlinked`).

## Notes

- **Branding** comes from the official Alpha High guidelines: Dark Navy `#002970`,
  Blue/Cyan `#00A1E9`, Montserrat Bold. The display face, Neuropolitical, is a paid font
  and is not bundled — Montserrat stands in, per the brand guide's own note.
- `alpha-high-brand-guide.skill` in the repo root is a skill package, already installed
  in Claude Code. It's gitignored and safe to delete.
