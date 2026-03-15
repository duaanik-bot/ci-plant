import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import Link from 'next/link'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  let session = null
  try {
    session = await getServerSession(authOptions)
  } catch (e) {
    console.error('[Dashboard] getServerSession error:', e)
  }
  if (!session) redirect('/login')

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="border-b border-slate-700 px-4 py-2 flex items-center justify-between">
        <Link href="/" className="font-semibold text-amber-400">
          Colour Impressions
        </Link>
        <span className="text-sm text-slate-400">
          {session.user?.name} · {session.user?.role}
        </span>
      </header>
      <main>{children}</main>
    </div>
  )
}
