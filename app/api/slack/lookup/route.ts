import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

/**
 * POST { userId } → { slackUserId }
 *
 * Resolves a campus user to their Slack member id via users.lookupByEmail,
 * cached on profiles for 7 days. Runs server-side because it needs the Slack
 * bot token and the Supabase service role (the caller may only update their
 * own profile row; the cache is everyone's).
 */
const CACHE_DAYS = 7

export async function POST(req: Request) {
  const { userId } = (await req.json().catch(() => ({}))) as { userId?: string }
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 })

  // Must be a signed-in campus user.
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })

  const token = process.env.SLACK_BOT_TOKEN
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!token || !serviceKey) {
    return NextResponse.json({ error: 'Slack isn’t set up for this campus yet.' }, { status: 503 })
  }

  // Read through RLS as the caller: same visibility rules as the People page.
  const { data: target } = await sb
    .from('profiles')
    .select('id, email, visible, slack_user_id, slack_checked_at')
    .eq('id', userId)
    .maybeSingle()
  if (!target || target.visible === false) {
    return NextResponse.json({ error: 'That person isn’t listed.' }, { status: 404 })
  }

  const fresh =
    target.slack_checked_at &&
    Date.now() - new Date(target.slack_checked_at).getTime() < CACHE_DAYS * 86400_000
  if (fresh && target.slack_user_id) {
    return NextResponse.json({ slackUserId: target.slack_user_id })
  }

  // Ask Slack.
  const url = new URL('https://slack.com/api/users.lookupByEmail')
  url.searchParams.set('email', target.email)
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
  const body = (await res.json()) as { ok: boolean; error?: string; user?: { id: string; deleted?: boolean } }

  const slackUserId = body.ok && body.user && !body.user.deleted ? body.user.id : null

  // Cache the answer (including "not found") with the service role.
  const admin = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    auth: { persistSession: false },
  })
  await admin
    .from('profiles')
    .update({ slack_user_id: slackUserId, slack_checked_at: new Date().toISOString() })
    .eq('id', target.id)

  if (!slackUserId) {
    const why = body.error === 'users_not_found'
      ? 'They don’t have a Slack account under that email.'
      : body.error === 'missing_scope' || body.error === 'invalid_auth'
        ? 'The Slack app needs the users:read.email permission.'
        : 'Could not find them on Slack.'
    return NextResponse.json({ error: why }, { status: 404 })
  }

  return NextResponse.json({ slackUserId })
}
