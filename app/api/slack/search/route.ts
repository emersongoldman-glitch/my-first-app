import { NextResponse } from 'next/server'
import { createClient as createServiceClient, type SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/slack/search?q=name → { people: [{ slackUserId, name, title, avatar, profileId }] }
 *
 * Searches the campus Slack directory, so People can find anyone in the
 * workspace — not only people who have signed into this app. The directory
 * is cached in slack_directory and refreshed from users.list when stale.
 */
const STALE_HOURS = 6
const PAGE = 500

type SlackMember = {
  id: string
  deleted?: boolean
  is_bot?: boolean
  is_app_user?: boolean
  real_name?: string
  profile?: { real_name?: string; display_name?: string; title?: string; image_48?: string; email?: string }
}

export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim()
  if (q.length < 2) return NextResponse.json({ people: [] })

  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })

  const token = process.env.SLACK_BOT_TOKEN
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!token || !serviceKey) return NextResponse.json({ people: [] })

  const admin = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, { auth: { persistSession: false } })

  // Refresh the cache if it is empty or old. Awaited so the first search on a
  // fresh install still returns results; later searches hit the cache.
  const { data: newest } = await admin
    .from('slack_directory').select('updated_at').order('updated_at', { ascending: false }).limit(1).maybeSingle()
  const ageHours = newest ? (Date.now() - new Date(newest.updated_at).getTime()) / 3_600_000 : Infinity
  if (ageHours > STALE_HOURS) {
    try { await syncDirectory(admin, token) } catch (e) { console.error('slack sync failed', e) }
  }

  // Read through RLS as the caller.
  const like = `%${q.replace(/[%_]/g, '')}%`
  const { data } = await sb
    .from('slack_directory')
    .select('slack_user_id, real_name, display_name, title, avatar_url, profile_id')
    .or(`real_name.ilike.${like},display_name.ilike.${like}`)
    .order('real_name')
    .limit(20)

  return NextResponse.json({
    people: (data ?? []).map((r) => ({
      slackUserId: r.slack_user_id,
      name: r.display_name?.trim() || r.real_name,
      title: r.title ?? null,
      avatar: r.avatar_url ?? null,
      profileId: r.profile_id ?? null,
    })),
  })
}

async function syncDirectory(admin: SupabaseClient, token: string) {
  // Everyone with a profile, so members can be linked without storing emails.
  const { data: profiles } = await admin.from('profiles').select('id, email')
  const byEmail = new Map((profiles ?? []).map((p) => [p.email.toLowerCase(), p.id]))

  const rows: Record<string, unknown>[] = []
  let cursor: string | undefined
  do {
    const url = new URL('https://slack.com/api/users.list')
    url.searchParams.set('limit', String(PAGE))
    if (cursor) url.searchParams.set('cursor', cursor)
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
    const body = (await res.json()) as { ok: boolean; error?: string; members?: SlackMember[]; response_metadata?: { next_cursor?: string } }
    if (!body.ok) throw new Error(body.error ?? 'users.list failed')

    for (const m of body.members ?? []) {
      if (m.deleted || m.is_bot || m.is_app_user || m.id === 'USLACKBOT') continue
      const name = m.profile?.real_name || m.real_name
      if (!name) continue
      rows.push({
        slack_user_id: m.id,
        real_name: name,
        display_name: m.profile?.display_name || null,
        title: m.profile?.title || null,
        avatar_url: m.profile?.image_48 || null,
        profile_id: m.profile?.email ? byEmail.get(m.profile.email.toLowerCase()) ?? null : null,
        updated_at: new Date().toISOString(),
      })
    }
    cursor = body.response_metadata?.next_cursor || undefined
  } while (cursor)

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from('slack_directory').upsert(rows.slice(i, i + 500), { onConflict: 'slack_user_id' })
    if (error) throw error
  }
  // Drop members who left since the last sync.
  const keep = rows.map((r) => r.slack_user_id as string)
  if (keep.length) await admin.from('slack_directory').delete().not('slack_user_id', 'in', `(${keep.map((k) => `"${k}"`).join(',')})`)
}
