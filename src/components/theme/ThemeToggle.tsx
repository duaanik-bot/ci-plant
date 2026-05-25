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
    'inline-flex items-center gap-1 rounded-ds-sm px-2.5 py-1 text-xs font-medium transition-colors'
  const inactiveCls = 'text-gray-300 hover:bg-white/10'

  const activeCls = 'bg-white text-gray-900 shadow-sm'

  return (
    <div
      className="inline-flex items-center gap-1 rounded-ds-md bg-white/10 p-0.5"
      role="group"
      aria-label="Theme"
    >
      <button
        type="button"
        className={`${btn} ${active === 'light' ? activeCls : inactiveCls}`}
        onClick={() => setTheme('light')}
        aria-pressed={active === 'light'}
      >
        <Sun className="w-3.5 h-3.5" />
        Light
      </button>
      <button
        type="button"
        className={`${btn} ${active === 'dark' ? activeCls : inactiveCls}`}
        onClick={() => setTheme('dark')}
        aria-pressed={active === 'dark'}
      >
        <Moon className="w-3.5 h-3.5" />
        Dark
      </button>
    </div>
  )
}
