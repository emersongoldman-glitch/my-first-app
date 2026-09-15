import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      const forwardedHost = request.headers.get('x-forwarded-host')
      const isLocal = process.env.NODE_ENV === 'development'
      if (isLocal) return NextResponse.redirect(`${origin}${next}`)
      if (forwardedHost) return NextResponse.redirect(`https://${forwardedHost}${next}`)
      return NextResponse.redirect(`${origin}${next}`)
    }
    // The database trigger rejects non-@alpha.school accounts here, so this is
    // the normal path for someone signing in with a personal Google account.
    return NextResponse.redirect(
      `${origin}/auth/auth-code-error?reason=${encodeURIComponent(error.message)}`
    )
  }

  return NextResponse.redirect(`${origin}/auth/auth-code-error`)
}
