'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Copy, Trash2 } from 'lucide-react'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'
import { useUnitOptions } from '@/hooks/useUnitOptions'
import { MasterSearchSelect } from '@/components/ui/MasterSearchSelect'
import { mapApiRowToPoCarton, type PoCartonCatalogItem } from '@/lib/po-carton-autocomplete'
import { amountInWords } from '@/lib/amount-in-words'
import { Badge, Button, CardSection, StatusBadge } from '@/components/design-system'
import { PageHeader } from '@/components/design-system/PageHeader'

type Customer = {
  id: string
  name: string
  gstNumber?: string | null
  contactName?: string | null
  contactPhone?: string | null
  email?: string | null
  address?: string | null
}

type JobCard = { id: string; jobCardNumber: number; setNumber: string | null; customerId: string }

type Line = {
  cartonId: string
  description: string
  hsnCode: string
  uom: string
  quantity: string
  rate: string
  discountPct: string
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

const DEFAULT_HSN = '48191010'
const DEFAULT_UOM = 'Pcs'

const defaultLine = (): Line => ({
  cartonId: '',
  description: '',
  hsnCode: '',
  uom: DEFAULT_UOM,
  quantity: '',
  rate: '',
  discountPct: '0',
  gstPct: '12',
  jobCardId: '',
})

function computeFlag(poQty: number, billedQty: number, tolerancePct: number): { flag: 'ok' | 'short' | 'excess'; varianceQty: number } {
  const varianceQty = billedQty - poQty
  const band = poQty * tolerancePct / 100
  if (Math.abs(varianceQty) <= band) return { flag: 'ok', varianceQty }
  return { flag: varianceQty < 0 ? 'short' : 'excess', varianceQty }
}

function lineMath(line: Line) {
  const qty = Number(line.quantity) || 0
  const rate = Number(line.rate) || 0
  const disc = Number(line.discountPct) || 0
  const gstPct = Number(line.gstPct) || 0
  const taxable = qty * rate * (1 - disc / 100)
  const gst = taxable * gstPct / 100
  const total = taxable + gst
  return { taxable, gst, total, gstPct }
}

function fmtINR(n: number, opts?: { withSymbol?: boolean }) {
  const v = n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return opts?.withSymbol === false ? v : `₹${v}`
}

export default function NewBillPage() {
  const router = useRouter()
  const { options: uomOptions } = useUnitOptions(['Pcs', 'Box', 'Set', 'Sheets', 'Kg'])
  const searchParams = useSearchParams()
  const [jobCards, setJobCards] = useState<JobCard[]>([])
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [billDate, setBillDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [lines, setLines] = useState<Line[]>([defaultLine()])
  const [notes, setNotes] = useState('')
  const [terms, setTerms] = useState('Goods once sold will not be taken back. Interest @ 18% p.a. on overdue bills.')
  const [saving, setSaving] = useState(false)
  const [cartonCatalog, setCartonCatalog] = useState<PoCartonCatalogItem[]>([])
  const [cartonLoading, setCartonLoading] = useState(false)
  const [cartonQueries, setCartonQueries] = useState<Record<number, string>>({})

  const [savedBillId, setSavedBillId] = useState<string | null>(null)
  const [savedBillNumber, setSavedBillNumber] = useState<string>('')
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
    setCustomer(c)
  }

  useEffect(() => {
    fetch('/api/job-cards')
      .then((r) => r.json())
      .then((data) => setJobCards(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  // Load carton catalogue for the selected customer (drives line item picker).
  useEffect(() => {
    if (!customer?.id) {
      setCartonCatalog([])
      return
    }
    setCartonLoading(true)
    fetch(`/api/cartons?customerId=${encodeURIComponent(customer.id)}&limit=4000`)
      .then((r) => r.json())
      .then((data: unknown) => {
        const arr = Array.isArray(data) ? data : []
        setCartonCatalog(arr.map((row) => mapApiRowToPoCarton(row as Record<string, unknown>)))
      })
      .catch(() => setCartonCatalog([]))
      .finally(() => setCartonLoading(false))
  }, [customer?.id])

  // Prefill from ?jobCardId=...
  useEffect(() => {
    const jobCardId = searchParams.get('jobCardId')
    if (!jobCardId) return
    fetch(`/api/job-cards/${jobCardId}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data || data.error) return
        const cust = data.customer
        if (cust?.id) {
          setCustomer({
            id: cust.id,
            name: cust.name ?? '',
            gstNumber: cust.gstNumber ?? null,
            contactName: cust.contactName ?? null,
            contactPhone: cust.contactPhone ?? null,
            email: cust.email ?? null,
            address: cust.address ?? null,
          })
          customerSearch.setQuery(cust.name ?? '')
        }
        const carton = String(data.poLine?.cartonName || '').trim()
        const po = String(data.poLine?.po?.poNumber || '').trim()
        const qty = Number(data.poLine?.quantity || 0)
        const rate = data.poLine?.rate != null ? Number(data.poLine.rate) : null
        const gstPct = data.poLine?.gstPct != null ? Number(data.poLine.gstPct) : null
        const desc = carton ? `${carton}${po ? ` · PO ${po}` : ''}` : `Job Card #${data.jobCardNumber}`
        setLines((prev) => {
          const first = prev[0] ?? defaultLine()
          return [
            {
              ...first,
              description: first.description || desc,
              cartonId: first.cartonId || String(data.poLine?.cartonId || ''),
              hsnCode: first.hsnCode || DEFAULT_HSN,
              quantity: first.quantity || (qty > 0 ? String(qty) : ''),
              rate: first.rate || (rate != null ? String(rate) : ''),
              gstPct: first.gstPct || (gstPct != null ? String(gstPct) : '12'),
              jobCardId: first.jobCardId || String(jobCardId),
            },
            ...prev.slice(1),
          ]
        })
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  const filteredJcs = customer
    ? jobCards.filter((jc) => jc.customerId === customer.id)
    : jobCards

  const addLine = () => setLines((prev) => [...prev, defaultLine()])
  const updateLine = (idx: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)))
  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx))
  const duplicateLine = (idx: number) =>
    setLines((prev) => {
      const copy = [...prev]
      copy.splice(idx + 1, 0, { ...prev[idx], jobCardId: '' })
      return copy
    })

  const pickCarton = (idx: number, c: PoCartonCatalogItem) => {
    updateLine(idx, {
      cartonId: c.id,
      description: c.cartonName + (c.cartonSize ? ` (${c.cartonSize})` : ''),
      hsnCode: DEFAULT_HSN,
      uom: DEFAULT_UOM,
      rate: c.rate != null ? String(c.rate) : '',
      gstPct: c.gstPct != null ? String(c.gstPct) : '12',
    })
    setCartonQueries((prev) => ({ ...prev, [idx]: c.cartonName }))
  }

  const lineCalcs = useMemo(() => lines.map(lineMath), [lines])

  const totals = useMemo(() => {
    let taxable = 0
    let gst = 0
    for (const c of lineCalcs) {
      taxable += c.taxable
      gst += c.gst
    }
    const grandRaw = taxable + gst
    const grand = Math.round(grandRaw)
    const roundOff = grand - grandRaw
    return { taxable, gst, grandRaw, grand, roundOff }
  }, [lineCalcs])

  // Place-of-supply split: if customer GSTIN starts with same state code as seller, intra-state (CGST+SGST), else IGST.
  // Seller state derived from env (fallback: customer state — single state means CGST+SGST always).
  const sellerStateCode = process.env.NEXT_PUBLIC_SELLER_GST_STATE_CODE || ''
  const customerStateCode = customer?.gstNumber?.slice(0, 2) || ''
  const isInterState = sellerStateCode !== '' && customerStateCode !== '' && sellerStateCode !== customerStateCode

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
    if (!customer?.id) {
      toast.error('Select a customer')
      return
    }
    const valid = lines.filter((l) => l.description && l.quantity && l.rate)
    if (!valid.length) {
      toast.error('Add at least one line with description, quantity and rate')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/bills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: customer.id,
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
      setSavedBillNumber(json.billNumber)
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
    setReconRows((prev) => prev.map((r, i) => (i === rowIdx ? { ...r, flagging: true } : r)))
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
      setReconRows((prev) =>
        prev.map((r, i) => (i === rowIdx ? { ...r, flagged: true, flagging: false } : r)),
      )
      toast.success('Flagged — visible in Short & Excess')
    } catch {
      toast.error('Failed to flag')
      setReconRows((prev) => prev.map((r, i) => (i === rowIdx ? { ...r, flagging: false } : r)))
    }
  }

  const allFlagged = reconRows.filter((r) => r.flag !== 'ok').every((r) => r.flagged)

  // ───────────────── Post-save Reconciliation view ─────────────────
  if (savedBillId) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-4">
        <PageHeader
          title={`Bill ${savedBillNumber} created`}
          description="Review PO reconciliation against billed quantities. Flag short / excess where variance exceeds tolerance."
          actions={
            <Button variant="secondary" onClick={() => router.push('/billing')}>
              ← Back to billing
            </Button>
          }
        />

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
              onClick={() =>
                router.push(
                  allFlagged && reconRows.some((r) => r.flag !== 'ok') ? '/stores/short-excess' : '/billing',
                )
              }
            >
              {allFlagged && reconRows.some((r) => r.flag !== 'ok') ? 'View Short & Excess →' : 'Done'}
            </Button>
          </div>
        )}
      </div>
    )
  }

  // ───────────────── New Bill form ─────────────────
  const yearPrefix = `CI-BILL-${new Date().getFullYear()}-####`
  const sgstOrIgstLabel = isInterState ? 'IGST' : 'SGST'
  const customerStateLabel = customerStateCode
    ? `${customerStateCode}`
    : customer
      ? '—'
      : 'select customer'

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-[1400px] space-y-6 p-4 pb-32">
      <div className="sticky top-0 z-40 -mx-4 border-b border-ds-line/80 bg-ds-main/90 px-4 py-3 backdrop-blur-md">
        <PageHeader
          className="border-0 pb-0"
          title="New tax invoice"
          description="GST tax invoice — customer, lines, and tax. Totals update live as you type."
          actions={
            <>
              <Badge tone="neutral">Draft</Badge>
              <Button type="button" variant="secondary" onClick={() => router.push('/billing')}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? 'Saving…' : 'Create bill'}
              </Button>
            </>
          }
        />
      </div>

      {/* Header — customer + meta */}
      <div className="space-y-4 rounded-ds-lg border border-ds-line/80 bg-ds-card/40 p-4 text-sm shadow-sm">
        <div className="flex items-center justify-between">
          <p className="ds-typo-label font-semibold uppercase tracking-wider text-ds-ink-faint">Invoice header</p>
          <p className="text-xs text-ds-ink-faint">
            Invoice # · <span className="font-mono text-ds-ink-muted">{yearPrefix}</span>{' '}
            <span className="ml-1 text-ds-ink-faint">(auto-assigned on save)</span>
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="md:col-span-2">
            <MasterSearchSelect
              label="Customer"
              required
              query={customerSearch.query}
              onQueryChange={(value) => {
                customerSearch.setQuery(value)
                if (customer) setCustomer(null)
              }}
              loading={customerSearch.loading}
              options={customerSearch.options}
              lastUsed={customerSearch.lastUsed}
              onSelect={applyCustomer}
              getOptionLabel={(c) => c.name}
              getOptionMeta={(c) =>
                [c.gstNumber ? `GSTIN ${c.gstNumber}` : null, c.contactName, c.contactPhone]
                  .filter(Boolean)
                  .join(' · ')
              }
              placeholder="Type to search customer (name, GST, contact)..."
              recentLabel="Recent customers"
              loadingMessage="Searching customers..."
              emptyMessage="No customer found."
            />
            {customer ? (
              <div className="mt-2 rounded-ds-sm border border-ds-line/60 bg-ds-elevated/40 px-3 py-2 text-xs text-ds-ink-muted">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {customer.gstNumber ? (
                    <span>
                      <span className="text-ds-ink-faint">GSTIN:</span>{' '}
                      <span className="font-mono text-ds-ink">{customer.gstNumber}</span>
                    </span>
                  ) : (
                    <span className="text-[var(--warning)]">⚠ No GSTIN on file</span>
                  )}
                  {customer.contactName ? (
                    <span>
                      <span className="text-ds-ink-faint">Contact:</span> {customer.contactName}
                      {customer.contactPhone ? ` · ${customer.contactPhone}` : ''}
                    </span>
                  ) : null}
                </div>
                {customer.address ? (
                  <p className="mt-1 line-clamp-2 text-ds-ink-muted">{customer.address}</p>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="bill-date" className="block text-xs font-medium text-ds-ink-muted">
              Invoice date <span className="text-[var(--error)]">*</span>
            </label>
            <input
              id="bill-date"
              type="date"
              value={billDate}
              onChange={(e) => setBillDate(e.target.value)}
              className="ds-input w-full [color-scheme:dark]"
              required
            />
            <p className="text-[11px] text-ds-ink-faint">
              Place of supply: <span className="font-mono">{customerStateLabel}</span>{' '}
              {customer
                ? isInterState
                  ? '(inter-state · IGST)'
                  : '(intra-state · CGST + SGST)'
                : ''}
            </p>
          </div>
        </div>
      </div>

      {/* Line items + totals */}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-3 rounded-ds-lg border border-ds-line/80 bg-ds-card/30 p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="ds-typo-label font-semibold uppercase tracking-wider text-ds-ink-faint">
              Line items · {lines.length}
            </p>
            <Button type="button" variant="secondary" onClick={addLine} className="px-3 py-1.5 text-xs">
              + Add line
            </Button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ds-line/60 text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
                  <th className="w-8 px-2 py-2 text-left">#</th>
                  <th className="px-2 py-2 text-left" style={{ minWidth: 260 }}>Item / Description</th>
                  <th className="px-2 py-2 text-left">HSN</th>
                  <th className="px-2 py-2 text-left">UOM</th>
                  <th className="px-2 py-2 text-right">Qty</th>
                  <th className="px-2 py-2 text-right">Rate</th>
                  <th className="px-2 py-2 text-right">Disc%</th>
                  <th className="px-2 py-2 text-right">GST%</th>
                  <th className="px-2 py-2 text-right">Taxable</th>
                  <th className="px-2 py-2 text-right">Tax</th>
                  <th className="px-2 py-2 text-right">Total</th>
                  <th className="px-2 py-2 text-left">Job card</th>
                  <th className="w-16 px-2 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ds-line/40">
                {lines.map((l, idx) => {
                  const calc = lineCalcs[idx]
                  const cartonPickQuery = cartonQueries[idx] ?? ''
                  const filteredCartons = cartonPickQuery.trim()
                    ? cartonCatalog.filter(
                        (c) =>
                          c.cartonName.toLowerCase().includes(cartonPickQuery.toLowerCase()) ||
                          (c.artworkCode ?? '').toLowerCase().includes(cartonPickQuery.toLowerCase()),
                      )
                    : cartonCatalog.slice(0, 50)
                  const hasMatchedCarton = Boolean(l.cartonId)
                  return (
                    <tr key={idx} className="align-top">
                      <td className="px-2 py-2 text-center text-xs text-ds-ink-faint tabular-nums">{idx + 1}</td>
                      <td className="px-2 py-2">
                        {customer ? (
                          <MasterSearchSelect<PoCartonCatalogItem>
                            label=""
                            hideLabel
                            query={cartonPickQuery || l.description}
                            onQueryChange={(value) => {
                              setCartonQueries((prev) => ({ ...prev, [idx]: value }))
                              updateLine(idx, { description: value, cartonId: '' })
                            }}
                            loading={cartonLoading}
                            options={filteredCartons}
                            lastUsed={[]}
                            onSelect={(c) => pickCarton(idx, c)}
                            getOptionLabel={(c) => c.cartonName}
                            getOptionMeta={(c) =>
                              [c.cartonSize, c.rate != null ? `₹${c.rate}` : null, c.gstPct != null ? `${c.gstPct}% GST` : null]
                                .filter(Boolean)
                                .join(' · ')
                            }
                            placeholder="Search carton master or type free-text..."
                            recentLabel="Recent"
                            loadingMessage="Loading cartons..."
                            emptyMessage="No carton in master — free-text line"
                          />
                        ) : (
                          <input
                            type="text"
                            placeholder="Select customer first..."
                            disabled
                            className="ds-input w-full"
                          />
                        )}
                        {customer && !hasMatchedCarton && l.description.trim() ? (
                          <span className="mt-1 inline-block text-[10px] font-medium text-ds-ink-faint">
                            <Badge tone="neutral" className="px-1.5 py-0.5 text-[10px]">Free-text</Badge>
                          </span>
                        ) : null}
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="text"
                          value={l.hsnCode}
                          onChange={(e) => updateLine(idx, { hsnCode: e.target.value })}
                          placeholder={DEFAULT_HSN}
                          className="ds-input w-24 font-mono text-xs"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <select
                          value={l.uom}
                          onChange={(e) => updateLine(idx, { uom: e.target.value })}
                          className="ds-input w-20 cursor-pointer text-xs"
                        >
                          {(uomOptions.includes(l.uom) || !l.uom ? uomOptions : [l.uom, ...uomOptions]).map((u) => (
                            <option key={u} value={u}>{u}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-2 text-right">
                        <input
                          type="number"
                          inputMode="numeric"
                          value={l.quantity}
                          onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                          placeholder="0"
                          className="ds-input w-24 text-right tabular-nums"
                        />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.0001"
                          value={l.rate}
                          onChange={(e) => updateLine(idx, { rate: e.target.value })}
                          placeholder="0.00"
                          className="ds-input w-28 text-right tabular-nums"
                        />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          value={l.discountPct}
                          onChange={(e) => updateLine(idx, { discountPct: e.target.value })}
                          className="ds-input w-16 text-right tabular-nums"
                        />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <input
                          type="number"
                          inputMode="numeric"
                          value={l.gstPct}
                          onChange={(e) => updateLine(idx, { gstPct: e.target.value })}
                          className="ds-input w-16 text-right tabular-nums"
                        />
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-ds-ink-muted">
                        {fmtINR(calc.taxable, { withSymbol: false })}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-ds-ink-muted">
                        {fmtINR(calc.gst, { withSymbol: false })}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums font-semibold text-ds-ink">
                        {fmtINR(calc.total, { withSymbol: false })}
                      </td>
                      <td className="px-2 py-2">
                        <select
                          value={l.jobCardId}
                          onChange={(e) => updateLine(idx, { jobCardId: e.target.value })}
                          className="ds-input w-32 cursor-pointer text-xs"
                          disabled={!customer}
                        >
                          <option value="">No job card</option>
                          {filteredJcs.map((jc) => (
                            <option key={jc.id} value={jc.id}>
                              JC#{jc.jobCardNumber} {jc.setNumber ? `Set ${jc.setNumber}` : ''}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            title="Duplicate"
                            onClick={() => duplicateLine(idx)}
                            className="rounded-ds-sm p-1 text-ds-ink-faint hover:bg-ds-elevated hover:text-ds-ink"
                          >
                            <Copy className="h-3.5 w-3.5" aria-hidden />
                          </button>
                          {lines.length > 1 && (
                            <button
                              type="button"
                              title="Remove"
                              onClick={() => removeLine(idx)}
                              className="rounded-ds-sm p-1 text-ds-ink-faint hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Notes / Terms */}
          <div className="grid gap-3 pt-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-ds-ink-muted">Notes (customer-facing)</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Any specific note for this invoice…"
                className="ds-input w-full resize-y"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ds-ink-muted">Terms &amp; conditions</label>
              <textarea
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                rows={2}
                className="ds-input w-full resize-y"
              />
            </div>
          </div>
        </div>

        {/* Sticky totals panel */}
        <aside className="space-y-3">
          <div className="sticky top-24 space-y-3 rounded-ds-lg border border-ds-line/80 bg-ds-card/40 p-4 text-sm shadow-sm">
            <p className="ds-typo-label font-semibold uppercase tracking-wider text-ds-ink-faint">
              Invoice totals
            </p>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-ds-ink-muted">Taxable value</span>
                <span className="tabular-nums text-ds-ink">{fmtINR(totals.taxable)}</span>
              </div>
              {isInterState ? (
                <div className="flex justify-between">
                  <span className="text-ds-ink-muted">IGST</span>
                  <span className="tabular-nums text-ds-ink">{fmtINR(totals.gst)}</span>
                </div>
              ) : (
                <>
                  <div className="flex justify-between">
                    <span className="text-ds-ink-muted">CGST</span>
                    <span className="tabular-nums text-ds-ink">{fmtINR(totals.gst / 2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ds-ink-muted">{sgstOrIgstLabel}</span>
                    <span className="tabular-nums text-ds-ink">{fmtINR(totals.gst / 2)}</span>
                  </div>
                </>
              )}
              <div className="flex justify-between text-xs text-ds-ink-faint">
                <span>Round off</span>
                <span className="tabular-nums">
                  {totals.roundOff >= 0 ? '+' : ''}
                  {fmtINR(totals.roundOff, { withSymbol: false })}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between border-t border-ds-line pt-2">
                <span className="text-sm font-semibold text-ds-ink">Grand total</span>
                <span className="text-lg font-bold tabular-nums text-[var(--brand-primary)]">
                  {fmtINR(totals.grand)}
                </span>
              </div>
            </div>
            <div className="rounded-ds-sm border border-ds-line/60 bg-ds-elevated/40 px-3 py-2 text-xs leading-snug text-ds-ink-muted">
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint">
                Amount in words
              </span>
              <span className="text-ds-ink">{amountInWords(totals.grand)}</span>
            </div>
            <Button type="submit" variant="primary" className="w-full" disabled={saving}>
              {saving ? 'Saving…' : `Create bill — ${fmtINR(totals.grand)}`}
            </Button>
            <p className="text-[10px] leading-snug text-ds-ink-faint">
              Saves as draft. PO reconciliation runs after save for any line tied to a job card.
            </p>
          </div>
        </aside>
      </div>
    </form>
  )
}
