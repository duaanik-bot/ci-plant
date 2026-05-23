'use client'

/**
 * Emboss Block Inventory — partial upgrade with ERP design system
 * ───────────────────────────────────────────────────────────────
 * ✓ Stat cards → KpiCard
 * ✓ h1 header → PageHeader
 * ✓ Add Block button → Button component
 * ✓ useEffect fetch kept (dynamic API query params: search/status/condition)
 * ✓ LifeBar inline component preserved (threshold: >85 error, >70 warning)
 * ✓ Tab filter system preserved
 * ✓ EnterpriseTableShell preserved (complex table)
 * ✓ Info banner preserved
 */

import { useEffect, useMemo, useState } from 'react'
import Link                             from 'next/link'
import { useRouter }                    from 'next/navigation'
import { Square, Archive, ArrowUpRight, Truck, Trash2 } from 'lucide-react'

import { PageHeader } from '@/components/shared/PageHeader'
import { KpiCard }    from '@/components/shared/KpiCard'
import { Button }     from '@/components/ui/Button'
import {
  EnterpriseTableShell,
  enterpriseTheadClass,
  enterpriseTbodyClass,
  enterpriseTrClass,
  enterpriseThClass,
  enterpriseTdBase,
  enterpriseTdMonoClass,
  enterpriseTdMutedClass,
  enterpriseTdClass,
} from '@/components/ui/EnterpriseTableShell'

/* ── Types ──────────────────────────────────────────────────────────────── */
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

type TabKey = 'all' | 'in_stock' | 'issued' | 'with_vendor' | 'attention' | 'scrapped'

const TABS: [TabKey, string][] = [
  ['all',         'All'],
  ['in_stock',    'In Stock'],
  ['issued',      'Issued'],
  ['with_vendor', 'With Vendor'],
  ['attention',   'Needs Attention'],
  ['scrapped',    'Scrapped'],
]

const inputCls =
  'min-h-[40px] min-w-[80px] rounded-ds-md bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand'

