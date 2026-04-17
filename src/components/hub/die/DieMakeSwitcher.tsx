'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { safeJsonParse, safeJsonStringify } from '@/lib/safe-json'

export function DieMakeSwitcher({
  dyeId,
  value,
  disabled,
  onPersisted,
  className = '',
}: {
  dyeId: string
  value: 'local' | 'laser'
  disabled?: boolean
  onPersisted: () => void
  className?: string
}) {
  const [v, setV] = useState(value)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    setV(value)
  }, [value])

  async function pick(next: 'local' | 'laser') {
    if (next === v || pending || disabled) return
    setPending(true)
    try {
      const r = await fetch(`/api/tooling-hub/dies/${encodeURIComponent(dyeId)}/spec`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({ dieMake: next }),
      })
      if (!r.ok) {
        const t = await r.text()
        const j = safeJsonParse<{ error?: string }>(t, {})
        toast.error(j.error ?? 'Could not update make')
        return
      }
      setV(next)
      onPersisted()
    } catch {
      toast.error('Could not update make')
    } finally {
      setPending(false)
    }
  }

  const btn = (key: 'local' | 'laser', label: string) => (
    <button
      type="button"
      disabled={disabled || pending}
      onClick={(e) => {
        e.stopPropagation()
        void pick(key)
      }}
      className={`px-2 py-0.5 min-w-[3.25rem] transition-colors disabled:opacity-50 ${
        v === key
          ? 'bg-amber-600 text-white'
          : 'bg-zinc-950 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div
      className={`inline-flex rounded-md border border-zinc-600 overflow-hidden text-[10px] font-bold uppercase tracking-wide ${className}`}
      onClick={(e) => e.stopPropagation()}
      role="group"
      aria-label="Die make"
    >
      {btn('local', 'Local')}
      {btn('laser', 'Laser')}
    </div>
  )
}
