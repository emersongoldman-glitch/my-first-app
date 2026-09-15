import Image from 'next/image'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import RolePicker from './role-picker'

export const dynamic = 'force-dynamic'

export default async function WelcomePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: me } = await supabase
    .from('profiles')
    .select('email, display_name, full_name, role, role_confirmed')
    .eq('id', user.id)
    .single()

  if (me?.role_confirmed) redirect('/')

  return (
    <main className="alpha-gradient flex min-h-dvh flex-col justify-center px-6 py-12">
      <div className="mx-auto w-full max-w-sm">
        <Image src="/brand/wolf-lockup-white.svg" alt="Alpha High School" width={200} height={96} priority className="mb-10 h-auto w-[200px]" />
        <h1 className="text-3xl font-bold tracking-tight text-white">
          Hi, {me?.display_name ?? me?.full_name?.split(' ')[0] ?? 'there'}.
        </h1>
        <p className="mt-2 text-white/75">One quick thing before the board — are you a guide or a student?</p>
        <RolePicker email={me?.email ?? user.email ?? ''} />
      </div>
    </main>
  )
}
