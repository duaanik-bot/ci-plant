'use client'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { useState } from 'react'

export interface FilterField { key: string; label: string; type: 'date' | 'text' }

export function FilterBar({ fields }: { fields: FilterField[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [state, setState] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, sp.get(f.key) ?? '']))
  )
  function apply() {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(state)) if (v) q.set(k, v)
    router.push(`${pathname}?${q.toString()}`)
  }
  function reset() {
    setState(Object.fromEntries(fields.map((f) => [f.key, ''])))
    router.push(pathname)
  }
  return (
    <div className="flex flex-wrap items-end gap-3">
      {fields.map((f) => (
        <div key={f.key} className="flex flex-col">
          <label className="text-xs text-ds-ink-muted">{f.label}</label>
          <input
            type={f.type === 'date' ? 'date' : 'text'}
            value={state[f.key] ?? ''}
            onChange={(e) => setState((s) => ({ ...s, [f.key]: e.target.value }))}
            className="rounded-md border border-ds-border px-2 py-1 text-sm"
          />
        </div>
      ))}
      <button onClick={apply} className="rounded-md bg-[var(--info)] px-3 py-1.5 text-sm text-white">
        Apply
      </button>
      <button onClick={reset} className="rounded-md border border-ds-border px-3 py-1.5 text-sm">
        Reset
      </button>
    </div>
  )
}
