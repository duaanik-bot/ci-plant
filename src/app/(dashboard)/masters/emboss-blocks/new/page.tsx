'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function NewEmbossBlockPage() {
  const router = useRouter()
  const [f, setF] = useState({
    blockNumber: '',
    blockType: 'Registered Emboss',
    blockMaterial: 'Magnesium',
    cartonName: '',
    artworkCode: '',
    storageLocation: '',
    compartment: '',
  })
  const [saving, setSaving] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const res = await fetch('/api/emboss-blocks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blockNumber: f.blockNumber ? Number(f.blockNumber) : undefined,
        blockType: f.blockType,
        blockMaterial: f.blockMaterial,
        cartonName: f.cartonName || null,
        artworkCode: f.artworkCode || null,
        storageLocation: f.storageLocation || null,
        compartment: f.compartment || null,
      }),
    })
    setSaving(false)
    if (!res.ok) return
    router.push('/masters/emboss-blocks')
  }

  return (
    <form onSubmit={submit} className="p-4 max-w-2xl mx-auto space-y-3">
      <h1 className="text-xl font-bold text-amber-400">Add Emboss Block</h1>
      <input value={f.blockNumber} onChange={(e) => setF((p) => ({ ...p, blockNumber: e.target.value }))} placeholder="Block Number" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground text-sm" />
      <input value={f.blockType} onChange={(e) => setF((p) => ({ ...p, blockType: e.target.value }))} placeholder="Block Type" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground text-sm" />
      <input value={f.blockMaterial} onChange={(e) => setF((p) => ({ ...p, blockMaterial: e.target.value }))} placeholder="Block Material" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground text-sm" />
      <input value={f.cartonName} onChange={(e) => setF((p) => ({ ...p, cartonName: e.target.value }))} placeholder="Carton Name" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground text-sm" />
      <input value={f.artworkCode} onChange={(e) => setF((p) => ({ ...p, artworkCode: e.target.value }))} placeholder="Artwork Code" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground text-sm" />
      <input value={f.storageLocation} onChange={(e) => setF((p) => ({ ...p, storageLocation: e.target.value }))} placeholder="Storage Location" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground text-sm" />
      <input value={f.compartment} onChange={(e) => setF((p) => ({ ...p, compartment: e.target.value }))} placeholder="Compartment/Shelf" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-foreground text-sm" />
      <button disabled={saving} className="px-3 py-2 rounded bg-amber-600 text-primary-foreground text-sm">{saving ? 'Saving...' : 'Save'}</button>
    </form>
  )
}
