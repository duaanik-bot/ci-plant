import Link from 'next/link'

export default function ForbiddenPage() {
  return (
    <main className="min-h-screen bg-ds-main text-ds-ink flex items-center justify-center px-4">
      <div className="w-full max-w-lg rounded-xl border border-ds-line/40 bg-ds-card/70 p-8 space-y-4">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="text-sm text-ds-ink-muted">
          Your account is authenticated, but you do not have permission to access this area.
        </p>
        <div className="flex items-center gap-2">
          <Link
            href="/"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-blue-500"
          >
            Go to Home
          </Link>
          <Link
            href="/api/auth/signout"
            className="rounded-md border border-ds-line/50 px-4 py-2 text-sm text-ds-ink hover:bg-ds-elevated"
          >
            Sign out
          </Link>
        </div>
      </div>
    </main>
  )
}
