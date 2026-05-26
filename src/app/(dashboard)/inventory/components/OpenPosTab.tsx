'use client'

import { useEffect, useMemo, useState } from 'react'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'
import { cn } from '@/lib/cn'
import { toast } from '@/store/toastStore'

type OpenPoRow = {
  id: string
  poNumber: string
  vendorName: string
  materialCode: string | null
  orderedKg: number
  receivedKg: number
  pendingKg: number
  requiredDeliveryDate: string | null
  status: string
  logisticsStatus: string | null
  daysOverdue: number | null
  linkedPrIds: string[]
  lineItems?: Array<{ materialCode: string | null; boardGrade: string; gsm: number; orderedKg: number }>
}

type Vendor = { id: string; name: string }
type PoLine = {
  id: string
  boardGrade: string
  gsm: number
  totalWeightKg: number
  ratePerKg: number | null
  linkedMaterialRefs?: Array<{ materialId: string | null; materialCode: string | null }>
}
type PoDetails = {
  id: string
  poNumber: string
  supplierId: string
  status: string
  signatoryName: string
  requiredDeliveryDate: string | null
  paymentTerms: string | null
  transportTerms: string | null
  remarks: string | null
  totalReceivedKg: number
  supplier: { name: string }
  lines: PoLine[]
  reservations: Array<{
    id: string
    materialCode: string
    jobCardNumber: number
    customerName: string
    jobStatus: string
    requiredSheets: number
    reservedSheets: number
    shortageSheets: number
    status: string
    isReleased: boolean
    updatedAt: string
  }>
  receipts: Array<{
    id: string
    receiptDate: string
    receivedQty: number
    vehicleNumber: string
    scaleSlipId: string
    qcStatus: string | null
    receivedByName: string
  }>
  auditLog: Array<{
    id: string
    action: string
    userName: string
    oldValue: unknown
    newValue: unknown
    timestamp: string
  }>
}

