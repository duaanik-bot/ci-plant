'use client'

/**
 * Dye Master — rebuilt with ERP design system
 * ─────────────────────────────────────────────
 * Before: raw fetch + useEffect, EnterpriseTableShell
 * After:  useQuery, DataTable, PageHeader, KpiCard,
 *         SearchInput, Pagination
 *         No delete button — view/edit only (as per original design)
 */

import { useState }       from 'react'
import Link               from 'next/link'
import { useRouter }      from 'next/navigation'
import { useQuery }       from '@tanstack/react-query'
import { Plus, Layers, Activity } from 'lucide-react'

import { PageHeader }  from '@/components/shared/PageHeader'
import { DataTable }   from '@/components/shared/DataTable'
import { KpiCard }     from '@/components/shared/KpiCard'
import { Button }      from '@/components/ui/Button'
import { SearchInput } from '@/components/ui/SearchInput'
import { Pagination }  from '@/components/ui/Pagination'

/* ── Types ──────────────────────────────────────────────────────────────── */
type DyeRow = {
  id: string
  dyeNumber: number
  dyeType: string
  ups: number
  sheetSize: string
  cartonSize: string
  location: string | null
  impressionCount: number
  conditionRating: string | null
  active: boolean
}

const PAGE_LIMIT = 20

/* ── API helper ──────────────────────────────────────────────────────────── */
async function fetchDyes(): Promise<DyeRow[]> {
  const res = await fetch('/api/masters/dyes')
  if (!res.ok) throw new Error('Failed to load dyes')
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

/* ── Page component ──────────────────────────────────────────────────────── */
export default function DyeMasterPage() {
  const router = useRouter()

  const [q,    setQ]    = useState('')
  const [page, setPage] = useState(1)

  /* ── Fetch ───────────────────────────────────────────────────────────── */
  const { data: list = [], isLoading } = useQuery<DyeRow[]>({
    queryKey: ['masters', 'dyes'],
    queryFn:  fetchDyes,
  })

  /* ── Filter + paginate ───────────────────────────────────────────────── */
  const ql = q.toLowerCase()
  const filtered = list.filter(d =>
    String(d.dyeNumber ?? '').includes(ql) ||
    (d.dyeType ?? '').toLowerCase().includes(ql) ||
    (d.cartonSize ?? '').toLowerCase().includes(ql) ||
    (d.sheetSize ?? '').toLowerCase().includes(ql),
  )
  const paginated = filtered.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT)

  const totalImpressions = list.reduce((acc, d) => acc + (d.impressionCount ?? 0), 0)

  /* ── Column definitions ──────────────────────────────────────────────── */
  const columns = [
    {
      key:       'dyeNumber',
      label:     'Dye No.',
      className: 'font-mono text-sm font-medium',
      render:    (row: DyeRow) => (
        <Link
          href={`/masters/dyes/${row.id}`}
          className="hover:text-ds-brand hover:underline"
        >
          {row.dyeNumber}
        </Link>
      ),
    },
    {
      key:       'dyeType',
      label:     'Type',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: DyeRow) => row.dyeType ?? '—',
    },
    {
      key:       'ups',
      label:     'UPS',
      align:     'right' as const,
      className: 'font-mono text-sm',
      render:    (row: DyeRow) => row.ups ?? '—',
    },
    {
      key:       'sheetSize',
      label:     'Sheet Size',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: DyeRow) => row.sheetSize ?? '—',
    },
    {
      key:       'cartonSize',
      label:     'Carton Size',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: DyeRow) => row.cartonSize ?? '—',
    },
    {
      key:       'impressionCount',
      label:     'Impressions',
      align:     'right' as const,
      className: 'font-mono text-sm',
      render:    (row: DyeRow) => (row.impressionCount ?? 0).toLocaleString('en-IN'),
    },
    {
      key:       'conditionRating',
      label:     'Condition',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: DyeRow) => row.conditionRating ?? 'Good',
    },
    {
      key:    'actions',
      label:  '',
      render: (row: DyeRow) => (
        <div className="flex items-center justify-end">
          <Link
            href={`/masters/dyes/${row.id}`}
            className="p-1.5 rounded-ds-sm text-ds-ink-faint hover:text-ds-brand hover:bg-ds-brand/8 transition-colors"
            title="Edit"
          >
            <span className="text-xs">Edit</span>
          </Link>
        </div>
      ),
    },
  ]

  /* ── Render ──────────────────────────────────────────────────────────── */
  return (
    <div className="p-6 space-y-6">

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiCard
          title="Total Dyes"
          value={list.length}
          icon={Layers}
          color="blue"
          loading={isLoading}
        />
        <KpiCard
          title="Active"
          value={list.filter(d => d.active).length}
          icon={Activity}
          color="green"
          loading={isLoading}
        />
        <KpiCard
          title="Total Impressions"
          value={totalImpressions.toLocaleString('en-IN')}
          icon={Activity}
          color="slate"
          loading={isLoading}
        />
      </div>

      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader
        title="Dye Master"
        subtitle="Track dye inventory, types and impression counts"
        action={
          <Button icon={Plus} onClick={() => router.push('/masters/dyes/new')}>
            Add Dye
          </Button>
        }
      />

      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <SearchInput
          value={q}
          onChange={v => { setQ(v); setPage(1) }}
          placeholder="Search by dye no, type, size…"
          className="w-72"
        />
      </div>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <DataTable
        columns={columns}
        data={paginated}
        loading={isLoading}
        emptyMessage={
          q ? 'No dyes match your search.' : 'No dyes yet. Add one to get started.'
        }
      />

      {/* ── Pagination ────────────────────────────────────────────────── */}
      <Pagination
        page={page}
        total={filtered.length}
        limit={PAGE_LIMIT}
        onChange={setPage}
      />

    </div>
  )
}
