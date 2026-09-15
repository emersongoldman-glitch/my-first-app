'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export type AllowlistRow = {
  email: string
  added_at: string
  adder: { display_name: string | null; full_name: string } | null
  confirmed?: boolean
}

export default function GuideList({ initial, myEmail }: { initial: AllowlistRow[]; myEmail: string }) {
  const [rows, setRows] = useState(initial)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const say = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3500) }

  async function refetch() {
    const sb = createClient()
    const [{ data: list }, { data: staff }] = await Promise.all([
      sb.from('staff_allowlist').select('email, added_at, adder:profiles!added_by(display_name, full_name)').order('email'),
      sb.from('profiles').select('email').in('role', ['guide', 'admin']),
    ])
    const confirmed = new Set((staff ?? []).map((p) => p.email.toLowerCase()))
    if (list) setRows((list as unknown as AllowlistRow[]).map((r) => ({ ...r, confirmed: confirmed.has(r.email) })))
  }

  async function add() {
    const e = email.trim().toLowerCase()
    if (!e.includes('@')) return
    setBusy(true)
    const sb = createClient()
    const { data: { user } } = await sb.auth.getUser()
    const { error } = await sb.from('staff_allowlist').insert({ email: e, added_by: user?.id ?? null })
    setBusy(false)
    if (error) { say(error.code === '23505' ? `${e} is already on the list.` : error.message); return }
    setEmail('')
    say(`${e} can now confirm as a guide.`)
    await refetch()
  }

  async function remove(e: string) {
    if (e === myEmail.toLowerCase()) { say("You can't remove yourself."); return }
    if (!confirm(`Remove ${e} from the guide list?\n\nIf they've already confirmed as a guide, they keep that role until an admin changes it — this only stops new confirmations.`)) return
    const { error } = await createClient().from('staff_allowlist').delete().eq('email', e)
    if (error) { say(error.message); return }
    say(`${e} removed.`)
    await refetch()
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="new.guide@alpha.school"
          className="flex-1 rounded-xl border border-border bg-surface px-4 py-2.5"
        />
        <button onClick={add} disabled={busy || !email.includes('@')} className="rounded-xl bg-navy px-4 py-2.5 font-bold text-white disabled:opacity-50">
          Add
        </button>
      </div>

      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
        {rows.map((r) => (
          <li key={r.email} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate font-bold">
                {r.email}
                {r.email === myEmail.toLowerCase() && <span className="ml-1 font-normal text-muted">(you)</span>}
              </p>
              <p className="text-xs text-muted">
                {r.confirmed ? 'Confirmed as a guide ✓' : 'Not signed in yet'}
                {r.adder && <> · added by {r.adder.display_name ?? r.adder.full_name}</>}
              </p>
            </div>
            <button onClick={() => remove(r.email)} className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-background hover:text-red-600" aria-label={`Remove ${r.email}`}>
              ✕
            </button>
          </li>
        ))}
        {rows.length === 0 && <li className="p-6 text-center text-sm text-muted">No guides yet. Add the first email above.</li>}
      </ul>

      <p className="text-xs text-muted">
        Only guides and admins can see or edit this list. Everyone on it still has to sign in with a school Google account.
      </p>

      {toast && (
        <div className="fixed inset-x-4 bottom-6 z-40 mx-auto max-w-md rounded-xl bg-foreground px-4 py-3 text-center text-sm font-medium text-background shadow-xl">{toast}</div>
      )}
    </div>
  )
}
