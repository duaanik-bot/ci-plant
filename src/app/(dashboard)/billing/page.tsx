'use client'

import { useMemo, useState, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from '@/store/toastStore'
import {
  Search, X, FileText, IndianRupee, CheckCircle2, Clock,
  Send, BadgeCheck, ExternalLink, Receipt, ChevronRight,
} from 'lucide-react'
import { IndustrialModuleShell, industrialTableClassName } from '@/components/industrial/IndustrialModuleShell'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import {
  Badge,
  Button,
  CardSection,
  KpiTile,
  StatusBadge,
} from '@/components/design-system'
import { fmtINR } from '@/lib/indian-gst'

type LineItem = {
  id: string
  description: string
  quantity: number
  rate: number
  amount: number
  gstPct: number
  jobCardId: string | null
}

type Bill = {
  id: string
  billNumber: string
  billDate: string
  financialYear?: string | null
  customer: { id: string; name: string }
  subtotal: number
  cgstAmount?: number
  sgstAmount?: number
  igstAmount?: number
  gstAmount: number
  totalAmount: number
  taxSplit?: string
  ewayApplicable?: boolean
  status: string
  lineItems: LineItem[]
}

type QueueLine = {
  dispatchId: string
  jobNumber: string
  productName: string
  poNumber: string | null
  qtyDispatched: number
  rate: number | null
  gstPct: number | null
  hsnCode: string | null
  excessQty: number
}

type QueueGroup = {
  customerId: string
  customerName: string
  customerStateCode: string | null
  customerGstNumber: string | null
  dispatches: QueueLine[]
  totalQty: number
  estimatedSubtotal: number
}

type Customer = { id: string; name: string }

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  paid: 'Paid',
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })
}

