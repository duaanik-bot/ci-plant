'use client'

import { useEffect, useState } from 'react'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'

type Vendor = { id: string; name: string }

export type GeneratePoSelection = {
  prIds: string[]
  summary: Array<{ materialCode: string; boardType: string | null; gsm: number | null; sizeLabel: string | null; totalQty: number; prCount: number }>
  suggestedVendorId: string | null
}

export function GeneratePoDialog({
  open,
  selection,
  onClose,
  onCreated,
}: {
  open: boolean
  selection: GeneratePoSelection | null
  onClose: () => void
  onCreated: () => void
}) {
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [vendorId, setVendorId] = useState('')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [paymentTerms, setPaymentTerms] = useState('')
  const [transportTerms, setTransportTerms] = useState('')
  const [remarks, setRemarks] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!open) return
    let ignore = false
    fetch('/api/procurement/suppliers', { cache: 'no-store' })
      .then(async (r) => (r.ok ? ((await r.json()) as Vendor[]) : []))
      .then((d) => {
        if (!ignore) setVendors(Array.isArray(d) ? d : [])
      })
      .catch(() => {
        if (!ignore) setVendors([])
      })
    setVendorId(selection?.suggestedVendorId ?? '')
    setDeliveryDate('')
    setPaymentTerms('')
    setTransportTerms('')
    setRemarks('')
    setDirty(false)
    return () => {
      ignore = true
    }
  }, [open, selection])

  async function create() {
    if (!selection || !vendorId) {
      alert('Select a vendor')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/purchase-requisitions/generate-po', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prIds: selection.prIds,
          vendorId,
          deliveryDate: deliveryDate ? new Date(deliveryDate).toISOString() : undefined,
          paymentTerms: paymentTerms || undefined,
          transportTerms: transportTerms || undefined,
          remarks: remarks || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'PO creation failed')
      setDirty(false)
      onCreated()
      onClose()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'PO creation failed')
    } finally {
      setBusy(false)
    }
  }

  const field = 'w-full rounded-ds-md bg-ds-card px-2 py-1 text-sm'
  const label = 'text-[11px] uppercase tracking-wide text-ds-ink-muted'

  return (
    <GlobalPopoutModal
      isOpen={open}
      onClose={onClose}
      title="Generate Purchase Order"
      mode="form"
      size="md"
      hasUnsavedChanges={dirty}
      primaryAction={{
        label: 'Generate PO',
        loadingLabel: 'Creating…',
        onClick: () => void create(),
        disabled: !vendorId,
        loading: busy,
      }}
    >
      <div className="space-y-4">
        <section className="rounded bg-ds-elevated/50 p-3 text-xs">
          <p className="mb-1 font-semibold text-ds-ink">Consolidation preview</p>
          {(selection?.summary ?? []).map((s, i) => (
            <div key={i} className="rounded px-2 py-1 text-ds-ink-muted">
              {s.materialCode} · {s.boardType ?? '—'} · {s.gsm ?? '—'}g · {s.sizeLabel ?? '—'} ·{' '}
              <span className="text-ds-ink">Total {s.totalQty.toLocaleString('en-IN')}</span> · {s.prCount} PR{s.prCount === 1 ? '' : 's'}
            </div>
          ))}
        </section>

        <div>
          <label className={label}>Vendor</label>
          <select className={field} value={vendorId} onChange={(e) => { setVendorId(e.target.value); setDirty(true) }}>
            <option value="">Select vendor…</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>Delivery Date</label>
          <input type="date" className={field} value={deliveryDate} onChange={(e) => { setDeliveryDate(e.target.value); setDirty(true) }} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={label}>Payment Terms</label>
            <input className={field} value={paymentTerms} onChange={(e) => { setPaymentTerms(e.target.value); setDirty(true) }} />
          </div>
          <div>
            <label className={label}>Transport Terms</label>
            <input className={field} value={transportTerms} onChange={(e) => { setTransportTerms(e.target.value); setDirty(true) }} />
          </div>
        </div>
        <div>
          <label className={label}>Remarks</label>
          <textarea className={field} rows={2} value={remarks} onChange={(e) => { setRemarks(e.target.value); setDirty(true) }} />
        </div>
      </div>
    </GlobalPopoutModal>
  )
}
