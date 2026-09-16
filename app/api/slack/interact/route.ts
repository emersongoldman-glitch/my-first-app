import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { notifyStudentDecision, respondToSlack, verifySlackSignature } from '@/lib/slack-server'

/**
 * Slack Interactivity endpoint. When a guide presses Approve or Decline in
 * the DM, Slack POSTs here (form-encoded, `payload=<json>`), signed with the
 * app's Signing Secret. The decision is applied and the message is replaced
 * with the outcome — no browser, no page.
 *
 * Only signed requests are accepted, so nobody can forge a button press.
 */
type BlockActions = {
  type: string
  response_url?: string
  user?: { id: string; username?: string; name?: string }
  actions?: { action_id: string; value: string }[]
}

export async function POST(req: Request) {
  const raw = await req.text()
  if (!(await verifySlackSignature(raw, req.headers))) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 })
  }

  const params = new URLSearchParams(raw)
  const payload = JSON.parse(params.get('payload') ?? '{}') as BlockActions
  if (payload.type !== 'block_actions' || !payload.actions?.length) {
    return new NextResponse(null, { status: 200 })  // url_verification etc. — nothing to do
  }

  const action = payload.actions[0]
  const decision = action.action_id === 'approve' ? 'approved' : action.action_id === 'decline' ? 'declined' : null
  const token = action.value
  if (!decision || !/^[0-9a-f]{64}$/.test(token ?? '')) return new NextResponse(null, { status: 200 })

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) return new NextResponse(null, { status: 200 })
  const admin = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, { auth: { persistSession: false } })

  const { data, error } = await admin.rpc('decide_by_token', { p_token: token, p_decision: decision, p_reason: null })
  const who = payload.user?.name || payload.user?.username || 'you'

  if (error) {
    const msg = /expired/i.test(error.message)
      ? '⌛ This request expired — the booking start time passed before anyone answered, so the room was released.'
      : /not valid/i.test(error.message)
        ? 'This request is no longer valid.'
        : `Couldn't record that: ${error.message}`
    if (payload.response_url) await respondToSlack(payload.response_url, msg, [{ type: 'section', text: { type: 'mrkdwn', text: msg } }])
    return new NextResponse(null, { status: 200 })
  }

  const result = data as { booking_id: string; decision: string | null; already_decided: boolean }
  let text: string
  if (result.already_decided) {
    text = `Already answered — this request was *${result.decision}*.`
  } else {
    text = decision === 'approved'
      ? `✅ *Approved* by ${who}. The student has been told and keeps the room.`
      : `✋ *Declined* by ${who}. The room is open again and the student has been told.`
    await notifyStudentDecision(admin, result.booking_id, decision)
  }

  if (payload.response_url) {
    await respondToSlack(payload.response_url, text.replace(/\*/g, ''), [{ type: 'section', text: { type: 'mrkdwn', text } }])
  }
  return new NextResponse(null, { status: 200 })
}
