'use client'

import { SelectDropdown } from '@/components/design-system/SelectDropdown'
import { useMaster } from '@/components/masters/MastersProvider'
import type { MasterKey } from '@/lib/masters/registry'

type Props = {
  masterKey: MasterKey
  value: string
  onChange: (code: string) => void
  disabled?: boolean
  placeholder?: string
  className?: string
  allowEmpty?: boolean
}

export function MasterSelect({
  masterKey,
  value,
  onChange,
  disabled,
  placeholder = 'Select…',
  className,
  allowEmpty = true,
}: Props) {
  const { options, loading } = useMaster(masterKey)
  const known = options.some((o) => o.code === value)
  const merged = !value || known ? options : [{ code: value, label: value }, ...options]

  return (
    <SelectDropdown
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || loading}
      className={className}
    >
      {allowEmpty && <option value="">{loading ? 'Loading…' : placeholder}</option>}
      {merged.map((o) => (
        <option key={o.code} value={o.code}>
          {o.label}
        </option>
      ))}
    </SelectDropdown>
  )
}
