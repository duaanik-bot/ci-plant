'use client'

import { useEffect } from 'react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[global-error]', error)
  }, [error])

  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
        <div style={{ maxWidth: 720, margin: '40px auto' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>
            Application error
          </h1>
          <p style={{ color: '#6b7280', marginBottom: 16 }}>
            Something went wrong rendering this page.
          </p>
          <pre
            style={{
              padding: 12,
              background: '#f3f4f6',
              borderRadius: 6,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : ''}
          </pre>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 16,
              padding: '8px 14px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              background: '#fff',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
