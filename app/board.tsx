'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  ACTIVE_STATUSES, cancelBooking, checkIn, createBooking, displayName,
  type Booking, type GuideMru, type Profile, type Room,
} from '@/lib/bookings'
import { fitsQuick, groupByZone, liveStatus, withTimes, type RoomLive } from '@/lib/board'
import { addMinutes, fmtTime, relative } from '@/lib/time'
import BookingSheet from './booking-sheet'

type Props = {
  rooms: Room[]
  initialBookings: Booking[]
  profile: Profile
  guides: GuideMru[]
}

/** Bookings that overlap [now − 1h, now + 24h): today's board, roughly. */
function windowRange(now: Date) {
  return `[${addMinutes(now, -60).toISOString()},${addMinutes(now, 24 * 60).toISOString()})`
}

export default function Board({ rooms, initialBookings, profile, guides }: Props) {
  const [bookings, setBookings] = useState<Booking[]>(initialBookings)
  const [now, setNow] = useState(() => new Date())
  const [sheet, setSheet] = useState<RoomLive | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [busyRoom, setBusyRoom] = useState<number | null>(null)

  const refetch = useCallback(async () => {
    const sb = createClient()
    const { data } = await sb
      .from('bookings')
      .select('*, user:profiles!user_id(display_name, full_name)')
      .in('status', [...ACTIVE_STATUSES])
      .overlaps('during', windowRange(new Date()))
    if (data) setBookings(data as Booking[])
  }, [])

  // Live updates: any change to bookings → refetch the window. Simpler and
  // safer than patching state from the event payload, and RLS still applies
  // to what we can read back. Fall back to a 30s poll if the socket drops.
  useEffect(() => {
    const sb = createClient()
    const channel = sb
      .channel('board')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, () => { void refetch() })
      .subscribe()
    const poll = setInterval(() => { void refetch() }, 30_000)
    const tick = setInterval(() => setNow(new Date()), 15_000)
    return () => { void sb.removeChannel(channel); clearInterval(poll); clearInterval(tick) }
  }, [refetch])

  const timed = useMemo(() => bookings.map(withTimes), [bookings])
  const zones = useMemo(
    () => groupByZone(rooms.map((r) => liveStatus(r, timed, now))),
    [rooms, timed, now]
  )

  function say(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 4000)
  }

  // Walk-up: one tap books from now and checks you in (PLAN.md §6, "Walk-ups").
  async function quickBook(live: RoomLive, minutes: number) {
    setBusyRoom(live.room.id)
    try {
      const sb = createClient()
      const start = new Date(); start.setSeconds(0, 0)
      const res = await createBooking(sb, { roomId: live.room.id, start, end: addMinutes(start, minutes) })
      try { await checkIn(sb, res.booking_id) } catch { /* fine — they can check in from My bookings */ }
      say(`${live.room.name} is yours until ${fmtTime(addMinutes(start, minutes))}.`)
      await refetch()
    } catch (e) {
      say(e instanceof Error ? e.message : 'Could not book that.')
      await refetch() // someone else may have just taken it
    } finally {
      setBusyRoom(null)
    }
  }

  async function act(fn: () => Promise<void>, ok: string) {
    try { await fn(); say(ok); await refetch() }
    catch (e) { say(e instanceof Error ? e.message : 'That didn’t work.') }
  }

  return (
    <>
      <div className="space-y-8">
        {zones.map((z) => (
          <section key={z.name}>
            <h2 className="mb-3 flex items-baseline gap-2 text-sm font-bold uppercase tracking-wider text-navy dark:text-cyan">
              {z.name}
              {z.floor === 2 && <span className="font-normal normal-case tracking-normal text-muted">2nd floor</span>}
              <span className="ml-auto font-normal normal-case tracking-normal text-muted">
                {z.rooms.filter((r) => r.state === 'open' || r.state === 'free_until').length} open
              </span>
            </h2>
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {z.rooms.map((live) => (
                <RoomRow
                  key={live.room.id}
                  live={live}
                  now={now}
                  me={profile.id}
                  isStaff={profile.role !== 'student'}
                  busy={busyRoom === live.room.id}
                  onQuick={(m) => quickBook(live, m)}
                  onMore={() => setSheet(live)}
                  onCheckIn={(id) => act(() => checkIn(createClient(), id), 'Checked in.')}
                  onCancel={(id) => act(() => cancelBooking(createClient(), id), 'Cancelled — the room is open again.')}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      {sheet && (
        <BookingSheet
          live={sheet}
          profile={profile}
          guides={guides}
          onClose={() => setSheet(null)}
          onBooked={() => { void refetch() }}
        />
      )}

      {toast && (
        <div className="fixed inset-x-4 bottom-6 z-40 mx-auto max-w-md rounded-xl bg-foreground px-4 py-3 text-center text-sm font-medium text-background shadow-xl">
          {toast}
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------

type RowProps = {
  live: RoomLive
  now: Date
  me: string
  isStaff: boolean
  busy: boolean
  onQuick: (minutes: number) => void
  onMore: () => void
  onCheckIn: (id: string) => void
  onCancel: (id: string) => void
}

function RoomRow({ live, now, me, isStaff, busy, onQuick, onMore, onCheckIn, onCancel }: RowProps) {
  const { room, state, current, next } = live
  const mine = current?.user_id === me
  const canCheckIn =
    current?.status === 'reserved' &&
    (mine || isStaff) &&
    now.getTime() >= current.start.getTime() - 10 * 60000 &&
    now.getTime() <= current.start.getTime() + 5 * 60000

  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Dot state={state} />
          <span className="font-bold">{room.name}</span>
          <span className="text-xs text-muted">{room.capacity === 1 ? '1 seat' : `${room.capacity} seats`}</span>
        </div>
        <p className="mt-0.5 text-sm text-muted">
          {state === 'open' && 'Open'}
          {state === 'free_until' && next && <>Open until <b className="text-foreground">{fmtTime(next.start)}</b> ({relative(next.start, now)})</>}
          {state === 'booked' && current && (
            <>
              {current.status === 'checked_in' ? 'In use' : 'Reserved'} until <b className="text-foreground">{fmtTime(current.end)}</b>
              {' · '}<span className="text-foreground">{mine ? 'you' : displayName(current.user)}</span>
              {current.status === 'reserved' && !mine && <span className="ml-1 text-xs">(not checked in yet)</span>}
            </>
          )}
          {state === 'held' && current && (
            <>Held for <span className="text-foreground">{mine ? 'you' : displayName(current.user)}</span> · awaiting guide approval · until {fmtTime(current.end)}</>
          )}
        </p>
      </div>

      <div className="flex shrink-0 flex-wrap gap-2">
        {(state === 'open' || state === 'free_until') && (
          <>
            {[30, 60].map((m) => (
              <button
                key={m}
                disabled={busy || !fitsQuick(live, m)}
                onClick={() => onQuick(m)}
                className="rounded-lg bg-navy px-3 py-1.5 text-sm font-bold text-white transition hover:opacity-90 disabled:opacity-40"
              >
                {m === 60 ? '1 h' : `${m} min`}
              </button>
            ))}
            <button onClick={onMore} className="rounded-lg border border-border px-3 py-1.5 text-sm font-bold hover:bg-background">
              More…
            </button>
          </>
        )}
        {canCheckIn && current && (
          <button onClick={() => onCheckIn(current.id)} className="rounded-lg bg-green-700 px-3 py-1.5 text-sm font-bold text-white hover:opacity-90">
            Check in
          </button>
        )}
        {current && (mine || isStaff) && (
          <button onClick={() => onCancel(current.id)} className="rounded-lg border border-border px-3 py-1.5 text-sm font-bold text-muted hover:bg-background">
            {mine ? 'Cancel' : 'Release'}
          </button>
        )}
      </div>
    </li>
  )
}

function Dot({ state }: { state: RoomLive['state'] }) {
  const cls = {
    open: 'bg-green-500',
    free_until: 'bg-green-500',
    booked: 'bg-amber-500',
    held: 'bg-neutral-400',
  }[state]
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${cls}`} aria-hidden />
}
