import { notFound } from 'next/navigation'
import PreviewBoard from './preview-board'

/**
 * Dev-only: the board with fake bookings and no sign-in, so the layout can be
 * looked at without a live session. 404s outside `next dev`.
 */
export const dynamic = 'force-dynamic'

export default function PreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
        DEV PREVIEW — fake data, no network
      </p>
      <h1 className="mb-6 text-2xl font-bold tracking-tight">Campus Rooms</h1>
      <PreviewBoard />
    </main>
  )
}
