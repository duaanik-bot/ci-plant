'use client'

import { useMemo, useState } from 'react'

export type OperatorMasterOption = {
  id: string
  name: string
  department?: string
}

/** Searchable operator picker (Operator Master). */
export function OperatorMasterCombobox({
  label,
  value,
  onChange,
  options,
  disabled,
  id: domId,
}: {
  label: string
  value: string
  onChange: (operatorId: string) => void
  options: OperatorMasterOption[]
  disabled?: boolean
  id?: string
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)

  const selected = useMemo(() => options.find((o) => o.id === value), [options, value])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return options
    return options.filter(
      (o) =>
        o.name.toLowerCase().includes(s) ||
        (o.department ?? '').toLowerCase().includes(s),
    )
  }, [options, q])

  return (
    <div className="space-y-1">
      <span className="block text-sm text-neutral-400">{label}</span>
      <div className="relative">
        <input
          id={domId}
          type="text"
          disabled={disabled}
          value={open ? q : selected?.name ?? ''}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onFocus={() => {
            setQ(selected?.name ?? '')
            setOpen(true)
          }}
          onBlur={() => {
            window.setTimeout(() => setOpen(false), 120)
          }}
          placeholder="Search operator…"
          className="w-full px-3 py-2 rounded-md bg-background border border-ds-line/50 text-foreground placeholder:text-neutral-500"
          autoComplete="off"
        />
        {open && !disabled && filtered.length > 0 ? (
          <ul className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-ds-line/50 bg-ds-main shadow-lg text-sm">
            {filtered.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 hover:bg-ds-card border-b border-ds-line/40 last:border-0"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(o.id)
                    setQ('')
                    setOpen(false)
                  }}
                >
                  <span className="text-ds-ink">{o.name}</span>
                  {o.department ? (
                    <span className="block text-[10px] text-neutral-500">{o.department}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}
