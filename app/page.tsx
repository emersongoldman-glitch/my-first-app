import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import SignOutButton from './sign-out-button'

type Room = {
  id: number
  slug: string
  name: string
  capacity: number
  kind: string
  zones: { name: string; floor: number; sort: number } | null
}

export default async function Home() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, full_name, role')
    .eq('id', user.id)
    .single()

  const { data: rooms, error } = await supabase
    .from('rooms')
    .select('id, slug, name, capacity, kind, zones(name, floor, sort)')
    .eq('bookable', true)
    .order('sort')
    .returns<Room[]>()

  // Group by zone, preserving the zone ordering from the database.
  const byZone = new Map<string, Room[]>()
  for (const room of rooms ?? []) {
    const zone = room.zones?.name ?? 'Unassigned'
    if (!byZone.has(zone)) byZone.set(zone, [])
    byZone.get(zone)!.push(room)
  }
  const zones = [...byZone.entries()].sort(
    (a, b) => (a[1][0].zones?.sort ?? 0) - (b[1][0].zones?.sort ?? 0)
  )

  const name = profile?.display_name ?? profile?.full_name ?? user.email

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Campus Rooms</h1>
          <p className="mt-1 text-neutral-600 dark:text-neutral-400">
            Signed in as {name}
            {profile?.role !== 'student' && (
              <span className="ml-2 rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-medium uppercase tracking-wide dark:bg-neutral-800">
                {profile?.role}
              </span>
            )}
          </p>
        </div>
        <SignOutButton />
      </header>

      {error && (
        <p className="mb-6 rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load rooms: {error.message}
        </p>
      )}

      <div className="space-y-8">
        {zones.map(([zone, zoneRooms]) => (
          <section key={zone}>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
              {zone}
              {zoneRooms[0].zones?.floor === 2 && (
                <span className="ml-2 font-normal normal-case text-neutral-400">
                  2nd floor
                </span>
              )}
            </h2>
            <ul className="divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
              {zoneRooms.map((room) => (
                <li key={room.id} className="flex items-center justify-between px-4 py-3">
                  <span className="font-medium">{room.name}</span>
                  <span className="text-sm text-neutral-500">
                    {room.capacity} {room.capacity === 1 ? 'seat' : 'seats'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <p className="mt-10 text-sm text-neutral-500">
        Phase 0 — auth and rooms only. Booking lands in Phase 1 (see PLAN.md).
      </p>
    </main>
  )
}
