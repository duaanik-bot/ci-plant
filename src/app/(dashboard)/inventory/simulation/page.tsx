'use client'

import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'

type StockStateItem = {
  id: string
  materialCode: string
  description: string
  unit: string
  qtyQuarantine: number
  qtyAvailable: number
  qtyReserved: number
  qtyFg: number
  reorderPoint: number
  valueQuarantine: number
  valueAvailable: number
  valueReserved: number
  valueFg: number
}

type Job = { id: string; jobNumber: string; productName: string; status: string; customer: { name: string } }

type ActivityItem = {
  id: string
  materialCode: string
  movementType: string
  qty: number
  unit: string
  createdAt: string
}

function pickMaterials(items: StockStateItem[]) {
  const board = items.find((i) => i.materialCode.startsWith('BRD-'))
  const ink = items.find((i) => i.materialCode.startsWith('INK-'))
  const foil = items.find((i) => i.materialCode.startsWith('FOIL-') || i.materialCode.startsWith('LAM-') || i.materialCode.startsWith('VRN-'))
  return [board || items[0], ink || items[1], foil || items[2]].filter(Boolean) as StockStateItem[]
}

function statusIndicator(available: number, reorderPoint: number) {
  if (reorderPoint <= 0) return { text: '● Available', cls: 'text-[var(--success)]' }
  if (available <= 0) return { text: '🔴 Critical', cls: 'text-[var(--error)]' }
  if (available <= reorderPoint) return { text: '⚠ Below Reorder', cls: 'text-ds-warning' }
  return { text: '● Available', cls: 'text-[var(--success)]' }
}

export default function SimulationPage() {
  const [selectedJobId, setSelectedJobId] = useState<string>('')

  const { data: jobs = [] } = useQuery<Job[]>({
    queryKey: ['jobs-active'],
    queryFn: () => fetch('/api/jobs/active').then((r) => r.json()),
    refetchInterval: 30_000,
  })

  const { data: stockStates = [] } = useQuery<StockStateItem[]>({
    queryKey: ['inventory-stock-states'],
    queryFn: () => fetch('/api/inventory/stock-states').then((r) => r.json()),
    refetchInterval: 30_000,
  })

  const { data: activityLog = [] } = useQuery<ActivityItem[]>({
    queryKey: ['inventory-activity-log'],
    queryFn: () => fetch('/api/inventory/activity-log?limit=20').then((r) => r.json()),
    refetchInterval: 30_000,
  })

  const materials = pickMaterials(stockStates)
  const wipValue = stockStates.reduce((s, i) => s + i.valueReserved, 0)
  const wipQty = stockStates.reduce((s, i) => s + i.qtyReserved, 0)
  const fgQty = stockStates.reduce((s, i) => s + i.qtyFg, 0)
  const fgValue = stockStates.reduce((s, i) => s + i.valueFg, 0)

  return (
    <div className="p-4 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-[var(--brand-primary)]">Live Stock Simulation</h1>
        <Link href="/inventory" className="text-ds-ink-muted hover:text-foreground text-sm">
          ← Stock States
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Active job</label>
          <select
            value={selectedJobId}
            onChange={(e) => setSelectedJobId(e.target.value)}
            className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated text-foreground"
          >
            <option value="">— Select job —</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.jobNumber} — {j.productName}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          <button
            type="button"
            className="px-4 py-2 rounded-ds-md bg-[var(--brand-primary)] hover:bg-[var(--brand-primary)] text-primary-foreground text-sm font-medium"
          >
            Simulate Stage Completion
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {materials.map((m) => {
          const status = statusIndicator(m.qtyAvailable, m.reorderPoint)
          return (
            <div
              key={m.id}
              className="rounded-ds-md bg-ds-elevated/50 p-4"
            >
              <p className="font-mono text-ds-warning text-sm">{m.materialCode}</p>
              <p className="text-ds-ink-muted text-xs mb-2">{m.description}</p>
              <p className="text-2xl font-bold text-foreground">
                {m.qtyAvailable.toLocaleString()} {m.unit}
              </p>
              <p className="text-[var(--error)] text-sm">Reserved: {m.qtyReserved.toLocaleString()} {m.unit}</p>
              <p className="text-ds-ink-faint text-xs mt-1">Reorder: {m.reorderPoint.toLocaleString()}</p>
              <p className={`text-sm mt-2 ${status.cls}`}>{status.text}</p>
            </div>
          )
        })}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="rounded-ds-md bg-ds-warning/8 p-4">
          <h2 className="font-semibold text-[var(--brand-primary)] mb-2">WIP</h2>
          <p className="text-2xl font-bold text-foreground">
            {wipQty.toLocaleString()} units
          </p>
          <p className="text-ds-warning/80">Est. cost ₹{wipValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</p>
        </div>
        <div className="rounded-ds-md bg-[var(--info-bg)] p-4">
          <h2 className="font-semibold text-[var(--info)] mb-2">Finished Goods</h2>
          <p className="text-2xl font-bold text-foreground">
            {fgQty.toLocaleString()} units
          </p>
          <p className="text-[var(--info)]/80">Value ₹{fgValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</p>
        </div>
      </div>

      <div className="rounded-ds-md bg-ds-elevated/30 p-4">
        <h2 className="font-semibold text-ds-ink-muted mb-2">Activity log (last 20)</h2>
        <div className="max-h-64 overflow-y-auto space-y-1 text-sm">
          {activityLog.length === 0 && (
            <p className="text-ds-ink-faint">No movements yet.</p>
          )}
          {activityLog.map((a) => (
            <div key={a.id} className="flex justify-between py-1">
              <span className="text-ds-ink-muted">
                {a.movementType} · {a.materialCode} · {a.qty} {a.unit}
              </span>
              <span className="text-ds-ink-faint text-xs">
                {new Date(a.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
