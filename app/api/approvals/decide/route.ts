import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { notifyStudentDecision } from '@/lib/slack-server'

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

  // Tell the student, best effort (shared with the Slack button handler).
  if (!result.already_decided) await notifyStudentDecision(admin, result.booking_id, decision, reason)

  return NextResponse.json(result)
}
