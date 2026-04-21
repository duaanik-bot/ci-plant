'use client'

import { useLayoutEffect, useRef } from 'react'
import { lineItemMatchesDrawerQuery } from '@/lib/po-list-deep-filter'
import { spotlightHighlightText } from '@/lib/spotlight-highlight'

type Line = {
  id: string
  cartonName: string
  quantity: number
  rate: number | null
}

type ToolingRow = { key: number; signal: 'green' | 'yellow' | 'red'; tooltip: string }

export function PoDrawerSpotlightLines({
  lineItems,
  toolingResults,
  spotlightQuery,
  poMono,
}: {
  lineItems: Line[]
  toolingResults: ToolingRow[] | null
  /** Active list filter (≥2 chars) or empty when no filter */
  spotlightQuery: string
  poMono: string
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const active = spotlightQuery.trim().length >= 2

  useLayoutEffect(() => {
    if (!active) return
    const root = listRef.current
    if (!root) return
    const first = root.querySelector<HTMLElement>('[data-spotlight-match="true"]')
    first?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [active, spotlightQuery, lineItems.length])

  return (
    <>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
        Line items
      </div>
      <div className="mb-2 grid grid-cols-[1fr_auto_auto] gap-x-2 text-[9px] font-semibold uppercase tracking-wide text-slate-500 border-b border-slate-800 pb-1">
        <span>Carton</span>
        <span className="text-right">Qty</span>
        <span className="text-right">₹</span>
      </div>
      <ul ref={listRef} className="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
        {lineItems.map((li, i) => {
          const tr = toolingResults?.find((t) => t.key === i)
          const dot =
            tr?.signal === 'green'
              ? 'bg-emerald-500'
              : tr?.signal === 'yellow'
                ? 'bg-amber-500'
                : 'bg-rose-500'
          const isSpotlight =
            active && lineItemMatchesDrawerQuery(li.cartonName, spotlightQuery)
          return (
            <li
              key={li.id}
              data-spotlight-match={isSpotlight ? 'true' : undefined}
              className={`rounded-md border px-2 py-1.5 text-xs transition-colors ${
                isSpotlight
                  ? 'border-l-2 border-l-orange-500 bg-orange-500/10 border-slate-800/90'
                  : 'border border-slate-800/90 bg-background'
              }`}
            >
              <div className="flex items-start gap-2">
                <span
                  className={`mt-1 h-2 w-2 shrink-0 rounded-full ring-2 ring-ring ${dot}`}
                  title={tr?.tooltip}
                />
                <div className="min-w-0 flex-1 grid grid-cols-[1fr_auto_auto] gap-x-2 items-start">
                  <div className="min-w-0 flex items-center gap-1.5 flex-wrap">
                    <span className="font-medium text-slate-200 truncate">
                      {active
                        ? spotlightHighlightText(li.cartonName, spotlightQuery.trim())
                        : li.cartonName}
                    </span>
                    {isSpotlight ? (
                      <span className="shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-orange-400/95 ring-1 ring-orange-500/35 bg-orange-500/10">
                        Match found
                      </span>
                    ) : null}
                  </div>
                  <span className={`${poMono} text-slate-300 text-[11px] text-right tabular-nums`}>
                    {li.quantity}
                  </span>
                  <span className={`${poMono} text-slate-200 text-[11px] text-right tabular-nums`}>
                    {li.rate != null
                      ? (Number(li.rate) * li.quantity).toLocaleString('en-IN', {
                          maximumFractionDigits: 0,
                        })
                      : '—'}
                  </span>
                  <div className={`col-span-3 ${poMono} text-slate-500 text-[10px]`}>
                    {li.rate != null
                      ? `₹${Number(li.rate).toLocaleString('en-IN', { maximumFractionDigits: 2 })} ea`
                      : ''}
                  </div>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}
