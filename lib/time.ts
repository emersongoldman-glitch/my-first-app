/** Campus timezone. Booking rules in the database use the same zone. */
export const CAMPUS_TZ = 'America/Chicago'

const timeFmt = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: CAMPUS_TZ,
})

const dayFmt = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: CAMPUS_TZ,
})

export function fmtTime(d: Date): string {
  return timeFmt.format(d).replace(' ', ' ') // narrow no-break space before AM/PM
}

export function fmtDay(d: Date): string {
  return dayFmt.format(d)
}

export function fmtRange(start: Date, end: Date): string {
  return `${fmtTime(start)} – ${fmtTime(end)}`
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60000)
}

export function addMinutes(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60000)
}

/** Round up to the next slot boundary (e.g. 10:07 → 10:15 for 15-minute slots). */
export function nextSlot(now: Date, slotMinutes = 15): Date {
  const ms = slotMinutes * 60000
  return new Date(Math.ceil(now.getTime() / ms) * ms)
}

/** "in 12 min", "5 min ago", "in 2 h" — for the board's until/opens copy. */
export function relative(target: Date, now: Date): string {
  const m = minutesBetween(now, target)
  const abs = Math.abs(m)
  const unit = abs < 60 ? `${abs} min` : `${Math.round(abs / 60)} h`
  if (m >= 0) return `in ${unit}`
  return `${unit} ago`
}

export function sameCampusDay(a: Date, b: Date): boolean {
  return dayFmt.format(a) === dayFmt.format(b)
}

/** Humanise a duration in minutes: 45 → "45 min", 90 → "1½ h", 120 → "2 h". */
export function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const rem = minutes % 60
  if (rem === 0) return `${h} h`
  if (rem === 30) return `${h}½ h`
  return `${h} h ${rem} min`
}
