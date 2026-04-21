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
    <div className="mx-auto min-h-0 max-w-6xl bg-slate-50 p-4 text-slate-900 dark:bg-slate-950 dark:text-slate-50">
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <Link
          href="/dashboard"
          className="text-sm text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-50"
        >
          ← Dashboard
        </Link>
        <Link href="/masters" className="text-base font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400">
          Masters
        </Link>
      </div>
      <MastersLayoutBody>{children}</MastersLayoutBody>
    </div>
  )
}
