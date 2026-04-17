import { JetBrains_Mono } from 'next/font/google'
import { DashboardShell } from './DashboardShell'

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-designing-queue',
  weight: ['400', '600', '700'],
})

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className={jetbrainsMono.variable}>
      <DashboardShell>{children}</DashboardShell>
    </div>
  )
}
