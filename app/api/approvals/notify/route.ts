import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { messageBlocks, postSlackDm, slackConfigured, slackIdForEmail, slackIdForProfile } from '@/lib/slack-server'
import { fmtDay, fmtRange } from '@/lib/time'
import { parseRange } from '@/lib/bookings'

/**
 * POST { bookingId } → DMs the named guide on Slack with Approve / Decline.
 *
 * Called by the booking sheet right after a request over the 1-hour gate is
 * created. The token is minted here, server-side, and never returned to the
 * student (PLAN.md §6.1) — only the guide's DM carries it.
 */
export async function POST(req: Request) {
  const { bookingId } = (await req.json().catch(() => ({}))) as { bookingId?: string }
  if (!bookingId) return NextResponse.json({ error: 'bookingId required' }, { status: 400 })

  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })

  // Through RLS as the caller: they can only see bookings they may see.
  const { data: booking } = await sb
    .from('bookings')
    .select('id, user_id, status, during, purpose, room:rooms(name), student:profiles!user_id(display_name, full_name)')
    .eq('id', bookingId)
    .maybeSingle()
  if (!booking) return NextResponse.json({ error: 'No such booking.' }, { status: 404 })
  if (booking.status !== 'pending_approval') return NextResponse.json({ error: 'That booking is not awaiting approval.' }, { status: 409 })

  const { data: me } = await sb.from('profiles').select('role').eq('id', user.id).single()
  if (booking.user_id !== user.id && me?.role === 'student') {
    return NextResponse.json({ error: 'Not your booking.' }, { status: 403 })
  }

  if (!slackConfigured()) return NextResponse.json({ notified: 'none', error: 'Slack isn’t set up for this campus yet.' }, { status: 503 })

  const admin = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const { data: approval } = await admin
    .from('approvals')
    .select('guide_email, guide_id, sent_at, decision')
    .eq('booking_id', bookingId)
    .maybeSingle()
  if (!approval) return NextResponse.json({ error: 'No approval request on that booking.' }, { status: 404 })
  if (approval.decision) return NextResponse.json({ notified: 'none', error: 'Already decided.' }, { status: 409 })
  // Don't spam a guide if the student taps twice.
  if (approval.sent_at && Date.now() - new Date(approval.sent_at).getTime() < 10 * 60_000) {
    return NextResponse.json({ notified: 'slack', already: true })
  }

  // Who to tell.
  const guideSlackId = approval.guide_id
    ? await slackIdForProfile(admin, approval.guide_id)
    : await slackIdForEmail(approval.guide_email)
  if (!guideSlackId) {
    await admin.from('approvals').update({ notified_via: 'none' }).eq('booking_id', bookingId)
    return NextResponse.json({ notified: 'none', error: `${approval.guide_email} isn’t on Slack — ask them directly.` }, { status: 404 })
  }

  // Mint the single-use token (service role only) and build the links.
  const { data: token, error: mintErr } = await admin.rpc('mint_approval_token', { p_booking_id: bookingId })
  if (mintErr || !token) return NextResponse.json({ error: mintErr?.message ?? 'Could not create approval link.' }, { status: 500 })
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin
  const approveUrl = `${site}/approve/${token}?d=approved`
  const declineUrl = `${site}/approve/${token}?d=declined`

  const { start, end } = parseRange(booking.during as string)
  const room = (booking.room as unknown as { name: string } | null)?.name ?? 'a room'
  const student = (booking.student as unknown as { display_name: string | null; full_name: string } | null)
  const who = student?.display_name ?? student?.full_name ?? 'A student'
  const when = `${fmtDay(start)}, ${fmtRange(start, end)}`
  const text =
    `*${who}* wants *${room}* for ${when}` +
    (booking.purpose ? `\n_${booking.purpose}_` : '') +
    `\nThat's over the 1-hour limit, so it needs your OK. The room is held until you answer or until it would start.`

  const sent = await postSlackDm(guideSlackId, `${who} wants ${room} for ${when} — approve or decline`, messageBlocks(text, [
    { label: '✅ Approve', url: approveUrl, style: 'primary' },
    { label: '✋ Decline', url: declineUrl, style: 'danger' },
  ]))

  await admin.from('approvals').update({ notified_via: sent.ok ? 'slack' : 'none' }).eq('booking_id', bookingId)
  if (!sent.ok) return NextResponse.json({ notified: 'none', error: `Slack refused the message (${sent.error}).` }, { status: 502 })

  return NextResponse.json({ notified: 'slack' })
}
