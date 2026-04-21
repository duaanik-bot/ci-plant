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
    'rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-card-foreground transition-colors hover:bg-accent hover:text-accent-foreground'

  const activeCls = 'ring-2 ring-ring/70 ring-offset-2 ring-offset-background'

  return (
    <div
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-background/90 p-0.5"
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
