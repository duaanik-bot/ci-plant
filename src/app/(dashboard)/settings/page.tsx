'use client'

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { PageHeader } from '@/components/shared/PageHeader'
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
      <PageHeader
        title="Settings"
        subtitle="Global preferences for appearance and workspace behavior."
      />

      <div className="rounded-ds-md bg-ds-main/40 p-4 space-y-3">
        <div>
          <p className="text-sm font-medium text-ds-ink">Theme</p>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => setTheme('light')}
              className={`rounded-ds-sm px-3 py-1.5 text-sm ${
                theme === 'light'
                  ? 'bg-[var(--info-bg)] text-primary-foreground'
                  : 'text-ds-ink hover:bg-ds-elevated'
              }`}
            >
              Light
            </button>
            <button
              onClick={() => setTheme('dark')}
              className={`rounded-ds-sm px-3 py-1.5 text-sm ${
                theme === 'dark'
                  ? 'bg-[var(--info-bg)] text-primary-foreground'
                  : 'text-ds-ink hover:bg-ds-elevated'
              }`}
            >
              Dark
            </button>
            <button
              onClick={() => setTheme('system')}
              className={`rounded-ds-sm px-3 py-1.5 text-sm ${
                theme === 'system'
                  ? 'bg-[var(--info-bg)] text-primary-foreground'
                  : 'text-ds-ink hover:bg-ds-elevated'
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
                className={`rounded-ds-sm px-3 py-1.5 text-sm ${
                  accentPreset === id
                    ? 'bg-ds-brand text-primary-foreground'
                    : 'text-ds-ink hover:bg-ds-elevated'
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
              className={`rounded-ds-sm px-3 py-1.5 text-sm ${
                highContrast
                  ? 'bg-ds-brand text-primary-foreground'
                  : 'text-ds-ink hover:bg-ds-elevated'
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
              className={`rounded-ds-sm px-3 py-1.5 text-sm ${
                !highContrast
                  ? 'bg-ds-brand text-primary-foreground'
                  : 'text-ds-ink hover:bg-ds-elevated'
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
