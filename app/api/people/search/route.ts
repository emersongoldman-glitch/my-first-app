import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { ensureSlackDirectoryFresh } from '@/lib/slack-directory'
import { slackConfigured, slackIdForEmail } from '@/lib/slack-server'

/**
 * GET /api/people/search?q=name → everyone matching, from four sources:
 *
 *   1. profiles          — people who have signed into the app (RLS as caller)
 *   2. slack_directory   — the whole campus Slack, signed in or not
 *   3. preferred_names   — guides known by the name people use ("Clay"),
 *                          even if Slack lists them by legal name
 *   4. roster_seed       — students on the roster who have never signed in
 *
 * Merged so each person appears once. Anyone found anywhere shows up, with a
 * Slack id when we can resolve one — the point is that "Clay" never returns
 * an empty list just because he hasn't opened the app.
 */
export type PersonHit = {
  key: string
  name: string
  /** Campus Rooms profile id, when they have signed in. */
  profileId: string | null
  role: 'student' | 'guide' | 'admin' | null
  slackUserId: string | null
  title: string | null
  avatar: string | null
  source: 'profile' | 'slack' | 'guide' | 'roster'
}

export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim()
  if (q.length < 1) return NextResponse.json({ people: [] })

  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })

  const like = `%${q.replace(/[%_]/g, '')}%`
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const admin = serviceKey
    ? createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, { auth: { persistSession: false } })
    : null

  if (admin) await ensureSlackDirectoryFresh(admin)

  const [profilesRes, slackRes, guidesRes, rosterRes] = await Promise.all([
    sb.from('profiles').select('id, display_name, full_name, role, email').eq('visible', true)
      .or(`display_name.ilike.${like},full_name.ilike.${like}`).limit(20),
    sb.from('slack_directory').select('slack_user_id, real_name, display_name, title, avatar_url, profile_id')
      .or(`real_name.ilike.${like},display_name.ilike.${like}`).limit(20),
    admin ? admin.from('preferred_names').select('email, display_name').ilike('display_name', like).limit(10) : Promise.resolve({ data: [] as { email: string; display_name: string }[] }),
    admin ? admin.from('roster_seed').select('match_name, guide_name').is('user_id', null).ilike('match_name', like).limit(20) : Promise.resolve({ data: [] as { match_name: string; guide_name: string }[] }),
  ])

  const hits: PersonHit[] = []
  const seenProfile = new Set<string>()
  const seenSlack = new Set<string>()
  const seenName = new Set<string>()
  const norm = (s: string) => s.trim().toLowerCase()

  // 1. Profiles first — richest rows.
  const profileEmails = new Map<string, string>()
  for (const p of profilesRes.data ?? []) {
    seenProfile.add(p.id)
    profileEmails.set(p.email.toLowerCase(), p.id)
    const name = p.display_name?.trim() || p.full_name
    seenName.add(norm(name))
    const slack = (slackRes.data ?? []).find((s) => s.profile_id === p.id)
    if (slack) seenSlack.add(slack.slack_user_id)
    hits.push({ key: `p:${p.id}`, name, profileId: p.id, role: p.role, slackUserId: slack?.slack_user_id ?? null, title: slack?.title ?? null, avatar: slack?.avatar_url ?? null, source: 'profile' })
  }

  // 2. Slack members not already covered.
  for (const s of slackRes.data ?? []) {
    if (seenSlack.has(s.slack_user_id) || (s.profile_id && seenProfile.has(s.profile_id))) continue
    seenSlack.add(s.slack_user_id)
    const name = s.display_name?.trim() || s.real_name
    seenName.add(norm(name))
    hits.push({ key: `s:${s.slack_user_id}`, name, profileId: s.profile_id ?? null, role: null, slackUserId: s.slack_user_id, title: s.title ?? null, avatar: s.avatar_url ?? null, source: 'slack' })
  }

  // 3. Guides known by preferred name (e.g. "Clay" for dustin.hansford@).
  for (const g of guidesRes.data ?? []) {
    const email = g.email.toLowerCase()
    if (profileEmails.has(email) || seenName.has(norm(g.display_name))) continue
    // Their Slack account will be under the legal name; resolve by email.
    const slackUserId = slackConfigured() ? await slackIdForEmail(email) : null
    if (slackUserId && seenSlack.has(slackUserId)) continue
    if (slackUserId) seenSlack.add(slackUserId)
    seenName.add(norm(g.display_name))
    hits.push({ key: `g:${email}`, name: g.display_name, profileId: null, role: 'guide', slackUserId, title: 'Guide', avatar: null, source: 'guide' })
  }

  // 4. Roster students who have never signed in (no email on file → no Slack).
  for (const r of rosterRes.data ?? []) {
    if (seenName.has(norm(r.match_name))) continue
    seenName.add(norm(r.match_name))
    hits.push({ key: `r:${r.match_name}`, name: r.match_name, profileId: null, role: 'student', slackUserId: null, title: `Student · ${r.guide_name}'s`, avatar: null, source: 'roster' })
  }

  // Guides first, then alphabetical.
  hits.sort((a, b) => Number(a.role === 'student' || a.role === null) - Number(b.role === 'student' || b.role === null) || a.name.localeCompare(b.name))
  return NextResponse.json({ people: hits.slice(0, 30) })
}
