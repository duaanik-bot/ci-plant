'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Search, X } from 'lucide-react'
import {
  IndustrialModuleShell,
  industrialTableClassName,
} from '@/components/industrial/IndustrialModuleShell'

type Bill = {
  id: string
  billNumber: string
  billDate: string
  customer: { id: string; name: string }
  subtotal: number
  gstAmount: number
  totalAmount: number
  status: string
}

type Customer = { id: string; name: string }

const STATUS_PILL: Record<string, string> = {
  draft: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
  sent: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  paid: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  paid: 'Paid',
}

export default function BillingPage() {
  const [customerId, setCustomerId] = useState('')
  const [status, setStatus] = useState('')
  const [localSearch, setLocalSearch] = useState('')

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ['billing-customers'],
    queryFn: () =>
      fetch('/api/masters/customers')
        .then((r) => r.json())
        .then((d) => (Array.isArray(d) ? d : [])),
  })

  const {
    data: list = [],
    isLoading,
    isFetching,
    isError,
  } = useQuery<Bill[]>({
    queryKey: ['bills', customerId, status],
    queryFn: () => {
      const params = new URLSearchParams()
      if (customerId) params.set('customerId', customerId)
      if (status) params.set('status', status)
      return fetch(`/api/bills?${params}`)
        .then((r) => r.json())
        .then((d) => (Array.isArray(d) ? d : []))
        .catch(() => {
          toast.error('Failed to load bills')
          return []
        })
    },
  })

  const filtered = useMemo(() => {
    const q = localSearch.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (b) => b.billNumber.toLowerCase().includes(q) || b.customer.name.toLowerCase().includes(q),
    )
  }, [list, localSearch])

  const kpiDraft = list.filter((b) => b.status === 'draft').length
  const kpiSent = list.filter((b) => b.status === 'sent').length
  const kpiPaid = list.filter((b) => b.status === 'paid').length

  const kpiTiles = (
    <>
      <KpiTile label="Draft" value={kpiDraft} color="slate" />
      <KpiTile label="Sent" value={kpiSent} color="blue" />
      <KpiTile label="Paid" value={kpiPaid} color="emerald" />
    </>
  )

  return (
    <IndustrialModuleShell
      title="Billing"
      subtitle={`All invoices${isFetching ? ' · refreshing…' : ''}`}
      kpiRow={kpiTiles}
      headerAction={
        <Link
          href="/billing/new"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-ds-warning text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
        >
          + New Bill
        </Link>
      }
    >
      {/* Search */}
      <div className="flex items-stretch gap-2">
        <div className={`group flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-ds-card/50 px-3 py-1.5 text-sm transition-all ${localSearch.trim().length >= 1 ? 'border-ds-warning/50 ring-1 ring-ds-warning/30' : 'border-ds-warning/30 ring-1 ring-ds-warning/20'}`}>
          <Search className="h-4 w-4 text-ds-warning shrink-0" aria-hidden />
          <input
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            placeholder="Bill # or customer…"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-0.5 text-ds-ink placeholder:text-ds-ink-faint focus:outline-none text-sm"
          />
        </div>
        {localSearch.trim().length > 0 ? (
          <button
            type="button"
            onClick={() => setLocalSearch('')}
            className="shrink-0 self-center rounded-md border border-ds-line/50 bg-ds-card/60 px-2.5 py-2 text-ds-ink-faint hover:border-ds-warning/40 hover:text-ds-warning transition-colors"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 text-sm">
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="px-3 py-1.5 rounded bg-ds-elevated border border-ds-line/60 text-foreground min-w-[180px]"
        >
          <option value="">All customers</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="px-3 py-1.5 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
        >
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="sent">Sent</option>
          <option value="paid">Paid</option>
        </select>
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-ds-ink-muted text-sm">Loading…</div>
      ) : isError ? (
        <div className="py-8 text-center text-rose-400 text-sm">Failed to load bills.</div>
      ) : (
        <div className={industrialTableClassName()}>
          <table className="w-full text-sm text-left">
            <thead className="bg-ds-elevated text-ds-ink-muted border-b border-ds-line/40">
              <tr>
                <th className="px-3 py-2 font-medium">Bill #</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium hidden sm:table-cell">Date</th>
                <th className="px-3 py-2 font-medium hidden md:table-cell text-right">Subtotal</th>
                <th className="px-3 py-2 font-medium hidden md:table-cell text-right">GST</th>
                <th className="px-3 py-2 font-medium text-right">Total</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ds-line/30">
              {filtered.map((b) => (
                <tr key={b.id} className="hover:bg-ds-elevated/40 transition-colors">
                  <td className="px-3 py-2 font-mono text-ds-warning text-xs">{b.billNumber}</td>
                  <td className="px-3 py-2 text-ds-ink">{b.customer.name}</td>
                  <td className="px-3 py-2 text-ds-ink-muted text-xs hidden sm:table-cell">
                    {new Date(b.billDate).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2 text-ds-ink-muted text-xs hidden md:table-cell text-right">
                    ₹{b.subtotal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  </td>
                  <td className="px-3 py-2 text-ds-ink-muted text-xs hidden md:table-cell text-right">
                    ₹{b.gstAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  </td>
                  <td className="px-3 py-2 text-ds-ink font-medium text-right">
                    ₹{b.totalAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs border font-medium ${STATUS_PILL[b.status] ?? 'bg-ds-elevated text-ds-ink border-ds-line/60'}`}
                    >
                      {STATUS_LABELS[b.status] ?? b.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      href={`/billing/${b.id}`}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-ds-line/50 text-ds-ink-muted text-xs hover:border-ds-warning/40 hover:text-ds-warning transition-colors"
                    >
                      Open <span aria-hidden>→</span>
                    </Link>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-ds-ink-faint text-sm">
                    {localSearch.trim() ? `No bills matching "${localSearch.trim()}"` : 'No bills found.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </IndustrialModuleShell>
  )
}

function KpiTile({
  label,
  value,
  color,
}: {
  label: string
  value: number
  color: 'slate' | 'blue' | 'emerald'
}) {
  const ring =
    color === 'slate'
      ? 'border-slate-500/20 text-slate-400'
      : color === 'blue'
        ? 'border-blue-500/20 text-blue-400'
        : 'border-emerald-500/20 text-emerald-400'
  return (
    <div
      className={`rounded-lg border bg-ds-elevated/60 px-4 py-3 flex flex-col gap-0.5 ${ring}`}
    >
      <span className="text-2xl font-bold">{value}</span>
      <span className="text-xs text-ds-ink-muted">{label}</span>
    </div>
  )
}
