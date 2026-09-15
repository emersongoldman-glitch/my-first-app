import { ACTIVE_STATUSES, parseRange, type Booking, type Room } from './bookings'
import { minutesBetween } from './time'

export type LiveState =
  | 'open'        // free, nothing coming up soon
  | 'free_until'  // free now, but a booking starts within the look-ahead window
  | 'booked'      // reserved or checked in right now
  | 'held'        // a pending approval request is holding it (PLAN.md §12 D1)

export type Timed = Booking & { start: Date; end: Date }

export type RoomLive = {
  room: Room
  state: LiveState
  /** The booking occupying the room right now, if any. */
  current?: Timed
  /** The next upcoming booking for this room today, if any. */
  next?: Timed
  /** For 'free_until': minutes until `next` begins. */
  freeMinutes?: number
}

/** Show "free until…" only when the next booking is this close. */
const LOOKAHEAD_MINUTES = 120

export function withTimes(b: Booking): Timed {
  const { start, end } = parseRange(b.during)
  return { ...b, start, end }
}

/**
 * Derive one room's live status from the booking list. Pure: same inputs,
 * same output, so the board re-renders on a clock tick without refetching.
 */
export function liveStatus(room: Room, bookings: Timed[], now: Date): RoomLive {
  const mine = bookings
    .filter((b) => b.room_id === room.id && ACTIVE_STATUSES.has(b.status))
    .sort((a, b) => a.start.getTime() - b.start.getTime())

  const current = mine.find((b) => b.start <= now && now < b.end)
  if (current) {
    return {
      room,
      state: current.status === 'pending_approval' ? 'held' : 'booked',
      current,
      next: mine.find((b) => b.start >= current.end),
    }
  }

  const next = mine.find((b) => b.start > now)
  if (next) {
    const freeMinutes = minutesBetween(now, next.start)
    if (freeMinutes <= LOOKAHEAD_MINUTES) {
      return { room, state: 'free_until', next, freeMinutes }
    }
  }
  return { room, state: 'open', next }
}

export type ZoneGroup = {
  name: string
  floor: number
  sort: number
  rooms: RoomLive[]
}

/** Group by zone in database order, open rooms first within each zone. */
export function groupByZone(live: RoomLive[]): ZoneGroup[] {
  const groups = new Map<string, ZoneGroup>()
  for (const r of live) {
    const z = r.room.zones
    const key = z?.name ?? 'Unassigned'
    if (!groups.has(key)) {
      groups.set(key, { name: key, floor: z?.floor ?? 1, sort: z?.sort ?? 999, rooms: [] })
    }
    groups.get(key)!.rooms.push(r)
  }
  const rank: Record<LiveState, number> = { open: 0, free_until: 1, held: 2, booked: 3 }
  for (const g of groups.values()) {
    g.rooms.sort((a, b) => rank[a.state] - rank[b.state] || a.room.sort - b.room.sort)
  }
  return [...groups.values()].sort((a, b) => a.sort - b.sort)
}

/** The largest quick-book length (in minutes) that fits before the next booking. */
export function fitsQuick(r: RoomLive, minutes: number): boolean {
  if (r.state === 'booked' || r.state === 'held') return false
  if (r.state === 'open') return true
  return (r.freeMinutes ?? 0) >= minutes
}