/* ── LifeBar ─────────────────────────────────────────────────────────────── */
function LifeBar({ pct }: { pct: number }) {
  const cls = pct > 85 ? 'bg-ds-error' : pct > 70 ? 'bg-ds-warning' : 'bg-ds-success'
  return (
    <div className="h-2 w-20 overflow-hidden rounded bg-ds-elevated">
      <div className={`h-full ${cls}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

/* ── Page component ──────────────────────────────────────────────────────── */
export default function EmbossBlocksListPage() {
  const router = useRouter()

  const [rows,      setRows]      = useState<Block[]>([])
  const [search,    setSearch]    = useState('')
  const [status,    setStatus]    = useState('')
  const [condition, setCondition] = useState('')
  const [tab,       setTab]       = useState<TabKey>('all')

  useEffect(() => {
    const qs = new URLSearchParams({
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(status ? { status } : {}),
      ...(condition ? { condition } : {}),
    })
    fetch(`/api/emboss-blocks?${qs}`)
      .then(r => r.json())
      .then(d => setRows(Array.isArray(d) ? d : []))
      .catch(() => setRows([]))
  }, [search, status, condition])

  const filtered = useMemo(
    () =>
      rows.filter(r => {
        if (tab === 'all')       return true
        if (tab === 'attention') return r.condition === 'Needs Polish' || r.condition === 'Damaged'
        return r.status === tab
      }),
    [rows, tab],
  )

  const stats = {
    total:      rows.length,
    inStock:    rows.filter(r => r.status === 'in_stock').length,
    issued:     rows.filter(r => r.status === 'issued').length,
    withVendor: rows.filter(r => r.status === 'with_vendor').length,
    scrapped:   rows.filter(r => r.status === 'scrapped').length,
  }

  /* ── Render ────────────────────────────────────────────────────────── */
  return (
    <div className="p-6 space-y-6">

      {/* ── Info banner ───────────────────────────────────────────────── */}
      <div className="rounded-ds-md bg-[var(--brand-bg-soft)] p-3 text-sm text-ds-brand">
        This module activates automatically when Embossing Required = Yes in Carton Master.
      </div>

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard title="Total Blocks"      value={stats.total}      icon={Square}        color="blue"   />
        <KpiCard title="In Stock"          value={stats.inStock}    icon={Archive}       color="green"  />
        <KpiCard title="Currently Issued"  value={stats.issued}     icon={ArrowUpRight}  color="orange" />
        <KpiCard title="With Vendor"       value={stats.withVendor} icon={Truck}         color="slate"  />
        <KpiCard title="Scrapped"          value={stats.scrapped}   icon={Trash2}        color="red"    />
      </div>

      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader
        title="Emboss Block Inventory"
        subtitle="Track block stock, condition and vendor orders"
        action={
          <div className="flex items-center gap-2">
            <Link
              href="/masters/emboss-blocks/location-view"
              className="rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink hover:bg-ds-line/30 transition-colors"
            >
              Block Location View
            </Link>
            <Link
              href="/masters/emboss-blocks/vendor-orders"
              className="rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink hover:bg-ds-line/30 transition-colors"
            >
              Block Vendor Orders
            </Link>
            <Button onClick={() => router.push('/masters/emboss-blocks/new')}>
              Add Block
            </Button>
          </div>
        }
      />

      {/* ── Tabs ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        {TABS.map(([k, l]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`rounded-ds-md px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === k
                ? 'bg-ds-brand text-white'
                : 'bg-ds-elevated/60 text-ds-ink-muted hover:text-ds-ink'
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      {/* ── Filters ───────────────────────────────────────────────────── */}
      <div className="grid gap-2 md:grid-cols-5">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search block/carton"
          className={inputCls}
        />
        <input placeholder="Customer" className={inputCls} readOnly />
        <input placeholder="Block Type" className={inputCls} readOnly />
        <select value={condition} onChange={e => setCondition(e.target.value)} className={inputCls}>
          <option value="">Condition</option>
          <option>New</option>
          <option>Excellent</option>
          <option>Good</option>
          <option>Fair</option>
          <option>Needs Polish</option>
          <option>Damaged</option>
          <option>Scrapped</option>
        </select>
        <select value={status} onChange={e => setStatus(e.target.value)} className={inputCls}>
          <option value="">Status</option>
          <option value="in_stock">in_stock</option>
          <option value="issued">issued</option>
          <option value="with_vendor">with_vendor</option>
          <option value="scrapped">scrapped</option>
        </select>
      </div>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <EnterpriseTableShell>
        <table className="w-full min-w-[1200px] border-collapse text-left text-sm text-ds-ink">
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>Block Code</th>
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
            {filtered.map(b => {
              const pct =
                b.maxImpressions > 0
                  ? Math.min(100, Math.round((b.impressionCount / b.maxImpressions) * 100))
                  : 0
              return (
                <tr key={b.id} className={enterpriseTrClass}>
                  <td className={`${enterpriseTdMonoClass} text-ds-warning`}>{b.blockCode ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{b.blockNumber ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{b.blockType ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{b.blockMaterial ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{b.cartonName ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{b.artworkCode ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{b.storageLocation ?? '—'}</td>
                  <td className={`${enterpriseTdMonoClass} max-w-[12rem] whitespace-normal`}>
                    {b.impressionCount?.toLocaleString() ?? '—'} / {b.maxImpressions?.toLocaleString() ?? '—'}
                    {' · '}Polished {b.polishCount ?? '—'}/{b.maxPolishCount ?? '—'}
                  </td>
                  <td className={enterpriseTdBase}>
                    <LifeBar pct={pct} />
                  </td>
                  <td className={enterpriseTdClass}>{b.condition ?? '—'}</td>
                  <td className={enterpriseTdClass}>{b.status ?? '—'}</td>
                  <td className={enterpriseTdClass}>
                    <Link
                      href={`/masters/emboss-blocks/${b.id}`}
                      className="text-ds-brand hover:underline text-xs"
                    >
                      View Details
                    </Link>
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={12} className="py-12 text-center text-sm text-ds-ink-muted">
                  No emboss blocks match your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </EnterpriseTableShell>

    </div>
  )
}
