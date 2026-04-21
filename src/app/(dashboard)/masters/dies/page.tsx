'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  EnterpriseTableShell,
  enterpriseTheadClass,
  enterpriseTbodyClass,
  enterpriseTrClass,
  enterpriseThClass,
  enterpriseTdClass,
  enterpriseTdBase,
  enterpriseTdMonoClass,
  enterpriseTdMutedClass,
} from '@/components/ui/EnterpriseTableShell'

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

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (tab === 'all') return true
        if (tab === 'attention') return r.condition === 'Needs Sharpening' || r.condition === 'Damaged'
        return r.status === tab
      }),
    [rows, tab]
  )

  const stats = {
    total: rows.length,
    inStock: rows.filter((r) => r.status === 'in_stock').length,
    issued: rows.filter((r) => r.status === 'issued').length,
    withVendor: rows.filter((r) => r.status === 'with_vendor').length,
    scrapped: rows.filter((r) => r.status === 'scrapped').length,
  }

  const inputCls =
    'min-h-[40px] min-w-[80px] rounded-lg border border-border bg-card px-3 py-2 text-sm text-card-foreground'

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold text-slate-900 dark:text-slate-50">Die Inventory</h1>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/masters/dies/location-view"
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 dark:border-slate-700 dark:text-slate-200"
          >
            Die Location View
          </Link>
          <Link
            href="/masters/dies/vendor-orders"
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 dark:border-slate-700 dark:text-slate-200"
          >
            Vendor Orders
          </Link>
          <Link href="/masters/dies/new" className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90">
            Add Die
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Total Dies" value={stats.total} />
        <Stat label="In Stock" value={stats.inStock} />
        <Stat label="Currently Issued" value={stats.issued} />
        <Stat label="With Vendor" value={stats.withVendor} />
        <Stat label="Scrapped" value={stats.scrapped} />
      </div>

      <div className="flex flex-wrap gap-2">
        {(
          [
            ['all', 'All'],
            ['in_stock', 'In Stock'],
            ['issued', 'Issued'],
            ['with_vendor', 'With Vendor'],
            ['attention', 'Needs Attention'],
            ['scrapped', 'Scrapped'],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`rounded border px-3 py-1.5 text-xs font-medium ${
              tab === k
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-slate-200 text-slate-700 dark:border-slate-700 dark:text-slate-300'
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      <div className="grid gap-2 md:grid-cols-5">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search die no or carton"
          className={inputCls}
        />
        <input placeholder="Customer" className={inputCls} />
        <input placeholder="Type" className={inputCls} />
        <select value={condition} onChange={(e) => setCondition(e.target.value)} className={inputCls}>
          <option value="">Condition</option>
          <option>New</option>
          <option>Excellent</option>
          <option>Good</option>
          <option>Fair</option>
          <option>Needs Sharpening</option>
          <option>Damaged</option>
          <option>Scrapped</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
          <option value="">Status</option>
          <option value="in_stock">in_stock</option>
          <option value="issued">issued</option>
          <option value="with_vendor">with_vendor</option>
          <option value="scrapped">scrapped</option>
        </select>
      </div>

      <EnterpriseTableShell>
        <table className="w-full min-w-[1100px] border-collapse text-left text-sm text-slate-900 dark:text-slate-50">
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>Die Code</th>
              <th className={enterpriseThClass}>Die No.</th>
              <th className={enterpriseThClass}>Type</th>
              <th className={enterpriseThClass}>UPS</th>
              <th className={enterpriseThClass}>Sheet</th>
              <th className={enterpriseThClass}>Carton</th>
              <th className={enterpriseThClass}>Location</th>
              <th className={enterpriseThClass}>Impressions</th>
              <th className={enterpriseThClass}>Life%</th>
              <th className={enterpriseThClass}>Condition</th>
              <th className={enterpriseThClass}>Status</th>
              <th className={enterpriseThClass}>Action</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {filtered.map((d) => {
              const pct = d.maxImpressions > 0 ? Math.min(100, Math.round((d.impressionCount / d.maxImpressions) * 100)) : 0
              return (
                <tr key={d.id} className={enterpriseTrClass}>
                  <td className={`${enterpriseTdMonoClass} text-amber-700 dark:text-amber-300`}>{d?.dieCode ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{d?.dieNumber ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{d?.dieType ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{d?.ups ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{d?.sheetSize ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{d?.cartonSize ?? d?.cartonName ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{d?.storageLocation ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>
                    {d?.impressionCount?.toLocaleString() ?? '—'} / {d?.maxImpressions?.toLocaleString() ?? '—'}
                  </td>
                  <td className={enterpriseTdBase}>
                    <LifeBar pct={pct} />
                  </td>
                  <td className={enterpriseTdClass}>{d?.condition ?? '—'}</td>
                  <td className={enterpriseTdClass}>{d?.status ?? '—'}</td>
                  <td className={enterpriseTdClass}>
                    <Link href={`/masters/dies/${d?.id ?? ''}`} className="text-blue-600 hover:underline dark:text-blue-400">
                      View Details
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </EnterpriseTableShell>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</p>
      <p className="text-lg font-semibold text-slate-900 dark:text-slate-50">{value}</p>
    </div>
  )
}

function LifeBar({ pct }: { pct: number }) {
  const cls = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-green-500'
  return (
    <div className="h-2 w-20 overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
      <div className={`h-full ${cls}`} style={{ width: `${pct}%` }} />
    </div>
  )
}
