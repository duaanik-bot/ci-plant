'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function NewDieStorePage() {
  const router = useRouter()
  const [form, setForm] = useState({
    dieNumber: '',
    dieType: 'BSO',
    ups: '1',
    sheetSize: '',
    cartonSize: '',
    storageLocation: '',
    compartment: '',
  })
  const [saving, setSaving] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const res = await fetch('/api/die-store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dieNumber: form.dieNumber ? Number(form.dieNumber) : undefined,
        dieType: form.dieType,
        ups: Number(form.ups || 1),
        sheetSize: form.sheetSize || null,
        cartonSize: form.cartonSize || null,
        storageLocation: form.storageLocation || null,
        compartment: form.compartment || null,
      }),
    })
    setSaving(false)
    if (!res.ok) return
    router.push('/masters/dies')
  }

  return (
    <form onSubmit={submit} className="p-4 max-w-2xl mx-auto space-y-3">
      <h1 className="text-xl font-bold text-amber-400">Add Die Record</h1>
      <input value={form.dieNumber} onChange={(e) => setForm((p) => ({ ...p, dieNumber: e.target.value }))} placeholder="Die Number" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground text-sm" />
      <input value={form.dieType} onChange={(e) => setForm((p) => ({ ...p, dieType: e.target.value }))} placeholder="Die Type" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground text-sm" />
      <input value={form.ups} onChange={(e) => setForm((p) => ({ ...p, ups: e.target.value }))} placeholder="UPS" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground text-sm" />
      <input value={form.sheetSize} onChange={(e) => setForm((p) => ({ ...p, sheetSize: e.target.value }))} placeholder="Sheet Size" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground text-sm" />
      <input value={form.cartonSize} onChange={(e) => setForm((p) => ({ ...p, cartonSize: e.target.value }))} placeholder="Carton Size" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground text-sm" />
      <input value={form.storageLocation} onChange={(e) => setForm((p) => ({ ...p, storageLocation: e.target.value }))} placeholder="Storage Location" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground text-sm" />
      <input value={form.compartment} onChange={(e) => setForm((p) => ({ ...p, compartment: e.target.value }))} placeholder="Compartment" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground text-sm" />
      <button disabled={saving} className="px-3 py-2 rounded bg-amber-600 text-primary-foreground text-sm">{saving ? 'Saving...' : 'Save'}</button>
    </form>
  )
}
