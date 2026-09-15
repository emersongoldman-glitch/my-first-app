'use client'

import { useState } from 'react'
import Board from '@/app/board'
import type { Booking, Profile, Room } from '@/lib/bookings'

/** Fake campus + bookings, frozen at first render so the view is stable. */
export default function PreviewBoard() {
  const [data] = useState(() => build(Date.now()))
  return <Board rooms={data.rooms} initialBookings={data.bookings} profile={data.me} guides={[]} offline />
}

function build(now: number) {
  const zones = {
    underpass: { id: 1, name: 'Underpass', floor: 1, sort: 10 },
    hallway:   { id: 2, name: 'Hallway', floor: 1, sort: 20 },
    atrium:    { id: 3, name: 'Atrium', floor: 1, sort: 30 },
    pomodoro:  { id: 4, name: 'Pomodoro Room', floor: 1, sort: 40 },
    conf:      { id: 5, name: 'Conference', floor: 1, sort: 50 },
    upstairs:  { id: 6, name: 'Upstairs', floor: 2, sort: 60 },
  }
  const mk = (id: number, name: string, z: keyof typeof zones, capacity = 1, kind: Room['kind'] = 'pod'): Room => ({
    id, slug: name.toLowerCase().replace(/\s+/g, '-'), name, capacity, kind, max_minutes: null, bookable: true, sort: id, zones: zones[z],
  })
  const rooms: Room[] = [
    mk(1, 'Underpass Pod 1', 'underpass'), mk(2, 'Underpass Pod 2', 'underpass'), mk(3, 'Underpass Pod 3', 'underpass'),
    mk(4, 'Hallway Pod 1', 'hallway'), mk(5, 'Hallway Pod 2', 'hallway'), mk(6, 'Hallway Pod 3', 'hallway'),
    mk(7, 'Hallway Pod 4', 'hallway'), mk(8, 'Hallway Pod 5', 'hallway'), mk(9, 'Hallway Pod 6', 'hallway'),
    mk(10, 'Atrium Double Pod', 'atrium', 2),
    mk(11, 'Pomodoro Pod', 'pomodoro'),
    mk(12, 'Conference Room 1', 'conf', 6, 'conference'), mk(13, 'Conference Room 2', 'conf', 6, 'conference'),
    mk(14, 'Conference Room 3', 'conf', 6, 'conference'), mk(15, 'Conference Room 4', 'conf', 6, 'conference'),
    mk(16, 'Upstairs Pod 1', 'upstairs'), mk(17, 'Upstairs Pod 2', 'upstairs'),
    mk(18, 'Upstairs 4-Seater Pod', 'upstairs', 4), mk(19, 'Upstairs Podcast Room', 'upstairs', 3, 'special'),
  ]

  const me: Profile = { id: 'me', email: 'emerson.goldman@alpha.school', full_name: 'Emerson Goldman', display_name: 'Emerson', role: 'admin', role_confirmed: true }
  const at = (m: number) => new Date(now + m * 60000)
  const range = (from: number, to: number) => `["${pg(at(from))}","${pg(at(to))}")`
  const bk = (id: string, room_id: number, from: number, to: number, status: Booking['status'], name: string, user_id = 'u-' + name): Booking => ({
    id, room_id, user_id, booked_by: user_id, during: range(from, to), purpose: null, status, checked_in_at: null,
    created_at: at(0).toISOString(), user: { display_name: name, full_name: name },
  })
  const bookings: Booking[] = [
    bk('b1', 5, -20, 40, 'checked_in', 'Maya R.'),
    bk('b2', 6, -5, 55, 'reserved', 'Jaiden'),
    bk('b3', 12, -30, 150, 'checked_in', 'Kent'),
    bk('b4', 13, 0, 180, 'pending_approval', 'Allegra'),
    bk('b5', 10, -10, 50, 'checked_in', 'Emerson', 'me'),
    bk('b6', 2, 45, 105, 'reserved', 'Oz'),
    bk('b7', 18, -15, 75, 'checked_in', 'Stella G'),
    bk('b8', 8, 90, 120, 'reserved', 'Lulu'),
  ]
  return { rooms, bookings, me }
}

/** Postgres text form, exactly what PostgREST returns: `2026-09-16 15:00:00+00`. */
function pg(d: Date) {
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '+00')
}
