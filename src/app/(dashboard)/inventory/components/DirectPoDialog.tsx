'use client'

import { useMemo, useState, useEffect } from 'react'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'
import { toast } from '@/store/toastStore'

type Vendor = { id: string; name: string }

export type DirectPoDialogProps = {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
  materialId: string
  materialCode: string
  boardType: string | null
  gsm: number | null
  lines?: Array<{ materialId: string; materialCode: string; boardType: string | null; gsm: number | null; suggestedQty?: number }>
  /** 'direct' = fast-track PO with no PR. 'from-pr' = generate PO for an existing PR. */
  mode: 'direct' | 'from-pr'
  prId?: string
  prefillQty?: number
}

export function DirectPoDialog({
  isOpen,
  onClose,
  onSuccess,
  materialId,
  materialCode,
  boardType,
  gsm,
  lines,
  mode,
  prId,
  prefillQty,
}: DirectPoDialogProps) {
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [qtyKg, setQtyKg] = useState(prefillQty ? String(prefillQty) : '')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [paymentTerms, setPaymentTerms] = useState('')
  const [transportTerms, setTransportTerms] = useState('')
  const [remarks, setRemarks] = useState('')
  const [lineQty, setLineQty] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const poLines = useMemo(
    () => (lines?.length ? lines : [{ materialId, materialCode, boardType, gsm, suggestedQty: prefillQty }]),
    [boardType, gsm, lines, materialCode, materialId, prefillQty],
  )

  useEffect(() => {
    if (!isOpen) return
    fetch('/api/procurement/suppliers')
      .then((r) => r.json())
      .then((d) => setVendors(Array.isArray(d) ? d : d.suppliers ?? []))
      .catch(() => {})
  }, [isOpen])

  useEffect(() => {
    if (prefillQty) setQtyKg(String(prefillQty))
  }, [prefillQty])

  useEffect(() => {
    if (!isOpen) return
    setLineQty(Object.fromEntries(poLines.map((l) => [l.materialId, String(l.suggestedQty ?? '')])))
  }, [isOpen, poLines])

  async function handleSubmit() {
    const materialLines = poLines.map((l) => ({ ...l, qtyKg: Number(lineQty[l.materialId] || qtyKg || 0) }))
    if (!supplierId || materialLines.some((l) => !Number.isFinite(l.qtyKg) || l.qtyKg <= 0)) return
    setLoading(true)
    try {
      let res: Response
      if (mode === 'direct' && materialLines.length > 1) {
        res = await fetch('/api/inventory/paper-warehouse/direct-po', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            supplierId,
            lines: materialLines.map((l) => ({ materialId: l.materialId, qtyKg: l.qtyKg })),
            deliveryDate: deliveryDate ? new Date(deliveryDate).toISOString() : undefined,
            paymentTerms: paymentTerms || undefined,
            transportTerms: transportTerms || undefined,
            remarks: remarks || undefined,
          }),
        })
      } else if (mode === 'direct') {
        res = await fetch(`/api/inventory/paper-warehouse/${materialId}/direct-po`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            supplierId,
            qtyKg: materialLines[0]!.qtyKg,
            deliveryDate: deliveryDate ? new Date(deliveryDate).toISOString() : undefined,
            paymentTerms: paymentTerms || undefined,
            transportTerms: transportTerms || undefined,
            remarks: remarks || undefined,
          }),
        })
      } else {
        res = await fetch('/api/purchase-requisitions/generate-po', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prIds: [prId],
            vendorId: supplierId,
            deliveryDate: deliveryDate ? new Date(deliveryDate).toISOString() : undefined,
            paymentTerms: paymentTerms || undefined,
            transportTerms: transportTerms || undefined,
            remarks: remarks || undefined,
          }),
        })
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Failed to create PO')
        return
      }
      toast.success('Purchase order created')
      onSuccess()
      onClose()
    } finally {
      setLoading(false)
    }
  }

  const title = mode === 'from-pr' ? `Generate PO from PR` : poLines.length > 1 ? `Generate PO (${poLines.length} materials)` : `Fast-track PO - ${materialCode}`
  const subtitle = poLines.length > 1 ? 'Consolidated warehouse procurement' : [boardType, gsm ? `${gsm} gsm` : null].filter(Boolean).join(' · ')
  const canCreate =
    !!supplierId &&
    poLines.every((line) => {
      const qty = Number(lineQty[line.materialId] || qtyKg || 0)
      return Number.isFinite(qty) && qty > 0
    })

  return (
    <GlobalPopoutModal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      metadata={subtitle || undefined}
      mode="form"
      hasUnsavedChanges={!!(supplierId || qtyKg || Object.values(lineQty).some(Boolean))}
      primaryAction={{ label: 'Create PO', loadingLabel: 'Creating…', onClick: handleSubmit, loading, disabled: !canCreate }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div className="flex flex-col gap-4">
        <div>
          <label className="mb-1 block text-xs font-semibold text-ds-ink-muted">Vendor *</label>
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className="w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-primary"
          >
            <option value="">Select vendor…</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-2">
          <label className="mb-1 block text-xs font-semibold text-ds-ink-muted">Material quantities (kg) *</label>
          {poLines.map((line) => (
            <div key={line.materialId} className="grid grid-cols-[1fr_120px] items-center gap-2 rounded-ds-md bg-ds-elevated/50 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs text-ds-ink">{line.materialCode}</p>
                <p className="truncate text-[11px] text-ds-ink-muted">{[line.boardType, line.gsm ? `${line.gsm} gsm` : null].filter(Boolean).join(' · ') || 'Material'}</p>
              </div>
              <input
                type="number"
                min={0}
                step="any"
                value={lineQty[line.materialId] ?? ''}
                onChange={(e) => setLineQty((prev) => ({ ...prev, [line.materialId]: e.target.value }))}
                className="w-full rounded-ds-md bg-background px-2 py-1.5 text-right text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-primary"
                placeholder="kg"
              />
            </div>
          ))}
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ds-ink-muted">Delivery Date</label>
          <input
            type="date"
            value={deliveryDate}
            onChange={(e) => setDeliveryDate(e.target.value)}
            className="w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-primary"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ds-ink-muted">Payment Terms</label>
          <input
            type="text"
            value={paymentTerms}
            onChange={(e) => setPaymentTerms(e.target.value)}
            className="w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-primary"
            placeholder="e.g. Net 30"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ds-ink-muted">Transport Terms</label>
          <input
            type="text"
            value={transportTerms}
            onChange={(e) => setTransportTerms(e.target.value)}
            className="w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-primary"
            placeholder="e.g. FOB mill"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ds-ink-muted">Remarks</label>
          <textarea
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            rows={2}
            className="w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-primary"
          />
        </div>
      </div>
    </GlobalPopoutModal>
  )
}
