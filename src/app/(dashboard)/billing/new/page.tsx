'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'
import { MasterSearchSelect } from '@/components/ui/MasterSearchSelect'

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
      const res = await fetch(`/api/customers?q=${encodeURIComponent(query)}`)
      return (await res.json()) as Customer[]
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
      <h1 className="text-xl font-bold text-ds-warning">New Bill</h1>

      <div className="grid md:grid-cols-2 gap-4 rounded-xl bg-ds-card border border-ds-line/50 p-4 text-sm">
        <div>
          <MasterSearchSelect
            label="Customer"
            required
            query={customerSearch.query}
            onQueryChange={(value) => {
              customerSearch.setQuery(value)
              setCustomerId('')
            }}
            loading={customerSearch.loading}
            options={customerSearch.options}
            lastUsed={customerSearch.lastUsed}
            onSelect={applyCustomer}
            getOptionLabel={(c) => c.name}
            getOptionMeta={(c) => c.contactName ?? ''}
            placeholder="Type 1-2 letters to search customers..."
            recentLabel="Recent customers"
            loadingMessage="Searching customers..."
            emptyMessage="No customer found."
          />
        </div>
        <div>
          <label className="block text-ds-ink-muted mb-1">Bill date</label>
          <input
            type="date"
            value={billDate}
            onChange={(e) => setBillDate(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground"
          />
        </div>
      </div>

      <div className="rounded-xl bg-ds-card border border-ds-line/50 p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-ds-ink">Line items</h2>
          <button type="button" onClick={addLine} className="px-3 py-1.5 rounded-lg bg-ds-elevated text-foreground text-xs">
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
                  className="w-full px-2 py-1.5 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
                />
              </div>
              <div className="col-span-1">
                <input
                  type="number"
                  placeholder="Qty"
                  value={l.quantity}
                  onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                  className="w-full px-2 py-1.5 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
                />
              </div>
              <div className="col-span-2">
                <input
                  type="number"
                  placeholder="Rate"
                  value={l.rate}
                  onChange={(e) => updateLine(idx, { rate: e.target.value })}
                  className="w-full px-2 py-1.5 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
                />
              </div>
              <div className="col-span-1">
                <input
                  type="number"
                  placeholder="GST%"
                  value={l.gstPct}
                  onChange={(e) => updateLine(idx, { gstPct: e.target.value })}
                  className="w-full px-2 py-1.5 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
                />
              </div>
              <div className="col-span-3">
                <select
                  value={l.jobCardId}
                  onChange={(e) => updateLine(idx, { jobCardId: e.target.value })}
                  className="w-full px-2 py-1.5 rounded bg-ds-elevated border border-ds-line/60 text-foreground"
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
          className="px-3 py-1.5 rounded-lg border border-ds-line/60 text-ds-ink text-sm"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-1.5 rounded-lg bg-ds-warning hover:bg-ds-warning disabled:opacity-50 text-primary-foreground text-sm font-medium"
        >
          {saving ? 'Saving…' : 'Create bill'}
        </button>
      </div>
    </form>
  )
}
