'use client'

import { useState, useEffect } from 'react'
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

export default function InventoryPage() {
  const [items, setItems] = useState<StockStateItem[]>([])
  const [alerts, setAlerts] = useState<StockStateItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      fetch('/api/inventory/stock-states').then((r) => r.json()),
      fetch('/api/inventory/alerts').then((r) => r.json()),
    ])
      .then(([states, al]) => {
        setItems(Array.isArray(states) ? states : [])
        setAlerts(Array.isArray(al) ? al : [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="p-4 text-slate-400">Loading…</div>

  const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
  const fmtVal = (n: number) => `₹${fmt(n)}`

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-amber-400">Stock States</h1>
        <div className="flex gap-2">
          <Link
            href="/inventory/flow"
            className="px-4 py-2 rounded-lg bg-slate-600 hover:bg-slate-500 text-white text-sm font-medium"
          >
            Inventory Flow
          </Link>
          <Link
            href="/inventory/simulation"
            className="px-4 py-2 rounded-lg bg-slate-600 hover:bg-slate-500 text-white text-sm font-medium"
          >
            Live Simulation
          </Link>
          <Link
            href="/inventory/purchase-requisitions"
            className="px-4 py-2 rounded-lg bg-slate-600 hover:bg-slate-500 text-white text-sm font-medium"
          >
            Purchase Requisitions
          </Link>
          <Link
            href="/inventory/grn"
            className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium"
          >
            Goods receipt (GRN)
          </Link>
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="mb-4 p-3 rounded-lg bg-red-900/30 border border-red-700 text-red-200 text-sm">
          Reorder alert: {alerts.length} material(s) at or below reorder point.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="rounded-lg border-2 border-red-700/50 bg-red-900/20 p-4">
          <h2 className="font-semibold text-red-300 mb-2">Quarantine</h2>
          {items
            .filter((i) => i.qtyQuarantine > 0)
            .map((i) => (
              <div key={i.id} className="text-sm py-1.5 flex flex-col gap-0.5">
                <span className="flex justify-between">
                  <span>{i.materialCode}</span>
                  <span>{fmt(i.qtyQuarantine)} {i.unit}</span>
                </span>
                <span className="text-red-200/80 text-xs">{fmtVal(i.valueQuarantine)}</span>
              </div>
            ))}
          {items.every((i) => i.qtyQuarantine === 0) && (
            <p className="text-slate-500 text-sm">None</p>
          )}
        </div>
        <div className="rounded-lg border-2 border-green-700/50 bg-green-900/20 p-4">
          <h2 className="font-semibold text-green-300 mb-2">Available</h2>
          {items
            .filter((i) => i.qtyAvailable > 0)
            .map((i) => (
              <div key={i.id} className="text-sm py-1.5 flex flex-col gap-0.5">
                <span className="flex justify-between">
                  <span>{i.materialCode}</span>
                  <span>{fmt(i.qtyAvailable)} {i.unit}</span>
                </span>
                <span className="text-green-200/80 text-xs">{fmtVal(i.valueAvailable)}</span>
              </div>
            ))}
          {items.every((i) => i.qtyAvailable === 0) && (
            <p className="text-slate-500 text-sm">None</p>
          )}
        </div>
        <div className="rounded-lg border-2 border-amber-700/50 bg-amber-900/20 p-4">
          <h2 className="font-semibold text-amber-300 mb-2">Reserved / WIP</h2>
          {items
            .filter((i) => i.qtyReserved > 0)
            .map((i) => (
              <div key={i.id} className="text-sm py-1.5 flex flex-col gap-0.5">
                <span className="flex justify-between">
                  <span>{i.materialCode}</span>
                  <span>{fmt(i.qtyReserved)} {i.unit}</span>
                </span>
                <span className="text-amber-200/80 text-xs">{fmtVal(i.valueReserved)}</span>
              </div>
            ))}
          {items.every((i) => i.qtyReserved === 0) && (
            <p className="text-slate-500 text-sm">None</p>
          )}
        </div>
        <div className="rounded-lg border-2 border-blue-700/50 bg-blue-900/20 p-4">
          <h2 className="font-semibold text-blue-300 mb-2">Finished Goods</h2>
          {items
            .filter((i) => i.qtyFg > 0)
            .map((i) => (
              <div key={i.id} className="text-sm py-1.5 flex flex-col gap-0.5">
                <span className="flex justify-between">
                  <span>{i.materialCode}</span>
                  <span>{fmt(i.qtyFg)} {i.unit}</span>
                </span>
                <span className="text-blue-200/80 text-xs">{fmtVal(i.valueFg)}</span>
              </div>
            ))}
          {items.every((i) => i.qtyFg === 0) && (
            <p className="text-slate-500 text-sm">None</p>
          )}
        </div>
      </div>

      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-left">
            <tr>
              <th className="px-4 py-2">Code</th>
              <th className="px-4 py-2">Description</th>
              <th className="px-4 py-2">Unit</th>
              <th className="px-4 py-2">Quarantine</th>
              <th className="px-4 py-2">Available</th>
              <th className="px-4 py-2">Reserved</th>
              <th className="px-4 py-2">FG</th>
              <th className="px-4 py-2">Reorder</th>
              <th className="px-4 py-2">Value (est)</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {items.map((i) => {
              const totalVal = i.valueQuarantine + i.valueAvailable + i.valueReserved + i.valueFg
              return (
                <tr key={i.id} className="hover:bg-slate-800/50">
                  <td className="px-4 py-2 font-mono">{i.materialCode}</td>
                  <td className="px-4 py-2">{i.description}</td>
                  <td className="px-4 py-2">{i.unit}</td>
                  <td className="px-4 py-2">{fmt(i.qtyQuarantine)}</td>
                  <td className="px-4 py-2">{fmt(i.qtyAvailable)}</td>
                  <td className="px-4 py-2">{fmt(i.qtyReserved)}</td>
                  <td className="px-4 py-2">{fmt(i.qtyFg)}</td>
                  <td className="px-4 py-2">{fmt(i.reorderPoint)}</td>
                  <td className="px-4 py-2">{fmtVal(totalVal)}</td>
                  <td className="px-4 py-2">
                    {i.qtyQuarantine > 0 && (
                      <Link href={`/inventory/release/${i.id}`} className="text-amber-400 hover:underline text-xs">
                        Release
                      </Link>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
