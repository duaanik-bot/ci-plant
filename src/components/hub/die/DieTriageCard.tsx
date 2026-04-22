'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { HubCardDeleteAction } from '@/components/hub/HubCardDeleteAction'
import { HubPriorityController, HubPriorityRankBadge } from '@/components/hub/HubPriorityController'
import { HubPriorityReorderAuditFooter } from '@/components/hub/HubPriorityReorderAuditFooter'
import type { HubPriorityDomain } from '@/lib/hub-priority-domain'
import { hubQueueAgeLabel } from '@/lib/hub-card-time'
import { safeJsonParse } from '@/lib/safe-json'
import type { SimilarDieMatch } from '@/components/hub/die/SimilarDiesModal'

/** Die row fields needed for incoming triage (Die Hub). */
export type DieTriageCardRow = {
  id: string
  displayCode: string
  title: string
  ledgerRank: number
  dimensionsLwh: string
  dimensionsLabel: string
  lastStatusUpdatedAt: string
  similarMatches: SimilarDieMatch[]
  typeMismatchMatches?: SimilarDieMatch[]
  masterType?: string | null
  hubConditionPoor?: boolean
  hubTriageHoldReason?: string | null
  lastReorderedBy?: string | null
  lastReorderedAt?: string | null
}

type RackPickItem = { id: string; displayCode: string; subtitle: string }

