export type AccentPreset = 'cyan' | 'emerald' | 'amber'

type AccentVars = {
  accent: string
  accentHover: string
  primaryHsl: string
  ringHsl: string
}

const ACCENT_PRESETS: Record<AccentPreset, AccentVars> = {
  cyan: {
    accent: '#38BDF8',
    accentHover: '#0EA5E9',
    primaryHsl: '199 89% 60%',
    ringHsl: '199 89% 60%',
  },
  emerald: {
    accent: '#34D399',
    accentHover: '#10B981',
    primaryHsl: '160 84% 39%',
    ringHsl: '160 84% 39%',
  },
  amber: {
    accent: '#F59E0B',
    accentHover: '#D97706',
    primaryHsl: '38 92% 50%',
    ringHsl: '38 92% 50%',
  },
}

export const ACCENT_STORAGE_KEY = 'ci-accent-preset'
export const CONTRAST_STORAGE_KEY = 'ci-high-contrast'

export function applyAccentPreset(preset: AccentPreset): void {
  if (typeof document === 'undefined') return
  const vars = ACCENT_PRESETS[preset]
  const root = document.documentElement
  root.style.setProperty('--ds-accent', vars.accent)
  root.style.setProperty('--ds-accent-hover', vars.accentHover)
  root.style.setProperty('--primary', vars.primaryHsl)
  root.style.setProperty('--ring', vars.ringHsl)
}

export function getStoredAccentPreset(): AccentPreset {
  if (typeof window === 'undefined') return 'cyan'
  const raw = window.localStorage.getItem(ACCENT_STORAGE_KEY)
  if (raw === 'emerald' || raw === 'amber' || raw === 'cyan') return raw
  return 'cyan'
}

export function applyHighContrast(enabled: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('ci-high-contrast', enabled)
}

export function getStoredHighContrast(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(CONTRAST_STORAGE_KEY) === '1'
}
