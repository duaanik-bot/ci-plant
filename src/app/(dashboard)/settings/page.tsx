'use client'

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import {
  ACCENT_STORAGE_KEY,
  CONTRAST_STORAGE_KEY,
  applyAccentPreset,
  applyHighContrast,
  getStoredAccentPreset,
  getStoredHighContrast,
  type AccentPreset,
} from '@/lib/accent-theme'

export default function SettingsPage() {
  const { theme, setTheme } = useTheme()
  const [accentPreset, setAccentPreset] = useState<AccentPreset>('cyan')
  const [highContrast, setHighContrast] = useState(false)

  useEffect(() => {
    const preset = getStoredAccentPreset()
    setAccentPreset(preset)
    applyAccentPreset(preset)
    const contrast = getStoredHighContrast()
    setHighContrast(contrast)
    applyHighContrast(contrast)
  }, [])

  return (
    <section className="p-6 space-y-4 max-w-2xl">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="text-sm text-ds-ink-muted">
        Global preferences for appearance and workspace behavior.
      </p>

      <div className="rounded-lg border border-ds-line/40 bg-ds-main/40 p-4 space-y-3">
        <div>
          <p className="text-sm font-medium text-ds-ink">Theme</p>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => setTheme('light')}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                theme === 'light'
                  ? 'border-blue-500 bg-blue-600 text-primary-foreground'
                  : 'border-ds-line/50 text-ds-ink hover:bg-ds-elevated'
              }`}
            >
              Light
            </button>
            <button
              onClick={() => setTheme('dark')}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                theme === 'dark'
                  ? 'border-blue-500 bg-blue-600 text-primary-foreground'
                  : 'border-ds-line/50 text-ds-ink hover:bg-ds-elevated'
              }`}
            >
              Dark
            </button>
            <button
              onClick={() => setTheme('system')}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                theme === 'system'
                  ? 'border-blue-500 bg-blue-600 text-primary-foreground'
                  : 'border-ds-line/50 text-ds-ink hover:bg-ds-elevated'
              }`}
            >
              System
            </button>
          </div>
        </div>
        <div>
          <p className="text-sm font-medium text-ds-ink">Accent preview</p>
          <p className="mt-1 text-xs text-ds-ink-muted">
            Pick a high-contrast accent for better readability on dark cards.
          </p>
          <div className="mt-2 flex items-center gap-2">
            {([
              ['cyan', 'Cyan'],
              ['emerald', 'Emerald'],
              ['amber', 'Amber'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => {
                  const next = id as AccentPreset
                  setAccentPreset(next)
                  applyAccentPreset(next)
                  if (typeof window !== 'undefined') {
                    window.localStorage.setItem(ACCENT_STORAGE_KEY, next)
                  }
                }}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  accentPreset === id
                    ? 'border-ds-brand bg-ds-brand text-primary-foreground'
                    : 'border-ds-line/50 text-ds-ink hover:bg-ds-elevated'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-sm font-medium text-ds-ink">Contrast mode</p>
          <p className="mt-1 text-xs text-ds-ink-muted">
            Increase text and border contrast for dense tables and dark cards.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => {
                setHighContrast(true)
                applyHighContrast(true)
                if (typeof window !== 'undefined') window.localStorage.setItem(CONTRAST_STORAGE_KEY, '1')
              }}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                highContrast
                  ? 'border-ds-brand bg-ds-brand text-primary-foreground'
                  : 'border-ds-line/50 text-ds-ink hover:bg-ds-elevated'
              }`}
            >
              High contrast
            </button>
            <button
              onClick={() => {
                setHighContrast(false)
                applyHighContrast(false)
                if (typeof window !== 'undefined') window.localStorage.setItem(CONTRAST_STORAGE_KEY, '0')
              }}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                !highContrast
                  ? 'border-ds-brand bg-ds-brand text-primary-foreground'
                  : 'border-ds-line/50 text-ds-ink hover:bg-ds-elevated'
              }`}
            >
              Normal
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
