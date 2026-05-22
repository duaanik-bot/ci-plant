'use client'

/**
 * RFQ Pipeline — rebuilt with ERP design system
 * ───────────────────────────────────────────────
 * ✓ useQuery (replaces useEffect + fetch)
 * ✓ DataTable (replaces raw <table>)
 * ✓ PageHeader, KpiCard, Button, SearchInput, Pagination, StatusBadge
 */

import { useMemo, useState }                          from 'react'
import Link                                           from 'next/link'
import { useRouter }                                  from 'next/navigation'
import { useQuery }                                   from '@tanstack/react-query'
import { Plus, FileText, CheckCircle2, Clock, Send }  from 'lucide-react'
import { differenceInDays }                           from 'date-fns'

import { PageHeader }  from '@/components/shared/PageHeader'
import { DataTable }   from '@/components/shared/DataTable'
import { KpiCard }     from '@/components/shared/KpiCard'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { Button }      from '@/components/ui/Button'
import { SearchInput } from '@/components/ui/SearchInput'
import { Pagination }  from '@/components/ui/Pagination'

/* ── Types ──────────────────────────────────────────────────────────────── */
type RfqItem = {
  id: string
  rfqNumber: string
  status: string
  productName: string
  packType: string
  estimatedVolume: number | null
  createdAt: string
  customer: { name: string }
}

const STATUS_OPTIONS = [
  { value: '',             label: 'All statuses' },
  { value: 'received',     label: 'RFQ Received' },
  { value: 'feasibility',  label: 'Feasibility' },
  { value: 'quoted',       label: 'Quoted' },
  { value: 'po_received',  label: 'PO Received' },
]

const PAGE_LIMIT = 20

/* ── API ─────────────────────────────────────────────────────────────────── */
async function fetchRfqs(status: string): Promise<RfqItem[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ''
  const res = await fetch(`/api/rfq${qs}`)
  if (!res.ok) throw new Error('Failed to load RFQs')
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default function RfqPage() {
  const router = useRouter()

  const [statusFilter, setStatusFilter] = useState('')
  const [q,            setQ]            = useState('')
  const [page,         setPage]         = useState(1)

  const { data: list = [], isLoading } = useQuery<RfqItem[]>({
    queryKey: ['rfqs', statusFilter],
    queryFn:  () => fetchRfqs(statusFilter),
  })

  /* ── Client-side search ─────────────────────────────────────────────── */
  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    if (!ql) return list
    return list.filter(r =>
      r.rfqNumber.toLowerCase().includes(ql) ||
      r.customer.name.toLowerCase().includes(ql) ||
      r.productName.toLowerCase().includes(ql) ||
      r.packType.toLowerCase().includes(ql),
    )
  }, [list, q])

  const paginated = filtered.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT)

  /* ── KPIs ───────────────────────────────────────────────────────────── */
  const kpiTotal      = list.length
  const kpiReceived   = list.filter(r => r.status === 'received').length
  const kpiFeasibility = list.filter(r => r.status === 'feasibility').length
  const kpiQuoted     = list.filter(r => r.status === 'quoted').length
  const kpiPoReceived = list.filter(r => r.status === 'po_received').length

  /* ── Columns ────────────────────────────────────────────────────────── */
  const columns = [
    {
      key:       'rfqNumber',
      label:     'RFQ #',
      className: 'font-mono text-sm text-ds-warning font-semibold',
      render:    (row: RfqItem) => (
        <Link href={`/rfq/${row.id}`} className="hover:underline">
          {row.rfqNumber}
        </Link>
      ),
    },
    {
      key:    'customer',
      label:  'Customer',
      render: (row: RfqItem) => row.customer?.name ?? '—',
    },
    {
      key:       'productName',
      label:     'Product',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: RfqItem) => row.productName ?? '—',
    },
    {
      key:       'packType',
      label:     'Pack Type',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: RfqItem) => row.packType ?? '—',
    },
    {
      key:       'estimatedVolume',
      label:     'Volume',
      align:     'right' as const,
      className: 'font-mono text-sm',
      render:    (row: RfqItem) =>
        row.estimatedVolume ? row.estimatedVolume.toLocaleString('en-IN') : '—',
    },
    {
      key:    'status',
      label:  'Status',
      render: (row: RfqItem) => (
        <StatusBadge status={row.status.replace(/_/g, ' ')} />
      ),
    },
    {
      key:    'daysOpen',
      label:  'Days Open',
      align:  'right' as const,
      render: (row: RfqItem) => {
        const days = differenceInDays(new Date(), new Date(row.createdAt))
        return (
          <span className={`font-mono text-sm ${days > 14 ? 'text-ds-error font-semibold' : 'text-ds-ink-muted'}`}>
            {days}
          </span>
        )
      },
    },
    {
      key:    'action',
      label:  '',
      render: (row: RfqItem) => (
        <Link
          href={`/rfq/${row.id}`}
          className="text-ds-brand hover:underline text-xs"
        >
          Open →
        </Link>
      ),
    },
  ]

  return (
    <div className="p-6 space-y-6">

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard title="Total RFQs"    value={kpiTotal}       icon={FileText}     color="blue"   loading={isLoading} />
        <KpiCard title="Received"      value={kpiReceived}    icon={Send}         color="orange" loading={isLoading} />
        <KpiCard title="Feasibility"   value={kpiFeasibility} icon={Clock}        color="slate"  loading={isLoading} />
        <KpiCard title="Quoted"        value={kpiQuoted}      icon={FileText}     color="green"  loading={isLoading} />
        <KpiCard title="PO Received"   value={kpiPoReceived}  icon={CheckCircle2} color="green"  loading={isLoading} />
      </div>

      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader
        title="RFQ Pipeline"
        subtitle="Track requests for quotation from inquiry to purchase order"
        action={
          <Button icon={Plus} onClick={() => router.push('/rfq/new')}>
            New RFQ
          </Button>
        }
      />

      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={q}
          onChange={v => { setQ(v); setPage(1) }}
          placeholder="Search RFQ #, customer, product…"
          className="w-80"
        />
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
          className="min-h-[40px] rounded-ds-md border border-ds-line bg-ds-card px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-brand"
        >
          {STATUS_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <DataTable
        columns={columns}
        data={paginated}
        loading={isLoading}
        emptyMessage={q ? 'No RFQs match your search.' : 'No RFQs found.'}
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
