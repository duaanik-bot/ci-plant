import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import Link from 'next/link'
import { MastersLayoutBody } from './MastersLayoutBody'

export default async function MastersLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await getServerSession(authOptions)
  if (!session) redirect('/login')
  const role = (session.user as { role?: string })?.role
  if (role !== 'operations_head' && role !== 'md') {
    redirect('/')
  }

  return (
    <div className="mx-auto min-h-0 max-w-6xl bg-neutral-50 p-4 text-neutral-900 dark:bg-ds-main dark:text-ds-ink">
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <Link
          href="/orders/purchase-orders"
          className="text-sm text-ds-ink-faint hover:text-neutral-900 dark:text-ds-ink-muted dark:hover:text-ds-ink"
        >
          ← Customer POs
        </Link>
        <Link href="/masters" className="text-base font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400">
          Masters
        </Link>
      </div>
      <MastersLayoutBody>{children}</MastersLayoutBody>
    </div>
  )
}
