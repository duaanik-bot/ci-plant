import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import { Providers } from '@/components/providers'
import { AppToaster } from '@/components/theme/AppToaster'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-designing-queue',
  weight: ['400', '600', '700'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_APP_NAME ?? 'Salary & Employee Management',
  description: 'Production-ready salary and employee management SaaS',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} bg-background font-sans text-sm text-foreground antialiased`}
      >
        <Providers>{children}</Providers>
        <AppToaster />
      </body>
    </html>
  )
}
