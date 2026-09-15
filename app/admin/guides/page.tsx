import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import GuideList, { type AllowlistRow } from './guide-list'

export const dynamic = 'force-dynamic'

export default async function ManageGuidesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: me } = await supabase.from('profiles').select('email, role').eq('id', user.id).single()
  if (!me || me.role === 'student') redirect('/')

  const [{ data: rows }, { data: staff }] = await Promise.all([
    supabase
      .from('staff_allowlist')
      .select('email, added_at, adder:profiles!added_by(display_name, full_name)')
      .order('email'),
    // Who has actually confirmed as a guide, so the list shows "signed in ✓".
    supabase.from('profiles').select('email, role, role_confirmed').in('role', ['guide', 'admin']),
  ])

  const confirmed = new Set((staff ?? []).map((p) => p.email.toLowerCase()))

  return (
    <main className="mx-auto max-w-2xl px-6 py-8">
      <header className="mb-6">
        <Link href="/" className="text-sm font-bold text-navy hover:underline dark:text-cyan">← Board</Link>
        <h1 className="mt-3 text-2xl font-bold tracking-tight">Guides</h1>
        <p className="mt-1 text-muted">
          Emails on this list can confirm themselves as guides at sign-in. Anyone else who picks
          &ldquo;guide&rdquo; is refused and can continue as a student.
        </p>
      </header>
      <GuideList
        initial={((rows ?? []) as unknown as AllowlistRow[]).map((r) => ({ ...r, confirmed: confirmed.has(r.email) }))}
        myEmail={me.email}
      />
    </main>
  )
}
