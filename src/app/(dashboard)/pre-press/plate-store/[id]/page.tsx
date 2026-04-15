'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { toast } from 'sonner'

type Plate = {
  id: string
  plateSetCode: string
  cartonName: string
  artworkCode: string | null
  customer: { id: string; name: string } | null
  artworkVersion: string | null
  numberOfColours: number
  colours: Array<{ name: string; type?: string; status: string; rackLocation?: string | null; condition?: string }>
  newPlates: number
  oldPlates: number
  totalPlates: number
  rackLocation: string | null
  slotNumber: string | null
  ctpOperator: string | null
  ctpDate: string | null
  issuedTo: string | null
  issuedAt: string | null
  expectedReturn: string | null
  returnedAt: string | null
  status: string
  issueRecords: Array<{ id: string; issuedTo: string; issuedAt: string; status: string; jobCardNumber: number | null; returnNotes: string | null }>
  auditLog: Array<{ id: string; action: string; performedBy: string; performedAt: string; details: unknown }>
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
  const [tab, setTab] = useState<'overview' | 'issue' | 'history' | 'audit'>('overview')
  const [users, setUsers] = useState<{ id: string; name: string }[]>([])
  const [jobCardId, setJobCardId] = useState('')
  const [issuedTo, setIssuedTo] = useState('')
  const [purpose, setPurpose] = useState<'production' | 'reprint' | 'sample' | 'proof'>('production')
  const [issueColours, setIssueColours] = useState<string[]>([])
  const [returnIssueId, setReturnIssueId] = useState('')
  const [returnNotes, setReturnNotes] = useState('')
  const [returnRack, setReturnRack] = useState('')
  const [savingRack, setSavingRack] = useState(false)
  const [rackLocation, setRackLocation] = useState('')
  const [slotNumber, setSlotNumber] = useState('')
  const [destroyColour, setDestroyColour] = useState('')
  const [destroyReason, setDestroyReason] = useState('damaged')
  const [destroyedBy, setDestroyedBy] = useState('')
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

  useEffect(() => {
    if (!plate) return
    setRackLocation(plate.rackLocation ?? '')
    setSlotNumber(plate.slotNumber ?? '')
    setReturnRack(plate.rackLocation ?? '')
    if (plate.issueRecords?.length) setReturnIssueId(plate.issueRecords[0].id)
    const available = (plate.colours || []).filter((c) => c.status !== 'destroyed')
    setIssueColours(available.map((c) => c.name))
    setDestroyColour(available[0]?.name ?? '')
  }, [plate])

  const refresh = async () => {
    const data = await fetch(`/api/plate-store/${id}`).then((r) => r.json())
    setPlate(data)
  }

  const handleIssue = async () => {
    if (!jobCardId || !issuedTo || issueColours.length === 0) {
      toast.error('Job card, issued to and colours are required')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/plate-store/${id}/issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobCardId,
          issuedTo,
          coloursToIssue: issueColours,
          purpose,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      await refresh()
      toast.success('Plates issued')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  const handleReturn = async () => {
    if (!returnIssueId || !issuedTo || !returnRack) {
      toast.error('Issue record, returned by and rack location are required')
      return
    }
    setSaving(true)
    try {
      const conditions = (plate?.colours || [])
        .filter((c) => c.status === 'issued')
        .map((c) => ({ name: c.name, condition: 'Good', action: 'store' as const }))
      const res = await fetch(`/api/plate-store/${id}/return`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issueRecordId: returnIssueId,
          returnedBy: issuedTo,
          colourConditions: conditions,
          returnNotes,
          rackLocation: returnRack,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      await refresh()
      toast.success('Plates returned')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  const handleRackUpdate = async () => {
    setSavingRack(true)
    try {
      const res = await fetch(`/api/plate-store/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rackLocation, slotNumber }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      await refresh()
      toast.success('Rack updated')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSavingRack(false)
    }
  }

  const handleDestroyColour = async () => {
    if (!destroyColour || !destroyedBy) {
      toast.error('Colour and destroyed by are required')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/plate-store/${id}/destroy-colour`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ colourName: destroyColour, reason: destroyReason, destroyedBy }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      await refresh()
      toast.success('Colour destroyed')
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

  const colours = plate.colours ?? []
  const availableColours = colours.filter((c) => c.status !== 'destroyed')

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-4">
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

      <div className="flex flex-wrap gap-2">
        {[
          { key: 'overview', label: 'Overview' },
          { key: 'issue', label: 'Issue / Return' },
          { key: 'history', label: 'History' },
          { key: 'audit', label: 'Audit Log' },
        ].map((t) => (
          <button key={t.key} onClick={() => setTab(t.key as typeof tab)} className={`px-3 py-1.5 rounded text-xs border ${tab === t.key ? 'bg-amber-600 border-amber-500 text-white' : 'border-slate-700 text-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="rounded-xl bg-slate-900 border border-slate-700 p-4 space-y-3 text-sm">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div><span className="text-slate-500">Artwork</span> {plate.artworkCode ?? '—'}</div>
            <div><span className="text-slate-500">Version</span> {plate.artworkVersion ?? '—'}</div>
            <div><span className="text-slate-500">CTP Date</span> {plate.ctpDate ? new Date(plate.ctpDate).toLocaleDateString() : '—'}</div>
            <div><span className="text-slate-500">CTP Operator</span> {plate.ctpOperator ?? '—'}</div>
            <div><span className="text-slate-500">Rack</span> {plate.rackLocation ?? '—'}</div>
            <div><span className="text-slate-500">Slot</span> {plate.slotNumber ?? '—'}</div>
            <div><span className="text-slate-500">Issued To</span> {plate.issuedTo ?? '—'}</div>
            <div><span className="text-slate-500">Expected Return</span> {plate.expectedReturn ? new Date(plate.expectedReturn).toLocaleDateString() : '—'}</div>
          </div>
          <div>
            <p className="text-slate-400 mb-1">Colour Inventory</p>
            <div className="space-y-1">
              {colours.map((c) => (
                <div key={c.name} className="flex items-center justify-between rounded bg-slate-800/60 border border-slate-700 px-2 py-1">
                  <span className="text-slate-200">{c.name}</span>
                  <span className="text-slate-400">{c.type || 'process'}</span>
                  <span className="text-slate-400">{c.status}</span>
                  <span className="text-slate-400">{c.rackLocation || '-'}</span>
                  <span className="text-slate-400">{c.condition || '-'}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href={`/api/plate-store/${id}/label`} target="_blank" rel="noreferrer" className="px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white text-xs">Print Label</a>
            <button onClick={handleRackUpdate} disabled={savingRack} className="px-3 py-1.5 rounded border border-slate-600 text-slate-200 text-xs">{savingRack ? 'Saving…' : 'Update Rack Location'}</button>
            <input value={rackLocation} onChange={(e) => setRackLocation(e.target.value)} placeholder="Rack" className="px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white text-xs" />
            <input value={slotNumber} onChange={(e) => setSlotNumber(e.target.value)} placeholder="Slot" className="px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white text-xs" />
          </div>
        </div>
      )}

      {tab === 'issue' && (
        <div className="rounded-xl bg-slate-900 border border-slate-700 p-4 grid md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-200">Issue Form</h2>
            <input value={jobCardId} onChange={(e) => setJobCardId(e.target.value)} placeholder="Job Card ID" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm" />
            <select value={issuedTo} onChange={(e) => setIssuedTo(e.target.value)} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm">
              <option value="">Issue to operator</option>
              {users.map((u) => <option key={u.id} value={u.name}>{u.name}</option>)}
            </select>
            <select value={purpose} onChange={(e) => setPurpose(e.target.value as typeof purpose)} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm">
              <option value="production">Production</option>
              <option value="reprint">Reprint</option>
              <option value="sample">Sample</option>
              <option value="proof">Proof</option>
            </select>
            <div className="flex flex-wrap gap-2">
              {availableColours.map((c) => (
                <label key={c.name} className="text-xs text-slate-300 inline-flex items-center gap-1">
                  <input type="checkbox" checked={issueColours.includes(c.name)} onChange={(e) => setIssueColours((prev) => e.target.checked ? Array.from(new Set([...prev, c.name])) : prev.filter((x) => x !== c.name))} />
                  {c.name}
                </label>
              ))}
            </div>
            <button onClick={handleIssue} disabled={saving} className="px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white text-xs">{saving ? 'Issuing…' : 'Issue Plates'}</button>
          </div>
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-200">Return Form</h2>
            <select value={returnIssueId} onChange={(e) => setReturnIssueId(e.target.value)} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm">
              <option value="">Select issue record</option>
              {(plate.issueRecords || []).map((r) => <option key={r.id} value={r.id}>{r.jobCardNumber ? `Job ${r.jobCardNumber}` : r.id.slice(0, 8)} · {r.status}</option>)}
            </select>
            <input value={returnRack} onChange={(e) => setReturnRack(e.target.value)} placeholder="Rack location" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm" />
            <textarea value={returnNotes} onChange={(e) => setReturnNotes(e.target.value)} placeholder="Return notes" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm" />
            <button onClick={handleReturn} disabled={saving} className="px-3 py-1.5 rounded border border-slate-600 text-slate-200 text-xs">{saving ? 'Returning…' : 'Confirm Return'}</button>
            <div className="pt-2 border-t border-slate-700">
              <h3 className="text-xs text-slate-300 mb-2">Destroy Colour</h3>
              <select value={destroyColour} onChange={(e) => setDestroyColour(e.target.value)} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm mb-2">
                {availableColours.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
              <input value={destroyReason} onChange={(e) => setDestroyReason(e.target.value)} placeholder="Reason" className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm mb-2" />
              <select value={destroyedBy} onChange={(e) => setDestroyedBy(e.target.value)} className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm mb-2">
                <option value="">Destroyed by</option>
                {users.map((u) => <option key={u.id} value={u.name}>{u.name}</option>)}
              </select>
              <button onClick={handleDestroyColour} disabled={saving} className="px-3 py-1.5 rounded border border-red-600 text-red-300 text-xs">{saving ? 'Saving…' : 'Destroy Colour'}</button>
            </div>
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div className="rounded-xl bg-slate-900 border border-slate-700 p-4 space-y-2">
          {(plate.issueRecords || []).map((h) => (
            <div key={h.id} className="rounded border border-slate-700 bg-slate-800/50 p-2 text-sm">
              <p className="text-slate-200">{new Date(h.issuedAt).toLocaleString('en-IN')} · {h.status}</p>
              <p className="text-slate-400">To {h.issuedTo} {h.jobCardNumber ? `· Job ${h.jobCardNumber}` : ''}</p>
              {h.returnNotes ? <p className="text-slate-500 text-xs">{h.returnNotes}</p> : null}
            </div>
          ))}
        </div>
      )}

      {tab === 'audit' && (
        <div className="rounded-xl bg-slate-900 border border-slate-700 p-4">
          <div className="grid grid-cols-4 gap-2 text-xs text-slate-400 border-b border-slate-700 pb-2 mb-2">
            <span>Timestamp</span><span>Action</span><span>By</span><span>Details</span>
          </div>
          {(plate.auditLog || []).map((a) => (
            <div key={a.id} className="grid grid-cols-4 gap-2 text-xs text-slate-300 py-2 border-b border-slate-800">
              <span>{new Date(a.performedAt).toLocaleString('en-IN')}</span>
              <span>{a.action}</span>
              <span>{a.performedBy}</span>
              <span className="truncate">{JSON.stringify(a.details)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
