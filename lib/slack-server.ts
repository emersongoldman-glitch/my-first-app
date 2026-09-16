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