function fmtAmount(n: number) {
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

export default function BillingPage() {
  const qc = useQueryClient()
  const router = useRouter()
  const [customerId, setCustomerId] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [localSearch, setLocalSearch] = useState('')
  const [drawerBill, setDrawerBill] = useState<Bill | null>(null)
  const [statusBusy, setStatusBusy] = useState(false)
  const [generatingForCustomerId, setGeneratingForCustomerId] = useState<string | null>(null)

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ['billing-customers'],
    queryFn: () => fetch('/api/masters/customers').then((r) => r.json()).then((d) => Array.isArray(d) ? d : []),
  })

  const { data: queue = [], isFetching: queueFetching } = useQuery<QueueGroup[]>({
    queryKey: ['billing-queue'],
    queryFn: () => fetch('/api/billing/queue').then((r) => r.json()).then((d) => (Array.isArray(d) ? d : [])).catch(() => []),
    refetchInterval: 30_000,
  })

  const { data: list = [], isLoading, isFetching, isError } = useQuery<Bill[]>({
    queryKey: ['bills', customerId, statusFilter],
    queryFn: () => {
      const p = new URLSearchParams()
      if (customerId) p.set('customerId', customerId)
      if (statusFilter) p.set('status', statusFilter)
      return fetch(`/api/bills?${p}`).then((r) => r.json()).then((d) => Array.isArray(d) ? d : []).catch(() => { toast.error('Failed to load bills'); return [] })
    },
  })

  async function generateForGroup(group: QueueGroup) {
    if (group.dispatches.length === 0) return
    setGeneratingForCustomerId(group.customerId)
    try {
      const res = await fetch('/api/billing/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dispatchIds: group.dispatches.map((d) => d.dispatchId) }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json?.error ?? 'Invoice generation failed')
        return
      }
      toast.success(
        `Invoice ${json.billNumber} · ${fmtINR(Number(json.totalAmount))}${json.ewayApplicable ? ' · E-way applicable' : ''}`,
      )
      await qc.invalidateQueries({ queryKey: ['billing-queue'] })
      await qc.invalidateQueries({ queryKey: ['bills'] })
    } catch {
      toast.error('Network error')
    } finally {
      setGeneratingForCustomerId(null)
    }
  }

  const filtered = useMemo(() => {
    const q = localSearch.trim().toLowerCase()
    if (!q) return list
    return list.filter((b) =>
      b.billNumber.toLowerCase().includes(q) ||
      b.customer.name.toLowerCase().includes(q) ||
      b.lineItems.some((li) => li.description.toLowerCase().includes(q))
    )
  }, [list, localSearch])

  const kpiDraft = list.filter((b) => b.status === 'draft').length
  const kpiSent = list.filter((b) => b.status === 'sent').length
  const kpiPaid = list.filter((b) => b.status === 'paid').length
  const totalOutstanding = list.filter((b) => b.status !== 'paid').reduce((s, b) => s + b.totalAmount, 0)

  const updateStatus = useCallback(async (bill: Bill, newStatus: string) => {
    setStatusBusy(true)
    try {
      const res = await fetch(`/api/bills/${bill.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      if (!res.ok) throw new Error('Update failed')
      toast.success(`Bill ${bill.billNumber} marked as ${STATUS_LABELS[newStatus] ?? newStatus}`)
      await qc.invalidateQueries({ queryKey: ['bills'] })
      setDrawerBill((prev) => prev && prev.id === bill.id ? { ...prev, status: newStatus } : prev)
    } catch {
      toast.error('Failed to update bill status')
    } finally {
      setStatusBusy(false)
    }
  }, [qc])

  function drawerFooter(bill: Bill) {
    if (bill.status === 'paid') {
      return (
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--success)]">
            <BadgeCheck className="h-4 w-4" />
            Fully Paid
          </span>
          <Link href={`/billing/${bill.id}`} className="ml-auto">
            <Button variant="secondary" className="gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" />
              Open Full Detail
            </Button>
          </Link>
        </div>
      )
    }
    return (
      <div className="flex items-center gap-2">
        {bill.status === 'draft' && (
          <Button variant="info" disabled={statusBusy} onClick={() => updateStatus(bill, 'sent')} className="gap-1.5">
            <Send className="h-3.5 w-3.5" />
            Mark as Sent
          </Button>
        )}
        {(bill.status === 'draft' || bill.status === 'sent') && (
          <Button variant="warning" disabled={statusBusy} onClick={() => updateStatus(bill, 'paid')} className="gap-1.5">
            <BadgeCheck className="h-3.5 w-3.5" />
            Mark as Paid
          </Button>
        )}
        <Link href={`/billing/${bill.id}`} className="ml-auto">
          <Button variant="secondary" className="gap-1.5">
            <ExternalLink className="h-3.5 w-3.5" />
            Open Full Detail
          </Button>
        </Link>
      </div>
    )
  }

  return (
    <>
      <IndustrialModuleShell
        title="Billing"
        subtitle={`Tax invoices & reconciliation${isFetching ? ' · refreshing…' : ''}`}
        kpiRow={
          <>
            <KpiTile label="Draft" tone="neutral" value={kpiDraft} icon={<FileText />} />
            <KpiTile label="Sent to Customer" tone="info" value={kpiSent} icon={<Clock />} />
            <KpiTile label="Paid" tone="success" value={kpiPaid} icon={<CheckCircle2 />} />
            <KpiTile label="Outstanding" tone="warning" value={fmtAmount(totalOutstanding)} icon={<IndianRupee />} raw />
          </>
        }
        headerAction={
          <Link href="/billing/new">
            <Button variant="primary" className="gap-1.5">+ New Bill</Button>
          </Link>
        }
      >
        {/* Pending Invoice Queue — dispatches flipped to sent_to_billing by Dispatch operators. */}
        {queue.length > 0 && (
          <div className="mb-4 space-y-2 rounded-ds-md bg-[var(--brand-bg-soft)] p-3">
            <div className="flex items-center justify-between px-1">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--brand-primary)]">
                Pending Invoice Queue
                {queueFetching && <span className="ml-2 text-ds-ink-faint">· refreshing…</span>}
              </div>
              <div className="text-[11px] text-ds-ink-muted">
                {queue.length} customer{queue.length === 1 ? '' : 's'} ·{' '}
                {queue.reduce((s, g) => s + g.dispatches.length, 0)} dispatches
              </div>
            </div>
            <div className="space-y-2">
              {queue.map((g) => (
                <div
                  key={g.customerId}
                  className="flex items-center justify-between gap-3 rounded-ds-sm bg-[var(--bg-card)] px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-semibold text-ds-ink">{g.customerName}</span>
                      {g.customerStateCode && (
                        <span className="text-[10px] font-mono text-ds-ink-faint">
                          ST {g.customerStateCode}
                        </span>
                      )}
                      {g.customerGstNumber && (
                        <span className="text-[10px] font-mono text-ds-ink-faint">
                          {g.customerGstNumber}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-ds-ink-muted">
                      {g.dispatches.length} dispatch{g.dispatches.length === 1 ? '' : 'es'} · Qty{' '}
                      <span className="font-medium tabular-nums">{g.totalQty.toLocaleString('en-IN')}</span>
                      {g.estimatedSubtotal > 0 && (
                        <>
                          {' · Est. subtotal '}
                          <span className="font-medium tabular-nums">{fmtINR(g.estimatedSubtotal)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="primary"
                    className="gap-1.5 px-3 py-1.5 text-xs"
                    onClick={() => generateForGroup(g)}
                    disabled={generatingForCustomerId === g.customerId}
                  >
                    {generatingForCustomerId === g.customerId ? (
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    ) : (
                      <Receipt className="h-3.5 w-3.5" />
                    )}
                    Generate Invoice
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Search + Filters */}
        <div className="ds-toolbar">
          <div className="relative flex min-w-0 flex-1 items-center">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-ds-ink-faint" aria-hidden />
            <input
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              placeholder="Bill #, customer or product…"
              className="ds-input ds-toolbar-search pl-9"
            />
          </div>
          {localSearch && (
            <Button variant="icon" aria-label="Clear search" onClick={() => setLocalSearch('')}>
              <X className="h-4 w-4" />
            </Button>
          )}
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className="ds-input h-9 min-w-[160px] cursor-pointer py-1.5"
          >
            <option value="">All customers</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="ds-input h-9 min-w-[140px] cursor-pointer py-1.5"
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="paid">Paid</option>
          </select>
        </div>

        {isLoading ? (
          <div className="py-12 text-center text-sm text-ds-ink-muted">Loading…</div>
        ) : isError ? (
          <div className="py-12 text-center text-sm text-[var(--error)]">Failed to load bills.</div>
        ) : (
          <div className={industrialTableClassName()}>
            <table className="w-full text-left text-sm">
              <thead className="bg-[var(--bg-elevated)]">
                <tr className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-muted">
                  <th className="px-3 py-2.5">Bill #</th>
                  <th className="px-3 py-2.5">Customer</th>
                  <th className="hidden px-3 py-2.5 sm:table-cell">Bill Date</th>
                  <th className="hidden px-3 py-2.5 md:table-cell">Items</th>
                  <th className="hidden px-3 py-2.5 text-right lg:table-cell">Qty</th>
                  <th className="hidden px-3 py-2.5 text-right md:table-cell">Taxable Amt</th>
                  <th className="hidden px-3 py-2.5 text-right md:table-cell">GST</th>
                  <th className="px-3 py-2.5 text-right">Total</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="">
                {filtered.map((b) => {
                  const firstItem = b.lineItems[0]
                  const totalQty = b.lineItems.reduce((s, li) => s + li.quantity, 0)
                  const hasJcLines = b.lineItems.some((li) => li.jobCardId)
                  return (
                    <tr
                      key={b.id}
                      className="cursor-pointer transition-colors hover:bg-[var(--bg-muted)]"
                      onClick={() => setDrawerBill(b)}
                    >
                      <td className="px-3 py-2.5">
                        <span className="font-mono text-xs font-medium text-[var(--brand-primary)]">{b.billNumber}</span>
                      </td>
                      <td className="px-3 py-2.5 text-xs font-medium text-ds-ink">{b.customer.name}</td>
                      <td className="hidden px-3 py-2.5 text-xs text-ds-ink-muted sm:table-cell">
                        {fmtDate(b.billDate)}
                      </td>
                      <td className="hidden max-w-[180px] px-3 py-2.5 md:table-cell">
                        <span className="block truncate text-xs text-ds-ink">{firstItem?.description ?? '—'}</span>
                        {b.lineItems.length > 1 && (
                          <span className="text-[10px] text-ds-ink-muted">+{b.lineItems.length - 1} more</span>
                        )}
                      </td>
                      <td className="hidden px-3 py-2.5 text-right text-xs tabular-nums text-ds-ink-muted lg:table-cell">
                        {totalQty.toLocaleString('en-IN')}
                      </td>
                      <td className="hidden px-3 py-2.5 text-right text-xs tabular-nums text-ds-ink-muted md:table-cell">
                        {fmtAmount(b.subtotal)}
                      </td>
                      <td className="hidden px-3 py-2.5 text-right text-xs tabular-nums text-ds-ink-muted md:table-cell">
                        {fmtAmount(b.gstAmount)}
                      </td>
                      <td className="px-3 py-2.5 text-right text-xs font-semibold tabular-nums text-ds-ink">
                        {fmtAmount(b.totalAmount)}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <StatusBadge status={STATUS_LABELS[b.status] ?? b.status} />
                          {hasJcLines && (
                            <Badge tone="neutral" className="px-1 py-0 text-[9px]">JC</Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          className="px-2.5 py-1 text-xs"
                          onClick={(e) => { e.stopPropagation(); setDrawerBill(b) }}
                        >
                          View →
                        </Button>
                      </td>
                    </tr>
                  )
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-3 py-12 text-center text-sm text-ds-ink-faint">
                      {localSearch ? `No bills matching "${localSearch}"` : 'No bills found.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </IndustrialModuleShell>

      {/* Bill Quick-View Drawer */}
      <SlideOverPanel
        isOpen={!!drawerBill}
        onClose={() => setDrawerBill(null)}
        title={drawerBill ? drawerBill.billNumber : ''}
        headerMeta={drawerBill ? (
          <span className="text-sm text-ds-ink-muted">
            {drawerBill.customer.name} · {fmtDate(drawerBill.billDate)}
          </span>
        ) : null}
        footer={drawerBill ? drawerFooter(drawerBill) : null}
        widthClass="w-[min(100%,clamp(460px,44vw,720px))]"
      >
        {drawerBill && <BillDrawerBody bill={drawerBill} />}
      </SlideOverPanel>
    </>
  )
}

/* ─── Bill Drawer Body ─────────────────────────────────────────────────── */

function BillDrawerBody({ bill }: { bill: Bill }) {
  const hasJcLines = bill.lineItems.some((li) => li.jobCardId)

  return (
    <div className="space-y-4 pb-2">
      {/* Bill summary strip */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-ds-md bg-[var(--brand-bg-soft)] px-4 py-3.5">
        <div>
          <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-widest text-[var(--brand-primary)]">Bill #</p>
          <p className="font-mono text-sm font-bold text-ds-ink">{bill.billNumber}</p>
        </div>
        <div>
          <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-widest text-ds-ink-muted">Customer</p>
          <p className="text-sm font-semibold text-ds-ink">{bill.customer.name}</p>
        </div>
        <div>
          <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-widest text-ds-ink-muted">Bill Date</p>
          <p className="text-sm text-ds-ink">{fmtDate(bill.billDate)}</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <StatusBadge status={STATUS_LABELS[bill.status] ?? bill.status} />
          {hasJcLines && <Badge tone="neutral" className="px-1 py-0 text-[9px]">JC</Badge>}
        </div>
      </div>

      {/* Line Items */}
      <CardSection title="Line Items">
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="text-[10px] font-semibold uppercase tracking-wider text-ds-ink-muted">
                <th className="pr-3 py-1.5 text-left font-semibold">Description</th>
                <th className="px-2 py-1.5 text-right font-semibold">Qty</th>
                <th className="px-2 py-1.5 text-right font-semibold">Rate</th>
                <th className="px-2 py-1.5 text-right font-semibold">GST%</th>
                <th className="pl-2 py-1.5 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody className="">
              {bill.lineItems.map((li) => (
                <tr key={li.id} className="text-ds-ink-muted">
                  <td className="pr-3 py-2">
                    <span className="font-medium text-ds-ink">{li.description}</span>
                    {li.jobCardId && <Badge tone="neutral" className="ml-1.5 px-1 py-0 text-[9px]">JC</Badge>}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{li.quantity.toLocaleString('en-IN')}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtAmount(li.rate)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{li.gstPct}%</td>
                  <td className="pl-2 py-2 text-right font-semibold tabular-nums text-ds-ink">{fmtAmount(li.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardSection>

      {/* Financial Breakdown */}
      <CardSection title="Financial Summary">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-ds-ink-muted">Taxable Amount</span>
            <span className="font-medium tabular-nums text-ds-ink">{fmtAmount(bill.subtotal)}</span>
          </div>
          {bill.taxSplit === 'intra' || (bill.cgstAmount ?? 0) > 0 || (bill.sgstAmount ?? 0) > 0 ? (
            <>
              <div className="flex items-center justify-between text-xs">
                <span className="text-ds-ink-muted">CGST</span>
                <span className="font-medium tabular-nums text-ds-ink">{fmtAmount(bill.cgstAmount ?? 0)}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-ds-ink-muted">SGST</span>
                <span className="font-medium tabular-nums text-ds-ink">{fmtAmount(bill.sgstAmount ?? 0)}</span>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between text-xs">
              <span className="text-ds-ink-muted">IGST</span>
              <span className="font-medium tabular-nums text-ds-ink">{fmtAmount(bill.igstAmount ?? 0)}</span>
            </div>
          )}
          {(bill.cgstAmount ?? 0) === 0 && (bill.sgstAmount ?? 0) === 0 && (bill.igstAmount ?? 0) === 0 && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-ds-ink-muted">GST</span>
              <span className="font-medium tabular-nums text-ds-ink">{fmtAmount(bill.gstAmount)}</span>
            </div>
          )}
          <div className="mt-1 flex items-center justify-between pt-2">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-ds-ink">
              <Receipt className="h-3.5 w-3.5 text-[var(--brand-primary)]" />
              Total Amount
            </span>
            <span className="text-base font-bold tabular-nums text-[var(--brand-primary)]">{fmtAmount(bill.totalAmount)}</span>
          </div>
          {bill.ewayApplicable && (
            <div className="mt-1 rounded-ds-sm bg-[var(--warning-bg)] px-2 py-1 text-[11px] text-[var(--warning)]">
              E-way bill applicable (≥ ₹50,000 with transport mode set)
            </div>
          )}
        </div>
      </CardSection>

      {/* Quick Links */}
      <div className="flex gap-2">
        <Link href={`/billing/${bill.id}`} className="flex-1">
          <Button variant="secondary" className="w-full gap-1.5 text-xs">
            <ExternalLink className="h-3 w-3" />
            Open Full Bill Detail
          </Button>
        </Link>
        <Link href={`/stores/short-excess`} className="flex-1">
          <Button variant="secondary" className="w-full gap-1.5 text-xs">
            Short &amp; Excess →
          </Button>
        </Link>
      </div>
    </div>
  )
}
