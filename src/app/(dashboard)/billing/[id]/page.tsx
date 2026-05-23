'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { toast } from '@/store/toastStore'
import { Badge, Button, CardSection, StatusBadge } from '@/components/design-system'

type LineItem = {
  id: string
  description: string
  quantity: number
  rate: number
  gstPct: number
  amount: number
  jobCardId: string | null
}

type Bill = {
  id: string
  billNumber: string
  billDate: string
  customer: { id: string; name: string }
  subtotal: number
  gstAmount: number
  totalAmount: number
  status: string
  lineItems: LineItem[]
}

type ReconRow = {
  jobCardId: string
  poLineItemId: string
  cartonName: string
  poNumber: string
  poQty: number
  billedQty: number
  tolerancePct: number
  flag: 'ok' | 'short' | 'excess'
  varianceQty: number
  seRecord: { id: string; status: string } | null
  flagging: boolean
}

function computeFlag(poQty: number, billedQty: number, tolerancePct: number): { flag: 'ok' | 'short' | 'excess'; varianceQty: number } {
  const varianceQty = billedQty - poQty
  const band = poQty * tolerancePct / 100
  if (Math.abs(varianceQty) <= band) return { flag: 'ok', varianceQty }
  return { flag: varianceQty < 0 ? 'short' : 'excess', varianceQty }
}

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  closed: 'Closed',
  sent_to_planning: 'Sent to Planning',
  sent_to_fg: 'Sent to FG',
}

