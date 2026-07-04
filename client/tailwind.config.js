/** @type {import('tailwindcss').Config} */
// macOS Tahoe theme — Apple system palette + Liquid Glass materials.
// blue/indigo alias to systemBlue so every existing utility class lands on-brand;
// emerald/amber/red/violet are re-tuned to systemGreen/Orange/Red/Purple ramps.
const appleBlue = {
  50: '#F0F7FF', 100: '#E1EFFF', 200: '#C3E0FF', 300: '#94CBFF', 400: '#57ADFF',
  500: '#0A84FF', 600: '#007AFF', 700: '#0064D2', 800: '#0053AD', 900: '#003E82', 950: '#00294F',
};

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '-apple-system', 'BlinkMacSystemFont', 'SF Pro Display', 'SF Pro Text',
          'Inter', 'system-ui', 'sans-serif',
        ],
      },
      colors: {
        brand: appleBlue,
        blue: appleBlue,
        indigo: appleBlue,
        emerald: { // systemGreen
          50: '#EFFAF1', 100: '#DCF5E2', 200: '#BBEAC7', 300: '#8CDCA2', 400: '#57CB75',
          500: '#34C759', 600: '#1FA548', 700: '#19813A', 800: '#146530', 900: '#104E26', 950: '#082D15',
        },
        amber: { // systemOrange
          50: '#FFF7EB', 100: '#FFEDD1', 200: '#FFDCA8', 300: '#FFC470', 400: '#FFAB38',
          500: '#FF9500', 600: '#DB7C00', 700: '#B05F00', 800: '#874A05', 900: '#6E3D08', 950: '#3F2103',
        },
        red: { // systemRed
          50: '#FFF1F0', 100: '#FFE1DF', 200: '#FFC5C2', 300: '#FF9C96', 400: '#FF6961',
          500: '#FF3B30', 600: '#E0281D', 700: '#B81F16', 800: '#911912', 900: '#77150F', 950: '#420A07',
        },
        violet: { // systemPurple
          50: '#F9F1FE', 100: '#F3E3FD', 200: '#E6C8FA', 300: '#D5A3F5', 400: '#C273EA',
          500: '#AF52DE', 600: '#9640C2', 700: '#7B309F', 800: '#632781', 900: '#511F69', 950: '#300E41',
        },
        ink: {
          950: '#0A0A0C', 900: '#1D1D1F', 800: '#2C2C2E', 700: '#3A3A3C',
        },
      },
      boxShadow: {
        // Liquid Glass elevation ramp — soft ambient + specular top edge.
        card: '0 1px 1px rgba(29,29,31,.03), 0 8px 24px rgba(29,29,31,.06), inset 0 1px 0 rgba(255,255,255,.85)',
        lift: '0 2px 6px rgba(29,29,31,.06), 0 16px 40px rgba(29,29,31,.10), inset 0 1px 0 rgba(255,255,255,.9)',
        modal: '0 2px 10px rgba(29,29,31,.08), 0 40px 90px rgba(29,29,31,.26), inset 0 1px 0 rgba(255,255,255,.9)',
        glow: '0 0 0 1px rgba(10,132,255,.22), 0 10px 28px rgba(10,132,255,.28)',
        glass: 'inset 0 1px 0 rgba(255,255,255,.92), inset 0 -1px 0 rgba(29,29,31,.04), 0 1px 1px rgba(29,29,31,.03), 0 12px 32px rgba(29,29,31,.07)',
      },
      transitionTimingFunction: {
        apple: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      keyframes: {
        fadeIn: { from: { opacity: 0 }, to: { opacity: 1 } },
        slideUp: { from: { opacity: 0, transform: 'translateY(10px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
        scaleIn: { from: { opacity: 0, transform: 'scale(.97) translateY(4px)' }, to: { opacity: 1, transform: 'scale(1) translateY(0)' } },
        pulseSoft: { '0%,100%': { opacity: 1 }, '50%': { opacity: .55 } },
      },
      animation: {
        fadeIn: 'fadeIn .18s cubic-bezier(0.32,0.72,0,1)',
        slideUp: 'slideUp .26s cubic-bezier(0.32,0.72,0,1)',
        scaleIn: 'scaleIn .22s cubic-bezier(0.32,0.72,0,1)',
        pulseSoft: 'pulseSoft 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
