import Image from 'next/image'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ACTIVE_STATUSES, type Booking, type GuideMru, type Profile, type Room } from '@/lib/bookings'
import Board from './board'
import SignOutButton from './sign-out-button'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const now = new Date()
  const windowStart = new Date(now.getTime() - 60 * 60000).toISOString()
  const windowEnd = new Date(now.getTime() + 24 * 60 * 60000).toISOString()

  const [{ data: profile }, { data: rooms, error: roomsErr }, { data: bookings }, { data: guides }] =
    await Promise.all([
      supabase.from('profiles').select('id, email, full_name, display_name, role').eq('id', user.id).single(),
      supabase
        .from('rooms')
        .select('id, slug, name, capacity, kind, max_minutes, bookable, shared, sort, zones(id, name, floor, sort)')
        .eq('bookable', true)
        .order('sort'),
      supabase
        .from('bookings')
        .select('*, user:profiles!user_id(display_name, full_name)')
        .in('status', [...ACTIVE_STATUSES])
        .overlaps('during', `[${windowStart},${windowEnd})`),
      supabase
        .from('guide_mru')
        .select('guide_email, confirmed, last_used_at, seed_priority')
        .eq('user_id', user.id)
        .order('confirmed', { ascending: false })
        .order('last_used_at', { ascending: false })
        .order('seed_priority', { ascending: true, nullsFirst: false }),
    ])

  const me = (profile ?? {
    id: user.id, email: user.email ?? '', full_name: user.email ?? '', display_name: null, role: 'student',
  }) as Profile
  const name = me.display_name ?? me.full_name

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <Image src="/brand/wolf-lockup-navy.svg" alt="Alpha High School" width={150} height={72} priority className="mb-4 h-auto w-[150px] dark:hidden" />
          <Image src="/brand/wolf-lockup-white.svg" alt="Alpha High School" width={150} height={72} priority className="mb-4 hidden h-auto w-[150px] dark:block" />
          <h1 className="text-2xl font-bold tracking-tight">Campus Rooms</h1>
          <p className="mt-1 text-muted">
            {name}
            {me.role !== 'student' && (
              <span className="ml-2 rounded-full bg-cyan/15 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-navy dark:text-cyan">
                {me.role}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <SignOutButton />
          <Link href="/people" className="text-sm font-bold text-navy hover:underline dark:text-cyan">
            Find someone →
          </Link>
          <Link href="/bookings" className="text-sm font-bold text-navy hover:underline dark:text-cyan">
            My bookings →
          </Link>
          {me.role !== 'student' && (
            <>
              <Link href="/admin/rooms" className="text-sm font-bold text-navy hover:underline dark:text-cyan">
                Manage rooms →
              </Link>
              <Link href="/admin/guides" className="text-sm font-bold text-navy hover:underline dark:text-cyan">
                Manage guides →
              </Link>
            </>
          )}
        </div>
      </header>

      {roomsErr && (
        <p className="mb-6 rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load rooms: {roomsErr.message}
        </p>
      )}

      <Board
        rooms={(rooms ?? []) as unknown as Room[]}
        initialBookings={(bookings ?? []) as Booking[]}
        profile={me}
        guides={(guides ?? []) as GuideMru[]}
      />

      <p className="mt-10 text-center text-xs text-muted">
        Book what you need · check in within 5 minutes · rooms you don&apos;t use open back up.
      </p>
    </main>
  )
}
