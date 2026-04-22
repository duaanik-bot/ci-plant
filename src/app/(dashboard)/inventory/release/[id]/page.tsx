'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

type InventoryItem = {
  id: string
  materialCode: string
  description: string
  unit: string
  qtyQuarantine: number
}

export default function ReleasePage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const [material, setMaterial] = useState<InventoryItem | null>(null)
  const [qty, setQty] = useState('')
  const [readings, setReadings] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    fetch('/api/inventory')
      .then((r) => r.json())
      .then((data) => {
        const item = Array.isArray(data) ? data.find((i: { id: string }) => i.id === id) : null
        setMaterial(item ?? null)
      })
      .catch(() => {})
  }, [id])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const numQty = Number(qty)
    if (!numQty || numQty <= 0 || !material) {
      toast.error('Enter valid quantity')
      return
    }
    if (numQty > Number(material.qtyQuarantine)) {
      toast.error('Quantity exceeds quarantine balance')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(`/api/inventory/${id}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          qty: numQty,
          instrumentReadings: readings ? { notes: readings } : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      toast.success(data.message)
      router.push('/inventory')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (!material) return <div className="p-4 text-ds-ink-muted">Loading…</div>

  const maxQty = Number(material.qtyQuarantine) || 0

  return (
    <div className="p-4 max-w-md mx-auto">
      <Link href="/inventory" className="text-ds-ink-muted hover:text-foreground text-sm mb-4 inline-block">← Inventory</Link>
      <h1 className="text-xl font-bold text-ds-warning mb-2">QA release from quarantine</h1>
      <p className="text-ds-ink-muted text-sm mb-4">{material.materialCode} — {material.description}</p>
      <p className="text-sm mb-4">In quarantine: <strong>{maxQty} {material.unit}</strong></p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Quantity to release *</label>
          <input
            type="number"
            min={1}
            max={maxQty}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            required
            className="w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground"
          />
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Instrument readings / notes</label>
          <textarea
            value={readings}
            onChange={(e) => setReadings(e.target.value)}
            rows={3}
            placeholder="e.g. Caliper 0.28mm, GSM 350"
            className="w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="w-full py-2.5 rounded-lg bg-ds-warning hover:bg-ds-warning disabled:bg-ds-line/30 text-primary-foreground font-medium"
        >
          {submitting ? 'Releasing…' : 'Release to available'}
        </button>
      </form>
    </div>
  )
}
