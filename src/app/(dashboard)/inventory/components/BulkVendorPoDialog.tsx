'use client'

import { useEffect, useMemo, useState } from 'react'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'
import { toast } from '@/store/toastStore'
import type { PaperWarehouseRow } from '../page'

type Vendor = { id: string; name: string }

type Props = {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
  rows: PaperWarehouseRow[]
  initialSelectedIds?: Set<string>
}

const nf = new Intl.NumberFormat('en-IN')

function suggestedQty(row: PaperWarehouseRow): number {
  const shortageNet = Math.max(0, Number(row.shortage_sheets || 0) - Number(row.incoming_sheets || 0))
  if (shortageNet > 0) return shortageNet
  const free = Number(row.available_sheets || 0) - Number(row.reserved_sheets || 0)
  const reorderGap = Math.max(0, Number(row.reorder_level || 0) - free)
  return reorderGap
}

export function BulkVendorPoDialog({ isOpen, onClose, onSuccess, rows, initialSelectedIds }: Props) {
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [paymentTerms, setPaymentTerms] = useState('')
  const [transportTerms, setTransportTerms] = useState('')
  const [remarks, setRemarks] = useState('')
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [qtyById, setQtyById] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    fetch('/api/procurement/suppliers', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setVendors(Array.isArray(d) ? d : d.suppliers ?? []))
      .catch(() => setVendors([]))
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const initial =
      initialSelectedIds && initialSelectedIds.size > 0
        ? new Set(initialSelectedIds)
        : new Set(rows.filter((r) => suggestedQty(r) > 0 || Number(r.shortage_sheets || 0) > 0).map((r) => r.material_id))
    setSelectedIds(initial)
    setQtyById(Object.fromEntries(rows.map((r) => [r.material_id, String(suggestedQty(r) || '')])))
    setSupplierId('')
    setDeliveryDate('')
    setPaymentTerms('')
    setTransportTerms('')
    setRemarks('')
    setQuery('')
  }, [initialSelectedIds, isOpen, rows])

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((row) =>
      [row.material_code, row.board_type_id ?? '', row.size_display, row.gsm == null ? '' : String(row.gsm)]
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [query, rows])

  const selectedLines = rows
    .filter((row) => selectedIds.has(row.material_id))
    .map((row) => ({ row, qtyKg: Number(qtyById[row.material_id] || 0) }))

  const totalQty = selectedLines.reduce((sum, line) => sum + (Number.isFinite(line.qtyKg) ? line.qtyKg : 0), 0)
  const canCreate = !!supplierId && selectedLines.length > 0 && selectedLines.every((line) => Number.isFinite(line.qtyKg) && line.qtyKg > 0)

  async function createPo() {
    if (!canCreate) return
    setLoading(true)
    try {
      const res = await fetch('/api/inventory/paper-warehouse/direct-po', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId,
          lines: selectedLines.map(({ row, qtyKg }) => ({ materialId: row.material_id, qtyKg })),
          deliveryDate: deliveryDate ? new Date(deliveryDate).toISOString() : undefined,
          paymentTerms: paymentTerms || undefined,
          transportTerms: transportTerms || undefined,
          remarks: remarks || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'PO creation failed')
      toast.success(`Vendor PO created for ${selectedLines.length} material${selectedLines.length === 1 ? '' : 's'}`)
      onSuccess()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'PO creation failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <GlobalPopoutModal
      isOpen={isOpen}
      onClose={onClose}
      title="Create Vendor PO"
      metadata={`${selectedLines.length} materials selected · ${nf.format(Math.round(totalQty))} kg`}
      mode="form"
      size="lg"
      hasUnsavedChanges={selectedLines.length > 0 || !!supplierId}
      primaryAction={{ label: 'Raise Vendor PO', loadingLabel: 'Creating...', onClick: createPo, loading, disabled: !canCreate }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="block text-xs font-semibold text-ds-ink-muted">
            Vendor
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="mt-1 w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink">
              <option value="">Select vendor...</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-semibold text-ds-ink-muted">
            Delivery Date
            <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} className="mt-1 w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
          </label>
          <label className="block text-xs font-semibold text-ds-ink-muted">
            Payment Terms
            <input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} className="mt-1 w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
          </label>
          <label className="block text-xs font-semibold text-ds-ink-muted">
            Transport Terms
            <input value={transportTerms} onChange={(e) => setTransportTerms(e.target.value)} className="mt-1 w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search material..."
            className="w-full max-w-xs rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink"
          />
          <button type="button" onClick={() => setSelectedIds(new Set(visibleRows.map((r) => r.material_id)))} className="rounded-ds-md bg-ds-elevated px-3 py-2 text-xs font-medium text-ds-ink">
            Select Visible
          </button>
          <button type="button" onClick={() => setSelectedIds(new Set())} className="rounded-ds-md bg-ds-elevated px-3 py-2 text-xs font-medium text-ds-ink">
            Clear
          </button>
        </div>

        <div className="max-h-[360px] overflow-auto rounded-ds-md bg-ds-elevated/30">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-ds-elevated text-left text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">
              <tr>
                <th className="px-3 py-2">Select</th>
                <th className="px-3 py-2">Material</th>
                <th className="px-3 py-2">Spec</th>
                <th className="px-3 py-2 text-right">Shortage</th>
                <th className="px-3 py-2 text-right">Incoming</th>
                <th className="px-3 py-2 text-right">PO Qty kg</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.material_id} className="hover:bg-ds-elevated/60">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(row.material_id)}
                      onChange={(e) =>
                        setSelectedIds((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(row.material_id)
                          else next.delete(row.material_id)
                          return next
                        })
                      }
                      className="h-4 w-4"
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-ds-ink">{row.material_code}</td>
                  <td className="px-3 py-2 text-ds-ink-muted">{[row.board_type_id, row.gsm ? `${row.gsm} gsm` : null, row.size_display].filter(Boolean).join(' · ')}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-ds-error">{nf.format(Number(row.shortage_sheets || 0))}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-ds-ink-muted">{nf.format(Number(row.incoming_sheets || 0))}</td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={qtyById[row.material_id] ?? ''}
                      onChange={(e) => setQtyById((prev) => ({ ...prev, [row.material_id]: e.target.value }))}
                      className="ml-auto block w-28 rounded-ds-md bg-background px-2 py-1.5 text-right text-sm text-ds-ink"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <label className="block text-xs font-semibold text-ds-ink-muted">
          Remarks
          <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} className="mt-1 w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink" />
        </label>
      </div>
    </GlobalPopoutModal>
  )
}
