'use client'

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'

/** Dark | Light — pharma-white light mode uses dashboard tokens in globals.css */
export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const active = mounted ? (resolvedTheme ?? theme ?? 'light') : 'light'

  const btn =
    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors border border-[#E2E8F0] bg-white text-[#1A1A1B] hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'

  const activeCls = 'ring-2 ring-amber-500/80 ring-offset-2 ring-offset-white dark:ring-offset-slate-900'

  return (
    <div
      className="inline-flex items-center gap-1 rounded-lg border border-[#E2E8F0] bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-900/80"
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
        className={`${btn} ${active === 'dark' ? activeCls : ''}`}
        onClick={() => setTheme('dark')}
      >
        Dark
      </button>
    </div>
  )
}
