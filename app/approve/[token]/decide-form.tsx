'use client'

import { useState } from 'react'

type Decision = 'approved' | 'declined'

export default function DecideForm({ token, preselect }: { token: string; preselect: Decision | null }) {
  const [choice, setChoice] = useState<Decision | null>(preselect)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<null | { decision: string | null; already: boolean }>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit(decision: Decision) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/approvals/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, decision, reason: decision === 'declined' ? reason : undefined }),
      })
      const body = (await res.json()) as { decision?: string | null; already_decided?: boolean; error?: string }
      if (!res.ok) { setError(body.error ?? 'That didn’t work.'); return }
      setDone({ decision: body.decision ?? decision, already: Boolean(body.already_decided) })
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    const approved = done.decision === 'approved'
    return (
      <div className={`mt-6 rounded-xl p-5 ${approved ? 'bg-green-500/20' : 'bg-white/10'} text-white`}>
        <p className="text-lg font-bold">{done.already ? 'Already answered' : approved ? 'Approved ✅' : 'Declined'}</p>
        <p className="mt-1 text-sm text-white/75">
          {done.already
            ? `Someone got there first — this request was ${done.decision}.`
            : approved
              ? 'The student has been told on Slack. The room stays held for them.'
              : 'The room is open again and the student has been told on Slack.'}
        </p>
        <p className="mt-3 text-xs text-white/50">You can close this tab.</p>
      </div>
    )
  }

  return (
    <div className="mt-6 space-y-3">
      {choice !== 'declined' && (
        <button
          onClick={() => submit('approved')}
          disabled={busy}
          className="w-full rounded-xl bg-white px-4 py-4 text-left font-bold text-[#00031e] shadow-lg transition hover:bg-white/90 disabled:opacity-60"
        >
          {busy ? 'Approving…' : '✅ Approve'}
          <span className="block text-sm font-normal text-[#00031e]/70">They keep the room for the whole time.</span>
        </button>
      )}

      {choice === 'declined' ? (
        <div className="rounded-xl bg-white p-4 shadow-lg">
          <p className="font-bold text-[#00031e]">Decline this request?</p>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Optional reason the student will see"
            maxLength={140}
            className="mt-3 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-[#00031e] focus:border-[#002970] focus:outline-none"
          />
          <div className="mt-3 flex gap-2">
            <button onClick={() => submit('declined')} disabled={busy}
              className="flex-1 rounded-lg bg-[#002970] px-4 py-2.5 font-bold text-white disabled:opacity-50">
              {busy ? 'Declining…' : 'Decline'}
            </button>
            <button onClick={() => setChoice(null)} disabled={busy} className="rounded-lg px-3 py-2.5 text-sm font-bold text-[#00031e]/70">
              Back
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setChoice('declined')}
          disabled={busy}
          className="w-full rounded-xl border border-white/30 px-4 py-4 text-left font-bold text-white transition hover:bg-white/10 disabled:opacity-60"
        >
          ✋ Decline
          <span className="block text-sm font-normal text-white/70">The room opens up again right away.</span>
        </button>
      )}

      {error && <p className="rounded-lg bg-black/25 p-3 text-sm text-white">{error}</p>}
    </div>
  )
}
