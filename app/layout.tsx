import type { Metadata, Viewport } from 'next'
import { Montserrat } from 'next/font/google'
import './globals.css'

// Alpha High's body/sub-heading face. The display face, Neuropolitical, is a
// paid font and is not bundled — see the brand guide's typography note.
const montserrat = Montserrat({
  variable: '--font-montserrat',
  subsets: ['latin'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Campus Rooms',
  description:
    'Book a pod or conference room at Alpha High School, and see where everyone is.',
  manifest: '/site.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', type: 'image/x-icon' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
}

export const viewport: Viewport = {
  themeColor: '#002970',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // The font variable belongs on <html>, not <body>: Tailwind's `@theme
    // inline` resolves --font-sans at :root, so a variable scoped to <body>
    // resolves to nothing and every element silently falls back to system UI.
    <html lang="en" className={montserrat.variable}>
      <body className="antialiased">{children}</body>
    </html>
  )
}
