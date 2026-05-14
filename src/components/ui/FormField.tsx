import type { ReactNode } from 'react'

type Props = {
  label: string
  required?: boolean
  error?: string
  helper?: string
  children: ReactNode
}

export function FormField({ label, required, error, helper, children }: Props) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium uppercase tracking-[0.06em] text-ds-ink-muted">
        {label}
        {required ? <span className="ml-0.5 text-[var(--error)]">*</span> : null}
      </label>
      <div className={error ? 'rounded-ds-sm border border-[var(--error)]/70 p-1' : ''}>{children}</div>
      {error ? <p className="text-xs text-[var(--error)]">{error}</p> : null}
      {!error && helper ? <p className="text-xs text-ds-ink-faint">{helper}</p> : null}
    </div>
  )
}
