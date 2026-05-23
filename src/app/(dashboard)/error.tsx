'use client'

import { useEffect } from 'react'

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[dashboard-error]', error)
  }, [error])

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="rounded-ds-md bg-[var(--bg-card)] p-6 shadow-ds-depth-sm">
        <h1 className="text-base font-semibold text-[var(--text-primary)]">
          This page failed to load
        </h1>
        <p className="mt-2 text-sm text-ds-ink-muted">
          A render error occurred in this section.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-ds-sm bg-[var(--bg-muted)] p-3 text-xs text-ds-ink whitespace-pre-wrap break-words">
          {error.message}
          {error.digest ? `\n\ndigest: ${error.digest}` : ''}
        </pre>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded-ds-sm border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-muted)]"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-ds-sm border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-muted)]"
          >
            Reload page
          </button>
        </div>
      </div>
    </div>
  )
}
