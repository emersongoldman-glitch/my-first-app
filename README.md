# Campus Rooms

Pod and conference room reservations for Alpha High School — plus a live board showing
who's where, so students can actually find their guides and each other.

**Status:** Phase 0 complete. Auth, schema, and seed data are done and verified; nothing
is bookable yet.

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
| `npm run verify:schema` | Runs every migration + the seed against a throwaway Postgres and asserts 22 behaviours. **No Docker needed.** |

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
