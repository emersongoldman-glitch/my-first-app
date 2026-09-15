'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  ACTIVE_STATUSES, cancelBooking, checkIn, extendBooking,
  type Booking, type BookingStatus, type Profile,
} from '@/lib/bookings'
import { withTimes, type Timed } from '@/lib/board'
import { addMinutes, fmtDay, fmtRange, fmtTime, minutesBetween, sameCampusDay } from '@/lib/time'

export type MyBooking = Booking & {
  room: { name: string; zones: { name: string } | null } | null
  approval: { guide_email: string; decision: string | null; reason: string | null } | null
}

const LABEL: Record<BookingStatus, string> = {
  pending_approval: 'Awaiting approval',
  reserved: 'Reserved',
  checked_in: 'Checked in',
  completed: 'Done',
  cancelled: 'Cancelled',
  declined: 'Declined',
  expired: 'Request expired',
  no_show: 'Released — no check-in',
}

export default function MyBookings({ initial, profile }: { initial: MyBooking[]; profile: Profile }) {
  const [rows, setRows] = useState<MyBooking[]>(initial)
  const [now, setNow] = useState(() => new Date())
  const [toast, setToast] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    const sb = createClient()
    const { data } = await sb
      .from('bookings')
      .select('*, room:rooms(name, zones(name)), approval:approvals(guide_email, decision, reason)')
      .eq('user_id', profile.id)
      .order('during', { ascending: false })
      .limit(60)
    if (data) setRows(data as unknown as MyBooking[])
  }, [profile.id])

  useEffect(() => {
    const sb = createClient()
    const ch = sb
      .channel('my-bookings')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings', filter: `user_id=eq.${profile.id}` }, () => { void refetch() })
      .subscribe()
    const tick = setInterval(() => setNow(new Date()), 15_000)
    return () => { void sb.removeChannel(ch); clearInterval(tick) }
  }, [refetch, profile.id])

  const timed = useMemo(() => rows.map((r) => withTimes(r) as Timed & MyBooking), [rows])
  const upcoming = timed.filter((b) => ACTIVE_STATUSES.has(b.status) && b.end > now).sort((a, b) => a.start.getTime() - b.start.getTime())
  const past = timed.filter((b) => !upcoming.includes(b))

  function say(m: string) { setToast(m); setTimeout(() => setToast(null), 4000) }
  async function act(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); say(ok); await refetch() }
    catch (e) { say(e instanceof Error ? e.message : 'That didn’t work.') }
  }

  return (
    <>
      <Section title="Upcoming" empty="Nothing booked. Grab a room from the board.">
        {upcoming.map((b) => {
          const sinceStart = minutesBetween(b.start, now)          // negative before start
          const canCheckIn = b.status === 'reserved' && sinceStart >= -10 && sinceStart <= 5
          const live = b.status === 'checked_in' || (b.status === 'reserved' && sinceStart >= 0)
          const canExtend = live && minutesBetween(b.start, b.end) < 120
          return (
            <Card key={b.id} b={b} now={now}>
              <div className="mt-3 flex flex-wrap gap-2">
                {canCheckIn && (
                  <Btn primary onClick={() => act(() => checkIn(createClient(), b.id), 'Checked in.')}>Check in</Btn>
                )}
                {canExtend && (
                  <Btn onClick={() => act(() => extendBooking(createClient(), b.id, addMinutes(b.end, 30)), `Extended to ${fmtTime(addMinutes(b.end, 30))}.`)}>
                    +30 min
                  </Btn>
                )}
                <Btn quiet onClick={() => act(() => cancelBooking(createClient(), b.id), b.status === 'pending_approval' ? 'Request withdrawn.' : 'Cancelled — the room is open again.')}>
                  {b.status === 'pending_approval' ? 'Withdraw' : live ? 'Done early' : 'Cancel'}
                </Btn>
              </div>
              {b.status === 'reserved' && sinceStart < -10 && (
                <p className="mt-2 text-xs text-muted">Check-in opens at {fmtTime(addMinutes(b.start, -10))}. Miss it by 5 min and the room opens back up.</p>
              )}
            </Card>
          )
        })}
      </Section>

      <Section title="Past" empty="No history yet.">
        {past.slice(0, 20).map((b) => <Card key={b.id} b={b} now={now} muted />)}
      </Section>

      {toast && (
        <div className="fixed inset-x-4 bottom-6 z-40 mx-auto max-w-md rounded-xl bg-foreground px-4 py-3 text-center text-sm font-medium text-background shadow-xl">
          {toast}
        </div>
      )}
    </>
  )
}

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-navy dark:text-cyan">{title}</h2>
      {children.length === 0
        ? <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">{empty}</p>
        : <ul className="space-y-3">{children}</ul>}
    </section>
  )
}

function Card({ b, now, muted, children }: { b: Timed & MyBooking; now: Date; muted?: boolean; children?: React.ReactNode }) {
  const tone: Record<BookingStatus, string> = {
    pending_approval: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
    reserved: 'bg-cyan/15 text-navy dark:text-cyan',
    checked_in: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
    completed: 'bg-surface text-muted',
    cancelled: 'bg-surface text-muted',
    declined: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
    expired: 'bg-surface text-muted',
    no_show: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  }
  return (
    <li className={`rounded-xl border border-border bg-surface p-4 ${muted ? 'opacity-75' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-bold">{b.room?.name ?? 'Room'}</p>
          <p className="text-sm text-muted">
            {!sameCampusDay(b.start, now) && <>{fmtDay(b.start)} · </>}
            {fmtRange(b.start, b.end)}
            {b.room?.zones?.name && <> · {b.room.zones.name}</>}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${tone[b.status]}`}>{LABEL[b.status]}</span>
      </div>
      {b.status === 'pending_approval' && b.approval && (
        <p className="mt-2 text-sm text-muted">Asked <span className="text-foreground">{b.approval.guide_email}</span>. The room is held for you until they answer or until {fmtTime(b.start)}.</p>
      )}
      {b.status === 'declined' && b.approval?.reason && (
        <p className="mt-2 text-sm text-muted">Reason: “{b.approval.reason}”</p>
      )}
      {b.purpose && <p className="mt-2 text-sm text-muted">“{b.purpose}”</p>}
      {children}
    </li>
  )
}

function Btn({ children, onClick, primary, quiet }: { children: React.ReactNode; onClick: () => void; primary?: boolean; quiet?: boolean }) {
  const cls = primary
    ? 'bg-green-700 text-white hover:opacity-90'
    : quiet
      ? 'border border-border text-muted hover:bg-background'
      : 'bg-navy text-white hover:opacity-90'
  return <button onClick={onClick} className={`rounded-lg px-3 py-1.5 text-sm font-bold transition ${cls}`}>{children}</button>
}
