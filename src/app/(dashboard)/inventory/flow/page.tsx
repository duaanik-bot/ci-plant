'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'

type FlowSummary = {
  approvedSuppliers: number
  grnThisMonth: number
  grnValueReceived: number
  quarantineLots: number
  quarantineTotal: number
  availableMaterials: number
  availableValue: number
  reservedValue: number
  fgCartons: number
  wasteLedgerPct: number
  fgPallets: number
  fgAvailable: number
  fgOnHold: number
  fgBlocked: number
  dispatchedThisMonth: number
  dispatchedValue: number
}

type TraceItem = { stage: string; detail: string }

export default function InventoryFlowPage() {
  const [traceQuery, setTraceQuery] = useState('')
  const [traceResult, setTraceResult] = useState<{ query: string; trace: TraceItem[] } | null>(null)
  const [traceLoading, setTraceLoading] = useState(false)

  const { data: summary, isLoading } = useQuery<FlowSummary>({
    queryKey: ['inventory-flow-summary'],
    queryFn: () => fetch('/api/inventory/flow-summary').then((r) => r.json()),
    refetchInterval: 30_000,
  })

  const runTrace = () => {
    if (!traceQuery.trim()) return
    setTraceLoading(true)
    fetch(`/api/inventory/trace/${encodeURIComponent(traceQuery.trim())}`)
      .then((r) => r.json())
      .then(setTraceResult)
      .catch(() => setTraceResult({ query: traceQuery, trace: [{ stage: 'Error', detail: 'Query failed' }] }))
      .finally(() => setTraceLoading(false))
  }

  const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 0 })
  const fmtRupee = (n: number) => `₹${fmt(n)}`

  if (isLoading || !summary) return <div className="p-4 text-ds-ink-muted">Loading…</div>

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-ds-warning">Inventory Flow</h1>
        <Link href="/inventory" className="text-ds-ink-muted hover:text-foreground text-sm">← Stock States</Link>
      </div>

      <div className="space-y-3 text-sm">
        <div className="rounded-ds-md border border-ds-line/60 bg-ds-elevated/50 p-3">
          <p className="text-ds-ink-muted">Approved suppliers</p>
          <p className="text-xl font-semibold text-foreground">{summary.approvedSuppliers} active</p>
        </div>
        <p className="text-ds-ink-faint text-center">↓</p>
        <div className="rounded-ds-md border border-ds-line/60 bg-ds-elevated/50 p-3">
          <p className="text-ds-ink-muted">GRN this month</p>
          <p className="text-xl font-semibold text-foreground">{summary.grnThisMonth} receipts · {fmtRupee(summary.grnValueReceived)}</p>
        </div>
        <p className="text-ds-ink-faint text-center">↓</p>
        <div className="rounded-ds-md border border-[var(--error)]/50 bg-[var(--error-bg)] p-3">
          <p className="text-[var(--error)]">Quarantine</p>
          <p className="text-xl font-semibold text-foreground">{summary.quarantineLots} lots · {fmt(summary.quarantineTotal)} total</p>
        </div>
        <p className="text-ds-ink-faint text-center">↓ QA Released</p>
        <div className="rounded-ds-md border border-[var(--success)]/50 bg-[var(--success-bg)] p-3">
          <p className="text-[var(--success)]">Available stock</p>
          <p className="text-xl font-semibold text-foreground">{summary.availableMaterials} materials · {fmtRupee(summary.availableValue)}</p>
        </div>
        <p className="text-ds-ink-faint text-center">↓ Work order</p>
        <div className="rounded-ds-md border border-ds-warning/30 bg-ds-warning/8 p-3">
          <p className="text-ds-warning">Reserved / WIP</p>
          <p className="text-xl font-semibold text-foreground">{fmtRupee(summary.reservedValue)}</p>
        </div>
        <p className="text-ds-ink-faint text-center">↓ Production complete</p>
        <div className="rounded-ds-md border border-ds-line/60 bg-ds-elevated/50 p-3">
          <p className="text-ds-ink-muted">Good output → FG</p>
          <p className="text-foreground">{fmt(summary.fgCartons)} cartons</p>
          <p className="text-ds-ink-faint text-xs">Waste → Ledger: {summary.wasteLedgerPct}%</p>
        </div>
        <p className="text-ds-ink-faint text-center">↓</p>
        <div className="rounded-ds-md border border-[var(--info)]/50 bg-[var(--info-bg)] p-3">
          <p className="text-[var(--info)]">Finished goods</p>
          <p className="text-foreground">{summary.fgPallets} pallets · Available: {summary.fgAvailable} · On hold: {summary.fgOnHold} · Blocked: {summary.fgBlocked}</p>
        </div>
        <p className="text-ds-ink-faint text-center">↓</p>
        <div className="rounded-ds-md border border-ds-line/60 bg-ds-elevated/50 p-3">
          <p className="text-ds-ink-muted">Dispatched this month</p>
          <p className="text-xl font-semibold text-foreground">{fmt(summary.dispatchedThisMonth)} cartons · {fmtRupee(summary.dispatchedValue)}</p>
        </div>
      </div>

      <div className="mt-10 rounded-ds-md border border-ds-line/60 bg-ds-elevated/30 p-4">
        <h2 className="font-semibold text-ds-ink-muted mb-2">Lot traceability</h2>
        <p className="text-ds-ink-faint text-xs mb-2">Enter batch number, job number, or material lot. Query time &lt; 2s.</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={traceQuery}
            onChange={(e) => setTraceQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runTrace()}
            placeholder="Batch / Job / Material"
            className="flex-1 px-3 py-2 rounded-ds-md bg-ds-elevated border border-ds-line/60 text-foreground"
          />
          <button
            type="button"
            onClick={runTrace}
            disabled={traceLoading}
            className="px-4 py-2 rounded-ds-md bg-ds-warning hover:bg-ds-warning disabled:opacity-50 text-primary-foreground font-medium"
          >
            {traceLoading ? '…' : 'Query'}
          </button>
        </div>
        {traceResult && (
          <div className="mt-4 space-y-1 text-sm">
            <p className="text-ds-ink-muted">Result for &quot;{traceResult.query}&quot;</p>
            {traceResult.trace.map((t, i) => (
              <div key={i} className="flex gap-2 py-1">
                <span className="text-ds-warning font-mono">{t.stage}:</span>
                <span className="text-ds-ink-muted">{t.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
