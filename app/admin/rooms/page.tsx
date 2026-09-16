import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import RoomManager, { type ManagedRoom, type ManagedZone } from './room-manager'

export const dynamic = 'force-dynamic'

export default async function ManageRoomsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (!me || me.role === 'student') redirect('/')

  const [{ data: zones }, { data: rooms }] = await Promise.all([
    supabase.from('zones').select('id, name, floor, sort').order('sort'),
    // bookings(count) rides along so the UI knows which rooms can be deleted
    // outright and which must be retired to keep history intact.
    supabase
      .from('rooms')
      .select('id, slug, name, zone_id, capacity, kind, bookable, shared, sort, bookings(count)')
      .order('sort'),
  ])

  const managed: ManagedRoom[] = (rooms ?? []).map((r) => {
    const { bookings, ...rest } = r as typeof r & { bookings: { count: number }[] }
    return { ...rest, booking_count: bookings?.[0]?.count ?? 0 } as ManagedRoom
  })

  return (
    <main className="mx-auto max-w-2xl px-6 py-8">
      <header className="mb-6">
        <Link href="/" className="text-sm font-bold text-navy hover:underline dark:text-cyan">← Board</Link>
        <h1 className="mt-3 text-2xl font-bold tracking-tight">Rooms &amp; zones</h1>
        <p className="mt-1 text-muted">
          Rename, add, regroup, or retire rooms. Changes show on the board immediately.
        </p>
      </header>
      <RoomManager zones={(zones ?? []) as ManagedZone[]} rooms={managed} />
    </main>
  )
}
