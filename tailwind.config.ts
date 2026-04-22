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
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        'po-dashboard': ['var(--font-po-predictive)', 'ui-monospace', 'monospace'],
        'director-cc': ['var(--font-director-cc)', 'ui-monospace', 'monospace'],
        'designing-queue': ['var(--font-designing-queue)', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        'ds-sm': '6px',
        'ds-md': '10px',
        'ds-lg': '12px',
      },
      boxShadow: {
        /** Premium depth — cards, shells, table wraps */
        'ds-depth': '0 10px 30px rgba(0,0,0,0.25)',
        'ds-depth-sm': '0 4px 16px rgba(0,0,0,0.2)',
        'ds-drawer': '0 10px 30px rgba(0,0,0,0.25)',
        'ds-drawer-foot': '0 -8px 28px rgba(0,0,0,0.22)',
        'ds-focus': '0 0 0 3px rgba(99, 102, 241, 0.18)',
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
        'slide-over-enter': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        /** App-standard right rail (180–220ms, ease-out) */
        'ds-drawer-slide': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
      },
      animation: {
        'po-age-alert': 'po-age-alert 2.2s ease-in-out infinite',
        'industrial-age-pulse': 'industrial-age-pulse 2.2s ease-in-out infinite',
        'slide-over-enter': 'slide-over-enter 200ms ease-in-out both',
        'ds-drawer-slide': 'ds-drawer-slide 200ms ease-out both',
      },
      colors: {
        border: 'hsl(var(--border))',
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
        /** COLOUR IMPRESSIONS SaaS — premium dark skin (indigo accent, soft surfaces) */
        ds: {
          main: '#0A0F1C',
          card: '#111827',
          elevated: '#131A2B',
          line: '#1A2332',
          lineStrong: '#2A3344',
          ink: '#E5E7EB',
          'ink-muted': '#9CA3AF',
          'ink-faint': '#6B7280',
          brand: '#6366F1',
          'brand-hover': '#4F46E5',
          success: '#3FCF8E',
          warning: '#EAB308',
          error: '#F87171',
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
