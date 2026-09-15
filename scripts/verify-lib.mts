/**
 * Pure-function checks for lib/. Runs on Node's built-in type stripping —
 * no bundler, no test framework.
 *
 *   npm run verify:lib
 *
 * The first block is the regression that took down /people in production:
 * Postgres emits `+00`, JavaScript's Date needs `+00:00`.
 */
import { parseRange, pgTimestampToDate } from '../lib/bookings.ts'
import { fmtTime, fmtDay, fmtRange, sameCampusDay, nextSlot, fmtDuration } from '../lib/time.ts'

let passed = 0
const failures: string[] = []
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
const iso = (d: Date) => Number.isNaN(d.getTime()) ? 'Invalid Date' : d.toISOString()

console.log('\npgTimestampToDate — every shape Postgres actually emits')
const cases: [string, string][] = [
  ['2026-09-16 15:00:00+00',        '2026-09-16T15:00:00.000Z'],   // the production crash
  ['2026-09-16 15:00:00-05',        '2026-09-16T20:00:00.000Z'],
  ['2026-09-16 15:00:00+05:30',     '2026-09-16T09:30:00.000Z'],
  ['2026-09-16 15:00:00.123456+00', '2026-09-16T15:00:00.123Z'],
  ['2026-09-16T15:00:00Z',          '2026-09-16T15:00:00.000Z'],   // already ISO
  ['2026-09-16 15:00:00+0530',      '2026-09-16T09:30:00.000Z'],
]
for (const [input, expected] of cases) {
  const got = iso(pgTimestampToDate(input))
  check(`"${input}" → ${expected}`, got === expected, `got ${got}`)
}

console.log('\nparseRange — the exact text PostgREST returns for tstzrange')
const r = parseRange('["2026-09-16 15:00:00+00","2026-09-16 16:00:00+00")')
check('start parses', iso(r.start) === '2026-09-16T15:00:00.000Z', iso(r.start))
check('end parses',   iso(r.end)   === '2026-09-16T16:00:00.000Z', iso(r.end))
check('end is after start', r.end > r.start)
let threw = false
try { parseRange('nonsense') } catch { threw = true }
check('garbage throws rather than returning Invalid Dates', threw)

console.log('\nformatters never throw')
const bad = new Date('not a date')
let ok = true
try { fmtTime(bad); fmtDay(bad); fmtRange(bad, bad); sameCampusDay(bad, new Date()) } catch { ok = false }
check('fmtTime/fmtDay/fmtRange/sameCampusDay survive an Invalid Date', ok)
check('fmtTime renders a dash for it', fmtTime(bad) === '—', JSON.stringify(fmtTime(bad)))
check('fmtTime renders a real time in campus tz', /^\d{1,2}:\d{2} [AP]M$/.test(fmtTime(new Date('2026-09-16T15:00:00Z'))), fmtTime(new Date('2026-09-16T15:00:00Z')))
check('15:00Z is 10:00 AM in Chicago (CDT)', fmtTime(new Date('2026-09-16T15:00:00Z')).startsWith('10:00'))

console.log('\nslots & durations')
check('nextSlot rounds 10:07 up to 10:15', nextSlot(new Date('2026-09-16T15:07:00Z')).toISOString() === '2026-09-16T15:15:00.000Z')
check('nextSlot leaves 10:15 alone',       nextSlot(new Date('2026-09-16T15:15:00Z')).toISOString() === '2026-09-16T15:15:00.000Z')
check('fmtDuration 90 → 1½ h', fmtDuration(90) === '1½ h', fmtDuration(90))
check('fmtDuration 45 → 45 min', fmtDuration(45) === '45 min')
check('fmtDuration 120 → 2 h', fmtDuration(120) === '2 h')

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1) }
