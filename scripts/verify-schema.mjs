/**
 * Runs every migration and the seed against a throwaway Postgres, then asserts
 * the behaviour the plan depends on — above all that the database itself
 * refuses to double-book a room (PLAN.md §7.1).
 *
 * No Docker and no Supabase project required: the Postgres binary comes from
 * the embedded-postgres dev dependency, and supabase/test/00_supabase_stubs.sql
 * stands in for the auth schema.
 *
 *   npm run verify:schema
 */
import EmbeddedPostgres from 'embedded-postgres'
import { readFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = new URL('..', import.meta.url).pathname
const dataDir = mkdtempSync(join(tmpdir(), 'campus-rooms-pg-'))
const port = 5000 + Math.floor(Math.random() * 2000)

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: false,
})

let client
try {
  console.log(`\nStarting Postgres on port ${port}…`)
  await pg.initialise()
  await pg.start()
  await pg.createDatabase('campus_rooms')
  client = pg.getPgClient()
  client.database = 'campus_rooms'
  await client.connect()

  // --- apply stubs, migrations, seed ---------------------------------------
  console.log('\nApplying stubs + migrations…')
  await client.query(readFileSync(join(root, 'supabase/test/00_supabase_stubs.sql'), 'utf8'))

  const migrations = readdirSync(join(root, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()
  for (const file of migrations) {
    await client.query(readFileSync(join(root, 'supabase/migrations', file), 'utf8'))
    console.log(`  applied ${file}`)
  }

  console.log('\nApplying seed…')
  await client.query(readFileSync(join(root, 'supabase/seed.sql'), 'utf8'))
  console.log('  applied seed.sql')

  // --- seed contents -------------------------------------------------------
  console.log('\nSeed data:')
  const rooms = await client.query('select count(*)::int n from rooms')
  check('19 rooms seeded', rooms.rows[0].n === 19, `found ${rooms.rows[0].n}`)

  const zones = await client.query('select count(*)::int n from zones')
  check('6 zones seeded', zones.rows[0].n === 6, `found ${zones.rows[0].n}`)

  const roster = await client.query(
    'select count(distinct match_name)::int students, count(*)::int pairs from roster_seed')
  check('55 students on the roster', roster.rows[0].students === 55, `found ${roster.rows[0].students}`)
  check('68 student-guide pairings', roster.rows[0].pairs === 68, `found ${roster.rows[0].pairs}`)

  const shared = await client.query(
    `select count(*)::int n from (
       select match_name from roster_seed group by match_name having count(*) > 1
     ) t`)
  check("Chloe's 13 students also have Clay", shared.rows[0].n === 13, `found ${shared.rows[0].n}`)

  const pomodoro = await client.query(
    `select z.name zone, r.capacity, r.max_minutes from rooms r
       join zones z on z.id = r.zone_id where r.slug = 'pomodoro'`)
  check('Pomodoro Pod is in the Pomodoro Room with no special limit',
    pomodoro.rows[0].zone === 'Pomodoro Room' && pomodoro.rows[0].max_minutes === null)

  // --- auth boundary -------------------------------------------------------
  console.log('\nAuth boundary:')
  let rejected = false
  try {
    await client.query(`insert into auth.users (email) values ('someone@gmail.com')`)
  } catch (e) { rejected = /alpha\.school/.test(e.message) }
  check('non-@alpha.school sign-up is rejected', rejected)

  const guideId = (await client.query(
    `insert into auth.users (email, raw_user_meta_data)
     values ('dustin.hansford@alpha.school', '{"full_name":"Dustin Hansford"}'::jsonb)
     returning id`)).rows[0].id
  check('@alpha.school sign-up is accepted', !!guideId)

  // --- preferred names -----------------------------------------------------
  console.log('\nPreferred names:')
  const clay = await client.query(
    `select full_name, display_name, display_of(p) as shown, role
       from profiles p where email = 'dustin.hansford@alpha.school'`)
  check('profile row created on sign-up', clay.rowCount === 1)
  check('Clay shows as "Clay", not "Dustin Hansford"',
    clay.rows[0].shown === 'Clay', `shown as "${clay.rows[0]?.shown}"`)
  check('legal name is still recorded', clay.rows[0].full_name === 'Dustin Hansford')

  // --- roster auto-linking -------------------------------------------------
  console.log('\nRoster auto-linking:')
  await client.query(
    `insert into auth.users (email, raw_user_meta_data)
     values ('aarya.x@alpha.school', '{"full_name":"Aarya Patel"}'::jsonb)`)
  const aarya = await client.query(
    `select p.display_name, count(g.*)::int guides
       from profiles p left join guide_mru g on g.user_id = p.id
      where p.email = 'aarya.x@alpha.school' group by p.display_name`)
  check('unambiguous student auto-links', aarya.rows[0]?.guides === 1,
    `${aarya.rows[0]?.guides} guide rows`)
  check('student display name comes from the roster', aarya.rows[0]?.display_name === 'Aarya')

  await client.query(
    `insert into auth.users (email, raw_user_meta_data)
     values ('stella.c@alpha.school', '{"full_name":"Stella Cortez"}'::jsonb)`)
  const stella = await client.query(
    `select count(g.*)::int guides from profiles p
       left join guide_mru g on g.user_id = p.id where p.email = 'stella.c@alpha.school'`)
  check('ambiguous student is NOT guessed at', stella.rows[0].guides === 0,
    `${stella.rows[0].guides} guide rows — should be 0`)

  const unlinked = await client.query(`select count(*)::int n from roster_unlinked where ambiguous`)
  check('8 ambiguous students await manual linking', unlinked.rows[0].n === 8, `found ${unlinked.rows[0].n}`)

  // --- THE constraint ------------------------------------------------------
  console.log('\nDouble-booking (PLAN.md §7.1):')
  const studentId = (await client.query(
    `select id from profiles where email = 'aarya.x@alpha.school'`)).rows[0].id
  const roomId = (await client.query(`select id from rooms where slug = 'hallway-3'`)).rows[0].id

  const mk = (start, end, status = 'reserved', user = studentId) => client.query(
    `insert into bookings (room_id, user_id, booked_by, during, status)
     values ($1, $2, $2, tstzrange($3::timestamptz, $4::timestamptz), $5) returning id`,
    [roomId, user, start, end, status])

  await mk('2026-09-16 10:00Z', '2026-09-16 11:00Z')

  let overlapRejected = false
  try { await mk('2026-09-16 10:30Z', '2026-09-16 11:30Z') }
  catch (e) { overlapRejected = e.code === '23P01' }
  check('overlapping booking is rejected by the database', overlapRejected)

  let touchOk = true
  try { await mk('2026-09-16 11:00Z', '2026-09-16 12:00Z') }
  catch { touchOk = false }
  check('back-to-back booking is allowed', touchOk)

  // A pending request must hold the room (D1), and releasing must free it.
  const roomId2 = (await client.query(`select id from rooms where slug = 'conf-1'`)).rows[0].id
  const pending = (await client.query(
    `insert into bookings (room_id, user_id, booked_by, during, status)
     values ($1,$2,$2, tstzrange('2026-09-17 13:00Z','2026-09-17 17:00Z'), 'pending_approval')
     returning id`, [roomId2, studentId])).rows[0].id

  let heldByPending = false
  try {
    await client.query(
      `insert into bookings (room_id, user_id, booked_by, during, status)
       values ($1,$2,$2, tstzrange('2026-09-17 14:00Z','2026-09-17 15:00Z'), 'reserved')`,
      [roomId2, studentId])
  } catch (e) { heldByPending = e.code === '23P01' }
  check('a pending approval holds the room (D1)', heldByPending)

  await client.query(`update bookings set status = 'expired' where id = $1`, [pending])
  let freedAfterExpiry = true
  try {
    await client.query(
      `insert into bookings (room_id, user_id, booked_by, during, status)
       values ($1,$2,$2, tstzrange('2026-09-17 14:00Z','2026-09-17 15:00Z'), 'reserved')`,
      [roomId2, studentId])
  } catch { freedAfterExpiry = false }
  check('expiring the request frees the room instantly', freedAfterExpiry)

  let noShowFrees = true
  const [a] = (await client.query(
    `insert into bookings (room_id, user_id, booked_by, during, status)
     values ($1,$2,$2, tstzrange('2026-09-18 09:00Z','2026-09-18 10:00Z'), 'reserved')
     returning id`, [roomId, studentId])).rows
  await client.query(`update bookings set status = 'no_show' where id = $1`, [a.id])
  try {
    await mk('2026-09-18 09:00Z', '2026-09-18 10:00Z')
  } catch { noShowFrees = false }
  check('a no-show release reopens the slot (§6.4)', noShowFrees)

  // --- RLS -----------------------------------------------------------------
  console.log('\nRow-level security:')
  const rlsOff = await client.query(
    `select string_agg(c.relname, ', ') t
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)
  check('RLS is enabled on every public table', rlsOff.rows[0].t === null,
    `missing on: ${rlsOff.rows[0].t}`)

  const bookingWrite = await client.query(
    `select count(*)::int n from pg_policies
      where tablename = 'bookings' and cmd <> 'SELECT'`)
  check('bookings have no direct write policy (RPC-only)', bookingWrite.rows[0].n === 0)

  // --- role guard ----------------------------------------------------------
  // The 22 checks above all passed while this was broken: nothing tested that
  // the first admin can actually be created. Now it does.
  console.log('\nRole guard:')
  const asUser = (id) => client.query(`select set_config('request.jwt.claim.sub', $1, false)`, [id ?? ''])

  await asUser(null)  // dashboard / SQL editor / service role: no user JWT
  let bootstrapOk = true
  try {
    await client.query(`update profiles set role = 'admin' where id = $1`, [guideId])
  } catch { bootstrapOk = false }
  check('first admin can be created from the SQL editor (no JWT)', bootstrapOk)

  await asUser(studentId)  // a signed-in student
  let selfPromoteBlocked = false
  try {
    await client.query(`update profiles set role = 'admin' where id = $1`, [studentId])
  } catch (e) { selfPromoteBlocked = e.code === '42501' }
  check('signed-in student cannot promote themselves', selfPromoteBlocked)

  let ownProfileOk = true
  try {
    await client.query(`update profiles set display_name = 'Aarya P.' where id = $1`, [studentId])
  } catch { ownProfileOk = false }
  check('student can still edit their own display name', ownProfileOk)

  await asUser(guideId)  // the admin we just made
  let adminPromoteOk = true
  try {
    await client.query(`update profiles set role = 'guide' where id = $1`, [studentId])
  } catch { adminPromoteOk = false }
  check('admin can change another user\'s role', adminPromoteOk)
  await asUser(null)

  // --- room management (staff-managed rooms & zones) -----------------------
  // Observed as the real `authenticated` role so RLS, not superuser, decides.
  console.log('\nRoom management:')
  await client.query(`update profiles set role = 'student' where id = $1`, [studentId])  // undo the promotion above
  await client.query(`set role authenticated`)

  await asUser(studentId)
  const stuRename = await client.query(`update rooms set name = 'Hacked Pod' where slug = 'hallway-3' returning id`)
  check('student cannot rename a room (RLS hides the row)', stuRename.rowCount === 0, `${stuRename.rowCount} rows`)
  let stuZoneBlocked = false
  try { await client.query(`insert into zones (name) values ('Student Zone')`) } catch (e) { stuZoneBlocked = e.code === '42501' }
  check('student cannot add a zone', stuZoneBlocked)

  await asUser(guideId)  // staff
  const staffRename = await client.query(`update rooms set name = 'Hallway Booth 3' where slug = 'hallway-3' returning name`)
  check('staff can rename a room', staffRename.rows[0]?.name === 'Hallway Booth 3')
  const staffZone = await client.query(`insert into zones (name, floor) values ('Library', 1) returning id, sort`)
  check('staff can add a zone; sort defaults past existing zones', staffZone.rowCount === 1 && staffZone.rows[0].sort > 60, `sort ${staffZone.rows[0]?.sort}`)
  const moved = await client.query(`update rooms set zone_id = $1 where slug = 'pomodoro' returning zone_id`, [staffZone.rows[0].id])
  check('staff can move a room to another zone', moved.rows[0]?.zone_id === staffZone.rows[0].id)
  const added = await client.query(
    `insert into rooms (slug, name, zone_id, capacity, sort) values ('library-1', 'Library Booth', $1, 2, next_room_sort($1)) returning id`,
    [staffZone.rows[0].id])
  check('staff can add a room', added.rowCount === 1)

  let fkBlocked = false
  try { await client.query(`delete from rooms where slug = 'hallway-3'`) } catch (e) { fkBlocked = e.code === '23503' }
  check('deleting a room with bookings is blocked (retire instead)', fkBlocked)
  const retired = await client.query(`update rooms set bookable = false where slug = 'hallway-3' returning bookable`)
  check('…but it can be retired', retired.rows[0]?.bookable === false)
  const del = await client.query(`delete from rooms where slug = 'library-1' returning id`)
  check('a never-booked room can be deleted', del.rowCount === 1)
  let zoneFk = false
  try { await client.query(`delete from zones where id = $1`, [staffZone.rows[0].id]) } catch (e) { zoneFk = e.code === '23503' }
  check('deleting a zone that still has rooms is blocked', zoneFk)

  await client.query(`reset role`)
  await asUser(null)
  // Restore fixtures other checks may rely on.
  await client.query(`update rooms set name = 'Hallway Pod 3', bookable = true where slug = 'hallway-3'`)

  // --- role confirmation at first sign-in (D11) ---------------------------
  console.log('\nRole confirmation:')
  const backfilled = await client.query(`select role_confirmed from profiles where id = $1`, [guideId])  // an admin
  check('existing staff are backfilled as confirmed', backfilled.rows[0]?.role_confirmed === true)
  // A brand-new sign-in, untouched by earlier sections.
  const freshId = (await client.query(
    `insert into auth.users (email, raw_user_meta_data) values ('benny.x@alpha.school', '{"full_name":"Benjamin Ortiz"}'::jsonb) returning id`)).rows[0].id
  const fresh = await client.query(`select role, role_confirmed from profiles where id = $1`, [freshId])
  check('a new sign-in starts unconfirmed as a student', fresh.rows[0]?.role === 'student' && fresh.rows[0]?.role_confirmed === false)
  const seeded = await client.query(`select count(*)::int n from staff_allowlist`)
  check('guide allowlist seeded from the known guides (5) + existing staff', seeded.rows[0].n >= 5, `${seeded.rows[0].n}`)

  await client.query(`set role authenticated`)
  await asUser(freshId)
  let notListed = null
  try { await client.query(`select confirm_role('guide', 'benny.x@alpha.school')`) } catch (e) { notListed = e }
  check('student not on the list cannot become a guide', notListed?.code === '42501' && /guide list/.test(notListed.message), notListed?.message)
  let stillStudent = await client.query(`select role, role_confirmed from profiles where id = $1`, [freshId])
  check('…and is still an unconfirmed student', stillStudent.rows[0].role === 'student' && stillStudent.rows[0].role_confirmed === false)

  const asStudent = (await client.query(`select confirm_role('student') r`)).rows[0].r
  stillStudent = await client.query(`select role, role_confirmed from profiles where id = $1`, [freshId])
  check('confirming as student marks the profile confirmed', asStudent.role === 'student' && stillStudent.rows[0].role_confirmed === true)

  // Promotion by an admin counts as confirmation and lands on the allowlist;
  // demotion must leave the allowlist, or they could re-promote themselves.
  await client.query(`reset role`)
  await asUser(guideId)  // admin
  await client.query(`update profiles set role = 'guide' where id = $1`, [freshId])
  const promoted = await client.query(`select role_confirmed from profiles where id = $1`, [freshId])
  const onList = await client.query(`select count(*)::int n from staff_allowlist where email = 'benny.x@alpha.school'`)
  check('admin promotion → confirmed and on the allowlist', promoted.rows[0].role_confirmed === true && onList.rows[0].n === 1)
  await client.query(`update profiles set role = 'student' where id = $1`, [freshId])
  const offList = await client.query(`select count(*)::int n from staff_allowlist where email = 'benny.x@alpha.school'`)
  check('admin demotion → removed from the allowlist', offList.rows[0].n === 0)
  await client.query(`set role authenticated`)
  await asUser(freshId)
  let rePromote = null
  try { await client.query(`select confirm_role('guide', 'benny.x@alpha.school')`) } catch (e) { rePromote = e }
  check('a demoted guide cannot re-promote themselves via confirm_role', rePromote?.code === '42501', rePromote?.message ?? 'it succeeded')

  // Put a real guide on the list and let them confirm.
  await client.query(`reset role`)
  await asUser(null)
  const kentId = (await client.query(
    `insert into auth.users (email, raw_user_meta_data) values ('kent.auslander@alpha.school', '{"full_name":"Kent Auslander"}'::jsonb) returning id`)).rows[0].id
  await client.query(`set role authenticated`)
  await asUser(kentId)
  let mismatch = null
  try { await client.query(`select confirm_role('guide', 'someone.else@alpha.school')`) } catch (e) { mismatch = e }
  check('guide claim with a different email than the account is refused', /doesn't match/.test(mismatch?.message ?? ''), mismatch?.message)
  const asGuide = (await client.query(`select confirm_role('guide', 'Kent.Auslander@alpha.school') r`)).rows[0].r
  const kentRow = await client.query(`select role, role_confirmed from profiles where id = $1`, [kentId])
  check('listed guide confirms (case-insensitive) → role guide', asGuide.role === 'guide' && kentRow.rows[0].role === 'guide' && kentRow.rows[0].role_confirmed === true)

  await asUser(guideId)  // the admin
  const adminPick = (await client.query(`select confirm_role('student') r`)).rows[0].r
  check('an admin tapping "student" stays admin', adminPick.role === 'admin')
  const canAdd = await client.query(`insert into staff_allowlist (email, added_by) values ('new.guide@alpha.school', $1) returning email`, [guideId])
  check('staff can add to the guide list', canAdd.rowCount === 1)
  await asUser(studentId)
  const stuList = await client.query(`select count(*)::int n from staff_allowlist`)
  check('students cannot see the guide list', stuList.rows[0].n === 0)
  let stuAdd = false
  try { await client.query(`insert into staff_allowlist (email) values ('me@alpha.school')`) } catch (e) { stuAdd = e.code === '42501' }
  check('students cannot add to the guide list', stuAdd)
  await client.query(`reset role`)
  await asUser(null)
} catch (err) {
  console.error('\nFATAL:', err.message)
  failures.push(`fatal: ${err.message}`)
} finally {
  try { await client?.end() } catch {}
  try { await pg.stop() } catch {}
  rmSync(dataDir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nFailures:')
  failures.forEach(f => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Schema verified.\n')
