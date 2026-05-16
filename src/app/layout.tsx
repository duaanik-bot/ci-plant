import type { Metadata } from 'next'
import { Plus_Jakarta_Sans, IBM_Plex_Mono } from 'next/font/google'
import { Providers } from '@/components/providers'
import { AppToaster } from '@/components/theme/AppToaster'
import './globals.css'

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-jakarta',
})

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-plex-mono',
})

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_APP_NAME ?? 'Colour Impressions — Plant Management',
  description: 'Colour Impressions plant management system — orders, production, tooling, and dispatch.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${jakarta.variable} ${plexMono.variable} bg-ds-main font-sans text-sm text-ds-ink antialiased`}
      >
        <Providers>{children}</Providers>
        <AppToaster />
      </body>
    </html>
  )
}
