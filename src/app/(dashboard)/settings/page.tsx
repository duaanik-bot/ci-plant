'use client'

import { useTheme } from 'next-themes'

export default function SettingsPage() {
  const { theme, setTheme } = useTheme()

  return (
    <section className="p-6 space-y-4 max-w-2xl">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="text-sm text-slate-400">
        Global preferences for appearance and workspace behavior.
      </p>

      <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-4 space-y-3">
        <div>
          <p className="text-sm font-medium text-slate-200">Theme</p>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => setTheme('light')}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                theme === 'light'
                  ? 'border-blue-500 bg-blue-600 text-white'
                  : 'border-slate-700 text-slate-200 hover:bg-slate-800'
              }`}
            >
              Light
            </button>
            <button
              onClick={() => setTheme('dark')}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                theme === 'dark'
                  ? 'border-blue-500 bg-blue-600 text-white'
                  : 'border-slate-700 text-slate-200 hover:bg-slate-800'
              }`}
            >
              Dark
            </button>
            <button
              onClick={() => setTheme('system')}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                theme === 'system'
                  ? 'border-blue-500 bg-blue-600 text-white'
                  : 'border-slate-700 text-slate-200 hover:bg-slate-800'
              }`}
            >
              System
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
