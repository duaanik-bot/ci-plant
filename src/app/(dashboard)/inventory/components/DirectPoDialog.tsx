'use client'

import { useState, useEffect } from 'react'
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
  mode,
  prId,
  prefillQty,
}: DirectPoDialogProps) {
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [qtyKg, setQtyKg] = useState(prefillQty ? String(prefillQty) : '')
  const [ratePerKg, setRatePerKg] = useState('')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [paymentTerms, setPaymentTerms] = useState('')
  const [transportTerms, setTransportTerms] = useState('')
  const [remarks, setRemarks] = useState('')
  const [loading, setLoading] = useState(false)

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

  async function handleSubmit() {
    if (!supplierId || !qtyKg) return
    setLoading(true)
    try {
      let res: Response
      if (mode === 'direct') {
        res = await fetch(`/api/inventory/paper-warehouse/${materialId}/direct-po`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            supplierId,
            qtyKg: Number(qtyKg),
            ratePerKg: ratePerKg ? Number(ratePerKg) : undefined,
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

  const title = mode === 'from-pr' ? `Generate PO from PR` : `Fast-track PO — ${materialCode}`
  const subtitle = [boardType, gsm ? `${gsm} gsm` : null].filter(Boolean).join(' · ')

  return (
    <GlobalPopoutModal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      metadata={subtitle || undefined}
      mode="form"
      hasUnsavedChanges={!!(supplierId || qtyKg)}
      primaryAction={{ label: 'Create PO', loadingLabel: 'Creating…', onClick: handleSubmit, loading, disabled: !supplierId || !qtyKg }}
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
        <div>
          <label className="mb-1 block text-xs font-semibold text-ds-ink-muted">Qty (kg) *</label>
          <input
            type="number"
            min={0}
            step="any"
            value={qtyKg}
            onChange={(e) => setQtyKg(e.target.value)}
            className="w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-primary"
            placeholder="e.g. 4200"
          />
        </div>
        {mode === 'direct' && (
          <div>
            <label className="mb-1 block text-xs font-semibold text-ds-ink-muted">Rate (₹/kg)</label>
            <input
              type="number"
              min={0}
              step="any"
              value={ratePerKg}
              onChange={(e) => setRatePerKg(e.target.value)}
              className="w-full rounded-ds-md bg-ds-elevated px-3 py-2 text-sm text-ds-ink focus:outline-none focus:ring-1 focus:ring-ds-primary"
              placeholder="e.g. 58"
            />
          </div>
        )}
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
