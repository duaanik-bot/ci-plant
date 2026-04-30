export type AccentPreset = 'cyan' | 'emerald' | 'amber'

/** All presets map to the same brand orange — accent switcher is retained without fragmenting the palette. */
const BRAND = {
  accent: '#F97316',
  accentHover: '#EA580C',
  accentRgb: '249 115 22',
  accentHoverRgb: '234 88 12',
  /** HSL for shadcn `primary` / `ring` */
  primaryHsl: '24 95% 53%',
  ringHsl: '24 95% 53%',
} as const

export const ACCENT_STORAGE_KEY = 'ci-accent-preset'
export const CONTRAST_STORAGE_KEY = 'ci-high-contrast'

export function applyAccentPreset(_preset: AccentPreset): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.setProperty('--ds-accent', BRAND.accent)
  root.style.setProperty('--ds-accent-hover', BRAND.accentHover)
  root.style.setProperty('--ds-accent-rgb', BRAND.accentRgb)
  root.style.setProperty('--ds-accent-hover-rgb', BRAND.accentHoverRgb)
  root.style.setProperty('--primary', BRAND.primaryHsl)
  root.style.setProperty('--ring', BRAND.ringHsl)
}

export function getStoredAccentPreset(): AccentPreset {
  if (typeof window === 'undefined') return 'amber'
  const raw = window.localStorage.getItem(ACCENT_STORAGE_KEY)
  if (raw === 'emerald' || raw === 'amber' || raw === 'cyan') return raw
  return 'amber'
}

export function applyHighContrast(enabled: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('ci-high-contrast', enabled)
}

export function getStoredHighContrast(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(CONTRAST_STORAGE_KEY) === '1'
}
