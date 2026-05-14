'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'
import { MasterSearchSelect } from '@/components/ui/MasterSearchSelect'
import { Badge, Button, CardSection } from '@/components/design-system'

type Customer = { id: string; name: string; contactName?: string | null }
type JobCard = { id: string; jobCardNumber: number; setNumber: string | null; customerId: string }

type Line = {
  description: string
  quantity: string
  rate: string
  gstPct: string
  jobCardId: string
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
  flagged: boolean
  flagging: boolean
}

function computeFlag(poQty: number, billedQty: number, tolerancePct: number): { flag: 'ok' | 'short' | 'excess'; varianceQty: number } {
  const varianceQty = billedQty - poQty
  const band = poQty * tolerancePct / 100
  if (Math.abs(varianceQty) <= band) return { flag: 'ok', varianceQty }
  return { flag: varianceQty < 0 ? 'short' : 'excess', varianceQty }
}

export default function NewBillPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [jobCards, setJobCards] = useState<JobCard[]>([])
  const [customerId, setCustomerId] = useState('')
  const [billDate, setBillDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [lines, setLines] = useState<Line[]>([
    { description: '', quantity: '', rate: '', gstPct: '12', jobCardId: '' },
  ])
  const [saving, setSaving] = useState(false)

  const [savedBillId, setSavedBillId] = useState<string | null>(null)
  const [reconRows, setReconRows] = useState<ReconRow[]>([])
  const [reconLoading, setReconLoading] = useState(false)

  const customerSearch = useAutoPopulate<Customer>({
    storageKey: 'billing-customer',
    search: async (query: string) => {
      const res = await fetch(`/api/customers?q=${encodeURIComponent(query)}`)
      return (await res.json()) as Customer[]
    },
    getId: (c) => c.id,
    getLabel: (c) => c.name,
  })

  const applyCustomer = (c: Customer) => {
    customerSearch.select(c)
    setCustomerId(c.id)
  }

  useEffect(() => {
    fetch('/api/job-cards')
      .then((r) => r.json())
      .then((data) => setJobCards(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const jobCardId = searchParams.get('jobCardId')
    if (!jobCardId) return
    fetch(`/api/job-cards/${jobCardId}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data || data.error) return
        const cid = String(data.customer?.id || '')
        if (cid) setCustomerId(cid)
        const carton = String(data.poLine?.cartonName || '').trim()
        const po = String(data.poLine?.po?.poNumber || '').trim()
        const qty = Number(data.poLine?.quantity || 0)
        const desc = carton ? `${carton}${po ? ` · PO ${po}` : ''}` : `Job Card #${data.jobCardNumber}`
        setLines((prev) => {
          const first = prev[0] ?? { description: '', quantity: '', rate: '', gstPct: '12', jobCardId: '' }
          return [
            {
              ...first,
              description: first.description || desc,
              quantity: first.quantity || (qty > 0 ? String(qty) : ''),
              jobCardId: first.jobCardId || String(jobCardId),
            },
            ...prev.slice(1),
          ]
        })
      })
      .catch(() => {})
  }, [searchParams])

  const filteredJcs = customerId
    ? jobCards.filter((jc) => jc.customerId === customerId)
    : jobCards

  const addLine = () => {
    setLines((prev) => [
      ...prev,
      { description: '', quantity: '', rate: '', gstPct: '12', jobCardId: '' },
    ])
  }

  const updateLine = (idx: number, patch: Partial<Line>) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)))
  }

  const removeLine = (idx: number) => {
    setLines((prev) => prev.filter((_, i) => i !== idx))
  }

  async function loadReconciliation(billId: string, submittedLines: Line[]) {
    setReconLoading(true)
    const linesWithJc = submittedLines.filter((l) => l.jobCardId && l.description && l.quantity && l.rate)
    const rows: ReconRow[] = []
    await Promise.all(
      linesWithJc.map(async (line) => {
        try {
          const res = await fetch(`/api/job-cards/${line.jobCardId}`)
          const data = await res.json()
          if (!data || data.error || !data.poLine) return
          const poQty = Number(data.poLine.quantity || 0)
          const tolerancePct = Number(data.poLine.tolerancePct ?? 2)
          const billedQty = Number(line.quantity)
          const { flag, varianceQty } = computeFlag(poQty, billedQty, tolerancePct)
          rows.push({
            jobCardId: line.jobCardId,
            poLineItemId: data.poLine.id,
            cartonName: data.poLine.cartonName || line.description,
            poNumber: data.poLine.po?.poNumber || '—',
            poQty,
            billedQty,
            tolerancePct,
            flag,
            varianceQty,
            flagged: false,
            flagging: false,
          })
        } catch {
          // skip line if fetch fails
        }
      })
    )
    setReconRows(rows.sort((a, b) => (a.flag === 'ok' ? 1 : -1)))
    setReconLoading(false)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!customerId) {
      toast.error('Select customer')
      return
    }
    const valid = lines.filter((l) => l.description && l.quantity && l.rate)
    if (!valid.length) {
      toast.error('Add at least one line with description, qty and rate')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/bills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId,
          billDate,
          lineItems: valid.map((l) => ({
            description: l.description,
            quantity: Number(l.quantity),
            rate: Number(l.rate),
            gstPct: Number(l.gstPct) || 12,
            jobCardId: l.jobCardId || undefined,
          })),
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to create bill')
      toast.success(`Bill ${json.billNumber} created`)
      setSavedBillId(json.id)
      await loadReconciliation(json.id, valid)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  async function flagToShortExcess(rowIdx: number) {
    const row = reconRows[rowIdx]
    if (!row || !savedBillId) return
    setReconRows((prev) => prev.map((r, i) => i === rowIdx ? { ...r, flagging: true } : r))
    try {
      const res = await fetch('/api/short-excess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poLineItemId: row.poLineItemId,
          jobCardId: row.jobCardId,
          billId: savedBillId,
          poQty: row.poQty,
          actualQty: row.billedQty,
          tolerancePct: row.tolerancePct,
        }),
      })
      if (!res.ok) throw new Error('Failed to flag')
      setReconRows((prev) => prev.map((r, i) => i === rowIdx ? { ...r, flagged: true, flagging: false } : r))
      toast.success('Flagged — visible in Short & Excess')
    } catch {
      toast.error('Failed to flag')
      setReconRows((prev) => prev.map((r, i) => i === rowIdx ? { ...r, flagging: false } : r))
    }
  }

  const allFlagged = reconRows.filter((r) => r.flag !== 'ok').every((r) => r.flagged)

  if (savedBillId) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-[var(--brand-primary)]">PO Reconciliation</h1>
          <Button variant="secondary" onClick={() => router.push('/billing')}>
            ← Back to billing
          </Button>
        </div>

        {reconLoading ? (
          <CardSection>
            <div className="animate-pulse py-6 text-center text-sm text-ds-ink-muted">
              Checking PO quantities…
            </div>
          </CardSection>
        ) : reconRows.length === 0 ? (
          <CardSection>
            <div className="py-4 text-center text-sm text-ds-ink-muted">
              No job-card lines to reconcile. Bill saved successfully.
            </div>
          </CardSection>
        ) : (
          <CardSection
            title={`Reconciliation · ${reconRows.length} line${reconRows.length !== 1 ? 's' : ''}`}
            className="overflow-hidden p-0"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-[11px] font-semibold uppercase tracking-wider text-ds-ink-muted">
                    <th className="px-4 py-2.5 text-left">Carton</th>
                    <th className="px-3 py-2.5 text-left">PO #</th>
                    <th className="px-3 py-2.5 text-right">PO Qty</th>
                    <th className="px-3 py-2.5 text-right">Billed Qty</th>
                    <th className="px-3 py-2.5 text-right">Variance</th>
                    <th className="px-3 py-2.5 text-center">Tol%</th>
                    <th className="px-3 py-2.5 text-center">Flag</th>
                    <th className="px-3 py-2.5 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
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
                          {row.flag !== 'ok' && (
                            row.flagged ? (
                              <span className="text-xs font-medium text-[var(--success)]">✓ Flagged</span>
                            ) : (
                              <Button
                                variant="warning"
                                className="px-2.5 py-1 text-xs"
                                onClick={() => flagToShortExcess(idx)}
                                disabled={row.flagging}
                              >
                                {row.flagging ? 'Flagging…' : '→ Short & Excess'}
                              </Button>
                            )
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardSection>
        )}

        {!reconLoading && (
          <div className="flex justify-end gap-2">
            {!allFlagged && reconRows.some((r) => r.flag !== 'ok' && !r.flagged) && (
              <Button variant="ghost" onClick={() => router.push('/stores/short-excess')}>
                Skip reconciliation
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => router.push(allFlagged && reconRows.some((r) => r.flag !== 'ok') ? '/stores/short-excess' : '/billing')}
            >
              {allFlagged && reconRows.some((r) => r.flag !== 'ok') ? 'View Short & Excess →' : 'Done'}
            </Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-4xl space-y-4 p-4">
      <h1 className="text-xl font-bold text-[var(--brand-primary)]">New Bill</h1>

      <CardSection>
        <div className="grid gap-4 text-sm md:grid-cols-2">
          <div>
            <MasterSearchSelect
              label="Customer"
              required
              query={customerSearch.query}
              onQueryChange={(value) => {
                customerSearch.setQuery(value)
                setCustomerId('')
              }}
              loading={customerSearch.loading}
              options={customerSearch.options}
              lastUsed={customerSearch.lastUsed}
              onSelect={applyCustomer}
              getOptionLabel={(c) => c.name}
              getOptionMeta={(c) => c.contactName ?? ''}
              placeholder="Type 1-2 letters to search customers..."
              recentLabel="Recent customers"
              loadingMessage="Searching customers..."
              emptyMessage="No customer found."
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="bill-date" className="block text-xs font-medium text-ds-ink-muted">Bill date</label>
            <input
              id="bill-date"
              type="date"
              value={billDate}
              onChange={(e) => setBillDate(e.target.value)}
              className="ds-input"
            />
          </div>
        </div>
      </CardSection>

      <CardSection
        title="Line items"
        action={
          <Button variant="secondary" onClick={addLine} className="px-3 py-1.5 text-xs">
            + Add line
          </Button>
        }
      >
        <div className="space-y-2">
          {lines.map((l, idx) => (
            <div key={idx} className="grid grid-cols-12 items-end gap-2 text-sm">
              <div className="col-span-4">
                <input
                  type="text"
                  placeholder="Description"
                  value={l.description}
                  onChange={(e) => updateLine(idx, { description: e.target.value })}
                  className="ds-input"
                />
              </div>
              <div className="col-span-1">
                <input
                  type="number"
                  placeholder="Qty"
                  value={l.quantity}
                  onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                  className="ds-input"
                />
              </div>
              <div className="col-span-2">
                <input
                  type="number"
                  placeholder="Rate"
                  value={l.rate}
                  onChange={(e) => updateLine(idx, { rate: e.target.value })}
                  className="ds-input"
                />
              </div>
              <div className="col-span-1">
                <input
                  type="number"
                  placeholder="GST%"
                  value={l.gstPct}
                  onChange={(e) => updateLine(idx, { gstPct: e.target.value })}
                  className="ds-input"
                />
              </div>
              <div className="col-span-3">
                <select
                  value={l.jobCardId}
                  onChange={(e) => updateLine(idx, { jobCardId: e.target.value })}
                  className="ds-input cursor-pointer"
                >
                  <option value="">No job card</option>
                  {filteredJcs.map((jc) => (
                    <option key={jc.id} value={jc.id}>
                      JC#{jc.jobCardNumber} {jc.setNumber ? `Set ${jc.setNumber}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-1 flex justify-center">
                {lines.length > 1 && (
                  <Button
                    variant="ghost"
                    aria-label="Remove line"
                    className="px-2 py-1 text-[var(--error)] hover:text-[var(--error)]"
                    onClick={() => removeLine(idx)}
                  >
                    ✕
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardSection>

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => router.push('/billing')}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Create bill'}
        </Button>
      </div>
    </form>
  )
}
