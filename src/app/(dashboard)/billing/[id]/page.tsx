'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

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

export default function BillDetailPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const [bill, setBill] = useState<Bill | null>(null)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => {
    fetch(`/api/bills/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data || data.error) throw new Error(data.error || 'Failed to load')
        setBill(data)
        setStatus(data.status)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [id])

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
    <div className="p-4 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/billing" className="text-sm text-ds-ink-muted hover:text-foreground mb-1 inline-block">
            ← Bills
          </Link>
          <h1 className="text-xl font-bold text-ds-warning">{bill.billNumber}</h1>
          <p className="text-sm text-ds-ink-muted">
            {bill.customer.name} · {new Date(bill.billDate).toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="px-3 py-1.5 rounded-lg bg-ds-card border border-ds-line/60 text-foreground text-sm"
          >
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="paid">Paid</option>
          </select>
          <button
            onClick={handleSaveStatus}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg bg-ds-warning hover:bg-ds-warning disabled:opacity-50 text-primary-foreground text-sm"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="rounded-xl bg-ds-card border border-ds-line/50 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ds-elevated text-ds-ink-muted">
            <tr>
              <th className="px-4 py-2 text-left">Description</th>
              <th className="px-4 py-2 text-right">Qty</th>
              <th className="px-4 py-2 text-right">Rate</th>
              <th className="px-4 py-2 text-right">GST%</th>
              <th className="px-4 py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ds-line/40">
            {bill.lineItems.map((li) => (
              <tr key={li.id}>
                <td className="px-4 py-2 text-ds-ink">{li.description}</td>
                <td className="px-4 py-2 text-right text-ds-ink-muted">{li.quantity}</td>
                <td className="px-4 py-2 text-right text-ds-ink-muted">
                  ₹{li.rate.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-2 text-right text-ds-ink-muted">{li.gstPct}%</td>
                <td className="px-4 py-2 text-right text-ds-ink">
                  ₹{li.amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl bg-ds-card border border-ds-line/50 p-4 flex justify-end">
        <div className="text-sm space-y-1 text-right">
          <div className="flex justify-between gap-8">
            <span className="text-ds-ink-muted">Subtotal</span>
            <span className="text-ds-ink">
              ₹{bill.subtotal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="flex justify-between gap-8">
            <span className="text-ds-ink-muted">GST</span>
            <span className="text-ds-ink">
              ₹{bill.gstAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="flex justify-between gap-8 font-semibold text-ds-warning border-t border-ds-line/50 pt-2 mt-2">
            <span>Total</span>
            <span>₹{bill.totalAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
