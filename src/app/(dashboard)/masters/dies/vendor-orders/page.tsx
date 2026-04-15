'use client'

import { useEffect, useMemo, useState } from 'react'

type Order = {
  id: string
  orderCode: string
  orderedAt: string
  orderType: string
  cartonName: string | null
  cartonSize: string | null
  dieType: string | null
  ups: number | null
  sheetSize: string | null
  vendorName: string
  expectedBy: string | null
  quotedCost: string | null
  priority: string
  status: string
}

export default function DieVendorOrdersPage() {
  const [rows, setRows] = useState<Order[]>([])
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    fetch('/api/die-vendor-orders').then((r) => r.json()).then((data) => setRows(Array.isArray(data) ? data : []))
  }, [refresh])

  const today = Date.now()
  const withOverdue = useMemo(() => rows.map((r) => {
    const overdueDays = r.expectedBy && r.status !== 'received'
      ? Math.max(0, Math.floor((today - new Date(r.expectedBy).getTime()) / (1000 * 60 * 60 * 24)))
      : 0
    return { ...r, overdueDays }
  }), [rows, today])

  async function updateStatus(id: string, status: string) {
    await fetch(`/api/die-vendor-orders/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    setRefresh((x) => x + 1)
  }

  async function markReceived(id: string) {
    await fetch(`/api/die-vendor-orders/${id}/receive`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ condition: 'New', storageLocation: 'Die Rack A-1', compartment: 'Compartment 1' }),
    })
    setRefresh((x) => x + 1)
  }

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-4">
      <h1 className="text-xl font-bold text-amber-400">Vendor Orders</h1>
      <div className="rounded-xl border border-slate-700 overflow-x-auto">
        <table className="w-full text-xs text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-2 py-2">Order</th><th className="px-2 py-2">Date</th><th className="px-2 py-2">Type</th>
              <th className="px-2 py-2">Carton</th><th className="px-2 py-2">Die Spec</th><th className="px-2 py-2">Vendor</th>
              <th className="px-2 py-2">Expected</th><th className="px-2 py-2">Priority</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {withOverdue.map((o) => (
              <tr key={o.id} className="border-t border-slate-800">
                <td className="px-2 py-2 font-mono text-amber-300">{o.orderCode}</td>
                <td className="px-2 py-2">{new Date(o.orderedAt).toLocaleDateString('en-IN')}</td>
                <td className="px-2 py-2">{o.orderType}</td>
                <td className="px-2 py-2">{o.cartonName ?? '-'}</td>
                <td className="px-2 py-2">{o.dieType ?? '-'} · {o.ups ?? '-'} up · {o.sheetSize ?? '-'}</td>
                <td className="px-2 py-2">{o.vendorName}</td>
                <td className="px-2 py-2">{o.expectedBy ? new Date(o.expectedBy).toLocaleDateString('en-IN') : '-'} {o.overdueDays > 0 ? <span className="text-red-400">OVERDUE {o.overdueDays}d</span> : null}</td>
                <td className="px-2 py-2">{o.priority}</td>
                <td className="px-2 py-2">{o.status}</td>
                <td className="px-2 py-2">
                  <div className="flex gap-2">
                    <select value={o.status} onChange={(e) => updateStatus(o.id, e.target.value)} className="bg-slate-800 border border-slate-600 rounded px-1 py-0.5 text-xs">
                      <option>ordered</option><option>confirmed</option><option>in_manufacturing</option><option>dispatched</option><option>received</option><option>cancelled</option>
                    </select>
                    <button onClick={() => markReceived(o.id)} className="text-green-300 hover:underline">Receive</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
