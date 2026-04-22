/**
 * Figma / design-spec mirror — use with Tailwind `ds-*` classes (see tailwind.config).
 * Spacing scale: 4, 8, 12, 16, 24, 32px → Tailwind 1–4, 6, 8.
 */
export const dsColors = {
  bgMain: '#0B1220',
  bgCard: '#111827',
  bgElevated: '#121A2A',
  borderSubtle: '#1F2937',
  borderStrong: '#374151',
  textPrimary: '#E5E7EB',
  textSecondary: '#9CA3AF',
  textMuted: '#6B7280',
  accent: '#3B82F6',
  accentHover: '#2563EB',
  success: '#22C55E',
  warning: '#F59E0B',
  error: '#EF4444',
} as const

export const dsTypography = {
  label: '12px / 13px — text-xs',
  input: '14px / 15px — text-sm base',
  heading: '16px / 18px — text-base / font-semibold',
  total: '20px / 22px — text-xl font-bold',
} as const

export const dsSpacing = [4, 8, 12, 16, 24, 32] as const
export const dsRadius = { sm: 6, md: 10, lg: 12 } as const
