import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Image from 'next/image'
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
          <Image
            src="/brand/wolf-lockup-navy.svg"
            alt="Alpha High School"
            width={150}
            height={72}
            priority
            className="mb-4 h-auto w-[150px] dark:hidden"
          />
          <Image
            src="/brand/wolf-lockup-white.svg"
            alt="Alpha High School"
            width={150}
            height={72}
            priority
            className="mb-4 hidden h-auto w-[150px] dark:block"
          />
          <h1 className="text-2xl font-bold tracking-tight">Campus Rooms</h1>
          <p className="mt-1 text-muted">
            Signed in as {name}
            {profile?.role !== 'student' && (
              <span className="ml-2 rounded-full bg-cyan/15 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-navy dark:text-cyan">
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
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-navy dark:text-cyan">
              {zone}
              {zoneRooms[0].zones?.floor === 2 && (
                <span className="ml-2 font-normal normal-case tracking-normal text-muted">
                  2nd floor
                </span>
              )}
            </h2>
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {zoneRooms.map((room) => (
                <li key={room.id} className="flex items-center justify-between px-4 py-3">
                  <span className="font-medium">{room.name}</span>
                  <span className="text-sm text-muted">
                    {room.capacity} {room.capacity === 1 ? 'seat' : 'seats'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <p className="mt-10 text-sm text-muted">
        Phase 0 — auth and rooms only. Booking lands in Phase 1 (see PLAN.md).
      </p>
    </main>
  )
}
