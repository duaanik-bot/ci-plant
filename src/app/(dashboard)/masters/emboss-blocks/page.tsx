'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

type Block = {
  id: string
  blockCode: string
  blockNumber: number | null
  blockType: string
  blockMaterial: string
  cartonName: string | null
  customerId: string | null
  artworkCode: string | null
  storageLocation: string | null
  impressionCount: number
  maxImpressions: number
  polishCount: number
  maxPolishCount: number
  condition: string
  status: string
}

export default function EmbossBlocksListPage() {
  const [rows, setRows] = useState<Block[]>([])
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
    fetch(`/api/emboss-blocks?${qs}`).then((r) => r.json()).then((d) => setRows(Array.isArray(d) ? d : []))
  }, [search, status, condition])

  const filtered = useMemo(() => rows.filter((r) => {
    if (tab === 'all') return true
    if (tab === 'attention') return r.condition === 'Needs Polish' || r.condition === 'Damaged'
    return r.status === tab
  }), [rows, tab])

  const stats = {
    total: rows.length,
    stock: rows.filter((r) => r.status === 'in_stock').length,
    issued: rows.filter((r) => r.status === 'issued').length,
    vendor: rows.filter((r) => r.status === 'with_vendor').length,
    scrapped: rows.filter((r) => r.status === 'scrapped').length,
  }

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-4">
      <div className="rounded-lg border border-blue-800 bg-blue-950/30 p-3 text-sm text-blue-200">
        This module activates automatically when Embossing Required = Yes in Carton Master.
      </div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-amber-400">Emboss Block Inventory</h1>
        <div className="flex gap-2">
          <Link href="/masters/emboss-blocks/location-view" className="px-3 py-2 rounded border border-slate-600 text-slate-200 text-xs">Block Location View</Link>
          <Link href="/masters/emboss-blocks/vendor-orders" className="px-3 py-2 rounded border border-slate-600 text-slate-200 text-xs">Block Vendor Orders</Link>
          <Link href="/masters/emboss-blocks/new" className="px-3 py-2 rounded bg-amber-600 text-white text-xs">Add Block</Link>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <Stat label="Total Blocks" value={stats.total} />
        <Stat label="In Stock" value={stats.stock} />
        <Stat label="Issued" value={stats.issued} />
        <Stat label="With Vendor" value={stats.vendor} />
        <Stat label="Scrapped" value={stats.scrapped} />
      </div>

      <div className="flex gap-2 flex-wrap">
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
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search block/carton" className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm" />
        <input placeholder="Customer" className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm" />
        <input placeholder="Block Type" className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm" />
        <select value={condition} onChange={(e) => setCondition(e.target.value)} className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm">
          <option value="">Condition</option>
          <option>New</option><option>Excellent</option><option>Good</option><option>Fair</option><option>Needs Polish</option><option>Damaged</option><option>Scrapped</option>
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
              <th className="px-2 py-2">Block</th><th className="px-2 py-2">No.</th><th className="px-2 py-2">Type</th><th className="px-2 py-2">Material</th><th className="px-2 py-2">Carton</th>
              <th className="px-2 py-2">Artwork</th><th className="px-2 py-2">Location</th><th className="px-2 py-2">Impressions</th><th className="px-2 py-2">Life%</th><th className="px-2 py-2">Condition</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((b) => {
              const pct = b.maxImpressions > 0 ? Math.min(100, Math.round((b.impressionCount / b.maxImpressions) * 100)) : 0
              return (
                <tr key={b.id} className="border-t border-slate-800">
                  <td className="px-2 py-2 font-mono text-amber-300">{b.blockCode}</td>
                  <td className="px-2 py-2">{b.blockNumber ?? '-'}</td>
                  <td className="px-2 py-2">{b.blockType}</td>
                  <td className="px-2 py-2">{b.blockMaterial}</td>
                  <td className="px-2 py-2">{b.cartonName ?? '-'}</td>
                  <td className="px-2 py-2">{b.artworkCode ?? '-'}</td>
                  <td className="px-2 py-2">{b.storageLocation ?? '-'}</td>
                  <td className="px-2 py-2">{b.impressionCount.toLocaleString()} / {b.maxImpressions.toLocaleString()} · Polished {b.polishCount}/{b.maxPolishCount}</td>
                  <td className="px-2 py-2"><LifeBar pct={pct} /></td>
                  <td className="px-2 py-2">{b.condition}</td>
                  <td className="px-2 py-2">{b.status}</td>
                  <td className="px-2 py-2"><Link href={`/masters/emboss-blocks/${b.id}`} className="text-amber-400 hover:underline">View</Link></td>
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
  const cls = pct > 85 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-green-500'
  return <div className="w-20 h-2 rounded bg-slate-700 overflow-hidden"><div className={`h-full ${cls}`} style={{ width: `${pct}%` }} /></div>
}
