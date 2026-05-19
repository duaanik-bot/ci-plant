'use client'

import { SelectDropdown } from '@/components/design-system/SelectDropdown'
import { useMaster } from '@/components/masters/MastersProvider'
import { normalizeCode } from '@/lib/masters/code-map'
import type { MasterKey } from '@/lib/masters/registry'

type EffectSelectProps = {
  category: string
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  placeholder?: string
  className?: string
}

// Legacy callers pass a category *name* string (and historically stored the
// human label, not a code). To stay a drop-in we keep the label contract:
// option values and onChange remain labels. We only change the data source
// to the cached registry — removing the ad-hoc fetch and the Duplex/SBS
// filter hack. (Code-based storage applies to new MasterSelect wiring, not
// these existing label-storing carton/PO consumers.)
function resolveKey(category: string): MasterKey {
  const c = category.trim().toLowerCase()
  if (c === 'board classification') return normalizeCode('Board Type') as MasterKey
  if (c === 'embossing') return normalizeCode('Emboss') as MasterKey
  return normalizeCode(category) as MasterKey
}

export function EffectSelect({
  category,
  value,
  onChange,
  disabled,
  placeholder = 'Select...',
  className,
}: EffectSelectProps) {
  const { options, loading } = useMaster(resolveKey(category))
  const labels = options.map((o) => o.label)
  const known = labels.includes(value)
  const merged = !value || known ? labels : [value, ...labels]

  return (
    <SelectDropdown
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || loading}
      className={className}
    >
      <option value="">{loading ? 'Loading…' : placeholder}</option>
      {merged.map((label) => (
        <option key={label} value={label}>
          {label}
        </option>
      ))}
    </SelectDropdown>
  )
}
