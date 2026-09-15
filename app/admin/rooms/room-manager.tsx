'use client'

import { useCallback, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export type ManagedZone = { id: number; name: string; floor: number; sort: number }
export type ManagedRoom = {
  id: number
  slug: string
  name: string
  zone_id: number
  capacity: number
  kind: 'pod' | 'conference' | 'special'
  bookable: boolean
  sort: number
  booking_count: number
}

const KINDS: ManagedRoom['kind'][] = ['pod', 'conference', 'special']

export default function RoomManager({ zones: z0, rooms: r0 }: { zones: ManagedZone[]; rooms: ManagedRoom[] }) {
  const [zones, setZones] = useState(z0)
  const [rooms, setRooms] = useState(r0)
  const [toast, setToast] = useState<string | null>(null)
  const [newZone, setNewZone] = useState('')

  const say = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(null), 3500) }, [])

  const refetch = useCallback(async () => {
    const sb = createClient()
    const [{ data: zs }, { data: rs }] = await Promise.all([
      sb.from('zones').select('id, name, floor, sort').order('sort'),
      sb.from('rooms').select('id, slug, name, zone_id, capacity, kind, bookable, sort, bookings(count)').order('sort'),
    ])
    if (zs) setZones(zs as ManagedZone[])
    if (rs) setRooms((rs as unknown as (ManagedRoom & { bookings: { count: number }[] })[]).map(({ bookings, ...r }) => ({
      ...r, booking_count: bookings?.[0]?.count ?? 0,
    })))
  }, [])

  // Every write goes through here: optimistic UI, then the database is the
  // authority (RLS decides who may do this), then we re-sync.
  async function write(label: string, fn: (sb: ReturnType<typeof createClient>) => PromiseLike<{ error: { message: string; code?: string } | null }>) {
    const { error } = await fn(createClient())
    if (error) {
      say(friendly(error))
      await refetch()
      return false
    }
    say(label)
    await refetch()
    return true
  }

  // --- rooms ---------------------------------------------------------------
  const updateRoom = (id: number, patch: Partial<ManagedRoom>, label = 'Saved.') => {
    setRooms((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    return write(label, (sb) => sb.from('rooms').update(patch).eq('id', id))
  }

  async function addRoom(zoneId: number, name: string) {
    const base = slugify(name)
    // Slug must be unique; retry with a numeric suffix if a sibling took it.
    for (let n = 0; n < 5; n++) {
      const slug = n === 0 ? base : `${base}-${n + 1}`
      const sb = createClient()
      const sort = (Math.max(0, ...rooms.filter((r) => r.zone_id === zoneId).map((r) => r.sort)) || 0) + 10
      const { error } = await sb.from('rooms').insert({ slug, name, zone_id: zoneId, capacity: 1, kind: 'pod', sort })
      if (!error) { say(`Added ${name}.`); await refetch(); return }
      if (error.code !== '23505') { say(friendly(error)); return }
    }
    say('Could not find a free name for that room.')
  }

  async function removeRoom(r: ManagedRoom) {
    if (r.booking_count > 0) {
      // Bookings reference this room; deleting would orphan history. Retire instead.
      if (!confirm(`${r.name} has ${r.booking_count} booking${r.booking_count === 1 ? '' : 's'} on record, so it can't be deleted.\n\nRetire it instead? It disappears from the board but history stays.`)) return
      await updateRoom(r.id, { bookable: false }, `${r.name} retired.`)
      return
    }
    if (!confirm(`Delete ${r.name}? It has never been booked, so nothing is lost.`)) return
    await write(`${r.name} deleted.`, (sb) => sb.from('rooms').delete().eq('id', r.id))
  }

  // --- zones ---------------------------------------------------------------
  const updateZone = (id: number, patch: Partial<ManagedZone>) => {
    setZones((zs) => zs.map((z) => (z.id === id ? { ...z, ...patch } : z)))
    return write('Saved.', (sb) => sb.from('zones').update(patch).eq('id', id))
  }

  async function addZone() {
    const name = newZone.trim()
    if (!name) return
    const ok = await write(`Added ${name}.`, (sb) => sb.from('zones').insert({ name, floor: 1 }))
    if (ok) setNewZone('')
  }

  async function removeZone(z: ManagedZone) {
    const count = rooms.filter((r) => r.zone_id === z.id).length
    if (count > 0) { say(`Move or delete the ${count} room${count === 1 ? '' : 's'} in ${z.name} first.`); return }
    if (!confirm(`Delete the empty zone “${z.name}”?`)) return
    await write(`${z.name} deleted.`, (sb) => sb.from('zones').delete().eq('id', z.id))
  }

  const byZone = useMemo(() => {
    const m = new Map<number, ManagedRoom[]>()
    for (const r of rooms) { if (!m.has(r.zone_id)) m.set(r.zone_id, []); m.get(r.zone_id)!.push(r) }
    for (const list of m.values()) list.sort((a, b) => a.sort - b.sort)
    return m
  }, [rooms])

  return (
    <div className="space-y-8">
      {zones.map((z) => (
        <section key={z.id} className="rounded-xl border border-border bg-surface">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <input
              defaultValue={z.name}
              onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== z.name && updateZone(z.id, { name: e.target.value.trim() })}
              className="min-w-0 flex-1 rounded-lg bg-transparent px-2 py-1 text-sm font-bold uppercase tracking-wider text-navy hover:bg-background focus:bg-background focus:outline-none dark:text-cyan"
              aria-label="Zone name"
            />
            <label className="flex items-center gap-1 text-xs text-muted">
              floor
              <input type="number" min={1} max={9} defaultValue={z.floor}
                onBlur={(e) => Number(e.target.value) !== z.floor && updateZone(z.id, { floor: Number(e.target.value) })}
                className="w-12 rounded-lg border border-border bg-background px-2 py-1 text-center text-sm" />
            </label>
            <button onClick={() => removeZone(z)} className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-background hover:text-red-600" title="Delete zone (must be empty)">
              delete
            </button>
          </div>

          <ul className="divide-y divide-border">
            {(byZone.get(z.id) ?? []).map((r) => (
              <li key={r.id} className={`flex flex-wrap items-center gap-2 px-4 py-2.5 ${r.bookable ? '' : 'opacity-60'}`}>
                <input
                  defaultValue={r.name}
                  onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== r.name && updateRoom(r.id, { name: e.target.value.trim() })}
                  className="min-w-[10rem] flex-1 rounded-lg bg-transparent px-2 py-1 font-bold hover:bg-background focus:bg-background focus:outline-none"
                  aria-label="Room name"
                />
                <input type="number" min={1} max={30} defaultValue={r.capacity} title="Seats"
                  onBlur={(e) => Number(e.target.value) !== r.capacity && updateRoom(r.id, { capacity: Number(e.target.value) })}
                  className="w-14 rounded-lg border border-border bg-background px-2 py-1 text-center text-sm" />
                <select value={r.kind} onChange={(e) => updateRoom(r.id, { kind: e.target.value as ManagedRoom['kind'] })}
                  className="rounded-lg border border-border bg-background px-2 py-1 text-sm">
                  {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
                <select value={r.zone_id} onChange={(e) => updateRoom(r.id, { zone_id: Number(e.target.value) }, `Moved ${r.name}.`)}
                  className="rounded-lg border border-border bg-background px-2 py-1 text-sm" title="Move to zone">
                  {zones.map((zz) => <option key={zz.id} value={zz.id}>{zz.name}</option>)}
                </select>
                <button onClick={() => updateRoom(r.id, { bookable: !r.bookable }, r.bookable ? `${r.name} retired.` : `${r.name} is bookable again.`)}
                  className={`rounded-lg px-2 py-1 text-xs font-bold ${r.bookable ? 'text-muted hover:bg-background' : 'bg-navy text-white'}`}>
                  {r.bookable ? 'retire' : 'restore'}
                </button>
                <button onClick={() => removeRoom(r)} className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-background hover:text-red-600"
                  title={r.booking_count ? `${r.booking_count} bookings on record — will offer to retire` : 'Delete (never booked)'}>
                  ✕
                </button>
              </li>
            ))}
            <li className="px-4 py-2.5">
              <AddRoom onAdd={(name) => addRoom(z.id, name)} />
            </li>
          </ul>
        </section>
      ))}

      <div className="flex gap-2">
        <input value={newZone} onChange={(e) => setNewZone(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addZone()}
          placeholder="New zone — e.g. Library, 3rd Floor" className="flex-1 rounded-xl border border-border bg-surface px-4 py-2.5" />
        <button onClick={addZone} disabled={!newZone.trim()} className="rounded-xl bg-navy px-4 py-2.5 font-bold text-white disabled:opacity-50">Add zone</button>
      </div>

      <p className="text-xs text-muted">
        Retired rooms keep their history and vanish from the board; restore them any time. A room that has never
        been booked can be deleted outright. Room names are free text — “Pod”, “Study Room”, “Booth”, whatever your campus calls them.
      </p>

      {toast && (
        <div className="fixed inset-x-4 bottom-6 z-40 mx-auto max-w-md rounded-xl bg-foreground px-4 py-3 text-center text-sm font-medium text-background shadow-xl">{toast}</div>
      )}
    </div>
  )
}

function AddRoom({ onAdd }: { onAdd: (name: string) => void }) {
  const [name, setName] = useState('')
  const submit = () => { const n = name.trim(); if (n) { onAdd(n); setName('') } }
  return (
    <div className="flex gap-2">
      <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="Add a room to this zone…" className="flex-1 rounded-lg border border-dashed border-border bg-transparent px-3 py-1.5 text-sm" />
      <button onClick={submit} disabled={!name.trim()} className="rounded-lg border border-border px-3 py-1.5 text-sm font-bold disabled:opacity-40">Add</button>
    </div>
  )
}

function slugify(s: string) {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-') || 'room'
}

function friendly(e: { message: string; code?: string }) {
  if (e.code === '42501' || /row-level security/i.test(e.message)) return 'Only guides and admins can change rooms.'
  if (e.code === '23503') return 'That room has bookings on record — retire it instead of deleting.'
  if (e.code === '23505') return 'A room with that name already exists here.'
  return e.message
}
