import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const PUBLIC_PATHS = [
  '/login',
  '/auth',
  '/approve',   // guides arrive from a Slack DM, signed out; the token is the credential

  // The fake-data preview exists only under `next dev`; the page itself 404s elsewhere.
  ...(process.env.NODE_ENV === 'development' ? ['/dev'] : []),
]

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  // Without Supabase credentials there is no session to refresh, and calling
  // out anyway fails with a network error that looks nothing like the actual
  // problem. Pass through instead; the pages say what is missing.
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    return supabaseResponse
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // A magic-link or OAuth code that lands anywhere other than the callback —
  // typically because Supabase fell back to the Site URL — is forwarded to the
  // callback with its query intact, instead of being redirected to /login and
  // silently lost.
  if (request.nextUrl.searchParams.has('code') && request.nextUrl.pathname !== '/auth/callback') {
    const url = request.nextUrl.clone()
    url.pathname = '/auth/callback'
    return NextResponse.redirect(url)
  }

  // Do not put logic between createServerClient and getUser(): a stray await
  // here makes sessions randomly fail to refresh and users get logged out.
  const { data: { user } } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p))
  // API routes authenticate themselves and answer with JSON; a redirect to
  // the login page is the wrong shape for a fetch() caller.
  const isApi = path.startsWith('/api')
  if (!user && !isPublic && !isApi) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // First visit: everyone confirms guide-or-student once (PLAN.md D11).
  // The claim itself is verified server-side in confirm_role; this only
  // routes unconfirmed people to the screen.
  if (user && !isPublic && !path.startsWith('/welcome') && !isApi) {
    const { data: me } = await supabase
      .from('profiles')
      .select('role, role_confirmed')
      .eq('id', user.id)
      .maybeSingle()
    if (me && me.role_confirmed === false) {
      const url = request.nextUrl.clone()
      url.pathname = '/welcome'
      return NextResponse.redirect(url)
    }
    // Staff-only area. The pages check this too and the database refuses
    // student writes regardless; this just stops the URL from loading at all.
    if (path.startsWith('/admin') && (!me || me.role === 'student')) {
      const url = request.nextUrl.clone()
      url.pathname = '/'
      return NextResponse.redirect(url)
    }
  }

  return supabaseResponse
}
