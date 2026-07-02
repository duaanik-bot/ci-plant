/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      colors: {
        // Pureflix indigo — the elite brand ramp. Every brand-* class reads this.
        brand: {
          50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc',
          400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca',
        },
        ink: {
          950: '#020617', 900: '#0f172a', 800: '#1e293b', 700: '#334155',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(15,23,42,.05), 0 1px 3px rgba(15,23,42,.08)',
        lift: '0 4px 12px rgba(15,23,42,.08), 0 2px 4px rgba(15,23,42,.05)',
        modal: '0 24px 48px -12px rgba(15,23,42,.25)',
        glow: '0 0 0 1px rgba(99,102,241,.25), 0 8px 24px rgba(79,70,229,.25)',
      },
      keyframes: {
        fadeIn: { from: { opacity: 0 }, to: { opacity: 1 } },
        slideUp: { from: { opacity: 0, transform: 'translateY(8px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
        scaleIn: { from: { opacity: 0, transform: 'scale(.96)' }, to: { opacity: 1, transform: 'scale(1)' } },
        pulseSoft: { '0%,100%': { opacity: 1 }, '50%': { opacity: .55 } },
      },
      animation: {
        fadeIn: 'fadeIn .15s ease-out',
        slideUp: 'slideUp .2s ease-out',
        scaleIn: 'scaleIn .18s ease-out',
        pulseSoft: 'pulseSoft 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
