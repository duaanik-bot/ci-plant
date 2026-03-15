'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

type InventoryItem = {
  id: string
  materialCode: string
  description: string
  unit: string
  qtyQuarantine: number
  qtyAvailable: number
  qtyReserved: number
  qtyFg: number
  weightedAvgCost: number
  reorderPoint: number
}

export default function InventoryPage() {
  const [items, setItems] = useState<InventoryItem[]>([])
  const [alerts, setAlerts] = useState<InventoryItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      fetch('/api/inventory').then((r) => r.json()),
      fetch('/api/inventory/alerts').then((r) => r.json()),
    ])
      .then(([inv, al]) => {
        setItems(Array.isArray(inv) ? inv : [])
        setAlerts(Array.isArray(al) ? al : [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="p-4 text-slate-400">Loading…</div>

  const n = (v: unknown) => Number(v) || 0
  const value = (i: InventoryItem) => n(i.qtyAvailable) * n(i.weightedAvgCost)

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-amber-400">Inventory</h1>
        <Link
          href="/inventory/grn"
          className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium"
        >
          Goods receipt (GRN)
        </Link>
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
            .filter((i) => n(i.qtyQuarantine) > 0)
            .map((i) => (
              <div key={i.id} className="text-sm py-1 flex justify-between">
                <span>{i.materialCode}</span>
                <span>{n(i.qtyQuarantine)} {i.unit}</span>
              </div>
            ))}
          {items.every((i) => n(i.qtyQuarantine) === 0) && (
            <p className="text-slate-500 text-sm">None</p>
          )}
        </div>
        <div className="rounded-lg border-2 border-green-700/50 bg-green-900/20 p-4">
          <h2 className="font-semibold text-green-300 mb-2">Available</h2>
          {items
            .filter((i) => n(i.qtyAvailable) > 0)
            .map((i) => (
              <div key={i.id} className="text-sm py-1 flex justify-between">
                <span>{i.materialCode}</span>
                <span>{n(i.qtyAvailable)} {i.unit}</span>
              </div>
            ))}
          {items.every((i) => n(i.qtyAvailable) === 0) && (
            <p className="text-slate-500 text-sm">None</p>
          )}
        </div>
        <div className="rounded-lg border-2 border-amber-700/50 bg-amber-900/20 p-4">
          <h2 className="font-semibold text-amber-300 mb-2">Reserved</h2>
          {items
            .filter((i) => n(i.qtyReserved) > 0)
            .map((i) => (
              <div key={i.id} className="text-sm py-1 flex justify-between">
                <span>{i.materialCode}</span>
                <span>{n(i.qtyReserved)} {i.unit}</span>
              </div>
            ))}
          {items.every((i) => n(i.qtyReserved) === 0) && (
            <p className="text-slate-500 text-sm">None</p>
          )}
        </div>
        <div className="rounded-lg border-2 border-blue-700/50 bg-blue-900/20 p-4">
          <h2 className="font-semibold text-blue-300 mb-2">Finished goods</h2>
          {items
            .filter((i) => n(i.qtyFg) > 0)
            .map((i) => (
              <div key={i.id} className="text-sm py-1 flex justify-between">
                <span>{i.materialCode}</span>
                <span>{n(i.qtyFg)} {i.unit}</span>
              </div>
            ))}
          {items.every((i) => n(i.qtyFg) === 0) && (
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
            {items.map((i) => (
              <tr key={i.id} className="hover:bg-slate-800/50">
                <td className="px-4 py-2 font-mono">{i.materialCode}</td>
                <td className="px-4 py-2">{i.description}</td>
                <td className="px-4 py-2">{i.unit}</td>
                <td className="px-4 py-2">{n(i.qtyQuarantine)}</td>
                <td className="px-4 py-2">{n(i.qtyAvailable)}</td>
                <td className="px-4 py-2">{n(i.qtyReserved)}</td>
                <td className="px-4 py-2">{n(i.qtyFg)}</td>
                <td className="px-4 py-2">{n(i.reorderPoint)}</td>
                <td className="px-4 py-2">₹{value(i).toFixed(2)}</td>
                <td className="px-4 py-2">
                  {n(i.qtyQuarantine) > 0 && (
                    <Link href={`/inventory/release/${i.id}`} className="text-amber-400 hover:underline text-xs">
                      Release
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
