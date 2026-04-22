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
    fetch(`/api/emboss-blocks?${qs}`)
      .then((r) => r.json())
      .then((d) => setRows(Array.isArray(d) ? d : []))
  }, [search, status, condition])

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (tab === 'all') return true
        if (tab === 'attention') return r.condition === 'Needs Polish' || r.condition === 'Damaged'
        return r.status === tab
      }),
    [rows, tab]
  )

  const stats = {
    total: rows.length,
    stock: rows.filter((r) => r.status === 'in_stock').length,
    issued: rows.filter((r) => r.status === 'issued').length,
    vendor: rows.filter((r) => r.status === 'with_vendor').length,
    scrapped: rows.filter((r) => r.status === 'scrapped').length,
  }

  const inputCls =
    'min-h-[40px] min-w-[80px] rounded-lg border border-border bg-card px-3 py-2 text-sm text-card-foreground'

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="rounded-lg border border-blue-200 bg-blue-50/80 p-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
        This module activates automatically when Embossing Required = Yes in Carton Master.
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold text-neutral-900 dark:text-ds-ink">Emboss Block Inventory</h1>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/masters/emboss-blocks/location-view"
            className="rounded-lg border border-neutral-200 px-3 py-2 text-xs text-neutral-800 dark:border-ds-line/50 dark:text-ds-ink"
          >
            Block Location View
          </Link>
          <Link
            href="/masters/emboss-blocks/vendor-orders"
            className="rounded-lg border border-neutral-200 px-3 py-2 text-xs text-neutral-800 dark:border-ds-line/50 dark:text-ds-ink"
          >
            Block Vendor Orders
          </Link>
          <Link href="/masters/emboss-blocks/new" className="rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground hover:bg-primary/90">
            Add Block
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Stat label="Total Blocks" value={stats.total} />
        <Stat label="In Stock" value={stats.stock} />
        <Stat label="Issued" value={stats.issued} />
        <Stat label="With Vendor" value={stats.vendor} />
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
                : 'border-neutral-200 text-neutral-700 dark:border-ds-line/50 dark:text-ds-ink-muted'
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
          placeholder="Search block/carton"
          className={inputCls}
        />
        <input placeholder="Customer" className={inputCls} />
        <input placeholder="Block Type" className={inputCls} />
        <select value={condition} onChange={(e) => setCondition(e.target.value)} className={inputCls}>
          <option value="">Condition</option>
          <option>New</option>
          <option>Excellent</option>
          <option>Good</option>
          <option>Fair</option>
          <option>Needs Polish</option>
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
        <table className="w-full min-w-[1200px] border-collapse text-left text-sm text-neutral-900 dark:text-ds-ink">
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>Block</th>
              <th className={enterpriseThClass}>No.</th>
              <th className={enterpriseThClass}>Type</th>
              <th className={enterpriseThClass}>Material</th>
              <th className={enterpriseThClass}>Carton</th>
              <th className={enterpriseThClass}>Artwork</th>
              <th className={enterpriseThClass}>Location</th>
              <th className={enterpriseThClass}>Impressions</th>
              <th className={enterpriseThClass}>Life%</th>
              <th className={enterpriseThClass}>Condition</th>
              <th className={enterpriseThClass}>Status</th>
              <th className={enterpriseThClass}>Action</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {filtered.map((b) => {
              const pct = b.maxImpressions > 0 ? Math.min(100, Math.round((b.impressionCount / b.maxImpressions) * 100)) : 0
              return (
                <tr key={b.id} className={enterpriseTrClass}>
                  <td className={`${enterpriseTdMonoClass} text-ds-warning dark:text-ds-warning`}>{b?.blockCode ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{b?.blockNumber ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{b?.blockType ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{b?.blockMaterial ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{b?.cartonName ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{b?.artworkCode ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{b?.storageLocation ?? '—'}</td>
                  <td className={`${enterpriseTdMonoClass} max-w-[12rem] whitespace-normal`}>
                    {b?.impressionCount?.toLocaleString() ?? '—'} / {b?.maxImpressions?.toLocaleString() ?? '—'} · Polished{' '}
                    {b?.polishCount ?? '—'}/{b?.maxPolishCount ?? '—'}
                  </td>
                  <td className={enterpriseTdBase}>
                    <LifeBar pct={pct} />
                  </td>
                  <td className={enterpriseTdClass}>{b?.condition ?? '—'}</td>
                  <td className={enterpriseTdClass}>{b?.status ?? '—'}</td>
                  <td className={enterpriseTdClass}>
                    <Link href={`/masters/emboss-blocks/${b?.id ?? ''}`} className="text-blue-600 hover:underline dark:text-blue-400">
                      View
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
      <p className="text-xs uppercase tracking-wider text-ds-ink-faint dark:text-ds-ink-muted">{label}</p>
      <p className="text-lg font-semibold text-neutral-900 dark:text-ds-ink">{value}</p>
    </div>
  )
}

function LifeBar({ pct }: { pct: number }) {
  const cls = pct > 85 ? 'bg-red-500' : pct > 70 ? 'bg-ds-warning' : 'bg-green-500'
  return (
    <div className="h-2 w-20 overflow-hidden rounded bg-neutral-200 dark:bg-ds-elevated">
      <div className={`h-full ${cls}`} style={{ width: `${pct}%` }} />
    </div>
  )
}
