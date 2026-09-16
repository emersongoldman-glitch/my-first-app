import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Server-side Slack helpers. Everything here needs the bot token and runs only
 * in route handlers / server components — never in the browser.
 */

const CACHE_DAYS = 7

type SlackUser = { id: string; deleted?: boolean }

export function slackConfigured(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

async function slackApi<T>(method: string, params: Record<string, string> | Record<string, unknown>, post = false): Promise<T & { ok: boolean; error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN!
  const res = post
    ? await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(params),
        cache: 'no-store',
      })
    : await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params as Record<string, string>)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
  return (await res.json()) as T & { ok: boolean; error?: string }
}

/** Slack member id for an email, or null if they are not in the workspace. */
export async function slackIdForEmail(email: string): Promise<string | null> {
  const body = await slackApi<{ user?: SlackUser }>('users.lookupByEmail', { email })
  return body.ok && body.user && !body.user.deleted ? body.user.id : null
}

/**
 * Slack member id for a Campus Rooms profile, using the 7-day cache on
 * profiles and refreshing it through the service role when stale.
 */
export async function slackIdForProfile(admin: SupabaseClient, profileId: string): Promise<string | null> {
  const { data: p } = await admin
    .from('profiles')
    .select('email, slack_user_id, slack_checked_at')
    .eq('id', profileId)
    .maybeSingle()
  if (!p) return null

  const fresh = p.slack_checked_at && Date.now() - new Date(p.slack_checked_at).getTime() < CACHE_DAYS * 86_400_000
  if (fresh) return p.slack_user_id ?? null

  const id = await slackIdForEmail(p.email)
  await admin.from('profiles').update({ slack_user_id: id, slack_checked_at: new Date().toISOString() }).eq('id', profileId)
  return id
}

/** Send a DM. `channel` may be a user id — Slack opens the DM. */
export async function postSlackDm(
  userId: string,
  text: string,
  blocks?: unknown[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  const body = await slackApi<Record<string, unknown>>(
    'chat.postMessage',
    { channel: userId, text, ...(blocks ? { blocks } : {}), unfurl_links: false, unfurl_media: false },
    true
  )
  return body.ok ? { ok: true } : { ok: false, error: body.error ?? 'chat.postMessage failed' }
}

// ---------------------------------------------------------------------------
// Interactive buttons (block_actions). Slack POSTs to /api/slack/interact when
// one is pressed, signed with the app's Signing Secret. Available only when
// SLACK_SIGNING_SECRET is set; otherwise messages fall back to link buttons.
// ---------------------------------------------------------------------------
export function interactivityConfigured(): boolean {
  return Boolean(process.env.SLACK_SIGNING_SECRET)
}

/**
 * Verify a request really came from Slack: HMAC-SHA256 of
 * `v0:<timestamp>:<raw body>` with the Signing Secret, compared in constant
 * time, and no older than five minutes (replay guard).
 */
export async function verifySlackSignature(rawBody: string, headers: Headers): Promise<boolean> {
  const secret = process.env.SLACK_SIGNING_SECRET
  const ts = headers.get('x-slack-request-timestamp')
  const sig = headers.get('x-slack-signature')
  if (!secret || !ts || !sig) return false
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false

  const { createHmac, timingSafeEqual } = await import('node:crypto')
  const expected = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${rawBody}`).digest('hex')
  const a = Buffer.from(expected), b = Buffer.from(sig)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Replace the original message after a button press (via response_url). */
export async function respondToSlack(responseUrl: string, text: string, blocks?: unknown[]): Promise<void> {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ replace_original: true, text, ...(blocks ? { blocks } : {}) }),
  }).catch(() => {})
}

/** Block Kit: paragraph + interactive Approve/Decline buttons + a fallback link. */
export function actionBlocks(text: string, token: string, fallbackUrl: string) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      block_id: 'approval',
      elements: [
        { type: 'button', action_id: 'approve', value: token, style: 'primary', text: { type: 'plain_text', text: '✅ Approve', emoji: true } },
        { type: 'button', action_id: 'decline', value: token, style: 'danger', text: { type: 'plain_text', text: '✋ Decline', emoji: true } },
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Buttons not working? <${fallbackUrl}|Open the request>` }] },
  ]
}

/**
 * Tell the student how their request went. Shared by the button handler and
 * the confirm-page route so both paths behave the same.
 */
export async function notifyStudentDecision(
  admin: SupabaseClient,
  bookingId: string,
  decision: 'approved' | 'declined',
  reason?: string | null
): Promise<void> {
  if (!slackConfigured()) return
  try {
    const { data: b } = await admin
      .from('bookings')
      .select('user_id, during, room:rooms(name)')
      .eq('id', bookingId)
      .single()
    if (!b) return
    const studentSlack = await slackIdForProfile(admin, b.user_id)
    if (!studentSlack) return
    const { parseRange } = await import('@/lib/bookings')
    const { fmtRange } = await import('@/lib/time')
    const { start, end } = parseRange(b.during as string)
    const room = (b.room as unknown as { name: string } | null)?.name ?? 'your room'
    const why = reason?.trim() ? ` "${reason.trim()}"` : ''
    const msg = decision === 'approved'
      ? `✅ Approved — *${room}* is yours, ${fmtRange(start, end)}. Check in within 5 minutes of the start.`
      : `✋ Your request for *${room}* (${fmtRange(start, end)}) was declined.${why} You can still book up to an hour without approval.`
    await postSlackDm(studentSlack, msg.replace(/\*/g, ''), [{ type: 'section', text: { type: 'mrkdwn', text: msg } }])
  } catch (e) {
    console.error('student notify failed', e)
  }
}

/** Block Kit: a paragraph plus link buttons. */
export function messageBlocks(text: string, buttons: { label: string; url: string; style?: 'primary' | 'danger' }[]) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: buttons.map((b) => ({
        type: 'button',
        text: { type: 'plain_text', text: b.label, emoji: true },
        url: b.url,
        ...(b.style ? { style: b.style } : {}),
      })),
    },
  ]
}
