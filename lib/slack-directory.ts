import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Cached copy of the Slack workspace directory (slack_directory). Refreshed
 * from users.list when older than STALE_HOURS. No emails are stored; members
 * are linked to profiles by email at sync time and only the profile id kept.
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

export async function ensureSlackDirectoryFresh(admin: SupabaseClient): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) return
  const { data: newest } = await admin
    .from('slack_directory').select('updated_at').order('updated_at', { ascending: false }).limit(1).maybeSingle()
  const ageHours = newest ? (Date.now() - new Date(newest.updated_at).getTime()) / 3_600_000 : Infinity
  if (ageHours <= STALE_HOURS) return
  try { await syncSlackDirectory(admin, token) } catch (e) { console.error('slack directory sync failed', e) }
}

export async function syncSlackDirectory(admin: SupabaseClient, token: string): Promise<number> {
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
  // Members who left since the last sync: remove in chunks so the URL stays short.
  const keep = new Set(rows.map((r) => r.slack_user_id as string))
  const { data: existing } = await admin.from('slack_directory').select('slack_user_id')
  const gone = (existing ?? []).map((r) => r.slack_user_id).filter((id) => !keep.has(id))
  for (let i = 0; i < gone.length; i += 200) {
    await admin.from('slack_directory').delete().in('slack_user_id', gone.slice(i, i + 200))
  }
  return rows.length
}
