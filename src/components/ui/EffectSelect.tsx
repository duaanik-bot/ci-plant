'use client'

import { useEffect, useMemo, useState } from 'react'
import { SelectDropdown } from '@/components/design-system/SelectDropdown'

type EffectOption = {
  id: string
  value: string
  description: string | null
  sortOrder: number
}

type EffectSelectProps = {
  category: string
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  placeholder?: string
  className?: string
}

export function EffectSelect({
  category,
  value,
  onChange,
  disabled,
  placeholder = 'Select...',
  className,
}: EffectSelectProps) {
  const [options, setOptions] = useState<EffectOption[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const name = category.trim()
    if (!name) {
      setOptions([])
      return
    }

    let cancelled = false
    setLoading(true)

    void (async () => {
      try {
        const res = await fetch(`/api/effects/values?category=${encodeURIComponent(name)}`, { cache: 'no-store' })
        const data = (await res.json().catch(() => [])) as EffectOption[]
        if (!cancelled) setOptions(Array.isArray(data) ? data : [])
      } catch {
        if (!cancelled) setOptions([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [category])

  const optionValues = useMemo(() => new Set(options.map((o) => o.value)), [options])
  const effectiveValue = optionValues.has(value) ? value : ''

  return (
    <SelectDropdown
      value={effectiveValue}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || loading}
      className={className}
    >
      <option value="">{loading ? 'Loading…' : placeholder}</option>
      {options.map((opt) => (
        <option key={opt.id} value={opt.value}>
          {opt.value}
        </option>
      ))}
    </SelectDropdown>
  )
}
