'use client'

/**
 * Die Vendor Orders — rebuilt with ERP design system
 * ─────────────────────────────────────────────────────
 * ✓ useQuery (replaces useEffect + refresh counter)
 * ✓ DataTable (replaces EnterpriseTableShell)
 * ✓ PageHeader
 */

import { useMemo }                           from 'react'
import { useQuery, useQueryClient }          from '@tanstack/react-query'
import { format }                            from 'date-fns'

import { PageHeader } from '@/components/shared/PageHeader'
import { DataTable }  from '@/components/shared/DataTable'

/* ── Types ──────────────────────────────────────────────────────────────── */
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

type OrderWithOverdue = Order & { overdueDays: number }

/* ── API ─────────────────────────────────────────────────────────────────── */
async function fetchOrders(): Promise<Order[]> {
  const res = await fetch('/api/die-vendor-orders')
  if (!res.ok) throw new Error('Failed to load die vendor orders')
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default function DieVendorOrdersPage() {
  const qc = useQueryClient()

  const { data: rows = [], isLoading } = useQuery<Order[]>({
    queryKey: ['die-vendor-orders'],
    queryFn:  fetchOrders,
  })

  const refresh = () => void qc.invalidateQueries({ queryKey: ['die-vendor-orders'] })

  const today = Date.now()
  const withOverdue = useMemo<OrderWithOverdue[]>(
    () =>
      rows.map((r) => {
        const overdueDays =
          r.expectedBy && r.status !== 'received'
            ? Math.max(0, Math.floor((today - new Date(r.expectedBy).getTime()) / (1000 * 60 * 60 * 24)))
            : 0
        return { ...r, overdueDays }
      }),
    [rows, today],
  )

  async function updateStatus(id: string, status: string) {
    await fetch(`/api/die-vendor-orders/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    refresh()
  }

  async function markReceived(id: string) {
    await fetch(`/api/die-vendor-orders/${id}/receive`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ condition: 'New', storageLocation: 'Die Rack A-1', compartment: 'Compartment 1' }),
    })
    refresh()
  }

  const selectCls =
    'min-h-[32px] min-w-[80px] rounded border border-ds-line bg-ds-card px-1 py-0.5 text-xs text-ds-ink'

  /* ── Columns ────────────────────────────────────────────────────────── */
  const columns = [
    {
      key:    'orderCode',
      label:  'Order',
      render: (o: OrderWithOverdue) => (
        <span className="font-mono text-sm text-ds-warning">{o.orderCode ?? '—'}</span>
      ),
    },
    {
      key:    'orderedAt',
      label:  'Date',
      render: (o: OrderWithOverdue) => (
        <span className="font-mono text-xs text-ds-ink-muted">
          {o.orderedAt ? format(new Date(o.orderedAt), 'dd MMM yyyy') : '—'}
        </span>
      ),
    },
    {
      key:    'orderType',
      label:  'Type',
      render: (o: OrderWithOverdue) => <span className="text-ds-ink-muted text-sm">{o.orderType ?? '—'}</span>,
    },
    {
      key:    'cartonName',
      label:  'Carton',
      render: (o: OrderWithOverdue) => <span className="text-ds-ink-muted text-sm">{o.cartonName ?? '—'}</span>,
    },
    {
      key:    'dieSpec',
      label:  'Die Spec',
      render: (o: OrderWithOverdue) => (
        <span className="text-ds-ink-muted text-sm">
          {o.dieType ?? '—'} · {o.ups ?? '—'} up · {o.sheetSize ?? '—'}
        </span>
      ),
    },
    {
      key:    'vendorName',
      label:  'Vendor',
      render: (o: OrderWithOverdue) => <span className="text-ds-ink text-sm">{o.vendorName ?? '—'}</span>,
    },
    {
      key:    'expectedBy',
      label:  'Expected',
      render: (o: OrderWithOverdue) => (
        <span className="font-mono text-xs text-ds-ink-muted">
          {o.expectedBy ? format(new Date(o.expectedBy), 'dd MMM yyyy') : '—'}{' '}
          {o.overdueDays > 0 && (
            <span className="text-ds-error font-semibold">OVERDUE {o.overdueDays}d</span>
          )}
        </span>
      ),
    },
    {
      key:    'priority',
      label:  'Priority',
      render: (o: OrderWithOverdue) => <span className="text-ds-ink text-sm">{o.priority ?? '—'}</span>,
    },
    {
      key:    'status',
      label:  'Status',
      render: (o: OrderWithOverdue) => <span className="text-ds-ink text-sm">{o.status ?? '—'}</span>,
    },
    {
      key:    'action',
      label:  'Action',
      render: (o: OrderWithOverdue) => (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={o.status}
            onChange={(e) => void updateStatus(o.id, e.target.value)}
            className={selectCls}
          >
            <option>ordered</option>
            <option>confirmed</option>
            <option>in_manufacturing</option>
            <option>dispatched</option>
            <option>received</option>
            <option>cancelled</option>
          </select>
          <button
            type="button"
            onClick={() => void markReceived(o.id)}
            className="text-sm text-ds-success hover:underline"
          >
            Receive
          </button>
        </div>
      ),
    },
  ]

  return (
    <div className="p-6 space-y-6">

      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader
        title="Die Vendor Orders"
        subtitle="Track die manufacturing orders with vendors — status, expected delivery, and overdue tracking"
      />

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <DataTable
        columns={columns}
        data={withOverdue}
        loading={isLoading}
        emptyMessage="No die vendor orders found."
      />

    </div>
  )
}
