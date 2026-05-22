'use client'

/**
 * Approve Excess Requests — rebuilt with ERP design system
 * ─────────────────────────────────────────────────────────
 * ✓ useQuery (replaces useEffect + fetch)
 * ✓ PageHeader
 */

import Link                            from 'next/link'
import { useQuery }                    from '@tanstack/react-query'
import { CheckCircle2 }                from 'lucide-react'

import { PageHeader } from '@/components/shared/PageHeader'

/* ── Types ──────────────────────────────────────────────────────────────── */
type PendingItem = {
  id: string
  jobNumber: string
  productName: string
  materialCode: string
  qtyApproved: number
  qtyAlreadyIssued: number
  qtyRequested: number
  unit: string
  reasonCode: string | null
  issuedAt: string
}

/* ── API ─────────────────────────────────────────────────────────────────── */
async function fetchPendingItems(): Promise<PendingItem[]> {
  const res = await fetch('/api/sheet-issues/pending')
  if (!res.ok) throw new Error('Failed to load pending excess requests')
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default function ApproveExcessListPage() {
  const { data: list = [], isLoading } = useQuery<PendingItem[]>({
    queryKey: ['pending-excess'],
    queryFn:  fetchPendingItems,
  })

  return (
    <div className="p-6 space-y-6">

      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader
        title="Approve Excess Requests"
        subtitle="Review and approve excess sheet issue requests from production"
        action={
          <Link
            href="/stores/issue"
            className="text-ds-ink-muted hover:text-ds-ink text-sm"
          >
            ← Issue Sheets
          </Link>
        }
      />

      {/* ── List ──────────────────────────────────────────────────────── */}
      {isLoading ? (
        <p className="text-ds-ink-muted text-sm">Loading…</p>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-ds-ink-faint gap-3">
          <CheckCircle2 className="h-10 w-10 text-ds-success opacity-50" />
          <p className="text-sm">No pending excess requests — all clear!</p>
        </div>
      ) : (
        <ul className="space-y-2 max-w-2xl">
          {list.map((item) => (
            <li key={item.id}>
              <Link
                href={`/stores/approve-excess/${item.id}`}
                className="block p-4 rounded-ds-md bg-ds-elevated border border-ds-line/60 hover:border-ds-warning/50 transition-colors"
              >
                <p className="font-mono font-semibold text-ds-warning">{item.jobNumber}</p>
                <p className="text-ds-ink text-sm">{item.productName} · <span className="text-ds-ink-muted">{item.materialCode}</span></p>
                <p className="text-ds-ink-faint text-xs mt-1">
                  Approved: {item.qtyApproved} · Issued: {item.qtyAlreadyIssued} · Requesting: <span className="text-ds-warning font-semibold">{item.qtyRequested} {item.unit}</span>
                </p>
                {item.reasonCode && (
                  <p className="text-ds-ink-faint text-xs mt-0.5">Reason: {item.reasonCode.replace(/_/g, ' ')}</p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

    </div>
  )
}