export default function BillDetailPage() {
  const params = useParams()
  const id = params.id as string
  const [bill, setBill] = useState<Bill | null>(null)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [reconRows, setReconRows] = useState<ReconRow[]>([])
  const [reconLoading, setReconLoading] = useState(false)

  useEffect(() => {
    fetch(`/api/bills/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data || data.error) throw new Error(data.error || 'Failed to load')
        setBill(data)
        setStatus(data.status)
        loadReconciliation(data)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [id])

  async function loadReconciliation(data: Bill) {
    const linesWithJc = data.lineItems.filter((l) => l.jobCardId)
    if (!linesWithJc.length) return

    setReconLoading(true)
    try {
      const [seRes] = await Promise.all([
        fetch(`/api/short-excess?status=all`).then((r) => r.json()),
      ])
      const seRecords: { id: string; status: string; poLineItemId: string; billId: string | null }[] = Array.isArray(seRes) ? seRes : []
      const seByPoLineAndBill = new Map(seRecords.filter((r) => r.billId === data.id).map((r) => [r.poLineItemId, r]))

      const rows: ReconRow[] = []
      await Promise.all(
        linesWithJc.map(async (line) => {
          try {
            const jcRes = await fetch(`/api/job-cards/${line.jobCardId}`)
            const jcData = await jcRes.json()
            if (!jcData || jcData.error || !jcData.poLine) return
            const poQty = Number(jcData.poLine.quantity || 0)
            const tolerancePct = Number(jcData.poLine.tolerancePct ?? 2)
            const { flag, varianceQty } = computeFlag(poQty, line.quantity, tolerancePct)
            const seRecord = seByPoLineAndBill.get(jcData.poLine.id) ?? null
            rows.push({
              jobCardId: line.jobCardId!,
              poLineItemId: jcData.poLine.id,
              cartonName: jcData.poLine.cartonName || line.description,
              poNumber: jcData.poLine.po?.poNumber || '—',
              poQty,
              billedQty: line.quantity,
              tolerancePct,
              flag,
              varianceQty,
              seRecord,
              flagging: false,
            })
          } catch {
            // skip
          }
        })
      )
      setReconRows(rows.sort((a, b) => (a.flag === 'ok' ? 1 : -1)))
    } finally {
      setReconLoading(false)
    }
  }

  async function flagToShortExcess(rowIdx: number) {
    const row = reconRows[rowIdx]
    if (!row || !bill) return
    setReconRows((prev) => prev.map((r, i) => i === rowIdx ? { ...r, flagging: true } : r))
    try {
      const res = await fetch('/api/short-excess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poLineItemId: row.poLineItemId,
          jobCardId: row.jobCardId,
          billId: bill.id,
          poQty: row.poQty,
          actualQty: row.billedQty,
          tolerancePct: row.tolerancePct,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to flag')
      setReconRows((prev) => prev.map((r, i) => i === rowIdx ? { ...r, seRecord: { id: json.id, status: 'open' }, flagging: false } : r))
      toast.success('Flagged — visible in Short & Excess')
    } catch {
      toast.error('Failed to flag')
      setReconRows((prev) => prev.map((r, i) => i === rowIdx ? { ...r, flagging: false } : r))
    }
  }

  const handleSaveStatus = async () => {
    if (!bill) return
    setSaving(true)
    try {
      const res = await fetch(`/api/bills/${bill.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Save failed')
      toast.success('Updated')
      setBill((prev) => (prev ? { ...prev, status } : prev))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  if (!bill) return <div className="p-4 text-ds-ink-muted">Loading…</div>

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/billing" className="mb-1 inline-block text-sm text-ds-ink-muted hover:text-ds-ink">
            ← Bills
          </Link>
          <h1 className="text-xl font-bold text-[var(--brand-primary)]">{bill.billNumber}</h1>
          <p className="text-sm text-ds-ink-muted">
            {bill.customer.name} · {new Date(bill.billDate).toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/billing/${bill.id}/print`} target="_blank">
            <Button variant="secondary" className="gap-1.5">Print Tax Invoice</Button>
          </Link>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="ds-input h-9 cursor-pointer py-1.5"
          >
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="paid">Paid</option>
          </select>
          <Button variant="primary" onClick={handleSaveStatus} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      <CardSection className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-[var(--bg-elevated)] text-ds-ink-muted">
            <tr>
              <th className="px-4 py-2 text-left">Description</th>
              <th className="px-4 py-2 text-right">Qty</th>
              <th className="px-4 py-2 text-right">Rate</th>
              <th className="px-4 py-2 text-right">GST%</th>
              <th className="px-4 py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="">
            {bill.lineItems.map((li) => (
              <tr key={li.id}>
                <td className="px-4 py-2 text-ds-ink">{li.description}</td>
                <td className="px-4 py-2 text-right tabular-nums text-ds-ink-muted">{li.quantity}</td>
                <td className="px-4 py-2 text-right tabular-nums text-ds-ink-muted">
                  ₹{li.rate.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-ds-ink-muted">{li.gstPct}%</td>
                <td className="px-4 py-2 text-right tabular-nums text-ds-ink">
                  ₹{li.amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardSection>

      <CardSection className="flex justify-end">
        <div className="space-y-1 text-right text-sm">
          <div className="flex justify-between gap-8">
            <span className="text-ds-ink-muted">Subtotal</span>
            <span className="tabular-nums text-ds-ink">
              ₹{bill.subtotal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="flex justify-between gap-8">
            <span className="text-ds-ink-muted">GST</span>
            <span className="tabular-nums text-ds-ink">
              ₹{bill.gstAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="mt-2 flex justify-between gap-8 pt-2 font-semibold text-[var(--brand-primary)]">
            <span>Total</span>
            <span className="tabular-nums">₹{bill.totalAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
          </div>
        </div>
      </CardSection>

      {/* PO Reconciliation Panel */}
      {reconLoading ? (
        <CardSection>
          <div className="animate-pulse py-4 text-center text-sm text-ds-ink-muted">
            Checking PO reconciliation…
          </div>
        </CardSection>
      ) : reconRows.length > 0 ? (
        <CardSection
          title={`PO Reconciliation · ${reconRows.length} line${reconRows.length !== 1 ? 's' : ''}`}
          className="overflow-hidden p-0"
          action={
            reconRows.some((r) => r.seRecord) ? (
              <Link
                href="/stores/short-excess"
                className="text-xs font-semibold text-[var(--brand-primary)] hover:underline"
              >
                View in Short &amp; Excess →
              </Link>
            ) : undefined
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-muted">
                  <th className="px-4 py-2.5 text-left">Carton</th>
                  <th className="px-3 py-2.5 text-left">PO #</th>
                  <th className="px-3 py-2.5 text-right">PO Qty</th>
                  <th className="px-3 py-2.5 text-right">Billed Qty</th>
                  <th className="px-3 py-2.5 text-right">Variance</th>
                  <th className="px-3 py-2.5 text-center">Tol%</th>
                  <th className="px-3 py-2.5 text-center">Flag</th>
                  <th className="px-3 py-2.5 text-center">S&amp;E Status</th>
                </tr>
              </thead>
              <tbody className="">
                {reconRows.map((row, idx) => {
                  const varianceClass =
                    row.varianceQty < 0
                      ? 'text-[var(--error)]'
                      : row.varianceQty > 0
                        ? 'text-[var(--warning)]'
                        : 'text-[var(--success)]'
                  return (
                    <tr key={row.jobCardId} className="transition-colors hover:bg-[var(--bg-muted)]">
                      <td className="px-4 py-3 font-medium text-ds-ink">{row.cartonName}</td>
                      <td className="px-3 py-3 font-mono text-xs text-ds-ink-muted">{row.poNumber}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{row.poQty.toLocaleString('en-IN')}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{row.billedQty.toLocaleString('en-IN')}</td>
                      <td className={`px-3 py-3 text-right font-medium tabular-nums ${varianceClass}`}>
                        {row.varianceQty > 0 ? '+' : ''}{row.varianceQty.toLocaleString('en-IN')}
                      </td>
                      <td className="px-3 py-3 text-center text-xs text-ds-ink-muted">{row.tolerancePct}%</td>
                      <td className="px-3 py-3 text-center">
                        {row.flag === 'ok' && <Badge tone="success">OK</Badge>}
                        {row.flag === 'short' && (
                          <Badge tone="danger">SHORT {Math.abs(row.varianceQty).toLocaleString('en-IN')}</Badge>
                        )}
                        {row.flag === 'excess' && (
                          <Badge tone="warning">EXCESS +{row.varianceQty.toLocaleString('en-IN')}</Badge>
                        )}
                      </td>
                      <td className="px-3 py-3 text-center">
                        {row.flag === 'ok' ? (
                          <span className="text-xs text-ds-ink-muted">—</span>
                        ) : row.seRecord ? (
                          <StatusBadge status={STATUS_LABEL[row.seRecord.status] ?? row.seRecord.status} />
                        ) : (
                          <Button
                            variant="warning"
                            className="px-2.5 py-1 text-xs"
                            onClick={() => flagToShortExcess(idx)}
                            disabled={row.flagging}
                          >
                            {row.flagging ? 'Flagging…' : '→ Flag'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardSection>
      ) : null}
    </div>
  )
}