const nf = new Intl.NumberFormat('en-IN')
const STATUS_FILTERS = ['All', 'Dispatched', 'In Transit', 'At Gate', 'Overdue'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

function dateInputValue(value: string | null | undefined) {
  return value ? value.slice(0, 10) : ''
}

function compactJson(value: unknown) {
  if (!value) return '-'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function useOpenPos() {
  const [rows, setRows] = useState<OpenPoRow[]>([])
  const [loading, setLoading] = useState(true)

  async function reload() {
    setLoading(true)
    try {
      const data = await fetch('/api/inventory/paper-warehouse/open-pos', { cache: 'no-store' }).then((r) => r.json())
      setRows(Array.isArray(data) ? data : [])
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  return { rows, loading, reload }
}

export function OpenPosTab() {
  const { rows, loading, reload } = useOpenPos()
  const [filter, setFilter] = useState<StatusFilter>('All')
  const [search, setSearch] = useState('')
  const [vendorFilter, setVendorFilter] = useState('All')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [details, setDetails] = useState<PoDetails | null>(null)
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    supplierId: '',
    requiredDeliveryDate: '',
    paymentTerms: '',
    transportTerms: '',
    remarks: '',
    signatoryName: '',
    lineUpdates: {} as Record<string, { totalWeightKg: string; ratePerKg: string }>,
  })

  useEffect(() => {
    fetch('/api/procurement/suppliers', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setVendors(Array.isArray(d) ? d : []))
      .catch(() => setVendors([]))
  }, [])

  async function openDetails(id: string) {
    setSelectedId(id)
    setDetails(null)
    try {
      const data = await fetch(`/api/procurement/vendor-pos/${id}`, { cache: 'no-store' }).then((r) => r.json())
      if (data?.error) throw new Error(data.error)
      setDetails(data)
      setForm({
        supplierId: data.supplierId ?? '',
        requiredDeliveryDate: dateInputValue(data.requiredDeliveryDate),
        paymentTerms: data.paymentTerms ?? '',
        transportTerms: data.transportTerms ?? '',
        remarks: data.remarks ?? '',
        signatoryName: data.signatoryName ?? '',
        lineUpdates: Object.fromEntries(
          (data.lines ?? []).map((line: PoLine) => [
            line.id,
            {
              totalWeightKg: String(line.totalWeightKg ?? ''),
              ratePerKg: line.ratePerKg == null ? '' : String(line.ratePerKg),
            },
          ]),
        ),
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load PO details')
      setSelectedId(null)
    }
  }

  async function saveDetails(nextStatus?: 'draft') {
    if (!details) return
    setSaving(true)
    try {
      const res = await fetch(`/api/procurement/vendor-pos/${details.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: nextStatus,
          supplierId: form.supplierId || undefined,
          requiredDeliveryDate: form.requiredDeliveryDate || null,
          paymentTerms: form.paymentTerms || null,
          transportTerms: form.transportTerms || null,
          remarks: form.remarks || null,
          signatoryName: form.signatoryName || undefined,
          lineUpdates: details.lines.map((line) => ({
            lineId: line.id,
            totalWeightKg: Number(form.lineUpdates[line.id]?.totalWeightKg || line.totalWeightKg),
            ratePerKg: form.lineUpdates[line.id]?.ratePerKg === '' ? null : Number(form.lineUpdates[line.id]?.ratePerKg ?? line.ratePerKg ?? 0),
          })),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not update PO')
      toast.success(nextStatus === 'draft' ? 'PO reopened for editing' : 'PO updated')
      await reload()
      await openDetails(details.id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update PO')
    } finally {
      setSaving(false)
    }
  }

  async function deleteOrder(row: OpenPoRow) {
    if (!window.confirm(`Delete ${row.poNumber}? This is allowed only before any GRN receipt.`)) return
    try {
      const res = await fetch(`/api/procurement/vendor-pos/${row.id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not delete PO')
      toast.success(`${row.poNumber} deleted`)
      if (selectedId === row.id) {
        setSelectedId(null)
        setDetails(null)
      }
      await reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete PO')
    }
  }

  async function reopenOrder(row: OpenPoRow) {
    try {
      const res = await fetch(`/api/procurement/vendor-pos/${row.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'draft' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not reopen PO')
      toast.success(`${row.poNumber} reopened`)
      await reload()
      await openDetails(row.id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not reopen PO')
    }
  }

  const vendorSummary = useMemo(() => Array.from(
    rows.reduce((map, row) => {
      const cur = map.get(row.vendorName) ?? { vendorName: row.vendorName, poCount: 0, pendingKg: 0, orderedKg: 0, delayedCount: 0, maxOverdueDays: 0, nextEta: null as string | null }
      cur.poCount += 1
      cur.pendingKg += row.pendingKg
      cur.orderedKg += row.orderedKg
      cur.delayedCount += (row.daysOverdue ?? 0) > 0 && row.pendingKg > 0 ? 1 : 0
      cur.maxOverdueDays = Math.max(cur.maxOverdueDays, Math.max(0, row.daysOverdue ?? 0))
      if (row.requiredDeliveryDate && (!cur.nextEta || row.requiredDeliveryDate < cur.nextEta)) cur.nextEta = row.requiredDeliveryDate
      map.set(row.vendorName, cur)
      return map
    }, new Map<string, { vendorName: string; poCount: number; pendingKg: number; orderedKg: number; delayedCount: number; maxOverdueDays: number; nextEta: string | null }>())
      .values(),
  ).sort((a, b) => b.pendingKg - a.pendingKg), [rows])

  const filtered = rows.filter((r) => {
    if (vendorFilter !== 'All' && r.vendorName !== vendorFilter) return false
    if (filter === 'Overdue') return (r.daysOverdue ?? 0) > 0 && r.pendingKg > 0
    if (filter === 'Dispatched') return r.logisticsStatus === 'mill_dispatched'
    if (filter === 'In Transit') return r.logisticsStatus === 'in_transit'
    if (filter === 'At Gate') return r.logisticsStatus === 'at_gate'
    return true
  }).filter((r) => {
    if (!search) return true
    const q = search.toLowerCase()
    return r.poNumber.toLowerCase().includes(q) || (r.vendorName ?? '').toLowerCase().includes(q) || (r.materialCode ?? '').toLowerCase().includes(q)
  })

  if (loading) return <div className="py-8 text-center text-sm text-ds-ink-muted">Loading...</div>

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {vendorSummary.slice(0, 6).map((vendor) => (
            <button
              key={vendor.vendorName}
              type="button"
              onClick={() => setVendorFilter((prev) => (prev === vendor.vendorName ? 'All' : vendor.vendorName))}
              className={cn(
                'rounded-ds-md bg-ds-elevated/60 px-3 py-2 text-left hover:bg-ds-elevated',
                vendorFilter === vendor.vendorName && 'ring-1 ring-ds-primary',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold text-ds-ink">{vendor.vendorName}</span>
                <span className="text-[11px] text-ds-ink-muted">{vendor.poCount} PO{vendor.poCount === 1 ? '' : 's'}</span>
              </div>
              <div className="mt-1 grid grid-cols-3 gap-2 text-[11px] text-ds-ink-muted">
                <span>Pending <b className="text-ds-ink">{nf.format(Math.round(vendor.pendingKg))}</b></span>
                <span>Delay <b className={vendor.maxOverdueDays > 0 ? 'text-ds-error' : 'text-ds-ink'}>{vendor.maxOverdueDays}d</b></span>
                <span>Next <b className="text-ds-ink">{vendor.nextEta ? new Date(vendor.nextEta).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '-'}</b></span>
              </div>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                filter === f ? 'bg-ds-primary text-white' : 'bg-ds-elevated text-ds-ink-muted hover:text-ds-ink',
              )}
            >
              {f}
            </button>
          ))}
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search PO, vendor or material..."
            className="ml-auto w-56 rounded-ds-md bg-ds-elevated px-3 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ds-primary"
          />
          <select
            value={vendorFilter}
            onChange={(e) => setVendorFilter(e.target.value)}
            className="rounded-ds-md bg-ds-elevated px-3 py-1 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-primary"
          >
            <option value="All">All vendors</option>
            {vendorSummary.map((vendor) => (
              <option key={vendor.vendorName} value={vendor.vendorName}>{vendor.vendorName}</option>
            ))}
          </select>
        </div>

        {filtered.length === 0 ? (
          <p className="py-8 text-center text-sm text-ds-ink-muted">No open purchase orders.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
                <th className="pb-2 pr-4">PO Number</th>
                <th className="pb-2 pr-4">Vendor</th>
                <th className="pb-2 pr-4">Material</th>
                <th className="pb-2 pr-4 text-right">Ordered kg</th>
                <th className="pb-2 pr-4 text-right">Received kg</th>
                <th className="pb-2 pr-4 text-right">Pending kg</th>
                <th className="pb-2 pr-4">ETA</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const isOverdue = (r.daysOverdue ?? 0) > 0 && r.pendingKg > 0
                const pct = r.orderedKg > 0 ? (r.receivedKg / r.orderedKg) * 100 : 0
                const canDelete = r.receivedKg <= 0
                return (
                  <tr key={r.id} className={cn(isOverdue && 'bg-ds-error/5')}>
                    <td className="py-2 pr-4">
                      <button type="button" onClick={() => openDetails(r.id)} className="font-medium text-ds-ink hover:text-ds-primary">
                        {r.poNumber}
                      </button>
                    </td>
                    <td className="py-2 pr-4 text-ds-ink-muted">{r.vendorName}</td>
                    <td className="py-2 pr-4">
                      <button type="button" onClick={() => openDetails(r.id)} className="font-mono text-xs text-ds-ink hover:text-ds-primary">
                        {r.materialCode ?? '-'}
                      </button>
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">{nf.format(Math.round(r.orderedKg))}</td>
                    <td className="py-2 pr-4 text-right">
                      <div className="flex flex-col items-end gap-0.5">
                        <span className="tabular-nums">{nf.format(Math.round(r.receivedKg))}</span>
                        <div className="h-1 w-16 overflow-hidden rounded-full bg-ds-line/30">
                          <div className={cn('h-full', pct >= 100 ? 'bg-ds-success' : 'bg-ds-warning')} style={{ width: `${Math.min(100, pct)}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">{nf.format(Math.round(r.pendingKg))}</td>
                    <td className={cn('py-2 pr-4', isOverdue && 'font-medium text-ds-error')}>
                      {r.requiredDeliveryDate ? new Date(r.requiredDeliveryDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '-'}
                      {isOverdue && ` (+${r.daysOverdue}d)`}
                    </td>
                    <td className="py-2 pr-4">
                      <button
                        type="button"
                        onClick={() => openDetails(r.id)}
                        className="rounded-full bg-ds-elevated px-2 py-0.5 text-[11px] font-medium text-ds-ink-muted capitalize hover:text-ds-ink"
                      >
                        {r.logisticsStatus?.replace('_', ' ') ?? r.status}
                      </button>
                      {r.lineItems && r.lineItems.length > 1 ? (
                        <div className="mt-1 text-[10px] text-ds-ink-faint">
                          {r.lineItems.slice(0, 3).map((line) => line.materialCode ?? `${line.boardGrade} ${line.gsm}`).join(', ')}
                          {r.lineItems.length > 3 ? ` +${r.lineItems.length - 3}` : ''}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <button type="button" onClick={() => openDetails(r.id)} className="rounded bg-ds-elevated px-2 py-1 text-xs text-ds-ink-muted hover:text-ds-ink">Details</button>
                        <button type="button" onClick={() => reopenOrder(r)} className="rounded bg-ds-elevated px-2 py-1 text-xs text-ds-ink-muted hover:text-ds-ink">Reopen</button>
                        <button
                          type="button"
                          onClick={() => deleteOrder(r)}
                          disabled={!canDelete}
                          className="rounded bg-ds-error/10 px-2 py-1 text-xs text-ds-error disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <GlobalPopoutModal
        isOpen={!!selectedId}
        onClose={() => { setSelectedId(null); setDetails(null) }}
        title={details?.poNumber ?? 'Purchase Order'}
        metadata={details ? `${details.supplier.name} · ${details.status}` : 'Loading...'}
        mode="form"
        size="lg"
        hasUnsavedChanges={!!details}
        primaryAction={{ label: 'Save Changes', loadingLabel: 'Saving...', loading: saving, disabled: !details, onClick: () => saveDetails() }}
        secondaryAction={{ label: 'Close', onClick: () => { setSelectedId(null); setDetails(null) } }}
      >
        {!details ? (
          <div className="py-8 text-center text-sm text-ds-ink-muted">Loading...</div>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="text-xs font-semibold text-ds-ink-muted">
                Vendor
                <select value={form.supplierId} onChange={(e) => setForm((prev) => ({ ...prev, supplierId: e.target.value }))} className="mt-1 w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink">
                  {vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}
                </select>
              </label>
              <label className="text-xs font-semibold text-ds-ink-muted">
                Delivery Date
                <input type="date" value={form.requiredDeliveryDate} onChange={(e) => setForm((prev) => ({ ...prev, requiredDeliveryDate: e.target.value }))} className="mt-1 w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
              </label>
              <label className="text-xs font-semibold text-ds-ink-muted">
                Payment Terms
                <input value={form.paymentTerms} onChange={(e) => setForm((prev) => ({ ...prev, paymentTerms: e.target.value }))} className="mt-1 w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
              </label>
              <label className="text-xs font-semibold text-ds-ink-muted">
                Transport Terms
                <input value={form.transportTerms} onChange={(e) => setForm((prev) => ({ ...prev, transportTerms: e.target.value }))} className="mt-1 w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
              </label>
            </div>

            <div className="rounded-ds-md bg-ds-elevated/35 p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-ds-ink">Material Lines</h3>
                <button type="button" onClick={() => saveDetails('draft')} className="rounded bg-ds-primary px-3 py-1 text-xs font-medium text-white">Reopen to Edit</button>
              </div>
              <div className="space-y-2">
                {details.lines.map((line) => (
                  <div key={line.id} className="grid grid-cols-1 gap-2 rounded-ds-md bg-background px-3 py-2 text-sm md:grid-cols-[1fr_120px_120px]">
                    <div>
                      <div className="font-medium text-ds-ink">{line.linkedMaterialRefs?.map((ref) => ref.materialCode).filter(Boolean).join(', ') || `${line.boardGrade} ${line.gsm}`}</div>
                      <div className="text-xs text-ds-ink-muted">{line.boardGrade} · {line.gsm} gsm</div>
                    </div>
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
                      Qty kg
                      <input
                        type="number"
                        min={0}
                        step="any"
                        value={form.lineUpdates[line.id]?.totalWeightKg ?? ''}
                        onChange={(e) => setForm((prev) => ({ ...prev, lineUpdates: { ...prev.lineUpdates, [line.id]: { ...prev.lineUpdates[line.id], totalWeightKg: e.target.value } } }))}
                        className="mt-1 w-full rounded-ds-md bg-ds-elevated px-2 py-1 text-right text-sm text-ds-ink"
                      />
                    </label>
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
                      Rate/kg
                      <input
                        type="number"
                        min={0}
                        step="any"
                        value={form.lineUpdates[line.id]?.ratePerKg ?? ''}
                        onChange={(e) => setForm((prev) => ({ ...prev, lineUpdates: { ...prev.lineUpdates, [line.id]: { ...prev.lineUpdates[line.id], ratePerKg: e.target.value } } }))}
                        className="mt-1 w-full rounded-ds-md bg-ds-elevated px-2 py-1 text-right text-sm text-ds-ink"
                      />
                    </label>
                  </div>
                ))}
              </div>
            </div>

            <label className="block text-xs font-semibold text-ds-ink-muted">
              Remarks
              <textarea value={form.remarks} onChange={(e) => setForm((prev) => ({ ...prev, remarks: e.target.value }))} rows={2} className="mt-1 w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
            </label>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <section className="rounded-ds-md bg-ds-elevated/35 p-3">
                <h3 className="text-sm font-semibold text-ds-ink">Reservations</h3>
                <div className="mt-2 max-h-52 space-y-2 overflow-auto">
                  {details.reservations.length === 0 ? <p className="text-xs text-ds-ink-muted">No linked reservations.</p> : details.reservations.map((r) => (
                    <div key={r.id} className="rounded bg-background px-2 py-1.5 text-xs">
                      <div className="font-medium text-ds-ink">{r.materialCode} · JC-{r.jobCardNumber}</div>
                      <div className="text-ds-ink-muted">{r.customerName} · {nf.format(r.reservedSheets)} reserved · {r.isReleased ? 'Released' : r.status}</div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-ds-md bg-ds-elevated/35 p-3">
                <h3 className="text-sm font-semibold text-ds-ink">GRN Receipts</h3>
                <div className="mt-2 max-h-52 space-y-2 overflow-auto">
                  {details.receipts.length === 0 ? <p className="text-xs text-ds-ink-muted">No GRN receipts yet.</p> : details.receipts.map((r) => (
                    <div key={r.id} className="rounded bg-background px-2 py-1.5 text-xs">
                      <div className="font-medium text-ds-ink">{nf.format(r.receivedQty)} kg · {new Date(r.receiptDate).toLocaleDateString('en-IN')}</div>
                      <div className="text-ds-ink-muted">{r.vehicleNumber} · Slip {r.scaleSlipId} · {r.qcStatus ?? 'QC pending'}</div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-ds-md bg-ds-elevated/35 p-3">
                <h3 className="text-sm font-semibold text-ds-ink">Audit Logs</h3>
                <div className="mt-2 max-h-52 space-y-2 overflow-auto">
                  {details.auditLog.length === 0 ? <p className="text-xs text-ds-ink-muted">No audit logs yet.</p> : details.auditLog.map((log) => (
                    <details key={log.id} className="rounded bg-background px-2 py-1.5 text-xs">
                      <summary className="cursor-pointer font-medium text-ds-ink">{log.action} · {new Date(log.timestamp).toLocaleString('en-IN')}</summary>
                      <div className="mt-1 text-ds-ink-muted">{log.userName}</div>
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-ds-elevated/50 p-2 text-[10px] text-ds-ink-muted">{compactJson(log.newValue)}</pre>
                    </details>
                  ))}
                </div>
              </section>
            </div>
          </div>
        )}
      </GlobalPopoutModal>
    </>
  )
}
