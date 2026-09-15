'use client'

import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function SignOutButton() {
  const router = useRouter()

  async function signOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <button
      onClick={signOut}
      className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm font-bold transition hover:bg-surface"
    >
      Sign out
    </button>
  )
}
