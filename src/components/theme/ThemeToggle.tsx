'use client'

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { Sun, Moon } from 'lucide-react'

/** Light | Dark — 2-mode toggle; system mode removed */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const active = mounted ? (theme ?? 'light') : 'light'

  const btn =
    'inline-flex items-center gap-1 rounded-ds-sm border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-muted)]'

  const activeCls =
    'ring-2 ring-[var(--brand-primary)] ring-offset-1 ring-offset-[var(--bg-main)]'

  return (
    <div
      className="inline-flex items-center gap-1 rounded-ds-md border border-[var(--border)] bg-[var(--bg-main)] p-0.5"
      role="group"
      aria-label="Theme"
    >
      <button
        type="button"
        className={`${btn} ${active === 'light' ? activeCls : ''}`}
        onClick={() => setTheme('light')}
        aria-pressed={active === 'light'}
      >
        <Sun className="w-3.5 h-3.5" />
        Light
      </button>
      <button
        type="button"
        className={`${btn} ${active === 'dark' ? activeCls : ''}`}
        onClick={() => setTheme('dark')}
        aria-pressed={active === 'dark'}
      >
        <Moon className="w-3.5 h-3.5" />
        Dark
      </button>
    </div>
  )
}
