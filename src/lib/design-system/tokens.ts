/**
 * Figma / product-spec — Tailwind `ds-*` (see tailwind.config).
 * Spacing: 4, 8, 12, 16, 24, 32px → Tailwind 1–4, 6, 8.
 * Premium dark skin: indigo accent, soft borders, reduced harshness.
 */
export const dsColors = {
  bgMain: '#0A0F1C',
  bgCard: '#111827',
  bgElevated: '#131A2B',
  /** Low-contrast edges on main bg */
  borderSubtle: '#1A2332',
  borderStrong: '#2A3344',
  textPrimary: '#E5E7EB',
  textSecondary: '#9CA3AF',
  textMuted: '#6B7280',
  accent: '#6366F1',
  accentHover: '#4F46E5',
  success: '#3FCF8E',
  warning: '#EAB308',
  error: '#F87171',
} as const

export const dsTypography = {
  label: '12px / 13px — text-xs',
  input: '14px / 15px — text-sm base',
  heading: '16px / 18px — text-base / font-semibold',
  total: '20px / 22px — text-xl font-bold',
} as const

export const dsSpacing = [4, 8, 12, 16, 24, 32] as const
export const dsRadius = { sm: 6, md: 10, lg: 12 } as const
