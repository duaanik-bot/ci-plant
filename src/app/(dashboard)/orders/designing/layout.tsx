import { JetBrains_Mono } from 'next/font/google'
import { ErrorBoundary } from '@/components/ErrorBoundary'

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-designing-queue',
  weight: ['400', '600', '700'],
})

export default function DesigningSectionLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${jetbrainsMono.variable} min-h-0`}>
      <ErrorBoundary moduleName="Artwork queue">{children}</ErrorBoundary>
    </div>
  )
}
