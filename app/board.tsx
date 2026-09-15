'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  ACTIVE_STATUSES, cancelBooking, checkIn, createBooking, displayName,
  type Booking, type GuideMru, type Profile, type Room,
} from '@/lib/bookings'
import { fitsQuick, groupByZone, liveStatus, withTimes, type RoomLive, type Timed } from '@/lib/board'
import { addMinutes, fmtTime, relative } from '@/lib/time'
import BookingSheet from './booking-sheet'
import CampusMap from './campus-map'

type Props = {
  rooms: Room[]
  initialBookings: Booking[]
  profile: Profile
  guides: GuideMru[]
  /** Dev preview: skip network, render the given data only. */
  offline?: boolean
}

type View = 'map' | 'list'

/** Bookings that overlap [now − 1h, now + 24h): today's board, roughly. */
function windowRange(now: Date) {
  return `[${addMinutes(now, -60).toISOString()},${addMinutes(now, 24 * 60).toISOString()})`
}

export default function Board({ rooms, initialBookings, profile, guides, offline = false }: Props) {
  const [bookings, setBookings] = useState<Booking[]>(initialBookings)
  const [now, setNow] = useState(() => new Date())
  const [view, setView] = useState<View>('map')
  const [sheet, setSheet] = useState<RoomLive | null>(null)   // booking form
  const [focus, setFocus] = useState<RoomLive | null>(null)   // room detail (from a map tile)
  const [toast, setToast] = useState<string | null>(null)
  const [busyRoom, setBusyRoom] = useState<number | null>(null)

  // Remember the last view per device; a convenience, so failures are fine.
  // Read after first paint (not synchronously in the effect) so the server
  // and client render the same initial markup and no hydration mismatch.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      try { const v = localStorage.getItem('board.view'); if (v === 'map' || v === 'list') setView(v) } catch {}
    })
    return () => cancelAnimationFrame(id)
  }, [])
  const pickView = (v: View) => { setView(v); try { localStorage.setItem('board.view', v) } catch {} }

  const refetch = useCallback(async () => {
    if (offline) return
    const sb = createClient()
    const { data } = await sb
      .from('bookings')
      .select('*, user:profiles!user_id(display_name, full_name)')
      .in('status', [...ACTIVE_STATUSES])
      .overlaps('during', windowRange(new Date()))
    if (data) setBookings(data as Booking[])
  }, [offline])

  // Live updates: any change to bookings → refetch the window. Simpler and
  // safer than patching state from the event payload, and RLS still applies
  // to what we can read back. Fall back to a 30s poll if the socket drops.
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 15_000)
    if (offline) return () => clearInterval(tick)
    const sb = createClient()
    const channel = sb
      .channel('board')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, () => { void refetch() })
      .subscribe()
    const poll = setInterval(() => { void refetch() }, 30_000)
    return () => { void sb.removeChannel(channel); clearInterval(poll); clearInterval(tick) }
  }, [refetch, offline])

  const timed = useMemo(() => bookings.map(withTimes), [bookings])
  const lives = useMemo(() => rooms.map((r) => liveStatus(r, timed, now)), [rooms, timed, now])
  const zones = useMemo(() => groupByZone(lives), [lives])
  const counts = useMemo(() => ({
    open: lives.filter((l) => l.state === 'open' || l.state === 'free_until').length,
    busy: lives.filter((l) => l.state === 'booked').length,
    held: lives.filter((l) => l.state === 'held').length,
  }), [lives])

  // Keep the detail sheet pointing at fresh data as bookings change.
  const focusLive = focus ? lives.find((l) => l.room.id === focus.room.id) ?? null : null

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
      setFocus(null)
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

  const actions = (live: RoomLive) => ({
    busy: busyRoom === live.room.id,
    onQuick: (m: number) => quickBook(live, m),
    onMore: () => { setFocus(null); setSheet(live) },
    onCheckIn: (id: string) => act(() => checkIn(createClient(), id), 'Checked in.'),
    onCancel: (id: string) => act(() => cancelBooking(createClient(), id), 'Cancelled — the room is open again.'),
  })

  return (
    <>
      {/* Summary + view switch */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4 text-sm">
          <Stat dot="bg-green-500" n={counts.open} label="open" />
          <Stat dot="bg-amber-500" n={counts.busy} label="in use" />
          {counts.held > 0 && <Stat dot="bg-neutral-400" n={counts.held} label="held" />}
        </div>
        <div className="inline-flex rounded-xl border border-border bg-surface p-1 text-sm font-bold">
          {(['map', 'list'] as View[]).map((v) => (
            <button key={v} onClick={() => pickView(v)}
              className={`rounded-lg px-3 py-1 capitalize transition ${view === v ? 'bg-navy text-white' : 'text-muted hover:text-foreground'}`}>
              {v}
            </button>
          ))}
        </div>
      </div>

      {view === 'map' ? (
        <CampusMap zones={zones} me={profile.id} now={now} onTap={(live) => setFocus(live)} />
      ) : (
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
                  <RoomRow key={live.room.id} live={live} roomBookings={timed.filter((b) => b.room_id === live.room.id)}
                    now={now} me={profile.id} isStaff={profile.role !== 'student'} {...actions(live)} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {focusLive && (
        <RoomSheet
          live={focusLive}
          roomBookings={timed.filter((b) => b.room_id === focusLive.room.id)}
          now={now} me={profile.id} isStaff={profile.role !== 'student'}
          onClose={() => setFocus(null)}
          {...actions(focusLive)}
        />
      )}

      {sheet && (
        <BookingSheet live={sheet} profile={profile} guides={guides}
          onClose={() => setSheet(null)} onBooked={() => { void refetch() }} />
      )}

      {toast && (
        <div className="fixed inset-x-4 bottom-6 z-50 mx-auto max-w-md rounded-xl bg-foreground px-4 py-3 text-center text-sm font-medium text-background shadow-xl">
          {toast}
        </div>
      )}
    </>
  )
}

function Stat({ dot, n, label }: { dot: string; n: number; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
      <b>{n}</b> <span className="text-muted">{label}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Shared room actions: quick-book, more, check-in, cancel/release.
// ---------------------------------------------------------------------------
type ActionProps = {
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

function StatusLine({ live, now, me }: { live: RoomLive; now: Date; me: string }) {
  const { state, current, next } = live
  const mine = current?.user_id === me
  return (
    <p className="text-sm text-muted">
      {state === 'open' && 'Open now'}
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
  )
}

function Actions({ live, now, me, isStaff, busy, onQuick, onMore, onCheckIn, onCancel }: ActionProps) {
  const { state, current } = live
  const mine = current?.user_id === me
  const canCheckIn =
    current?.status === 'reserved' && (mine || isStaff) &&
    now.getTime() >= current.start.getTime() - 10 * 60000 &&
    now.getTime() <= current.start.getTime() + 5 * 60000

  return (
    <div className="flex shrink-0 flex-wrap gap-2">
      {(state === 'open' || state === 'free_until') && (
        <>
          {[30, 60].map((m) => (
            <button key={m} disabled={busy || !fitsQuick(live, m)} onClick={() => onQuick(m)}
              className="rounded-lg bg-navy px-3 py-1.5 text-sm font-bold text-white transition hover:opacity-90 disabled:opacity-40">
              {m === 60 ? '1 h' : `${m} min`}
            </button>
          ))}
          <button onClick={onMore} className="rounded-lg border border-border px-3 py-1.5 text-sm font-bold hover:bg-background">More…</button>
        </>
      )}
      {canCheckIn && current && (
        <button onClick={() => onCheckIn(current.id)} className="rounded-lg bg-green-700 px-3 py-1.5 text-sm font-bold text-white hover:opacity-90">Check in</button>
      )}
      {current && (mine || isStaff) && (
        <button onClick={() => onCancel(current.id)} className="rounded-lg border border-border px-3 py-1.5 text-sm font-bold text-muted hover:bg-background">
          {mine ? 'Cancel' : 'Release'}
        </button>
      )}
    </div>
  )
}

// --- list row ----------------------------------------------------------------
function RoomRow(props: ActionProps & { roomBookings: Timed[] }) {
  const { live, roomBookings, now, me } = props
  const [open, setOpen] = useState(false)
  return (
    <li className="px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-left" aria-expanded={open} title="Show the next 2 hours">
            <Dot state={live.state} />
            <span className="font-bold">{live.room.name}</span>
            <span className="text-xs text-muted">{live.room.capacity === 1 ? '1 seat' : `${live.room.capacity} seats`}</span>
            <span className={`text-xs text-muted transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden>▾</span>
          </button>
          <div className="mt-0.5"><StatusLine live={live} now={now} me={me} /></div>
        </div>
        <Actions {...props} />
      </div>
      {open && <NextTwoHours bookings={roomBookings} now={now} me={me} />}
    </li>
  )
}

// --- map tile → detail sheet -------------------------------------------------
function RoomSheet(props: ActionProps & { roomBookings: Timed[]; onClose: () => void }) {
  const { live, roomBookings, now, me, onClose } = props
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 sm:items-center sm:p-6" onClick={onClose} role="dialog" aria-modal>
      <div className="max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl bg-background p-6 shadow-2xl sm:max-w-md sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-muted">{live.room.zones?.name}</p>
            <h2 className="flex items-center gap-2 text-xl font-bold"><Dot state={live.state} />{live.room.name}</h2>
            <p className="text-xs text-muted">{live.room.capacity === 1 ? '1 seat' : `${live.room.capacity} seats`}</p>
          </div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-muted hover:bg-surface" aria-label="Close">✕</button>
        </div>
        <StatusLine live={live} now={now} me={me} />
        <div className="mt-4"><Actions {...props} /></div>
        <NextTwoHours bookings={roomBookings} now={now} me={me} />
      </div>
    </div>
  )
}

function Dot({ state }: { state: RoomLive['state'] }) {
  const cls = { open: 'bg-green-500', free_until: 'bg-green-500', booked: 'bg-amber-500', held: 'bg-neutral-400' }[state]
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${cls}`} aria-hidden />
}

// ---------------------------------------------------------------------------
// Who has this room for the next two hours: a 15-minute strip plus the list.
// Pure view over bookings the board already holds.
// ---------------------------------------------------------------------------
const WINDOW_MIN = 120
const SLOT_MIN = 15

function NextTwoHours({ bookings, now, me }: { bookings: Timed[]; now: Date; me: string }) {
  const start = new Date(Math.floor(now.getTime() / 60000) * 60000)
  const end = addMinutes(start, WINDOW_MIN)
  const inWindow = bookings
    .filter((b) => b.end > start && b.start < end)
    .sort((a, b) => a.start.getTime() - b.start.getTime())

  const cells = Array.from({ length: WINDOW_MIN / SLOT_MIN }, (_, i) => {
    const mid = addMinutes(start, i * SLOT_MIN + SLOT_MIN / 2)
    const b = inWindow.find((x) => x.start <= mid && mid < x.end)
    return b ? (b.status === 'pending_approval' ? 'held' : 'booked') : 'open'
  })

  const segments: { from: Date; to: Date; b?: Timed }[] = []
  let cursor = start
  for (const b of inWindow) {
    const from = b.start > cursor ? b.start : cursor
    if (from > cursor) segments.push({ from: cursor, to: from })
    const to = b.end < end ? b.end : end
    segments.push({ from, to, b })
    cursor = to
  }
  if (cursor < end) segments.push({ from: cursor, to: end })

  return (
    <div className="mt-4 rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 flex items-center justify-between text-xs text-muted">
        <span className="font-bold uppercase tracking-wider">Next 2 hours</span>
        <span>{fmtTime(start)} – {fmtTime(end)}</span>
      </div>
      <div className="flex gap-0.5" aria-hidden>
        {cells.map((c, i) => (
          <span key={i} className={`h-2.5 flex-1 rounded-sm ${c === 'booked' ? 'bg-amber-500' : c === 'held' ? 'bg-neutral-400' : 'bg-green-500/60'}`} />
        ))}
      </div>
      <ul className="mt-3 space-y-1.5 text-sm">
        {segments.map((sgm, i) => (
          <li key={i} className="flex items-baseline gap-3">
            <span className="w-[8.5rem] shrink-0 tabular-nums text-muted">{fmtTime(sgm.from)} – {fmtTime(sgm.to)}</span>
            {sgm.b ? (
              <span>
                <span className="font-bold">{sgm.b.user_id === me ? 'You' : displayName(sgm.b.user)}</span>
                <span className="text-muted">{' · '}{sgm.b.status === 'checked_in' ? 'in use' : sgm.b.status === 'pending_approval' ? 'held, awaiting approval' : 'reserved'}</span>
              </span>
            ) : (
              <span className="font-medium text-green-700 dark:text-green-400">Open</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