export function DieTriageCard({
  r,
  saving,
  onOpenAudit,
  onRouteToVendor,
  onTakeFromStock,
  onManualLink,
  onTriageHold,
  onSimilarClick,
  onReverse,
  onDeleted,
  specs,
  hubColumnPriority,
}: {
  r: DieTriageCardRow
  saving: boolean
  onOpenAudit: () => void
  onRouteToVendor: () => void
  onTakeFromStock: () => void
  onManualLink: (inventoryDyeId: string) => void
  onTriageHold: (placeOnHold: boolean, reason?: string) => void
  onSimilarClick: () => void
  onReverse: () => void
  onDeleted: () => void
  specs: React.ReactNode
  hubColumnPriority?: {
    domain: HubPriorityDomain
    rank: number
    isFirst: boolean
    isLast: boolean
    onSuccess: () => void
  }
}) {
  const mismatch = r.typeMismatchMatches ?? []
  const hasTypeMismatch = mismatch.length > 0
  const hasSimilar = !hasTypeMismatch && r.similarMatches.length > 0
  const dimTitle = r.dimensionsLwh || r.dimensionsLabel
  const onHold = !!r.hubTriageHoldReason?.trim()

  const [holdReasonDraft, setHoldReasonDraft] = useState('Query with Client.')
  const [manualQ, setManualQ] = useState('')
  const [manualFocused, setManualFocused] = useState(false)
  const [pickLoading, setPickLoading] = useState(false)
  const [pickItems, setPickItems] = useState<RackPickItem[]>([])

  useEffect(() => {
    if (onHold) return
    const q = manualQ.trim()
    if (!manualFocused && !q) {
      setPickItems([])
      return
    }
    const handle = window.setTimeout(() => {
      void (async () => {
        setPickLoading(true)
        try {
          const qs = q ? `&q=${encodeURIComponent(q)}` : ''
          const res = await fetch(`/api/tooling-hub/dies/rack-picklist?limit=40${qs}`)
          const t = await res.text()
          const j = safeJsonParse<{ items?: RackPickItem[] }>(t, {})
          setPickItems(Array.isArray(j.items) ? j.items : [])
        } catch {
          setPickItems([])
        } finally {
          setPickLoading(false)
        }
      })()
    }, 260)
    return () => clearTimeout(handle)
  }, [manualQ, manualFocused, onHold])

  const triageLocked = saving || onHold

  return (
    <motion.li
      data-hub-die-id={r.id}
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.2 }}
      className={`rounded-lg border bg-background p-2 overflow-visible ${
        onHold
          ? 'border-yellow-500/70 shadow-[0_0_16px_rgba(234,179,8,0.22)] ring-2 ring-yellow-400/35'
          : 'border-zinc-800'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[10px] text-amber-300/90 truncate">{r.displayCode}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <HubCardDeleteAction
            asset="die"
            recordId={r.id}
            disabled={saving}
            triggerClassName="relative shrink-0"
            onDeleted={onDeleted}
          />
          <button
            type="button"
            disabled={saving}
            title="Undo last hub action"
            className="text-[10px] font-bold uppercase tracking-wide text-amber-200/90 border border-amber-700/60 rounded px-1.5 py-0.5 hover:bg-amber-950/50 disabled:opacity-50 whitespace-nowrap"
            onClick={onReverse}
          >
            ↺ Reverse
          </button>
          {hasTypeMismatch ? (
            <button
              type="button"
              onClick={onSimilarClick}
              className="text-[9px] font-bold uppercase tracking-wider text-red-400 border border-red-600/60 rounded px-1.5 py-0.5 hover:bg-red-950/40"
            >
              Type mismatch
            </button>
          ) : hasSimilar ? (
            <button
              type="button"
              onClick={onSimilarClick}
              className="text-[9px] font-bold uppercase tracking-wider text-amber-500 border border-amber-600/60 rounded px-1.5 py-0.5 hover:bg-amber-950/50"
            >
              Similar
            </button>
          ) : null}
          {hubColumnPriority ? <HubPriorityRankBadge rank={hubColumnPriority.rank} /> : null}
        </div>
      </div>
      <p className="text-[11px] text-zinc-500 truncate mt-1" title={r.title}>
        {r.title}
      </p>
      {onHold ? (
        <p className="mt-1 text-[10px] text-yellow-200/90 leading-snug">
          <span className="font-bold uppercase tracking-wide text-yellow-400">On hold</span>
          {r.hubTriageHoldReason ? `: ${r.hubTriageHoldReason}` : null}
        </p>
      ) : null}
      {r.hubConditionPoor ? (
        <p className="mt-1 text-[9px] font-bold uppercase tracking-wider text-red-400 border border-red-700/60 rounded px-1.5 py-0.5 w-fit">
          Poor condition
        </p>
      ) : null}
      <button
        type="button"
        className="text-left w-full text-blue-400 hover:text-blue-300 hover:underline font-semibold text-sm mt-0.5 truncate"
        onClick={onOpenAudit}
      >
        {dimTitle}
      </button>
      {specs}

      <div className="mt-2 space-y-2">
        <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Command center</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            disabled={triageLocked}
            className="py-1.5 rounded-md bg-orange-600 hover:bg-orange-500 text-foreground text-xs font-bold disabled:opacity-50 shadow-sm"
            onClick={onRouteToVendor}
          >
            Route to vendor
          </button>
          <button
            type="button"
            disabled={triageLocked}
            className="py-1.5 rounded-md border border-zinc-500 bg-zinc-900 hover:bg-zinc-800 text-zinc-100 text-xs font-semibold disabled:opacity-50"
            onClick={onTakeFromStock}
          >
            Pull from rack
          </button>
        </div>

        <div className={`rounded-md border border-zinc-700 bg-zinc-950/80 p-2 ${triageLocked ? 'opacity-50 pointer-events-none' : ''}`}>
          <p className="text-[10px] font-semibold text-zinc-400 mb-1">Manual link (any rack die)</p>
          <input
            value={manualQ}
            onChange={(e) => setManualQ(e.target.value)}
            onFocus={() => setManualFocused(true)}
            onBlur={() => window.setTimeout(() => setManualFocused(false), 160)}
            disabled={triageLocked}
            placeholder="Search DYE #, dimensions, pasting…"
            className="w-full px-2 py-1.5 rounded border border-zinc-600 bg-background text-foreground text-xs placeholder:text-zinc-600"
          />
          {manualFocused && (pickLoading || pickItems.length > 0) ? (
            <ul className="mt-1 max-h-36 overflow-y-auto rounded border border-zinc-800 bg-background text-xs">
              {pickLoading && pickItems.length === 0 ? (
                <li className="px-2 py-2 text-zinc-500">Searching…</li>
              ) : null}
              {pickItems.map((it) => (
                <li key={it.id}>
                  <button
                    type="button"
                    disabled={triageLocked}
                    className="w-full text-left px-2 py-1.5 hover:bg-zinc-900 border-b border-zinc-900 last:border-0"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onManualLink(it.id)
                      setManualQ('')
                      setPickItems([])
                    }}
                  >
                    <span className="font-mono text-amber-200/90">{it.displayCode}</span>
                    <span className="block text-[10px] text-zinc-500 leading-tight">{it.subtitle}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="rounded-md border border-yellow-800/50 bg-yellow-950/20 p-2 space-y-2">
          {onHold ? (
            <button
              type="button"
              disabled={saving}
              className="w-full py-1.5 rounded-md border border-yellow-600/70 bg-yellow-950/40 text-yellow-100 text-xs font-bold hover:bg-yellow-950/60 disabled:opacity-50"
              onClick={() => onTriageHold(false)}
            >
              Release on-hold
            </button>
          ) : (
            <>
              <label className="block text-[10px] text-zinc-400">
                Hold reason (logged)
                <textarea
                  value={holdReasonDraft}
                  onChange={(e) => setHoldReasonDraft(e.target.value)}
                  rows={2}
                  disabled={saving}
                  className="mt-1 w-full px-2 py-1.5 rounded border border-zinc-600 bg-background text-foreground text-xs"
                />
              </label>
              <button
                type="button"
                disabled={saving || !holdReasonDraft.trim()}
                className="w-full py-1.5 rounded-md bg-yellow-700 hover:bg-yellow-600 text-foreground text-xs font-bold disabled:opacity-50"
                onClick={() => onTriageHold(true, holdReasonDraft.trim())}
              >
                On-hold
              </button>
            </>
          )}
        </div>
      </div>

      <p className="mt-1.5 text-[10px] leading-tight text-zinc-500">
        Time in triage: {hubQueueAgeLabel(r.lastStatusUpdatedAt)}
      </p>
      <HubPriorityReorderAuditFooter
        lastReorderedBy={r.lastReorderedBy}
        lastReorderedAt={r.lastReorderedAt}
      />
      {hubColumnPriority ? (
        <div className="mt-1.5 flex justify-end">
          <HubPriorityController
            domain={hubColumnPriority.domain}
            entityId={r.id}
            isFirst={hubColumnPriority.isFirst}
            isLast={hubColumnPriority.isLast}
            disabled={saving}
            onSuccess={hubColumnPriority.onSuccess}
          />
        </div>
      ) : null}
    </motion.li>
  )
}
