'use client'

/** Decision-first navigation: jump to CTP rack, live rack, or vendor PO context. */
export function HubPlateDecisionStrip() {
  const link =
    'inline-flex items-center justify-center rounded-lg bg-ds-elevated/90 px-2.5 py-1.5 text-xs font-medium text-ds-ink hover:bg-ds-elevated/95 transition-colors'

  return (
    <div
      data-testid="hub-plate-decision-strip"
      className="flex flex-wrap items-center gap-2 rounded-lg bg-ds-card/60 px-3 py-2"
      role="navigation"
      aria-label="Plate hub decisions"
    >
      <span className="text-xs uppercase tracking-wide text-ds-ink-faint w-full sm:w-auto">Decide route</span>
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
