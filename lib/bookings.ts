import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Types. Hand-written for now; `supabase gen types` needs a CLI login.
// ---------------------------------------------------------------------------
export type BookingStatus =
  | 'pending_approval'
  | 'reserved'
  | 'checked_in'
  | 'completed'
  | 'cancelled'
  | 'declined'
  | 'expired'
  | 'no_show'

/** Statuses that occupy a room, i.e. sit inside the exclusion constraint. */
export const ACTIVE_STATUSES: ReadonlySet<BookingStatus> = new Set([
  'pending_approval',
  'reserved',
  'checked_in',
])

export type Booking = {
  id: string
  room_id: number
  user_id: string
  booked_by: string
  /** Seats taken in a shared room; always 1 for exclusive rooms (D17). */
  seats: number
  /** Postgres tstzrange as text, e.g. `["2026-09-16 15:00:00+00","2026-09-16 16:00:00+00")` */
  during: string
  purpose: string | null
  status: BookingStatus
  checked_in_at: string | null
  created_at: string
  /** Joined via `user:profiles!user_id(...)` */
  user?: { display_name: string | null; full_name: string } | null
}

export type Room = {
  id: number
  slug: string
  name: string
  capacity: number
  kind: 'pod' | 'conference' | 'special'
  max_minutes: number | null
  bookable: boolean
  /** Booked by seat (overlapping bookings allowed up to capacity) rather than exclusively. */
  shared: boolean
  sort: number
  zones: { id: number; name: string; floor: number; sort: number } | null
}

export type Profile = {
  id: string
  email: string
  full_name: string
  display_name: string | null
  role: 'student' | 'guide' | 'admin'
  /** False until they pick guide-or-student once at first sign-in (D11). */
  role_confirmed?: boolean
}

/** Self-reported guide location (PLAN.md §5.4, §9). Never inferred. */
export type Presence = {
  user_id: string
  status: 'roaming' | 'in_room' | 'off_campus' | 'dnd'
  room_id: number | null
  note: string | null
  updated_at: string
}

export const PRESENCE_LABEL: Record<Presence['status'], string> = {
  roaming: 'Around campus',
  in_room: 'In a room',
  off_campus: 'Off campus',
  dnd: 'Do not disturb',
}

export type GuideMru = {
  guide_email: string
  confirmed: boolean
  last_used_at: string
  seed_priority: number | null
}

export type CreateBookingResult = {
  booking_id: string
  needs_approval: boolean
  status: 'pending_approval' | 'reserved'
}

// ---------------------------------------------------------------------------
// tstzrange parsing. PostgREST returns ranges as their text form.
// ---------------------------------------------------------------------------
export function parseRange(during: string): { start: Date; end: Date } {
  // `["2026-09-16 15:00:00+00","2026-09-16 16:00:00+00")`
  const m = during.match(/^[\[(]"?([^",]+)"?,"?([^")\]]+)"?[\])]$/)
  if (!m) throw new Error(`Unparseable range: ${during}`)
  return { start: pgTimestampToDate(m[1]), end: pgTimestampToDate(m[2]) }
}

/**
 * Postgres prints timestamptz as `2026-09-16 15:00:00+00` (or `+05:30`,
 * `-05`, with optional fractional seconds). JavaScript's Date only accepts
 * ISO 8601: a `T` separator and a `±HH:MM` offset — `+00` alone is an
 * Invalid Date in V8, which then throws from Intl formatting. Normalise.
 */
export function pgTimestampToDate(text: string): Date {
  let s = text.trim().replace(' ', 'T')
  // `+00` → `+00:00`, `-0530` → `-05:30`; leave `Z` and `+05:30` alone.
  s = s.replace(/([+-]\d{2})(?::?(\d{2}))?$/, (_, hh: string, mm?: string) => `${hh}:${mm ?? '00'}`)
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) throw new Error(`Unparseable timestamp: ${text}`)
  return d
}

export function displayName(p?: { display_name: string | null; full_name: string } | null) {
  return p?.display_name?.trim() || p?.full_name || 'Someone'
}

// ---------------------------------------------------------------------------
// RPC wrappers. Each mirrors one SECURITY DEFINER function; the database is
// the authority on every rule, these just shape the call.
// ---------------------------------------------------------------------------
type Client = SupabaseClient

export async function createBooking(
  sb: Client,
  args: {
    roomId: number
    start: Date
    end: Date
    purpose?: string
    guideEmail?: string
    forUser?: string
    /** Shared rooms only; defaults to 1. */
    seats?: number
  }
): Promise<CreateBookingResult> {
  const { data, error } = await sb.rpc('create_booking', {
    p_room_id: args.roomId,
    p_start: args.start.toISOString(),
    p_end: args.end.toISOString(),
    p_purpose: args.purpose ?? null,
    p_guide_email: args.guideEmail ?? null,
    p_for_user: args.forUser ?? null,
    p_seats: args.seats ?? 1,
  })
  if (error) throw new Error(friendly(error.message))
  return data as CreateBookingResult
}

export async function checkIn(sb: Client, bookingId: string): Promise<void> {
  const { error } = await sb.rpc('check_in', { p_booking_id: bookingId })
  if (error) throw new Error(friendly(error.message))
}

export async function cancelBooking(sb: Client, bookingId: string, reason?: string): Promise<void> {
  const { error } = await sb.rpc('cancel_booking', {
    p_booking_id: bookingId,
    p_reason: reason ?? null,
  })
  if (error) throw new Error(friendly(error.message))
}

export async function extendBooking(sb: Client, bookingId: string, newEnd: Date) {
  const { data, error } = await sb.rpc('extend_booking', {
    p_booking_id: bookingId,
    p_new_end: newEnd.toISOString(),
  })
  if (error) throw new Error(friendly(error.message))
  return data as { booking_id: string; minutes: number }
}

export async function decideAsGuide(
  sb: Client,
  bookingId: string,
  decision: 'approved' | 'declined',
  reason?: string
) {
  const { data, error } = await sb.rpc('decide_as_guide', {
    p_booking_id: bookingId,
    p_decision: decision,
    p_reason: reason ?? null,
  })
  if (error) throw new Error(friendly(error.message))
  return data as { booking_id: string; decision: string; already_decided: boolean }
}

/**
 * Postgres error text is already written for humans (see the RAISE messages),
 * but the exclusion constraint speaks database. Translate that one.
 */
function friendly(msg: string): string {
  if (/bookings_no_overlap|conflicting key value/.test(msg)) {
    return 'Someone just took that room for that time. Pick another slot or another room.'
  }
  // Shared-room seat check speaks for itself ("Only 2 of 8 seats are free then.")
  return msg
}
