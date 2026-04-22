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
    'rounded-md border border-ds-line/50 bg-ds-card px-2 py-1 text-xs font-medium text-ds-ink transition-colors hover:bg-ds-elevated hover:text-white'

  const activeCls = 'ring-2 ring-blue-600/90 ring-offset-2 ring-offset-ds-main'

  return (
    <div
      className="inline-flex items-center gap-1 rounded-lg border border-ds-line/50 bg-ds-main/80 p-0.5"
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
