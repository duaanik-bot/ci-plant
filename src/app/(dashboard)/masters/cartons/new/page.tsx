'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { BOARD_GRADES, PAPER_TYPES } from '@/lib/constants'

type Customer = { id: string; name: string }

export default function NewCartonPage() {
  const router = useRouter()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [form, setForm] = useState({
    cartonName: '',
    customerId: '',
    boardGrade: '',
    gsm: '',
    paperType: '',
    rate: '',
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/masters/customers')
      .then((r) => r.json())
      .then((data) => setCustomers(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load customers'))
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.cartonName || !form.customerId) {
      toast.error('Carton name and customer are required')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/masters/cartons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cartonName: form.cartonName,
          customerId: form.customerId,
          boardGrade: form.boardGrade || undefined,
          gsm: form.gsm ? Number(form.gsm) : undefined,
          paperType: form.paperType || undefined,
          rate: form.rate ? Number(form.rate) : undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to create carton')
      toast.success('Carton created')
      router.push('/masters/cartons')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h2 className="text-lg font-semibold text-white">Add Carton</h2>
      <div className="grid md:grid-cols-2 gap-4 bg-slate-900 rounded-lg border border-slate-700 p-4 text-sm">
        <div>
          <label className="block text-slate-400 mb-1">Carton name*</label>
          <input
            type="text"
            value={form.cartonName}
            onChange={(e) => setForm((f) => ({ ...f, cartonName: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Client*</label>
          <select
            value={form.customerId}
            onChange={(e) => setForm((f) => ({ ...f, customerId: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          >
            <option value="">Select client…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Board grade</label>
          <select
            value={form.boardGrade}
            onChange={(e) => setForm((f) => ({ ...f, boardGrade: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          >
            <option value="">Select grade…</option>
            {BOARD_GRADES.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-slate-400 mb-1">GSM</label>
          <input
            type="number"
            value={form.gsm}
            onChange={(e) => setForm((f) => ({ ...f, gsm: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Paper type</label>
          <select
            value={form.paperType}
            onChange={(e) => setForm((f) => ({ ...f, paperType: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          >
            <option value="">Select paper…</option>
            {PAPER_TYPES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-slate-400 mb-1">Rate (₹/1000)</label>
          <input
            type="number"
            value={form.rate}
            onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push('/masters/cartons')}
          className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

