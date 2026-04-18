import type { ReactNode } from 'react'

export function IndustrialKpiTile({
  label,
  value,
  hint,
  valueClassName = 'text-slate-100',
}: {
  label: string
  value: ReactNode
  hint?: string
  valueClassName?: string
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-slate-950/35 px-3 py-2 backdrop-blur-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07)]">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-0.5 text-xl md:text-2xl font-semibold tabular-nums ${valueClassName}`}>
        {value}
      </div>
      {hint ? <div className="text-[10px] text-slate-600 mt-0.5">{hint}</div> : null}
    </div>
  )
}
