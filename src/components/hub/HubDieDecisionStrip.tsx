'use client'

type Props = {
  rackAnchorId: string
  vendorAnchorId: string
}

/** Two-way: rack vs vendor procurement (no in-house die-making). */
export function HubDieDecisionStrip({ rackAnchorId, vendorAnchorId }: Props) {
  const link =
    'inline-flex items-center justify-center rounded-lg border border-slate-600 bg-slate-800/90 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 hover:bg-slate-700/95 hover:border-amber-600/60 transition-colors'

  return (
    <div
      data-testid="hub-die-decision-strip"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-700/80 bg-slate-900/60 px-3 py-2"
      role="navigation"
      aria-label="Die hub decisions"
    >
      <span className="text-[10px] uppercase tracking-wide text-slate-500 w-full sm:w-auto">Die route</span>
      <a href={`#${rackAnchorId}`} className={link}>
        From rack
      </a>
      <a href={`#${vendorAnchorId}`} className={link}>
        Send to vendor
      </a>
    </div>
  )
}
