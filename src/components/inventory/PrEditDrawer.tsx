'use client'

import { useEffect, useState } from 'react'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'

type Detail = {
  id: string
  status: string
  materialId: string
  material: { materialCode: string; description: string; unit: string }
  boardType: string | null
  gsm: number | null
  sizeLabel: string | null
  qtyRequired: number
  requiredByDate: string | null
  expectedDelivery: string | null
  supplierId: string | null
  remarks: string | null
  reservation: {
    requiredQty: number
    reservedQty: number
    purchaseRequired: number
    links: Array<{ jobCardId: string | null; jobCardNumber: number | null; requiredByDate: string | null; requiredQty: number; pendingShortage: number }>
  }
  revisions: Array<{ revision: number; at: string; userId: string | null; field: string; oldValue: unknown; newValue: unknown }>
}

export function PrEditDrawer({
  prId,
  open,
  onClose,
  onSaved,
}: {
  prId: string | null
  open: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ boardType: '', gsm: '', sizeLabel: '', qtyRequired: '', requiredByDate: '', remarks: '' })

  useEffect(() => {
    if (!open || !prId) return
    setLoading(true)
    setDetail(null)
    fetch(`/api/purchase-requisitions/${prId}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: Detail) => {
        setDetail(d)
        setForm({
          boardType: d.boardType ?? '',
          gsm: d.gsm != null ? String(d.gsm) : '',
          sizeLabel: d.sizeLabel ?? '',
          qtyRequired: String(d.qtyRequired ?? ''),
          requiredByDate: d.requiredByDate ? d.requiredByDate.slice(0, 10) : '',
          remarks: d.remarks ?? '',
        })
      })
      .catch(() => setDetail(null))
      .finally(() => setLoading(false))
  }, [open, prId])

  const isDraft = detail?.status === 'pending'

  async function save() {
    if (!prId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/purchase-requisitions/${prId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boardType: form.boardType || null,
          gsm: form.gsm ? Number(form.gsm) : null,
          sizeLabel: form.sizeLabel || null,
          qtyRequired: form.qtyRequired ? Number(form.qtyRequired) : undefined,
          requiredByDate: form.requiredByDate ? new Date(form.requiredByDate).toISOString() : null,
          remarks: form.remarks || null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Save failed')
      onSaved()
      onClose()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function approve() {
    if (!prId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/purchase-requisitions/${prId}/approve`, { method: 'PUT' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Approve failed')
      onSaved()
      onClose()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Approve failed')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!prId || !window.confirm('Delete this PR?')) return
    setBusy(true)
    try {
      const res = await fetch(`/api/purchase-requisitions/${prId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      onSaved()
      onClose()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  const field = 'w-full rounded-ds-md border border-ds-line/60 bg-ds-card px-2 py-1 text-sm'
  const label = 'text-[11px] uppercase tracking-wide text-ds-ink-muted'

  const footer =
    detail && isDraft ? (
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void save()} className="rounded border border-ds-line/50 px-3 py-1.5 text-xs text-ds-ink hover:bg-ds-main/50 disabled:opacity-40">Save Draft</button>
        <button type="button" disabled={busy} onClick={() => void approve()} className="rounded border border-[var(--success)]/40 bg-[var(--success-bg)] px-3 py-1.5 text-xs text-[var(--success)] disabled:opacity-40">Approve</button>
        <button type="button" disabled={busy} onClick={() => void remove()} className="rounded border border-[var(--error)]/35 bg-[var(--error-bg)] px-3 py-1.5 text-xs text-[var(--error)] disabled:opacity-40">Delete</button>
      </div>
    ) : detail ? (
      <p className="text-[11px] text-ds-ink-faint">Fields locked — this PR is no longer a draft.</p>
    ) : undefined

  return (
    <GlobalPopoutModal
      isOpen={open}
      onClose={onClose}
      title="Purchase Requisition"
      metadata={detail ? `${detail.material.materialCode} · ${detail.status}` : undefined}
      mode="form"
      size="md"
      footer={footer}
    >
      {loading || !detail ? (
        <p className="text-xs text-ds-ink-muted">Loading…</p>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-ds-ink-faint">{detail.material.description}</p>

          <section className="space-y-2">
            <div>
              <label className={label}>Board Type</label>
              <input className={field} disabled={!isDraft} value={form.boardType} onChange={(e) => setForm({ ...form, boardType: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={label}>GSM</label>
                <input type="number" className={field} disabled={!isDraft} value={form.gsm} onChange={(e) => setForm({ ...form, gsm: e.target.value })} />
              </div>
              <div>
                <label className={label}>Sheet Size</label>
                <input className={field} disabled={!isDraft} value={form.sizeLabel} onChange={(e) => setForm({ ...form, sizeLabel: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={label}>Required Qty</label>
                <input type="number" className={field} disabled={!isDraft} value={form.qtyRequired} onChange={(e) => setForm({ ...form, qtyRequired: e.target.value })} />
              </div>
              <div>
                <label className={label}>Required Date</label>
                <input type="date" className={field} disabled={!isDraft} value={form.requiredByDate} onChange={(e) => setForm({ ...form, requiredByDate: e.target.value })} />
              </div>
            </div>
            <div>
              <label className={label}>Procurement Remarks</label>
              <textarea className={field} rows={2} disabled={!isDraft} value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
            </div>
          </section>

          <section className="rounded border border-ds-line/40 p-3 text-xs">
            <p className="mb-1 font-semibold text-ds-ink">Reservation</p>
            <div className="mb-1 flex gap-3 text-ds-ink-muted">
              <span>Required <span className="text-ds-ink">{detail.reservation.requiredQty.toLocaleString('en-IN')}</span></span>
              <span>Reserved <span className="text-ds-ink">{detail.reservation.reservedQty.toLocaleString('en-IN')}</span></span>
              <span>Purchase req&apos;d <span className="text-ds-ink">{detail.reservation.purchaseRequired.toLocaleString('en-IN')}</span></span>
            </div>
            {detail.reservation.links.length === 0 ? (
              <p className="text-ds-ink-faint">No linked job cards.</p>
            ) : (
              <ul className="space-y-1">
                {detail.reservation.links.map((l, i) => (
                  <li key={i} className="rounded border border-ds-line/30 px-2 py-1 text-ds-ink-muted">
                    JC#{l.jobCardNumber ?? '—'} · Req {l.requiredQty.toLocaleString('en-IN')} · Short {l.pendingShortage.toLocaleString('en-IN')}
                    {l.requiredByDate ? ` · ${new Date(l.requiredByDate).toLocaleDateString('en-IN')}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded border border-ds-line/40 p-3 text-xs">
            <p className="mb-1 font-semibold text-ds-ink">Revision History</p>
            {detail.revisions.length === 0 ? (
              <p className="text-ds-ink-faint">No revisions yet.</p>
            ) : (
              <ul className="space-y-1">
                {detail.revisions.map((r) => (
                  <li key={r.revision} className="rounded border border-ds-line/30 px-2 py-1 text-ds-ink-muted">
                    #{r.revision} · {new Date(r.at).toLocaleString('en-IN')} · <span className="text-ds-ink">{r.field}</span>: {String(r.oldValue ?? '—')} → {String(r.newValue ?? '—')}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </GlobalPopoutModal>
  )
}
