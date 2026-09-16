import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { ensureSlackDirectoryFresh } from '@/lib/slack-directory'

/**
 * GET /api/slack/search?q=name → Slack workspace members only.
 * Kept for compatibility; the People page uses /api/people/search, which
 * merges this with profiles, known guides, and the roster.
 */
export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim()
  if (q.length < 2) return NextResponse.json({ people: [] })

  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (serviceKey && process.env.SLACK_BOT_TOKEN) {
    const admin = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, { auth: { persistSession: false } })
    await ensureSlackDirectoryFresh(admin)
  }

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
