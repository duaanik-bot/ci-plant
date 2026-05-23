import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
        'po-dashboard': ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
        'director-cc': ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
        'designing-queue': ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        'ds-sm': '6px',
        'ds-md': '10px',
        'ds-lg': '12px',
        'ds-card': '16px',
        'ds-modal': '18px',
      },
      boxShadow: {
        /** Unified depth — neutral only */
        'ds-depth': '0 4px 24px rgba(15,23,42,0.08)',
        'ds-depth-sm': '0 1px 3px rgba(15,23,42,0.06)',
        'ds-drawer': '0 8px 32px rgba(15,23,42,0.12)',
        'ds-drawer-foot': '0 -4px 20px rgba(15,23,42,0.08)',
        'ds-focus': '0 0 0 3px rgba(37, 99, 235, 0.2)',
        // ── ERP design-system component shadows ────────────────────────
        card:  '0 1px 3px 0 rgb(0 0 0 / 0.07), 0 1px 2px -1px rgb(0 0 0 / 0.07)',
        modal: '0 20px 60px -12px rgb(0 0 0 / 0.25), 0 8px 24px -4px rgb(0 0 0 / 0.1)',
        toast: '0 8px 30px -4px rgb(0 0 0 / 0.12)',
      },
      keyframes: {
        'po-age-alert': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.65' },
        },
        'industrial-age-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
        // ── ERP design-system modal / toast animations ──────────────────
        'slide-in-right': {
          from: { transform: 'translateX(100%)', opacity: '0' },
          to:   { transform: 'translateX(0)',    opacity: '1' },
        },
        'scale-in': {
          from: { transform: 'scale(0.95)', opacity: '0' },
          to:   { transform: 'scale(1)',    opacity: '1' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to:   { opacity: '1' },
        },
        'ds-modal-in': {
          from: { opacity: '0', transform: 'scale(0.98)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'ds-modal-out': {
          from: { opacity: '1', transform: 'scale(1)' },
          to: { opacity: '0', transform: 'scale(0.98)' },
        },
        'ds-overlay-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'ds-overlay-out': { from: { opacity: '1' }, to: { opacity: '0' } },
      },
      animation: {
        'po-age-alert': 'po-age-alert 2.2s ease-in-out infinite',
        'industrial-age-pulse': 'industrial-age-pulse 2.2s ease-in-out infinite',
        // ── ERP design-system ──────────────────────────────────────────
        'slide-in-right': 'slide-in-right 0.2s ease-out',
        'scale-in':       'scale-in 0.18s ease-out',
        'fade-in':        'fade-in 0.15s ease-out',
      },
      colors: {
        border: 'var(--border)',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        /** Plate Hub — process magenta (matches industry CMYK “M” on dark UI) */
        plateMagenta: '#FF00FF',
        /** COLOUR IMPRESSIONS SaaS — premium dark skin (high-contrast cyan accent, soft surfaces) */
        ds: {
          main: 'rgb(var(--ds-bg-main-rgb) / <alpha-value>)',
          card: 'rgb(var(--ds-bg-card-rgb) / <alpha-value>)',
          elevated: 'rgb(var(--ds-bg-elevated-rgb) / <alpha-value>)',
          line: 'rgb(var(--ds-border-subtle-rgb) / <alpha-value>)',
          lineStrong: 'rgb(var(--ds-border-strong-rgb) / <alpha-value>)',
          ink: 'rgb(var(--ds-text-primary-rgb) / <alpha-value>)',
          'ink-muted': 'rgb(var(--ds-text-secondary-rgb) / <alpha-value>)',
          'ink-faint': 'rgb(var(--ds-text-muted-rgb) / <alpha-value>)',
          kpi: 'rgb(var(--ds-kpi-rgb) / <alpha-value>)',
          brand: 'rgb(var(--ds-accent-rgb) / <alpha-value>)',
          'brand-hover': 'rgb(var(--ds-accent-hover-rgb) / <alpha-value>)',
          success: 'rgb(var(--ds-success-rgb) / <alpha-value>)',
          warning: 'rgb(var(--ds-warning-rgb) / <alpha-value>)',
          error: 'rgb(var(--ds-error-rgb) / <alpha-value>)',
        },
        /** Precision Pharma — enterprise light theme (see globals.css) */
        pharma: {
          app: 'var(--pharma-bg-app)',
          surface: 'var(--pharma-bg-surface)',
          hover: 'var(--pharma-bg-hover)',
          primary: 'var(--pharma-text-primary)',
          secondary: 'var(--pharma-text-secondary)',
          tertiary: 'var(--pharma-text-tertiary)',
          action: 'var(--pharma-action-primary)',
          'action-hover': 'var(--pharma-action-hover)',
          border: 'var(--pharma-border)',
          ready: {
            bg: 'var(--pharma-ready-bg)',
            fg: 'var(--pharma-ready-fg)',
          },
          blocked: {
            bg: 'var(--pharma-blocked-bg)',
            fg: 'var(--pharma-blocked-fg)',
          },
          pending: {
            bg: 'var(--pharma-pending-bg)',
            fg: 'var(--pharma-pending-fg)',
          },
        },
      },
    },
  },
  plugins: [require('@tailwindcss/forms')],
}
export default config
