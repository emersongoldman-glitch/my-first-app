'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function RolePicker({ email }: { email: string }) {
  const router = useRouter()
  const [choice, setChoice] = useState<'guide' | 'student' | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm(role: 'guide' | 'student') {
    setBusy(true)
    setError(null)
    const sb = createClient()
    const { error } = await sb.rpc('confirm_role', {
      p_choice: role,
      p_email: role === 'guide' ? typed.trim() : null,
    })
    setBusy(false)
    if (error) { setError(error.message); return }
    router.push('/')
    router.refresh()
  }

  const emailMatches = typed.trim().toLowerCase() === email.toLowerCase()

  return (
    <div className="mt-8 space-y-3">
      {choice !== 'guide' && (
        <button
          onClick={() => setChoice('guide')}
          disabled={busy}
          className="w-full rounded-xl bg-white px-4 py-4 text-left shadow-lg transition hover:bg-white/90 disabled:opacity-60"
        >
          <span className="block font-bold text-[#00031e]">I&apos;m a guide</span>
          <span className="block text-sm text-[#00031e]/70">Approve long bookings, manage rooms, see everything.</span>
        </button>
      )}

      {choice === 'guide' && (
        <div className="rounded-xl bg-white p-4 shadow-lg">
          <p className="font-bold text-[#00031e]">Confirm your school email</p>
          <p className="mt-1 text-sm text-[#00031e]/70">
            Type the email you signed in with. It has to be on your campus&apos;s guide list.
          </p>
          <input
            type="email"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && emailMatches && confirm('guide')}
            placeholder={email}
            autoFocus
            className="mt-3 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-[#00031e] focus:border-[#002970] focus:outline-none"
          />
          {typed && !emailMatches && (
            <p className="mt-2 text-xs text-amber-700">That doesn&apos;t match the account you signed in with.</p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => confirm('guide')}
              disabled={busy || !emailMatches}
              className="flex-1 rounded-lg bg-[#002970] px-4 py-2.5 font-bold text-white disabled:opacity-40"
            >
              {busy ? 'Checking…' : 'Confirm I’m a guide'}
            </button>
            <button onClick={() => { setChoice(null); setError(null) }} className="rounded-lg px-3 py-2.5 text-sm font-bold text-[#00031e]/70">
              Back
            </button>
          </div>
        </div>
      )}

      <button
        onClick={() => confirm('student')}
        disabled={busy}
        className="w-full rounded-xl border border-white/30 px-4 py-4 text-left transition hover:bg-white/10 disabled:opacity-60"
      >
        <span className="block font-bold text-white">I&apos;m a student</span>
        <span className="block text-sm text-white/70">Book pods, find people, check in.</span>
      </button>

      {error && <p className="rounded-lg bg-black/25 p-3 text-sm text-white">{error}</p>}

      <p className="pt-2 text-center text-xs text-white/50">
        Picked wrong? A guide can fix it later.
      </p>
    </div>
  )
}
