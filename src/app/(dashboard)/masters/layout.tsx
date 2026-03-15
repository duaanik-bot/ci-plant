import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth-options'
import Link from 'next/link'

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
    <div className="p-4 max-w-4xl mx-auto">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/" className="text-slate-400 hover:text-white text-sm">
          ← Dashboard
        </Link>
        <Link href="/masters" className="text-xl font-bold text-amber-400 hover:underline">Masters</Link>
      </div>
      {children}
    </div>
  )
}
