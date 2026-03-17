'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'

type Customer = { id: string; name: string; contactName?: string | null }
type JobCard = { id: string; jobCardNumber: number; setNumber: string | null; customerId: string }

type Line = {
  description: string
  quantity: string
  rate: string
  gstPct: string
  jobCardId: string
}

export default function NewBillPage() {
  const router = useRouter()
  const [jobCards, setJobCards] = useState<JobCard[]>([])
  const [customerId, setCustomerId] = useState('')
  const [billDate, setBillDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [lines, setLines] = useState<Line[]>([
    { description: '', quantity: '', rate: '', gstPct: '12', jobCardId: '' },
  ])
  const [saving, setSaving] = useState(false)

  const customerSearch = useAutoPopulate<Customer>({
    storageKey: 'billing-customer',
    search: async (query: string) => {
      const res = await fetch('/api/customers')
      const data = (await res.json()) as Customer[]
      const q = query.toLowerCase()
      return data.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.contactName ?? '').toLowerCase().includes(q),
      )
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
      toast.success('Bill created')
      router.push('/billing')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="p-4 max-w-4xl mx-auto space-y-4">
      <h1 className="text-xl font-bold text-amber-400">New Bill</h1>

      <div className="grid md:grid-cols-2 gap-4 rounded-xl bg-slate-900 border border-slate-700 p-4 text-sm">
        <div>
          <label className="block text-slate-400 mb-1">Customer *</label>
          <input
            type="text"
            value={customerSearch.query}
            onChange={(e) => {
              customerSearch.setQuery(e.target.value)
              setCustomerId('')
            }}
            placeholder="Type customer name…"
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
          {customerSearch.loading && (
            <p className="text-xs text-slate-400 mt-0.5">Searching…</p>
          )}
          {customerSearch.options.length > 0 && (
            <div className="mt-0.5 rounded border border-slate-700 bg-slate-900 max-h-40 overflow-y-auto">
              {customerSearch.options.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => applyCustomer(c)}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-800 text-slate-100"
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {customerSearch.lastUsed.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {customerSearch.lastUsed.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => applyCustomer(c)}
                  className="px-2 py-0.5 rounded-full bg-slate-800 text-xs text-slate-200 border border-slate-600 hover:border-amber-500"
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Bill date</label>
          <input
            type="date"
            value={billDate}
            onChange={(e) => setBillDate(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
      </div>

      <div className="rounded-xl bg-slate-900 border border-slate-700 p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-200">Line items</h2>
          <button type="button" onClick={addLine} className="px-3 py-1.5 rounded-lg bg-slate-800 text-white text-xs">
            + Add line
          </button>
        </div>
        <div className="space-y-2">
          {lines.map((l, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-end text-sm">
              <div className="col-span-4">
                <input
                  type="text"
                  placeholder="Description"
                  value={l.description}
                  onChange={(e) => updateLine(idx, { description: e.target.value })}
                  className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
                />
              </div>
              <div className="col-span-1">
                <input
                  type="number"
                  placeholder="Qty"
                  value={l.quantity}
                  onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                  className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
                />
              </div>
              <div className="col-span-2">
                <input
                  type="number"
                  placeholder="Rate"
                  value={l.rate}
                  onChange={(e) => updateLine(idx, { rate: e.target.value })}
                  className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
                />
              </div>
              <div className="col-span-1">
                <input
                  type="number"
                  placeholder="GST%"
                  value={l.gstPct}
                  onChange={(e) => updateLine(idx, { gstPct: e.target.value })}
                  className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
                />
              </div>
              <div className="col-span-3">
                <select
                  value={l.jobCardId}
                  onChange={(e) => updateLine(idx, { jobCardId: e.target.value })}
                  className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
                >
                  <option value="">No job card</option>
                  {filteredJcs.map((jc) => (
                    <option key={jc.id} value={jc.id}>
                      JC#{jc.jobCardNumber} {jc.setNumber ? `Set ${jc.setNumber}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-1">
                {lines.length > 1 && (
                  <button type="button" onClick={() => removeLine(idx)} className="text-red-400 text-xs">
                    ✕
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push('/billing')}
          className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium"
        >
          {saving ? 'Saving…' : 'Create bill'}
        </button>
      </div>
    </form>
  )
}
