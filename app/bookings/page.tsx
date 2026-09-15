import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import type { Booking, Profile } from '@/lib/bookings'
import MyBookings, { type MyBooking } from './my-bookings'

export const dynamic = 'force-dynamic'

export default async function BookingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data: profile }, { data: bookings }] = await Promise.all([
    supabase.from('profiles').select('id, email, full_name, display_name, role').eq('id', user.id).single(),
    supabase
      .from('bookings')
      .select('*, room:rooms(name, zones(name)), approval:approvals(guide_email, decision, reason)')
      .eq('user_id', user.id)
      .order('during', { ascending: false })
      .limit(60),
  ])

  return (
    <main className="mx-auto max-w-2xl px-6 py-8">
      <header className="mb-8">
        <Link href="/" className="text-sm font-bold text-navy hover:underline dark:text-cyan">← Board</Link>
        <h1 className="mt-3 text-2xl font-bold tracking-tight">My bookings</h1>
      </header>
      <MyBookings
        initial={(bookings ?? []) as unknown as MyBooking[]}
        profile={(profile ?? { id: user.id, role: 'student' }) as Profile}
      />
    </main>
  )
}

export type { Booking }
