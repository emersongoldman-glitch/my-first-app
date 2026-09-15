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
  sort: number
  zones: { id: number; name: string; floor: number; sort: number } | null
}

export type Profile = {
  id: string
  email: string
  full_name: string
  display_name: string | null
  role: 'student' | 'guide' | 'admin'
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
  return { start: new Date(m[1].replace(' ', 'T')), end: new Date(m[2].replace(' ', 'T')) }
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
  }
): Promise<CreateBookingResult> {
  const { data, error } = await sb.rpc('create_booking', {
    p_room_id: args.roomId,
    p_start: args.start.toISOString(),
    p_end: args.end.toISOString(),
    p_purpose: args.purpose ?? null,
    p_guide_email: args.guideEmail ?? null,
    p_for_user: args.forUser ?? null,
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
  return msg
}
