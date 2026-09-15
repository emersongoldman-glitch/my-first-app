'use client'

import { useState } from 'react'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'

const CONFIGURED = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

export default function LoginPage() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)

  // Email sign-in needs no Google Cloud setup. The @alpha.school restriction
  // still holds either way — it is a trigger on auth.users, not an OAuth hint.
  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!email.trim().toLowerCase().endsWith('@alpha.school')) {
      setError('Use your @alpha.school email address.')
      return
    }

    setLoading(true)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    })
    setLoading(false)
    if (error) setError(error.message)
    else setSent(true)
  }

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
    <main className="alpha-gradient flex min-h-dvh flex-col justify-center px-6 py-12">
      <div className="mx-auto w-full max-w-sm">
        {/* Lockup on the navy gradient: white colorway, well above the 125px minimum. */}
        <Image
          src="/brand/wolf-lockup-white.svg"
          alt="Alpha High School"
          width={200}
          height={96}
          priority
          className="mb-10 h-auto w-[200px]"
        />

        <h1 className="text-3xl font-bold tracking-tight text-white">Campus Rooms</h1>
        <p className="mt-2 text-white/75">
          Book a pod or conference room, and see where everyone is.
        </p>

        <button
          onClick={signIn}
          disabled={loading || !CONFIGURED}
          className="mt-8 flex w-full items-center justify-center gap-3 rounded-xl bg-white px-4 py-3.5 font-bold text-[#00031e] shadow-lg transition hover:bg-white/90 disabled:opacity-60"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
            <path fill="#4285F4" d="M23.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.86c2.26-2.09 3.57-5.17 3.57-8.87Z"/>
            <path fill="#34A853" d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.86-3c-1.08.72-2.45 1.16-4.08 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A12 12 0 0 0 12 24Z"/>
            <path fill="#FBBC05" d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58V6.62H1.29a12 12 0 0 0 0 10.76l3.98-3.09Z"/>
            <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z"/>
          </svg>
          {loading ? 'Redirecting…' : 'Sign in with Google'}
        </button>

        <div className="my-6 flex items-center gap-3 text-xs font-bold uppercase tracking-wider text-white/40">
          <span className="h-px flex-1 bg-white/20" />
          or
          <span className="h-px flex-1 bg-white/20" />
        </div>

        {sent ? (
          <div className="rounded-xl bg-white/10 p-4 text-sm text-white">
            <p className="font-bold">Check your email</p>
            <p className="mt-1 text-white/75">
              We sent a sign-in link to {email}. Open it on this device.
            </p>
          </div>
        ) : (
          <form onSubmit={sendMagicLink} className="space-y-3">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@alpha.school"
              autoComplete="email"
              className="w-full rounded-xl border border-white/25 bg-white/10 px-4 py-3 text-white placeholder:text-white/40 focus:border-white/60 focus:outline-none"
            />
            <button
              type="submit"
              disabled={loading || !CONFIGURED}
              className="w-full rounded-xl border border-white/30 px-4 py-3 font-bold text-white transition hover:bg-white/10 disabled:opacity-60"
            >
              {loading ? 'Sending…' : 'Email me a sign-in link'}
            </button>
          </form>
        )}

        {error && (
          <p className="mt-4 rounded-lg bg-black/25 p-3 text-sm text-white">{error}</p>
        )}

        {CONFIGURED ? (
          <p className="mt-6 text-sm text-white/60">Use your @alpha.school account.</p>
        ) : (
          <p className="mt-6 rounded-lg bg-black/25 p-3 text-sm text-white/80">
            Not connected to Supabase yet. Copy{' '}
            <code className="font-mono">.env.example</code> to{' '}
            <code className="font-mono">.env.local</code> and fill in your project URL
            and anon key.
          </p>
        )}
      </div>
    </main>
  )
}
