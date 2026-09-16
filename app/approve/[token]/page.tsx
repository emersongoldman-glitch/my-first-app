import Image from 'next/image'
import { createHash } from 'node:crypto'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { parseRange } from '@/lib/bookings'
import { fmtDay, fmtRange, fmtDuration, minutesBetween } from '@/lib/time'
import DecideForm from './decide-form'

export const dynamic = 'force-dynamic'

/**
 * The page a guide lands on from the Slack DM. No sign-in: the token in the
 * URL is the credential (PLAN.md §6.1). Nothing is decided by loading this
 * page — only by the button, which POSTs.
 */
export default async function ApprovePage({
  params, searchParams,
}: { params: Promise<{ token: string }>; searchParams: Promise<{ d?: string }> }) {
  const { token } = await params
  const { d } = await searchParams
  const preselect = d === 'approved' || d === 'declined' ? d : null

  let state: 'ok' | 'invalid' | 'expired' | 'decided' | 'unconfigured' = 'ok'
  let summary: null | { who: string; room: string; when: string; length: string; purpose: string | null; guide: string; decision: string | null } = null

  if (!/^[0-9a-f]{64}$/.test(token)) state = 'invalid'
  else if (!process.env.SUPABASE_SERVICE_ROLE_KEY) state = 'unconfigured'
  else {
    const admin = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const hash = createHash('sha256').update(token).digest('hex')
    const { data: a } = await admin
      .from('approvals')
      .select('guide_email, decision, token_expires, booking:bookings(during, purpose, status, room:rooms(name), student:profiles!user_id(display_name, full_name))')
      .eq('token_hash', hash)
      .maybeSingle()

    if (!a) state = 'invalid'
    else {
      const b = a.booking as unknown as {
        during: string; purpose: string | null; status: string
        room: { name: string } | null
        student: { display_name: string | null; full_name: string } | null
      } | null
      if (a.decision || (b && b.status !== 'pending_approval')) state = 'decided'
      else if (a.token_expires && isPast(a.token_expires)) state = 'expired'
      if (b) {
        const { start, end } = parseRange(b.during)
        summary = {
          who: b.student?.display_name ?? b.student?.full_name ?? 'A student',
          room: b.room?.name ?? 'a room',
          when: `${fmtDay(start)} · ${fmtRange(start, end)}`,
          length: fmtDuration(minutesBetween(start, end)),
          purpose: b.purpose,
          guide: a.guide_email,
          decision: a.decision,
        }
      }
    }
  }

  return (
    <main className="alpha-gradient flex min-h-dvh flex-col justify-center px-6 py-12">
      <div className="mx-auto w-full max-w-sm">
        <Image src="/brand/wolf-lockup-white.svg" alt="Alpha High School" width={180} height={86} priority className="mb-8 h-auto w-[180px]" />

        {state === 'ok' && summary && (
          <>
            <p className="text-xs font-bold uppercase tracking-wider text-white/60">Room request</p>
            <h1 className="mt-1 text-2xl font-bold text-white">
              {summary.who} wants {summary.room}
            </h1>
            <p className="mt-2 text-white/80">{summary.when} · {summary.length}</p>
            {summary.purpose && <p className="mt-1 italic text-white/70">“{summary.purpose}”</p>}
            <p className="mt-4 text-sm text-white/60">
              Over the 1-hour limit, so it needs a guide. The room is held until you answer or until it would start.
            </p>
            <DecideForm token={token} preselect={preselect} />
          </>
        )}

        {state === 'decided' && (
          <Notice title="Already answered" body={summary?.decision ? `This request was ${summary.decision}. Nothing more to do.` : 'This request is no longer waiting on approval.'} />
        )}
        {state === 'expired' && (
          <Notice title="This link has expired" body="The booking's start time passed before anyone answered, so the room was released." />
        )}
        {state === 'invalid' && (
          <Notice title="That link isn’t valid" body="It may have been used already, or copied incompletely. Ask the student to request again." />
        )}
        {state === 'unconfigured' && (
          <Notice title="Not set up" body="Approvals aren’t configured on this server yet." />
        )}
      </div>
    </main>
  )
}

/** Kept out of the component so render stays pure per React's rules. */
function isPast(iso: string): boolean {
  return new Date(iso).getTime() < Date.now()
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl bg-white/10 p-5 text-white">
      <p className="font-bold">{title}</p>
      <p className="mt-1 text-sm text-white/75">{body}</p>
    </div>
  )
}
