import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ACTIVE_STATUSES, type Profile } from '@/lib/bookings'
import People, { type PersonBooking, type PersonPresence, type RoomLite } from './people'

export const dynamic = 'force-dynamic'

export default async function PeoplePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Bookings that overlap "now": who is in a room this minute.
  const now = new Date()
  const nowRange = `[${now.toISOString()},${new Date(now.getTime() + 60000).toISOString()})`

  const [{ data: profile }, { data: rooms }, { data: current }, { data: presence }] = await Promise.all([
    supabase.from('profiles').select('id, email, full_name, display_name, role').eq('id', user.id).single(),
    supabase.from('rooms').select('id, name, zones(name)').order('sort'),
    supabase
      .from('bookings')
      .select('id, room_id, user_id, during, status, user:profiles!user_id(id, display_name, full_name, role, visible)')
      .in('status', [...ACTIVE_STATUSES])
      .overlaps('during', nowRange),
    supabase
      .from('presence')
      .select('user_id, status, room_id, note, updated_at, user:profiles!user_id(id, display_name, full_name, role, visible)'),
  ])

  return (
    <main className="mx-auto max-w-2xl px-6 py-8">
      <header className="mb-6">
        <Link href="/" className="text-sm font-bold text-navy hover:underline dark:text-cyan">← Board</Link>
        <h1 className="mt-3 text-2xl font-bold tracking-tight">People</h1>
        <p className="mt-1 text-muted">Find a guide or a classmate — and where they are right now.</p>
      </header>
      <People
        me={(profile ?? { id: user.id, role: 'student' }) as Profile}
        rooms={(rooms ?? []) as unknown as RoomLite[]}
        initialCurrent={(current ?? []) as unknown as PersonBooking[]}
        initialPresence={(presence ?? []) as unknown as PersonPresence[]}
      />
    </main>
  )
}
