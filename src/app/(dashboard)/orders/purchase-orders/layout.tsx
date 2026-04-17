import { JetBrains_Mono } from 'next/font/google'

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-po-predictive',
  weight: ['400', '600', '700'],
})

export default function PurchaseOrdersSectionLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${jetbrainsMono.variable} min-h-0`}>{children}</div>
}
