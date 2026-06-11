'use client'

import { SelectDropdown } from '@/components/design-system/SelectDropdown'
import { useMaster } from '@/components/masters/MastersProvider'
import { normalizeCode } from '@/lib/masters/code-map'
import { normalizeBoardTypeForStorage, normalizeBoardTypeOptions } from '@/lib/board-vocabulary'
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
  const key = resolveKey(category)
  const isBoardCategory = key === 'BOARD_TYPE' || key === 'BOARD_COLOUR'
  const displayValue = isBoardCategory ? (normalizeBoardTypeForStorage(value) ?? '') : value
  const labels = isBoardCategory ? normalizeBoardTypeOptions(options.map((o) => o.label)) : options.map((o) => o.label)
  const known = labels.includes(displayValue)
  const merged = !displayValue || known ? labels : [displayValue, ...labels]

  return (
    <SelectDropdown
      value={displayValue}
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
