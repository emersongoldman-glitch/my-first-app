# Campus Rooms

Pod and conference room reservations for Alpha High School — plus a live board showing
who's where, so students can actually find their guides and each other.

**Status:** planning. Nothing is built yet.

## Start here

- **[PLAN.md](PLAN.md)** — the full design: rooms, booking rules, schema, build order,
  and a decisions log (§12) recording what's already been settled and why.
- **[supabase/seed_roster.sql](supabase/seed_roster.sql)** — the 55-student roster and
  5 guides, ready to run. A *starting* value only; the app learns real pairings from use
  (PLAN.md §6.2).

## The two rules that matter most

1. **Bookings over 2 hours need a guide's approval** — the student names a guide, who
   approves or declines from a link in an email, no sign-in required (§6.1).
2. **Un-checked-in bookings auto-release 5 minutes after they start** (§6.4). A room that
   looks taken but sits empty is worse than having no system at all.

## Before Phase 0 can finish

- [ ] DNS records for a sending domain (`rooms.alpha.school` or similar) so approval
      emails actually arrive. **External lead time — start this first.**
- [ ] Confirm conference room zones and real capacities (PLAN.md §4).
- [ ] Confirm campus hours and any standing blackout windows.
