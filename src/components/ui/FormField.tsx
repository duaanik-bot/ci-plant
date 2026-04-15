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
      <label className="block text-sm text-slate-300">
        {label}
        {required ? <span className="text-red-400 ml-0.5">*</span> : null}
      </label>
      <div className={error ? 'rounded-lg border border-red-500' : ''}>{children}</div>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      {!error && helper ? <p className="text-xs text-slate-500">{helper}</p> : null}
    </div>
  )
}
