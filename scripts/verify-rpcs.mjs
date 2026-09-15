/**
 * Exercises the booking RPCs end to end against a throwaway Postgres, acting
 * as different users by setting the JWT claims the stubs read.
 *
 *   npm run verify:rpcs
 */
import EmbeddedPostgres from 'embedded-postgres'
import { readFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = new URL('..', import.meta.url).pathname
const read = (f) => readFileSync(join(root, f), 'utf8')
const dataDir = mkdtempSync(join(tmpdir(), 'rpc-pg-'))
const pg = new EmbeddedPostgres({
  databaseDir: dataDir, user: 'postgres', password: 'postgres',
  port: 6000 + Math.floor(Math.random() * 1500), persistent: false,
})

let client, passed = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
const q = (sql, params) => client.query(sql, params)
const as = async (userId, role = 'authenticated') => {
  await q(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? ''])
  await q(`select set_config('request.jwt.claim.role', $1, false)`, [role ?? ''])
}
const expectErr = async (fn, re) => {
  try { await fn(); return { ok: false, msg: 'did not throw' } }
  catch (e) { return { ok: re ? re.test(e.message) || re.test(e.code ?? '') : true, msg: `${e.code ?? ''} ${e.message}` } }
}
const signup = async (email, name) => (await q(
  `insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('full_name', $2::text)) returning id`,
  [email, name])).rows[0].id
const status = async (id) => (await q(`select status from bookings where id=$1`, [id])).rows[0].status

