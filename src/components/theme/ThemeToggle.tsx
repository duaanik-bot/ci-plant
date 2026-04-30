'use client'

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'

/** Dark | Light — pharma-white light mode uses dashboard tokens in globals.css */
export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const active = mounted ? (theme ?? 'system') : 'system'
  const activeResolved = mounted ? (resolvedTheme ?? 'light') : 'light'

  const btn =
    'rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-muted)]'

  const activeCls =
    'ring-2 ring-[var(--brand-primary)] ring-offset-2 ring-offset-[var(--bg-main)]'

  return (
    <div
      className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-main)] p-0.5"
      role="group"
      aria-label="Theme"
    >
      <button
        type="button"
        className={`${btn} ${active === 'light' ? activeCls : ''}`}
        onClick={() => setTheme('light')}
      >
        Light
      </button>
      <button
        type="button"
        className={`${btn} ${active === 'system' ? activeCls : ''}`}
        onClick={() => setTheme('system')}
        title={`System (${activeResolved})`}
      >
        System
      </button>
      <button
        type="button"
        className={`${btn} ${active === 'dark' ? activeCls : ''}`}
        onClick={() => setTheme('dark')}
      >
        Dark
      </button>
    </div>
  )
}
