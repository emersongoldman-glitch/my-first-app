import EmbeddedPostgres from 'embedded-postgres'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = '/Users/emerson_g/Developer/campus-rooms'
const dataDir = mkdtempSync(join(tmpdir(), 'bootstrap-pg-'))
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port: 7000 + Math.floor(Math.random()*1500), persistent: false })
let client, ok = true
try {
  await pg.initialise(); await pg.start(); await pg.createDatabase('cr')
  client = pg.getPgClient(); client.database = 'cr'; await client.connect()
  await client.query(readFileSync(join(root,'supabase/test/00_supabase_stubs.sql'),'utf8'))
  // The whole thing, exactly as it will be pasted into the SQL Editor.
  await client.query(readFileSync(join(root,'supabase/bootstrap.sql'),'utf8'))
  const r = await client.query(`select
      (select count(*) from rooms)::int rooms,
      (select count(distinct match_name) from roster_seed)::int students,
      (select count(*) from roster_seed)::int pairs,
      (select count(*) from preferred_names)::int guides`)
  console.log('bootstrap applied in one statement batch:', r.rows[0])
  ok = r.rows[0].rooms === 19 && r.rows[0].students === 55 && r.rows[0].pairs === 68 && r.rows[0].guides === 5
} catch (e) { console.error('FAILED:', e.message); ok = false }
finally { try { await client?.end() } catch {} ; try { await pg.stop() } catch {}; rmSync(dataDir,{recursive:true,force:true}) }
console.log(ok ? 'bootstrap.sql OK' : 'bootstrap.sql BROKEN')
process.exit(ok ? 0 : 1)
