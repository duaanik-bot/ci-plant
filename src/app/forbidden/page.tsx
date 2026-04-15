import Link from 'next/link'

export default function ForbiddenPage() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
      <div className="w-full max-w-lg rounded-xl border border-slate-800 bg-slate-900/70 p-8 space-y-4">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="text-sm text-slate-400">
          Your account is authenticated, but you do not have permission to access this area.
        </p>
        <div className="flex items-center gap-2">
          <Link
            href="/"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
          >
            Go to Home
          </Link>
          <Link
            href="/api/auth/signout"
            className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
          >
            Sign out
          </Link>
        </div>
      </div>
    </main>
  )
}
