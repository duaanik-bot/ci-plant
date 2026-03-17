import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import { DashboardShell } from './DashboardShell'

export const dynamic = 'force-dynamic'

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

  const role = session.user?.role as string | undefined
  const canSeeMasters = role === 'operations_head' || role === 'md'

  return (
    <DashboardShell
      canSeeMasters={canSeeMasters}
      userName={session.user?.name ?? null}
      userRole={role}
    >
      {children}
    </DashboardShell>
  )
}
