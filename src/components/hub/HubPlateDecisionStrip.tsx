'use client'

/** Decision-first navigation: jump to CTP rack, live rack, or vendor PO context. */
export function HubPlateDecisionStrip() {
  const link =
    'inline-flex items-center justify-center rounded-lg border border-ds-line/60 bg-ds-elevated/90 px-2.5 py-1.5 text-[11px] font-medium text-ds-ink hover:bg-ds-elevated/95 hover:border-ds-warning/50 transition-colors'

  return (
    <div
      data-testid="hub-plate-decision-strip"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-ds-line/50 bg-ds-card/60 px-3 py-2"
      role="navigation"
      aria-label="Plate hub decisions"
    >
      <span className="text-[10px] uppercase tracking-wide text-ds-ink-faint w-full sm:w-auto">Decide route</span>
      <a href="#ctp-production-queue" className={link}>
        In-house CTP
      </a>
      <a href="#plate-live-rack" className={link}>
        From rack
      </a>
      <a href="#plate-vendor-procurement" className={link}>
        Outside vendor
      </a>
    </div>
  )
}
