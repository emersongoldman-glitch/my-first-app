import Link from 'next/link'

export default async function AuthCodeError({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>
}) {
  const { reason } = await searchParams
  const isDomainError = reason?.toLowerCase().includes('alpha.school')

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold">Couldn&apos;t sign you in</h1>
      {isDomainError ? (
        <p className="text-neutral-600 dark:text-neutral-400">
          Campus Rooms is only for Alpha High School accounts. Sign in with your
          <span className="font-medium"> @alpha.school </span>
          Google account rather than a personal one.
        </p>
      ) : (
        <p className="text-neutral-600 dark:text-neutral-400">
          Something went wrong during sign-in. Please try again.
        </p>
      )}
      <Link
        href="/login"
        className="rounded-lg bg-neutral-900 px-4 py-2.5 text-center font-medium text-white dark:bg-white dark:text-neutral-900"
      >
        Back to sign in
      </Link>
    </main>
  )
}
