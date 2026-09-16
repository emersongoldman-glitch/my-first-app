import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { postSlackDm, slackConfigured, slackIdForProfile } from '@/lib/slack-server'
import { parseRange } from '@/lib/bookings'
import { fmtRange } from '@/lib/time'

/**
 * POST { token, decision, reason? } → applies a guide's decision.
 *
 * Deliberately POST-only: the links in the Slack DM open a confirm page, and
 * only the button there calls this. A GET that decided on click would be
 * triggered by Slack's own link preview fetcher.
 */
export async function POST(req: Request) {
  const { token, decision, reason } = (await req.json().catch(() => ({}))) as {
    token?: string; decision?: 'approved' | 'declined'; reason?: string
  }
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return NextResponse.json({ error: 'Invalid link.' }, { status: 400 })
  if (decision !== 'approved' && decision !== 'declined') return NextResponse.json({ error: 'Decision must be approve or decline.' }, { status: 400 })
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Not configured.' }, { status: 503 })

  const admin = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

  const { data, error } = await admin.rpc('decide_by_token', {
    p_token: token,
    p_decision: decision,
    p_reason: reason?.trim() || null,
  })
  if (error) {
    const status = /not valid|expired/i.test(error.message) ? 410 : 500
    return NextResponse.json({ error: error.message }, { status })
  }
  const result = data as { booking_id: string; decision: string | null; already_decided: boolean; booking_status?: string }

  // Tell the student, best effort.
  if (slackConfigured() && !result.already_decided) {
    try {
      const { data: b } = await admin
        .from('bookings')
        .select('user_id, during, room:rooms(name)')
        .eq('id', result.booking_id)
        .single()
      if (b) {
        const studentSlack = await slackIdForProfile(admin, b.user_id)
        if (studentSlack) {
          const { start, end } = parseRange(b.during as string)
          const room = (b.room as unknown as { name: string } | null)?.name ?? 'your room'
          const msg = decision === 'approved'
            ? `✅ Approved — *${room}* is yours, ${fmtRange(start, end)}. Check in within 5 minutes of the start.`
            : `✋ Your request for *${room}* (${fmtRange(start, end)}) was declined.${reason?.trim() ? ` "${reason.trim()}"` : ''} You can still book up to an hour without approval.`
          await postSlackDm(studentSlack, msg.replace(/\*/g, ''), [{ type: 'section', text: { type: 'mrkdwn', text: msg } }])
        }
      }
    } catch (e) {
      console.error('student notify failed', e)
    }
  }

  return NextResponse.json(result)
}
