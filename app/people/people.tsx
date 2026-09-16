'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  ACTIVE_STATUSES, PRESENCE_LABEL, displayName, parseRange,
  type Booking, type Presence, type Profile,
} from '@/lib/bookings'
import { fmtTime } from '@/lib/time'
import { lookupSlackUser, searchPeople, slackDmUrl, slackEnabled, type PersonHit } from '@/lib/slack'

// ---------------------------------------------------------------------------
// Shapes as fetched (with the profile join). Exported for the server page.
// ---------------------------------------------------------------------------
type Person = { id: string; display_name: string | null; full_name: string; role: Profile['role']; visible?: boolean }
export type RoomLite = { id: number; name: string; zones: { name: string } | null }
export type PersonBooking = Pick<Booking, 'id' | 'room_id' | 'user_id' | 'during' | 'status'> & { user: Person | null }
export type PersonPresence = Presence & { user: Person | null }

type Props = {
  me: Profile
  rooms: RoomLite[]
  initialCurrent: PersonBooking[]
  initialPresence: PersonPresence[]
}

type Where = { text: string; tone: 'room' | 'away' | 'none' }

export default function People({ me, rooms, initialCurrent, initialPresence }: Props) {
  const [q, setQ] = useState('')
  const searching = q.trim().length > 0
  const [hits, setHits] = useState<PersonHit[]>([])                // unified search results
  const [upcoming, setUpcoming] = useState<PersonBooking[]>([])   // next bookings for profile hits
  const [current, setCurrent] = useState(initialCurrent)
  const [presence, setPresence] = useState(initialPresence)
  const [now, setNow] = useState(() => new Date())
  const inputRef = useRef<HTMLInputElement>(null)
  const [toast, setToast] = useState<string | null>(null)
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(null), 4000) }

  function openDm(slackUserId: string) {
    window.open(slackDmUrl(slackUserId), '_blank', 'noopener')
  }

  // Open the window synchronously (popup blockers allow that on a click), then
  // point it at the DM once the lookup returns.
  async function messageOnSlack(personId: string, name: string) {
    const w = window.open('', '_blank')
    const r = await lookupSlackUser(personId)
    if (!r.ok) { w?.close(); say(`${name}: ${r.error}`); return }
    const url = slackDmUrl(r.slackUserId)
    if (w) w.location.assign(url); else window.location.assign(url)
  }

  const roomById = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms])
  const isStaff = me.role !== 'student'

  // --- live data -----------------------------------------------------------
  const refetchLive = useCallback(async () => {
    const sb = createClient()
    const t = new Date()
    const nowRange = `[${t.toISOString()},${new Date(t.getTime() + 60000).toISOString()})`
    const [{ data: c }, { data: p }] = await Promise.all([
      sb.from('bookings')
        .select('id, room_id, user_id, during, status, user:profiles!user_id(id, display_name, full_name, role, visible)')
        .in('status', [...ACTIVE_STATUSES]).overlaps('during', nowRange),
      sb.from('presence')
        .select('user_id, status, room_id, note, updated_at, user:profiles!user_id(id, display_name, full_name, role, visible)'),
    ])
    if (c) setCurrent(c as unknown as PersonBooking[])
    if (p) setPresence(p as unknown as PersonPresence[])
  }, [])

  useEffect(() => {
    const sb = createClient()
    const ch = sb.channel('people')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, () => { void refetchLive() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'presence' }, () => { void refetchLive() })
      .subscribe()
    const tick = setInterval(() => { setNow(new Date()); void refetchLive() }, 30_000)
    inputRef.current?.focus()
    return () => { void sb.removeChannel(ch); clearInterval(tick) }
  }, [refetchLive])

  // --- search (debounced) --------------------------------------------------
  // One server call merges app profiles, the Slack directory, known guides,
  // and the roster — so "Clay" is found even if he has never opened the app.
  useEffect(() => {
    const term = q.trim()
    if (!term) return  // `searching` is derived from q, so nothing to clear
    const handle = setTimeout(async () => {
      const found = await searchPeople(term)
      setHits(found)
      const ids = found.map((h) => h.profileId).filter((id): id is string => !!id)
      if (ids.length) {
        const t = new Date()
        const { data: next } = await createClient()
          .from('bookings')
          .select('id, room_id, user_id, during, status')
          .in('user_id', ids)
          .in('status', [...ACTIVE_STATUSES])
          .overlaps('during', `[${t.toISOString()},${new Date(t.getTime() + 24 * 3600000).toISOString()})`)
        setUpcoming((next ?? []) as PersonBooking[])
      } else setUpcoming([])
    }, 200)
    return () => clearTimeout(handle)
  }, [q])

  // --- where is someone? ---------------------------------------------------
  function whereIs(personId: string): Where {
    const inRoom = current.find((b) => b.user_id === personId && b.status !== 'pending_approval')
    if (inRoom) {
      const { end } = parseRange(inRoom.during)
      const r = roomById.get(inRoom.room_id)
      return { text: `${r?.name ?? 'A room'}${r?.zones ? ` · ${r.zones.name}` : ''} · until ${fmtTime(end)}`, tone: 'room' }
    }
    const pr = presence.find((p) => p.user_id === personId)
    if (pr) {
      if (pr.status === 'in_room' && pr.room_id) {
        const r = roomById.get(pr.room_id)
        return { text: `${r?.name ?? 'A room'}${pr.note ? ` · ${pr.note}` : ''}`, tone: 'room' }
      }
      return { text: `${PRESENCE_LABEL[pr.status]}${pr.note ? ` · ${pr.note}` : ''}`, tone: pr.status === 'roaming' ? 'none' : 'away' }
    }
    const next = upcoming
      .filter((b) => b.user_id === personId && parseRange(b.during).start > now)
      .sort((a, b) => parseRange(a.during).start.getTime() - parseRange(b.during).start.getTime())[0]
    if (next) {
      const r = roomById.get(next.room_id)
      return { text: `Not in a booked space · will be in ${r?.name ?? 'a room'} at ${fmtTime(parseRange(next.during).start)}`, tone: 'none' }
    }
    return { text: 'Not in a booked space', tone: 'none' }
  }

  function whereIsHit(h: PersonHit): Where {
    if (h.profileId) return whereIs(h.profileId)
    if (h.source === 'roster') return { text: 'Not in a booked space · hasn’t signed in to Campus Rooms yet', tone: 'none' }
    return { text: h.slackUserId ? 'Not in a booked space · message them on Slack' : 'Not in a booked space', tone: 'none' }
  }

  // Default view: everyone who is somewhere right now. Guides first.
  const rightNow: PersonHit[] = useMemo(() => {
    const seen = new Map<string, Person>()
    for (const p of presence) if (p.user && p.user.visible !== false && p.status !== 'roaming') seen.set(p.user.id, p.user)
    for (const b of current) if (b.user && b.user.visible !== false && b.status !== 'pending_approval') seen.set(b.user.id, b.user)
    return [...seen.values()]
      .sort((a, b) => rank(a.role) - rank(b.role) || displayName(a).localeCompare(displayName(b)))
      .map((p) => ({ key: `p:${p.id}`, name: displayName(p), profileId: p.id, role: p.role, slackUserId: null, title: null, avatar: null, source: 'profile' as const }))
  }, [presence, current])

  const list = searching ? hits : rightNow

  return (
    <div className="space-y-6">
      {isStaff && <StatusSetter me={me} rooms={rooms} mine={presence.find((p) => p.user_id === me.id)} onSaved={refetchLive} />}

      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search a name…"
        autoComplete="off"
        className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-lg focus:border-navy focus:outline-none dark:focus:border-cyan"
      />

      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-navy dark:text-cyan">
          {searching ? `${list.length} ${list.length === 1 ? 'match' : 'matches'}` : 'Right now'}
        </h2>
        {list.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">
            {searching ? 'No one by that name.' : 'Nobody is in a booked space right now.'}
          </p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
            {list.map((h) => {
              const w = whereIsHit(h)
              const isMe = h.profileId === me.id
              const canSlack = slackEnabled && !isMe && (h.slackUserId || h.profileId)
              return (
                <li key={h.key} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    {h.avatar ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={h.avatar} alt="" width={28} height={28} className="h-7 w-7 shrink-0 rounded-full" />
                    ) : (
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-border text-xs font-bold text-muted" aria-hidden>
                        {h.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="truncate font-bold">
                        {h.name}
                        {isMe && <span className="ml-1 font-normal text-muted">(you)</span>}
                        {h.role && h.role !== 'student' && (
                          <span className="ml-2 rounded-full bg-cyan/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-navy dark:text-cyan">guide</span>
                        )}
                        {h.title && h.role === null && <span className="ml-2 font-normal text-muted">{h.title}</span>}
                      </p>
                      <p className={`truncate text-sm ${w.tone === 'room' ? 'text-foreground' : 'text-muted'}`}>{w.text}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {canSlack && (
                      <button
                        type="button"
                        onClick={() => { if (h.slackUserId) openDm(h.slackUserId); else if (h.profileId) void messageOnSlack(h.profileId, h.name) }}
                        className="rounded-lg border border-border px-2.5 py-1 text-xs font-bold text-navy hover:bg-background dark:text-cyan"
                        title={`Message ${h.name} on Slack`}
                      >
                        Slack
                      </button>
                    )}
                    <Pin tone={w.tone} />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <p className="text-center text-xs text-muted">
        Location means “has a booking in a room”. Guides set their own status. Nothing is tracked.
      </p>

      {toast && (
        <div className="fixed inset-x-4 bottom-6 z-40 mx-auto max-w-md rounded-xl bg-foreground px-4 py-3 text-center text-sm font-medium text-background shadow-xl">{toast}</div>
      )}
    </div>
  )
}

function rank(role: Profile['role'] | null) { return role === 'student' || role === null ? 1 : 0 }

function Pin({ tone }: { tone: 'room' | 'away' | 'none' }) {
  const cls = { room: 'bg-green-500', away: 'bg-neutral-400', none: 'bg-border' }[tone]
  return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${cls}`} aria-hidden />
}

// ---------------------------------------------------------------------------
// Guides say where they are. Self-reported only (PLAN.md §9).
// ---------------------------------------------------------------------------
function StatusSetter({ me, rooms, mine, onSaved }: { me: Profile; rooms: RoomLite[]; mine?: PersonPresence; onSaved: () => void }) {
  const [status, setStatus] = useState<Presence['status']>(mine?.status ?? 'roaming')
  const [roomId, setRoomId] = useState<number | ''>(mine?.room_id ?? '')
  const [note, setNote] = useState(mine?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function save() {
    setBusy(true); setMsg(null)
    const sb = createClient()
    const { error } = await sb.from('presence').upsert({
      user_id: me.id, status, room_id: status === 'in_room' && roomId !== '' ? roomId : null,
      note: note.trim() || null, updated_at: new Date().toISOString(),
    })
    setBusy(false)
    setMsg(error ? error.message : 'Saved.')
    if (!error) onSaved()
  }

  return (
    <div className="rounded-xl border border-cyan/40 bg-cyan/10 p-4">
      <p className="text-sm font-bold">Where are you?</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {(Object.keys(PRESENCE_LABEL) as Presence['status'][]).map((s) => (
          <button key={s} type="button" onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1.5 text-sm font-bold ${status === s ? 'bg-navy text-white' : 'bg-background text-foreground hover:bg-border'}`}>
            {PRESENCE_LABEL[s]}
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {status === 'in_room' && (
          <select value={roomId} onChange={(e) => setRoomId(e.target.value ? Number(e.target.value) : '')}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm">
            <option value="">Which room?</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={80}
          placeholder="Optional note — “back at 1:30”"
          className="min-w-[12rem] flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" />
        <button onClick={save} disabled={busy || (status === 'in_room' && roomId === '')}
          className="rounded-lg bg-navy px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {msg && <p className="mt-2 text-xs text-muted">{msg}</p>}
    </div>
  )
}