try {
  await pg.initialise(); await pg.start(); await pg.createDatabase('cr')
  client = pg.getPgClient(); client.database = 'cr'; await client.connect()
  await q(read('supabase/test/00_supabase_stubs.sql'))
  for (const f of readdirSync(join(root, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort())
    await q(read('supabase/migrations/' + f))
  await q(read('supabase/seed.sql'))

  // --- actors --------------------------------------------------------------
  const aarya  = await signup('aarya.x@alpha.school',  'Aarya Patel')      // student, Emerson's
  const anya   = await signup('anya.x@alpha.school',   'Anya Rivera')      // student, Chloe/Clay's
  const kent   = await signup('kent.auslander@alpha.school', 'Kent Auslander')
  const chloe  = await signup('chloe.belvin@alpha.school',   'Chloe Belvin')
  const gus    = await signup('gus.x@alpha.school',    'Augustus Reyes')   // fresh, for extend tests
  const izzy   = await signup('izzy.x@alpha.school',   'Isabella Ng')
  const lulu   = await signup('lulu.x@alpha.school',   'Lucia Marsh')      // fresh, for in-app approvals
  await q(`update profiles set role='guide' where id in ($1,$2)`, [kent, chloe])
  const room   = async (slug) => (await q(`select id from rooms where slug=$1`, [slug])).rows[0].id
  const hallway3 = await room('hallway-3'), hallway4 = await room('hallway-4'), conf1 = await room('conf-1')

  // Next weekday at 10:00 campus time — always in the future, always open.
  const { rows: [{ start }] } = await q(`
    select (d + time '10:00') at time zone 'America/Chicago' as start
      from generate_series((now() at time zone 'America/Chicago')::date + 1,
                           (now() at time zone 'America/Chicago')::date + 7, '1 day') d
     where extract(isodow from d) between 1 and 5 order by d limit 1`)
  const T = (h, m = 0) => new Date(new Date(start).getTime() + (h * 60 + m) * 60000)
  const create = (roomId, from, to, extra = {}) => q(
    `select create_booking($1, $2, $3, $4, $5, $6) r`,
    [roomId, from, to, extra.purpose ?? null, extra.guide ?? null, extra.forUser ?? null]
  ).then(r => r.rows[0].r)

  // =========================================================================
  console.log('\ncreate_booking — happy path & the 2-hour gate')
  await as(aarya)
  const b1 = await create(hallway3, T(0), T(1))
  check('student books 1h → reserved', b1.status === 'reserved' && !b1.needs_approval)

  let r = await expectErr(() => create(conf1, T(0), T(3)), /guide's approval/)
  check('3h with no guide email is refused', r.ok, r.msg)

  r = await expectErr(() => create(conf1, T(0), T(3), { guide: 'kent@gmail.com' }), /alpha\.school/)
  check('non-school guide email is refused', r.ok, r.msg)

  const b2 = await create(conf1, T(0), T(3), { guide: 'Kent.Auslander@alpha.school', purpose: 'group project' })
  check('3h with guide email → pending_approval', b2.status === 'pending_approval' && b2.needs_approval)
  const appr = (await q(`select * from approvals where booking_id=$1`, [b2.booking_id])).rows[0]
  check('approvals row created, addressed to guide (lowercased), no token yet',
    appr?.guide_email === 'kent.auslander@alpha.school' && appr.guide_id === kent && appr.token_hash === null)
  const mru = (await q(`select * from guide_mru where user_id=$1 and guide_email='kent.auslander@alpha.school'`, [aarya])).rows[0]
  check('guide_mru remembers the ask, unconfirmed', mru && mru.confirmed === false)

  await as(anya)
  r = await expectErr(() => create(conf1, T(1), T(2)))
  check('pending request HOLDS the room against another student (D1)', r.ok && /23P01|overlap/.test(r.msg), r.msg)

  r = await expectErr(() => create(hallway3, T(0, 30), T(1, 30)))
  check('overlapping a reserved booking is rejected', r.ok && /23P01|overlap/.test(r.msg), r.msg)
  const b3 = await create(hallway3, T(1), T(2))
  check('back-to-back booking is fine', b3.status === 'reserved')

  await as(kent)
  const bg = await create(conf1, T(4), T(7))
  check('guide books 3h with no approval', bg.status === 'reserved' && !bg.needs_approval)

  // =========================================================================
  console.log('\ncreate_booking — rules')
  await as(aarya)
  r = await expectErr(() => create(hallway4, T(2), T(2, 20)), /15 minute steps/)
  check('20-minute booking refused (granularity)', r.ok, r.msg)
  r = await expectErr(() => create(hallway4, T(-3), T(-2)), /between/)
  check('07:00 start refused (before campus opens)', r.ok, r.msg)
  r = await expectErr(() => create(hallway4, T(6, 30), T(7, 30)), /between/)
  check('booking past 17:00 refused', r.ok, r.msg)
  const sat = new Date(start); sat.setDate(sat.getDate() + ((6 - sat.getDay() + 7) % 7 || 7))
  r = await expectErr(() => create(hallway4, sat, new Date(sat.getTime() + 3600000)), /closed|days ahead/)
  check('weekend refused', r.ok, r.msg)
  r = await expectErr(() => create(hallway4, new Date(Date.now() - 3600000), new Date()), /past/)
  check('past start refused', r.ok, r.msg)
  r = await expectErr(() => create(hallway4, T(-2), T(7), { guide: 'kent.auslander@alpha.school' }), /longest possible/)
  check('9h (08:00–17:00) refused even with a guide (hard ceiling)', r.ok, r.msg)

  // aarya holds b1 (reserved) + b2 (pending) = 2 → limit
  r = await expectErr(() => create(hallway4, T(2), T(3)), /already have 2/)
  check('third concurrent booking refused (quota)', r.ok, r.msg)

  r = await expectErr(() => create(hallway4, T(2), T(3), { forUser: anya }), /only book for yourself/)
  check('student cannot book for someone else', r.ok, r.msg)
  await as(chloe)
  const bf = await create(hallway4, T(2), T(3), { forUser: anya })
  const owner = (await q(`select user_id, booked_by from bookings where id=$1`, [bf.booking_id])).rows[0]
  const audit = (await q(`select count(*)::int n from audit_log where action='book_for' and booking_id=$1`, [bf.booking_id])).rows[0].n
  check('guide books on behalf of a student, audited', owner.user_id === anya && owner.booked_by === chloe && audit === 1)

  // =========================================================================
  console.log('\ncheck_in')
  const mkNow = async (userId, roomId, startOffsetMin, minutes = 60, st = 'reserved') => (await q(
    `insert into bookings (room_id,user_id,booked_by,during,status)
     values ($1,$2,$2, tstzrange(now() + make_interval(mins => $3::int), now() + make_interval(mins => $3::int + $4::int),'[)'), $5) returning id`,
    [roomId, userId, startOffsetMin, minutes, st])).rows[0].id
  const podA = await room('upstairs-1'), podB = await room('upstairs-2'), podC = await room('underpass-1')

  await as(aarya)
  const early = await mkNow(aarya, podA, 30)
  r = await expectErr(() => q(`select check_in($1)`, [early]), /opens 10 minutes/)
  check('check-in refused 30 min early', r.ok, r.msg)

  const soon = await mkNow(aarya, podB, 5)
  await q(`select check_in($1)`, [soon])
  check('check-in accepted 5 min early (inside 10-min window)', await status(soon) === 'checked_in')

  const late = await mkNow(aarya, podC, -6)
  r = await expectErr(() => q(`select check_in($1)`, [late]), /released/)
  check('check-in refused 6 min after start (past 5-min cutoff)', r.ok, r.msg)

  await as(anya)
  r = await expectErr(() => q(`select check_in($1)`, [early]), /not your booking/)
  check("cannot check in someone else's booking", r.ok, r.msg)

  // =========================================================================
  console.log('\ncancel_booking')
  r = await expectErr(() => q(`select cancel_booking($1)`, [b1.booking_id]), /not your booking/)
  check("student cannot cancel another student's booking", r.ok, r.msg)
  await as(aarya)
  await q(`select cancel_booking($1)`, [b1.booking_id])
  check('owner cancels', await status(b1.booking_id) === 'cancelled')
  await as(kent)
  await q(`select cancel_booking($1, 'assembly')`, [b3.booking_id])
  const fc = (await q(`select detail from audit_log where action='force_cancel' and booking_id=$1`, [b3.booking_id])).rows[0]
  check('guide force-cancels, with reason in audit log', await status(b3.booking_id) === 'cancelled' && fc?.detail?.reason === 'assembly')

  // =========================================================================
  console.log('\nextend_booking — D2: total length, not delta')
  await as(gus)
  const e1 = await create(hallway3, T(0), T(1))            // 60 min (b1 was cancelled, slot free)
  await q(`select extend_booking($1, $2)`, [e1.booking_id, T(1, 30)])
  check('60 → 90 min ok', (await q(`select upper(during) u from bookings where id=$1`, [e1.booking_id])).rows[0].u.getTime() === T(1, 30).getTime())
  r = await expectErr(() => q(`select extend_booking($1, $2)`, [e1.booking_id, T(2, 30)]), /pass the 120 minute limit/)
  check('90 → 150 min refused: crosses 2h gate by total', r.ok, r.msg)
  await as(izzy)
  const e2 = await create(hallway3, T(1, 45), T(2, 45))    // starts inside e1's possible 2h reach
  await as(gus)
  r = await expectErr(() => q(`select extend_booking($1, $2)`, [e1.booking_id, T(2)]))  // 120 min: gate allows, constraint refuses
  check('extending into another booking rejected by constraint', r.ok && /23P01|overlap/.test(r.msg), r.msg)
  void e2

  // =========================================================================
  console.log('\napprovals — token path')
  // Superuser ignores REVOKE, so observe the grants as the role PostgREST uses.
  await q(`set role authenticated`)
  r = await expectErr(() => q(`select mint_approval_token($1)`, [b2.booking_id]), /Not permitted|permission denied/)
  check('signed-in student cannot mint a token', r.ok, r.msg)
  r = await expectErr(() => q(`select apply_decision($1,'approved',null,null)`, [b2.booking_id]), /Not permitted|permission denied/)
  check('signed-in student cannot call apply_decision directly', r.ok, r.msg)
  r = await expectErr(() => q(`select decide_by_token('anything','approved')`), /permission denied/)
  check('signed-in student cannot call decide_by_token', r.ok, r.msg)
  r = await expectErr(() => q(`select run_sweeps()`), /permission denied/)
  check('signed-in student cannot run sweeps', r.ok, r.msg)
  r = await expectErr(() => q(`select link_roster_student($1, 'Stella G')`, [aarya]), /permission denied/)
  check('signed-in student cannot link roster rows', r.ok, r.msg)
  await q(`reset role`)
  // …and with superuser privileges but a student JWT, the in-function guard still holds.
  r = await expectErr(() => q(`select apply_decision($1,'approved',null,null)`, [b2.booking_id]), /Not permitted/)
  check('apply_decision refuses a student JWT even if the grant slipped', r.ok, r.msg)
  check('booking is still pending after all that', await status(b2.booking_id) === 'pending_approval')

  await as(null, 'service_role')
  const token = (await q(`select mint_approval_token($1) t`, [b2.booking_id])).rows[0].t
  const a2 = (await q(`select * from approvals where booking_id=$1`, [b2.booking_id])).rows[0]
  check('service role mints a 64-hex token; only its hash is stored',
    /^[0-9a-f]{64}$/.test(token) && a2.token_hash !== token && a2.token_hash?.length === 64 && a2.sent_at)
  check('token expiry is capped at the booking start', a2.token_expires.getTime() <= T(0).getTime())

  r = await expectErr(() => q(`select decide_by_token('deadbeef','approved')`), /not valid/)
  check('bogus token rejected', r.ok, r.msg)

  const d1 = (await q(`select decide_by_token($1,'approved') r`, [token])).rows[0].r
  check('valid token approves → reserved', d1.decision === 'approved' && !d1.already_decided && await status(b2.booking_id) === 'reserved')
  const mru2 = (await q(`select confirmed from guide_mru where user_id=$1 and guide_email='kent.auslander@alpha.school'`, [aarya])).rows[0]
  check('answered request CONFIRMS the guide in guide_mru (D7)', mru2.confirmed === true)

  const d2 = (await q(`select decide_by_token($1,'declined') r`, [token])).rows[0].r
  check('second click does not flip the decision', d2.already_decided && d2.decision === 'approved' && await status(b2.booking_id) === 'reserved')

  // =========================================================================
  console.log('\napprovals — in-app path & D3 cross-guide override')
  const conf2 = await room('conf-2'), conf3 = await room('conf-3')
  await as(lulu)
  const b5 = await create(conf2, T(0), T(3), { guide: 'chloe.belvin@alpha.school' })
  await as(aarya)
  r = await expectErr(() => q(`select decide_as_guide($1,'approved')`, [b5.booking_id]), /Only guides/)
  check('student cannot decide via the in-app path', r.ok, r.msg)

  await as(kent)  // NOT the guide it was addressed to
  const d3 = (await q(`select decide_as_guide($1,'approved') r`, [b5.booking_id])).rows[0].r
  const ov = (await q(`select detail from audit_log where action='override_approve' and booking_id=$1`, [b5.booking_id])).rows[0]
  check('a different guide can approve (D3), and it is audited',
    d3.decision === 'approved' && ov?.detail?.addressed_to === 'chloe.belvin@alpha.school')

  await as(lulu)
  const b6 = await create(conf3, T(0), T(3), { guide: 'chloe.belvin@alpha.school' })
  await as(chloe)
  const d4 = (await q(`select decide_as_guide($1,'declined','room is booked for testing') r`, [b6.booking_id])).rows[0].r
  check('addressed guide declines → declined, with reason', d4.decision === 'declined' &&
    (await q(`select reason from approvals where booking_id=$1`, [b6.booking_id])).rows[0].reason === 'room is booked for testing')
  const noOv = (await q(`select count(*)::int n from audit_log where action='override_approve' and booking_id=$1`, [b6.booking_id])).rows[0].n
  check('deciding your own request is not logged as an override', noOv === 0)
  await as(izzy)
  const b7 = await create(conf3, T(1), T(2))
  check('declined request frees the room immediately', b7.status === 'reserved')

  // =========================================================================
  console.log('\nsweeps')
  await as(null, null)  // pg_cron: no JWT
  const s1 = await room('underpass-2'), s2 = await room('underpass-3'), s3 = await room('hallway-1'), s4 = await room('hallway-2')
  const ns = await mkNow(anya, s1, -20)                    // reserved, started 20 min ago, never checked in
  const pend = await mkNow(anya, s2, -1, 180, 'pending_approval')  // request whose start has passed
  await q(`insert into approvals (booking_id, guide_email) values ($1,'chloe.belvin@alpha.school')`, [pend])
  const done = await mkNow(anya, s3, -120, 60, 'checked_in')   // ended an hour ago
  const fresh = await mkNow(anya, s4, -3)                  // started 3 min ago — still inside the 5-min grace
  const sw = (await q(`select run_sweeps() r`)).rows[0].r
  check('run_sweeps reports counts', sw.no_shows >= 1 && sw.expired >= 1 && sw.completed >= 1, JSON.stringify(sw))
  check('20-min-old un-checked-in booking → no_show', await status(ns) === 'no_show')
  check('3-min-old booking is NOT released yet (inside grace)', await status(fresh) === 'reserved')
  check('unanswered request past its start → expired', await status(pend) === 'expired')
  check('finished checked-in booking → completed', await status(done) === 'completed')
  await as(anya)
  const again = await mkNow(anya, s1, -20)  // same slot the no-show held
  check('the no-show slot is bookable again', !!again)
} catch (err) {
  console.error('\nFATAL:', err.message)
  failures.push(`fatal: ${err.message}`)
} finally {
  try { await client?.end() } catch {}
  try { await pg.stop() } catch {}
  rmSync(dataDir, { recursive: true, force: true })
}
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) { failures.forEach(f => console.log(`  - ${f}`)); process.exit(1) }
