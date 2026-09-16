/**
 * Verifies the two generated setup files against a throwaway Postgres:
 *
 *   1. bootstrap.sql on an empty database succeeds.
 *   2. bootstrap.sql run AGAIN fails with "already exists" — the state a
 *      half-finished first run leaves behind.
 *   3. reset_bootstrap.sql recovers from that state and lands correct counts.
 *
 *   npm run verify:bootstrap
 */
import EmbeddedPostgres from 'embedded-postgres'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = new URL('..', import.meta.url).pathname
const read = (f) => readFileSync(join(root, f), 'utf8')
const dataDir = mkdtempSync(join(tmpdir(), 'bootstrap-pg-'))
const pg = new EmbeddedPostgres({
  databaseDir: dataDir, user: 'postgres', password: 'postgres',
  port: 7000 + Math.floor(Math.random() * 1500), persistent: false,
})

const EXPECTED = { rooms: 19, zones: 6, students: 55, pairings: 68, guides: 5, settings: 13 }
let client
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const counts = async () => {
  const r = await client.query(`select
    (select count(*) from rooms)::int rooms,
    (select count(*) from zones)::int zones,
    (select count(distinct match_name) from roster_seed)::int students,
    (select count(*) from roster_seed)::int pairings,
    (select count(*) from preferred_names)::int guides,
    (select count(*) from settings)::int settings`)
  return r.rows[0]
}
const matches = (c) => Object.entries(EXPECTED).every(([k, v]) => c[k] === v)

try {
  await pg.initialise(); await pg.start(); await pg.createDatabase('cr')
  client = pg.getPgClient(); client.database = 'cr'; await client.connect()
  await client.query(read('supabase/test/00_supabase_stubs.sql'))

  console.log('\n1. bootstrap.sql on an empty database')
  await client.query(read('supabase/bootstrap.sql'))
  let c = await counts()
  check('applies cleanly and seeds correctly', matches(c), JSON.stringify(c))

  console.log('\n2. running it twice (the half-finished-run state)')
  let dupErr = null
  try { await client.query(read('supabase/bootstrap.sql')) } catch (e) { dupErr = e }
  check('fails with 42P07 "already exists", as expected',
    dupErr?.code === '42P07', dupErr ? `${dupErr.code}: ${dupErr.message}` : 'it did NOT fail')

  console.log('\n3. reset_bootstrap.sql recovers')
  await client.query(read('supabase/reset_bootstrap.sql'))
  c = await counts()
  check('wipes and rebuilds to correct counts', matches(c), JSON.stringify(c))

  // The reset must not leave stale triggers pointing at dropped functions.
  const t = await client.query(
    `select count(*)::int n from pg_trigger
      where tgrelid = 'auth.users'::regclass and not tgisinternal`)
  check('auth.users triggers rebuilt exactly once', t.rows[0].n === 2, `${t.rows[0].n} triggers`)

  // And the core guarantee must still hold after a reset.
  const uid = (await client.query(
    `insert into auth.users (email, raw_user_meta_data)
     values ('aarya.x@alpha.school','{"full_name":"Aarya Patel"}'::jsonb) returning id`)).rows[0].id
  const rid = (await client.query(`select id from rooms where slug='hallway-3'`)).rows[0].id
  await client.query(`insert into bookings (room_id,user_id,booked_by,during)
    values ($1,$2,$2,tstzrange('2026-09-16 10:00Z','2026-09-16 11:00Z'))`, [rid, uid])
  let blocked = false
  try {
    await client.query(`insert into bookings (room_id,user_id,booked_by,during)
      values ($1,$2,$2,tstzrange('2026-09-16 10:30Z','2026-09-16 11:30Z'))`, [rid, uid])
  } catch (e) { blocked = e.code === '23P01' }
  check('double-booking still rejected after reset', blocked)
} catch (err) {
  console.error('\nFATAL:', err.message)
  results.push({ name: 'fatal', ok: false, detail: err.message })
} finally {
  try { await client?.end() } catch {}
  try { await pg.stop() } catch {}
  rmSync(dataDir, { recursive: true, force: true })
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length ? 1 : 0)
