'use client'

import { useMemo, useState } from 'react'
import { displayName } from '@/lib/bookings'
import type { RoomLive, ZoneGroup } from '@/lib/board'
import { fmtTime } from '@/lib/time'

/**
 * A schematic map that draws itself from the data: each zone is a labeled
 * area, each room a tile sized by seats and coloured by live state. Works for
 * any campus's rooms without a hand-drawn floor plan (PLAN.md §5.2).
 */
export default function CampusMap({
  zones, me, now, onTap,
}: { zones: ZoneGroup[]; me: string; now: Date; onTap: (live: RoomLive) => void }) {
  const floors = useMemo(() => [...new Set(zones.map((z) => z.floor))].sort(), [zones])
  const [floor, setFloor] = useState<number>(floors[0] ?? 1)
  const visible = zones.filter((z) => z.floor === floor)

  return (
    <div className="space-y-4">
      {floors.length > 1 && (
        <div className="inline-flex rounded-xl border border-border bg-surface p-1 text-sm font-bold">
          {floors.map((f) => (
            <button
              key={f}
              onClick={() => setFloor(f)}
              className={`rounded-lg px-4 py-1.5 transition ${floor === f ? 'bg-navy text-white' : 'text-muted hover:text-foreground'}`}
            >
              {floorLabel(f)}
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {visible.map((z) => (
          <section
            key={z.name}
            className={`rounded-2xl border-2 border-border bg-surface/60 p-3 ${z.rooms.length >= 3 ? 'sm:col-span-2' : ''}`}
          >
            <header className="mb-3 flex items-baseline justify-between px-1">
              <h3 className="text-xs font-bold uppercase tracking-wider text-navy dark:text-cyan">{z.name}</h3>
              <span className="text-xs text-muted">
                {z.rooms.filter((r) => r.state === 'open' || r.state === 'free_until').length}/{z.rooms.length} open
              </span>
            </header>
            <div className="flex flex-wrap gap-2">
              {[...z.rooms].sort((a, b) => a.room.sort - b.room.sort).map((live) => (
                <Tile key={live.room.id} live={live} zoneName={z.name} me={me} now={now} onTap={() => onTap(live)} />
              ))}
            </div>
          </section>
        ))}
      </div>

      <Legend />
    </div>
  )
}

function Tile({ live, zoneName, me, now, onTap }: { live: RoomLive; zoneName: string; me: string; now: Date; onTap: () => void }) {
  const { room, state, current, next } = live
  const mine = current?.user_id === me
  void now

  const size =
    room.kind === 'conference' || room.capacity >= 5 ? 'h-24 w-44'
    : room.capacity >= 3 ? 'h-24 w-40'
    : room.capacity === 2 ? 'h-22 w-36'
    : 'h-22 w-[7.25rem]'

  const tone = {
    open:       'border-green-500/70 bg-green-50 text-green-900 hover:bg-green-100 dark:bg-green-950/60 dark:text-green-100 dark:hover:bg-green-950',
    free_until: 'border-green-500/70 bg-green-50 text-green-900 hover:bg-green-100 dark:bg-green-950/60 dark:text-green-100 dark:hover:bg-green-950',
    booked:     mine
      ? 'border-cyan bg-cyan/15 text-navy hover:bg-cyan/25 dark:text-cyan'
      : 'border-amber-500/70 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:bg-amber-950/60 dark:text-amber-100',
    held:       'border-neutral-400/70 bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200',
  }[state]

  const inUse = current?.status === 'checked_in'
  const line =
    state === 'open' ? 'Open'
    : state === 'free_until' && next ? `Open until ${fmtTime(next.start)}`
    : state === 'booked' && current ? `${mine ? 'You' : firstName(displayName(current.user))} until ${fmtTime(current.end)}`
    : state === 'held' && current ? `Held for ${firstName(displayName(current.user))}`
    : ''

  return (
    <button
      type="button"
      onClick={onTap}
      title={`${room.name} — ${line}`}
      className={`relative flex ${size} flex-col justify-between rounded-xl border-2 p-2.5 text-left shadow-sm transition active:scale-[0.98] ${tone}`}
    >
      <span className="flex items-start justify-between gap-1">
        <span className="text-sm font-bold leading-tight">{shortName(room.name, zoneName)}</span>
        <span className="shrink-0 text-[10px] font-bold opacity-60">{room.capacity}</span>
      </span>
      <span className="line-clamp-2 text-[11px] font-medium leading-snug opacity-90">
        {inUse && <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current align-middle" aria-label="in use" />}
        {line}
      </span>
    </button>
  )
}

function Legend() {
  const item = (cls: string, label: string) => (
    <span className="flex items-center gap-1.5"><span className={`h-3 w-3 rounded-sm border-2 ${cls}`} />{label}</span>
  )
  return (
    <div className="flex flex-wrap gap-4 px-1 text-xs text-muted">
      {item('border-green-500/70 bg-green-50 dark:bg-green-950', 'Open')}
      {item('border-amber-500/70 bg-amber-50 dark:bg-amber-950', 'Booked')}
      {item('border-cyan bg-cyan/15', 'Yours')}
      {item('border-neutral-400/70 bg-neutral-100 dark:bg-neutral-800', 'Held for approval')}
      <span className="ml-auto">Number = seats · tap a room to book or see who’s in it</span>
    </div>
  )
}

/** "Hallway Pod 3" inside the Hallway zone reads better as "Pod 3". */
function shortName(name: string, zone: string) {
  const stripped = name.replace(new RegExp(`^${zone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i'), '')
  return stripped || name
}

function firstName(full: string) {
  const [first, last] = full.split(' ')
  return last ? `${first} ${last[0]}.` : first
}

function floorLabel(f: number) {
  return f === 1 ? 'Main floor' : f === 2 ? '2nd floor' : f === 3 ? '3rd floor' : `Floor ${f}`
}
