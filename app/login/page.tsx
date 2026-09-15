'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function signIn() {
    setLoading(true)
    setError(null)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        // A hint only — the real restriction is a database trigger (PLAN.md §8).
        queryParams: { hd: 'alpha.school', prompt: 'select_account' },
      },
    })
    if (error) {
      setError(error.message)
      setLoading(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Campus Rooms</h1>
        <p className="text-neutral-600 dark:text-neutral-400">
          Book a pod or conference room, and see where everyone is.
        </p>
      </div>

      <button
        onClick={signIn}
        disabled={loading}
        className="flex items-center justify-center gap-3 rounded-lg border border-neutral-300 bg-white px-4 py-3 font-medium text-neutral-900 transition hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white dark:hover:bg-neutral-800"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
          <path fill="#4285F4" d="M23.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.86c2.26-2.09 3.57-5.17 3.57-8.87Z"/>
          <path fill="#34A853" d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.86-3c-1.08.72-2.45 1.16-4.08 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A12 12 0 0 0 12 24Z"/>
          <path fill="#FBBC05" d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58V6.62H1.29a12 12 0 0 0 0 10.76l3.98-3.09Z"/>
          <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z"/>
        </svg>
        {loading ? 'Redirecting…' : 'Sign in with Google'}
      </button>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <p className="text-sm text-neutral-500">
        Use your @alpha.school account.
      </p>
    </main>
  )
}
