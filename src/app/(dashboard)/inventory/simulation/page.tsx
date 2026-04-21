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
  if (reorderPoint <= 0) return { text: '● Available', cls: 'text-green-400' }
  if (available <= 0) return { text: '🔴 Critical', cls: 'text-red-400' }
  if (available <= reorderPoint) return { text: '⚠ Below Reorder', cls: 'text-amber-400' }
  return { text: '● Available', cls: 'text-green-400' }
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
        <h1 className="text-xl font-bold text-amber-400">Live Stock Simulation</h1>
        <Link href="/inventory" className="text-slate-400 hover:text-foreground text-sm">
          ← Stock States
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-sm text-slate-400 mb-1">Active job</label>
          <select
            value={selectedJobId}
            onChange={(e) => setSelectedJobId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
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
            className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-primary-foreground text-sm font-medium"
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
              className="rounded-lg border border-slate-600 bg-slate-800/50 p-4"
            >
              <p className="font-mono text-amber-400 text-sm">{m.materialCode}</p>
              <p className="text-slate-400 text-xs mb-2">{m.description}</p>
              <p className="text-2xl font-bold text-foreground">
                {m.qtyAvailable.toLocaleString()} {m.unit}
              </p>
              <p className="text-red-400 text-sm">Reserved: {m.qtyReserved.toLocaleString()} {m.unit}</p>
              <p className="text-slate-500 text-xs mt-1">Reorder: {m.reorderPoint.toLocaleString()}</p>
              <p className={`text-sm mt-2 ${status.cls}`}>{status.text}</p>
            </div>
          )
        })}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="rounded-lg border border-amber-700/50 bg-amber-900/20 p-4">
          <h2 className="font-semibold text-amber-300 mb-2">WIP</h2>
          <p className="text-2xl font-bold text-foreground">
            {wipQty.toLocaleString()} units
          </p>
          <p className="text-amber-200/80">Est. cost ₹{wipValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</p>
        </div>
        <div className="rounded-lg border border-blue-700/50 bg-blue-900/20 p-4">
          <h2 className="font-semibold text-blue-300 mb-2">Finished Goods</h2>
          <p className="text-2xl font-bold text-foreground">
            {fgQty.toLocaleString()} units
          </p>
          <p className="text-blue-200/80">Value ₹{fgValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</p>
        </div>
      </div>

      <div className="rounded-lg border border-slate-600 bg-slate-800/30 p-4">
        <h2 className="font-semibold text-slate-300 mb-2">Activity log (last 20)</h2>
        <div className="max-h-64 overflow-y-auto space-y-1 text-sm">
          {activityLog.length === 0 && (
            <p className="text-slate-500">No movements yet.</p>
          )}
          {activityLog.map((a) => (
            <div key={a.id} className="flex justify-between py-1 border-b border-slate-700/50">
              <span className="text-slate-300">
                {a.movementType} · {a.materialCode} · {a.qty} {a.unit}
              </span>
              <span className="text-slate-500 text-xs">
                {new Date(a.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
