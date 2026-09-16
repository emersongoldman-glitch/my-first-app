'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { createBooking, checkIn, type GuideMru, type Profile, type Room } from '@/lib/bookings'
import type { RoomLive } from '@/lib/board'
import { addMinutes, fmtDuration, fmtRange, fmtTime, nextSlot } from '@/lib/time'

const SELF_SERVE_MAX = 60  // minutes; mirrors settings.max_self_serve_minutes (D14)
const HORIZON_MIN = 120    // students book at most this far ahead (PLAN.md D10); staff exempt
const QUICK = [15, 30, 45, 60]
const LONG = [75, 90, 105, 120, 150, 180, 240, 300, 360, 420, 480]
const STARTS: [string, number][] = [['Now', 0], ['+30 min', 30], ['+1 h', 60], ['+2 h', 120]]

type Props = {
  live: RoomLive
  profile: Profile
  guides: GuideMru[]
  onClose: () => void
  onBooked: () => void
}

export default function BookingSheet({ live, profile, guides, onClose, onBooked }: Props) {
  const room: Room = live.room
  const isStaff = profile.role !== 'student'
  const now = new Date()

  const [start, setStart] = useState<Date>(() => nextSlot(now))
  const [minutes, setMinutes] = useState(60)
  const [purpose, setPurpose] = useState('')
  const [seats, setSeats] = useState(1)
  const [guideEmail, setGuideEmail] = useState(guides[0]?.guide_email ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<null | { pending: boolean; end: Date; checkedIn: boolean; notified: 'slack' | 'none'; note?: string }>(null)

  const end = useMemo(() => addMinutes(start, minutes), [start, minutes])
  const needsGuide = minutes > SELF_SERVE_MAX && !isStaff

  // Would this run into the next booking? The database is the authority; this
  // just greys out choices that are certain to fail.
  const collides = live.next ? end > live.next.start && start < live.next.start : false

  // Local date/time inputs. Students are on campus, so local time = campus time.
  const dateStr = toLocalDate(start)
  const timeStr = toLocalTime(start)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const sb = createClient()
      const result = await createBooking(sb, {
        roomId: room.id,
        start,
        end,
        purpose: purpose.trim() || undefined,
        guideEmail: needsGuide ? guideEmail.trim() : undefined,
        seats: room.shared ? seats : 1,
      })
      // Walk-up: booking a room you are standing at counts as arriving.
      let checkedIn = false
      if (!result.needs_approval && start.getTime() - Date.now() < 10 * 60000) {
        try { await checkIn(sb, result.booking_id); checkedIn = true } catch { /* window edge; not fatal */ }
      }
      // Over the gate: the server mints the approval link and DMs the guide on
      // Slack. The student never sees the link (PLAN.md §6.1).
      let notified: 'slack' | 'none' = 'none'
      let note: string | undefined
      if (result.needs_approval) {
        try {
          const res = await fetch('/api/approvals/notify', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bookingId: result.booking_id }),
          })
          const body = (await res.json()) as { notified?: 'slack' | 'none'; error?: string }
          notified = body.notified === 'slack' ? 'slack' : 'none'
          if (notified === 'none') note = body.error
        } catch { note = 'Could not reach Slack.' }
      }
      setDone({ pending: result.needs_approval, end, checkedIn, notified, note })
      onBooked()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal
    >
      <div
        className="max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl bg-background p-6 shadow-2xl sm:max-w-md sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-muted">{room.zones?.name}</p>
            <h2 className="text-xl font-bold">{room.name}</h2>
          </div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-muted hover:bg-surface" aria-label="Close">
            ✕
          </button>
        </div>

        {done ? (
          <Confirmation pending={done.pending} checkedIn={done.checkedIn} notified={done.notified} note={done.note} start={start} end={done.end} guideEmail={guideEmail} onClose={onClose} />
        ) : (
          <div className="space-y-5">
            {/* When. Students book for the next two hours, not next week (D10). */}
            {isStaff ? (
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-bold uppercase tracking-wider text-muted">Date</span>
                  <input
                    type="date"
                    value={dateStr}
                    min={toLocalDate(now)}
                    max={toLocalDate(addMinutes(now, 7 * 24 * 60))}
                    onChange={(e) => setStart(fromLocal(e.target.value, timeStr))}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-bold uppercase tracking-wider text-muted">Start</span>
                  <input
                    type="time"
                    step={900}
                    value={timeStr}
                    onChange={(e) => setStart(fromLocal(dateStr, e.target.value))}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2"
                  />
                </label>
              </div>
            ) : (
              <div>
                <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-muted">
                  Start <span className="font-normal normal-case tracking-normal">· up to 2 hours ahead</span>
                </span>
                <div className="flex flex-wrap gap-2">
                  {STARTS.map(([label, offset]) => {
                    const s = offset === 0 ? nextSlot(now) : addMinutes(nextSlot(now), offset)
                    return (
                      <Chip key={label} active={Math.abs(start.getTime() - s.getTime()) < 60000} onClick={() => setStart(s)}>
                        {label}
                      </Chip>
                    )
                  })}
                  <input
                    type="time"
                    step={900}
                    value={timeStr}
                    min={toLocalTime(now)}
                    max={toLocalTime(addMinutes(now, HORIZON_MIN))}
                    onChange={(e) => setStart(fromLocal(toLocalDate(now), e.target.value))}
                    className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm"
                    aria-label="Start time"
                  />
                </div>
              </div>
            )}

            {/* Seats — shared rooms only (D17) */}
            {room.shared && (
              <div>
                <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-muted">
                  Seats <span className="font-normal normal-case tracking-normal">· {live.seatsFree ?? room.capacity} of {room.capacity} free right now</span>
                </span>
                <div className="flex flex-wrap gap-2">
                  {Array.from({ length: room.capacity }, (_, i) => i + 1).map((n) => (
                    <Chip key={n} active={seats === n} onClick={() => setSeats(n)}>{n}</Chip>
                  ))}
                </div>
              </div>
            )}

            {/* How long */}
            <div>
              <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-muted">How long</span>
              <div className="flex flex-wrap gap-2">
                {QUICK.map((m) => (
                  <Chip key={m} active={minutes === m} onClick={() => setMinutes(m)}>{fmtDuration(m)}</Chip>
                ))}
              </div>
              <details className="mt-3" open={minutes > SELF_SERVE_MAX}>
                <summary className="cursor-pointer text-sm text-muted">
                  Longer {isStaff ? '' : '(needs a guide’s approval)'}
                </summary>
                <div className="mt-2 flex flex-wrap gap-2">
                  {LONG.map((m) => (
                    <Chip key={m} active={minutes === m} onClick={() => setMinutes(m)}>{fmtDuration(m)}</Chip>
                  ))}
                </div>
              </details>
              <p className="mt-2 text-sm text-muted">
                {fmtRange(start, end)}
                {collides && live.next && (
                  <span className="ml-2 text-amber-700 dark:text-amber-400">
                    · runs into a booking at {fmtTime(live.next.start)}
                  </span>
                )}
              </p>
            </div>

            {/* Guide, only past the gate */}
            {needsGuide && (
              <div className="rounded-xl border border-cyan/40 bg-cyan/10 p-4">
                <p className="text-sm font-bold">Over 1 hour — a guide needs to approve this.</p>
                <p className="mt-1 text-sm text-muted">
                  We&apos;ll message them on Slack. The room is held for you until they answer, or until the booking would start.
                </p>
                {guides.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {guides.slice(0, 3).map((g) => (
                      <Chip key={g.guide_email} active={guideEmail === g.guide_email} onClick={() => setGuideEmail(g.guide_email)}>
                        {g.guide_email.split('@')[0].split('.')[0].replace(/^\w/, (c) => c.toUpperCase())}
                      </Chip>
                    ))}
                  </div>
                )}
                <input
                  type="email"
                  value={guideEmail}
                  onChange={(e) => setGuideEmail(e.target.value)}
                  placeholder="guide@alpha.school"
                  className="mt-3 w-full rounded-lg border border-border bg-background px-3 py-2"
                />
              </div>
            )}

            {/* Why (optional) */}
            <label className="block">
              <span className="mb-1 block text-xs font-bold uppercase tracking-wider text-muted">
                What for <span className="font-normal normal-case tracking-normal">(optional)</span>
              </span>
              <input
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder={needsGuide ? 'Helps your guide say yes' : 'e.g. calc study group'}
                maxLength={140}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2"
              />
            </label>

            {error && (
              <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>
            )}

            <button
              onClick={submit}
              disabled={busy || (needsGuide && !guideEmail.includes('@'))}
              className="w-full rounded-xl bg-navy px-4 py-3.5 font-bold text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Booking…' : needsGuide ? 'Request approval' : room.shared ? `Book ${seats} ${seats === 1 ? 'seat' : 'seats'}` : `Book ${room.name}`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function Confirmation({
  pending, checkedIn, notified, note, start, end, guideEmail, onClose,
}: { pending: boolean; checkedIn: boolean; notified: 'slack' | 'none'; note?: string; start: Date; end: Date; guideEmail: string; onClose: () => void }) {
  const guideName = guideEmail.split('@')[0].split('.')[0].replace(/^\w/, (c) => c.toUpperCase())
  return (
    <div className="space-y-4">
      <div className={`rounded-xl p-4 ${pending ? 'bg-cyan/10' : 'bg-green-50 dark:bg-green-950'}`}>
        <p className="font-bold">{pending ? (notified === 'slack' ? `Asked ${guideName} on Slack` : 'Request saved') : 'You’re booked'}</p>
        <p className="mt-1 text-sm text-muted">
          {fmtRange(start, end)}
          {pending ? (
            notified === 'slack'
              ? <> · The room is held for you until they answer. You&apos;ll get a Slack message either way.</>
              : <> · Held for you until <span className="font-medium text-foreground">{guideEmail}</span> answers. {note ? <span className="text-amber-700 dark:text-amber-400">{note}</span> : 'Ask them directly.'}</>
          ) : checkedIn ? (
            <> · You’re checked in.</>
          ) : (
            <> · Check in within 5 minutes of {fmtTime(start)} or it opens back up.</>
          )}
        </p>
      </div>
      <button onClick={onClose} className="w-full rounded-xl border border-border px-4 py-3 font-bold hover:bg-surface">
        Done
      </button>
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-sm font-bold transition ${
        active ? 'bg-navy text-white' : 'bg-surface text-foreground hover:bg-border'
      }`}
    >
      {children}
    </button>
  )
}

// --- local date/time <-> Date --------------------------------------------
function pad(n: number) { return String(n).padStart(2, '0') }
function toLocalDate(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function toLocalTime(d: Date) { return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
function fromLocal(date: string, time: string) {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  return new Date(y, m - 1, d, hh, mm, 0, 0)
}
