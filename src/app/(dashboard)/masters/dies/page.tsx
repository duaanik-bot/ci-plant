'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

type Die = {
  id: string
  dieCode: string
  dieNumber: number | null
  dieType: string
  ups: number
  sheetSize: string | null
  cartonSize: string | null
  cartonName: string | null
  customerId: string | null
  storageLocation: string | null
  impressionCount: number
  maxImpressions: number
  condition: string
  status: string
}

export default function DiesPage() {
  const [rows, setRows] = useState<Die[]>([])
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [condition, setCondition] = useState('')
  const [tab, setTab] = useState<'all' | 'in_stock' | 'issued' | 'with_vendor' | 'attention' | 'scrapped'>('all')

  useEffect(() => {
    const qs = new URLSearchParams({
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(status ? { status } : {}),
      ...(condition ? { condition } : {}),
    })
    fetch(`/api/die-store?${qs}`)
      .then((r) => r.json())
      .then((data) => setRows(Array.isArray(data) ? data : []))
      .catch(() => setRows([]))
  }, [search, status, condition])

  const filtered = useMemo(() => rows.filter((r) => {
    if (tab === 'all') return true
    if (tab === 'attention') return r.condition === 'Needs Sharpening' || r.condition === 'Damaged'
    return r.status === tab
  }), [rows, tab])

  const stats = {
    total: rows.length,
    inStock: rows.filter((r) => r.status === 'in_stock').length,
    issued: rows.filter((r) => r.status === 'issued').length,
    withVendor: rows.filter((r) => r.status === 'with_vendor').length,
    scrapped: rows.filter((r) => r.status === 'scrapped').length,
  }

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-amber-400">Die Inventory</h1>
        <div className="flex gap-2">
          <Link href="/masters/dies/location-view" className="px-3 py-2 rounded-lg border border-slate-600 text-slate-200 text-sm">Die Location View</Link>
          <Link href="/masters/dies/vendor-orders" className="px-3 py-2 rounded-lg border border-slate-600 text-slate-200 text-sm">Vendor Orders</Link>
          <Link href="/masters/dies/new" className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm">Add Die</Link>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Total Dies" value={stats.total} />
        <Stat label="In Stock" value={stats.inStock} />
        <Stat label="Currently Issued" value={stats.issued} />
        <Stat label="With Vendor" value={stats.withVendor} />
        <Stat label="Scrapped" value={stats.scrapped} />
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          ['all', 'All'],
          ['in_stock', 'In Stock'],
          ['issued', 'Issued'],
          ['with_vendor', 'With Vendor'],
          ['attention', 'Needs Attention'],
          ['scrapped', 'Scrapped'],
        ].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k as typeof tab)} className={`px-3 py-1.5 rounded border text-xs ${tab === k ? 'bg-amber-600 border-amber-500 text-white' : 'border-slate-700 text-slate-300'}`}>{l}</button>
        ))}
      </div>

      <div className="grid md:grid-cols-5 gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search die no or carton" className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm" />
        <input placeholder="Customer" className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm" />
        <input placeholder="Type" className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm" />
        <select value={condition} onChange={(e) => setCondition(e.target.value)} className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm">
          <option value="">Condition</option>
          <option>New</option><option>Excellent</option><option>Good</option><option>Fair</option><option>Needs Sharpening</option><option>Damaged</option><option>Scrapped</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm">
          <option value="">Status</option>
          <option value="in_stock">in_stock</option><option value="issued">issued</option><option value="with_vendor">with_vendor</option><option value="scrapped">scrapped</option>
        </select>
      </div>

      <div className="rounded-lg border border-slate-700 overflow-x-auto">
        <table className="w-full text-xs text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-2 py-2">Die Code</th><th className="px-2 py-2">Die No.</th><th className="px-2 py-2">Type</th><th className="px-2 py-2">UPS</th>
              <th className="px-2 py-2">Sheet</th><th className="px-2 py-2">Carton</th><th className="px-2 py-2">Location</th><th className="px-2 py-2">Impressions</th>
              <th className="px-2 py-2">Life%</th><th className="px-2 py-2">Condition</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((d) => {
              const pct = d.maxImpressions > 0 ? Math.min(100, Math.round((d.impressionCount / d.maxImpressions) * 100)) : 0
              return (
                <tr key={d.id} className="border-t border-slate-800">
                  <td className="px-2 py-2 font-mono text-amber-300">{d.dieCode}</td>
                  <td className="px-2 py-2">{d.dieNumber ?? '-'}</td>
                  <td className="px-2 py-2">{d.dieType}</td>
                  <td className="px-2 py-2">{d.ups}</td>
                  <td className="px-2 py-2">{d.sheetSize ?? '-'}</td>
                  <td className="px-2 py-2">{d.cartonSize ?? d.cartonName ?? '-'}</td>
                  <td className="px-2 py-2">{d.storageLocation ?? '-'}</td>
                  <td className="px-2 py-2">{d.impressionCount.toLocaleString()} / {d.maxImpressions.toLocaleString()}</td>
                  <td className="px-2 py-2"><LifeBar pct={pct} /></td>
                  <td className="px-2 py-2">{d.condition}</td>
                  <td className="px-2 py-2">{d.status}</td>
                  <td className="px-2 py-2"><Link href={`/masters/dies/${d.id}`} className="text-amber-400 hover:underline">View Details</Link></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl border border-slate-700 bg-slate-900 p-3"><p className="text-xs text-slate-500">{label}</p><p className="text-lg text-slate-100">{value}</p></div>
}

function LifeBar({ pct }: { pct: number }) {
  const cls = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-green-500'
  return (
    <div className="w-20 h-2 rounded bg-slate-700 overflow-hidden">
      <div className={`h-full ${cls}`} style={{ width: `${pct}%` }} />
    </div>
  )
}
