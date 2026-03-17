'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { toast } from 'sonner'

type Plate = {
  id: string
  plateSetCode: string
  cartonName: string
  customer: { id: string; name: string } | null
  artworkVersion: string | null
  numberOfColours: number
  colours: Record<string, string>
  newPlates: number
  oldPlates: number
  totalPlates: number
  storageLocation: string | null
  storageNotes: string | null
  ctpOperator: string | null
  ctpDate: string | null
  collectedBy: string | null
  collectedAt: string | null
  status: string
}

const STATUS_BADGE: Record<string, string> = {
  in_use: 'bg-blue-900/50 text-blue-200 border-blue-600',
  stored: 'bg-green-900/50 text-green-200 border-green-600',
  destroyed: 'bg-red-900/50 text-red-200 border-red-600',
  missing: 'bg-amber-900/50 text-amber-200 border-amber-600',
}

export default function PlateStoreDetailPage() {
  const params = useParams()
  const id = params.id as string
  const [plate, setPlate] = useState<Plate | null>(null)
  const [loading, setLoading] = useState(true)
  const [storeOpen, setStoreOpen] = useState(false)
  const [destroyOpen, setDestroyOpen] = useState(false)
  const [destroyColour, setDestroyColour] = useState('')
  const [storeCollectedBy, setStoreCollectedBy] = useState('')
  const [storeLocation, setStoreLocation] = useState('')
  const [storeNotes, setStoreNotes] = useState('')
  const [destroyReason, setDestroyReason] = useState<'cannot_clean' | 'damaged' | 'wrong_version' | 'obsolete' | 'other'>('damaged')
  const [destroyDetail, setDestroyDetail] = useState('')
  const [destroyedBy, setDestroyedBy] = useState('')
  const [users, setUsers] = useState<{ id: string; name: string }[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch(`/api/plate-store/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error)
        setPlate(data)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    fetch('/api/users')
      .then((r) => r.json())
      .then((data) => setUsers(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  const handleMarkStored = async () => {
    if (!storeCollectedBy.trim()) {
      toast.error('Collected by is required')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/plate-store/${id}/store`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collectedBy: storeCollectedBy.trim(),
          storageLocation: storeLocation.trim() || null,
          storageNotes: storeNotes.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      setPlate((p) => (p ? { ...p, ...data } : null))
      setStoreOpen(false)
      toast.success('Plates marked as stored')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  const handleDestroyColour = async () => {
    if (!destroyColour.trim() || !destroyedBy.trim()) {
      toast.error('Select colour and enter destroyed by')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/plate-store/${id}/destroy-colour`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          colourName: destroyColour,
          reason: destroyReason,
          reasonDetail: destroyDetail.trim() || undefined,
          destroyedBy: destroyedBy.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      setPlate((p) => (p ? { ...p, ...data } : null))
      setDestroyOpen(false)
      setDestroyColour('')
      toast.success('Colour marked as destroyed')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading || !plate) {
    return (
      <div className="p-4 max-w-2xl mx-auto">
        <div className="h-8 w-48 bg-slate-800 rounded animate-pulse mb-4" />
        <div className="h-64 bg-slate-800/50 rounded animate-pulse" />
      </div>
    )
  }

  const colours = (plate.colours ?? {}) as Record<string, string>
  const colourEntries = Object.entries(colours)
  const availableColours = colourEntries.filter(([, v]) => v !== 'destroyed')

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      <Link href="/pre-press/plate-store" className="text-slate-400 hover:text-white text-sm mb-4 inline-block">
        ← Plate store
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-amber-400">{plate.plateSetCode}</h1>
          <p className="text-slate-400">{plate.cartonName}</p>
          <p className="text-sm text-slate-500">{plate.customer?.name ?? '—'}</p>
        </div>
        <span className={`px-2 py-1 rounded text-xs border ${STATUS_BADGE[plate.status] ?? 'bg-slate-700'}`}>
          {plate.status}
        </span>
      </div>

      <div className="rounded-xl bg-slate-900 border border-slate-700 p-4 space-y-2 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <div><span className="text-slate-500">Artwork version</span> {plate.artworkVersion ?? '—'}</div>
          <div><span className="text-slate-500">Colours</span> {plate.numberOfColours}</div>
          <div><span className="text-slate-500">New / Old</span> {plate.newPlates} / {plate.oldPlates}</div>
          <div><span className="text-slate-500">Location</span> {plate.storageLocation ?? '—'}</div>
          <div><span className="text-slate-500">CTP operator</span> {plate.ctpOperator ?? '—'}</div>
          <div><span className="text-slate-500">CTP date</span> {plate.ctpDate ? new Date(plate.ctpDate).toLocaleDateString() : '—'}</div>
          <div><span className="text-slate-500">Collected by</span> {plate.collectedBy ?? '—'}</div>
          <div><span className="text-slate-500">Collected at</span> {plate.collectedAt ? new Date(plate.collectedAt).toLocaleString() : '—'}</div>
        </div>
        <div>
          <span className="text-slate-500">Colour status </span>
          <div className="flex flex-wrap gap-1 mt-1">
            {colourEntries.map(([name, st]) => (
              <span
                key={name}
                className={`px-2 py-0.5 rounded text-xs ${
                  st === 'destroyed' ? 'bg-red-900/50 text-red-300' : st === 'new' ? 'bg-green-900/50 text-green-300' : 'bg-slate-700 text-slate-300'
                }`}
              >
                {name}: {st}
              </span>
            ))}
          </div>
        </div>
        {plate.storageNotes && <p className="text-slate-400 text-xs pt-1">{plate.storageNotes}</p>}
      </div>

      <div className="flex flex-wrap gap-2">
        {plate.status === 'in_use' && (
          <button
            onClick={() => setStoreOpen(true)}
            className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium"
          >
            Mark as stored
          </button>
        )}
        {availableColours.length > 0 && plate.status !== 'destroyed' && (
          <button
            onClick={() => {
              setDestroyColour(availableColours[0]?.[0] ?? '')
              setDestroyOpen(true)
            }}
            className="px-4 py-2 rounded-lg border border-red-600 text-red-300 hover:bg-red-900/30 text-sm"
          >
            Mark colour as destroyed
          </button>
        )}
        <button
          type="button"
          className="px-4 py-2 rounded-lg border border-slate-600 text-slate-300 text-sm"
        >
          Print label (placeholder)
        </button>
      </div>

      {storeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-4 w-full max-w-md space-y-3">
            <h2 className="text-lg font-semibold text-white">Collect & store plates</h2>
            <div>
              <label className="block text-slate-400 text-sm mb-1">Collected by *</label>
              <select
                value={storeCollectedBy}
                onChange={(e) => setStoreCollectedBy(e.target.value)}
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="">Select…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.name}>{u.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-slate-400 text-sm mb-1">Storage location</label>
              <input
                type="text"
                value={storeLocation}
                onChange={(e) => setStoreLocation(e.target.value)}
                placeholder={plate.storageLocation ?? 'e.g. Rack B-3'}
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 text-sm mb-1">Notes</label>
              <textarea
                value={storeNotes}
                onChange={(e) => setStoreNotes(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setStoreOpen(false)}
                className="px-3 py-1.5 rounded border border-slate-600 text-slate-200 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleMarkStored}
                disabled={saving}
                className="px-4 py-1.5 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {destroyOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-4 w-full max-w-md space-y-3">
            <h2 className="text-lg font-semibold text-white">Mark colour as destroyed</h2>
            <div>
              <label className="block text-slate-400 text-sm mb-1">Colour *</label>
              <select
                value={destroyColour}
                onChange={(e) => setDestroyColour(e.target.value)}
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                {availableColours.map(([name]) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-slate-400 text-sm mb-1">Reason</label>
              <select
                value={destroyReason}
                onChange={(e) => setDestroyReason(e.target.value as typeof destroyReason)}
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="cannot_clean">Cannot clean</option>
                <option value="damaged">Damaged</option>
                <option value="wrong_version">Wrong version</option>
                <option value="obsolete">Obsolete</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="block text-slate-400 text-sm mb-1">Detail (if Other)</label>
              <input
                type="text"
                value={destroyDetail}
                onChange={(e) => setDestroyDetail(e.target.value)}
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 text-sm mb-1">Destroyed by *</label>
              <select
                value={destroyedBy}
                onChange={(e) => setDestroyedBy(e.target.value)}
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="">Select…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.name}>{u.name}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDestroyOpen(false)}
                className="px-3 py-1.5 rounded border border-slate-600 text-slate-200 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDestroyColour}
                disabled={saving}
                className="px-4 py-1.5 rounded bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-sm"
              >
                {saving ? 'Saving…' : 'Mark destroyed'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
