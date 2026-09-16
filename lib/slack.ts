/**
 * "Message on Slack" — a deep link into a DM, nothing more. The app has no
 * chat of its own: students already live in Slack, and an in-app inbox for
 * minors would mean moderation and retention we don't want to own.
 *
 * Needs NEXT_PUBLIC_SLACK_TEAM_ID (the T… id in any Slack URL). Without it the
 * button simply doesn't render.
 */
export const SLACK_TEAM_ID = process.env.NEXT_PUBLIC_SLACK_TEAM_ID ?? ''
export const slackEnabled = SLACK_TEAM_ID.length > 0

/**
 * app_redirect opens the desktop app when installed and falls back to the
 * web client. `channel` accepts a user id and opens the DM with that person.
 */
export function slackDmUrl(slackUserId: string): string {
  const u = new URL('https://slack.com/app_redirect')
  u.searchParams.set('team', SLACK_TEAM_ID)
  u.searchParams.set('channel', slackUserId)
  return u.toString()
}

/** A workspace member from the cached Slack directory (see /api/slack/search). */
export type SlackPerson = {
  slackUserId: string
  name: string
  title: string | null
  avatar: string | null
  /** Set when this Slack member has also signed into Campus Rooms. */
  profileId: string | null
}

/** Search the whole campus Slack, not only people who have used this app. */
export async function searchSlackDirectory(q: string): Promise<SlackPerson[]> {
  if (!slackEnabled || q.trim().length < 2) return []
  try {
    const res = await fetch(`/api/slack/search?q=${encodeURIComponent(q.trim())}`)
    if (!res.ok) return []
    const body = (await res.json()) as { people?: SlackPerson[] }
    return body.people ?? []
  } catch {
    return []
  }
}

export type SlackLookup =
  | { ok: true; slackUserId: string }
  | { ok: false; error: string }

/** Ask the server for someone's Slack id (cached after the first hit). */
export async function lookupSlackUser(userId: string): Promise<SlackLookup> {
  try {
    const res = await fetch('/api/slack/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    })
    const body = (await res.json()) as { slackUserId?: string; error?: string }
    if (!res.ok || !body.slackUserId) return { ok: false, error: body.error ?? 'Could not find them on Slack.' }
    return { ok: true, slackUserId: body.slackUserId }
  } catch {
    return { ok: false, error: 'Could not reach Slack right now.' }
  }
}
