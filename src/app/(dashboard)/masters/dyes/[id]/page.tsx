'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { DYE_TYPES } from '@/lib/constants'

type UsageLog = {
  id: string
  impressions: number
  usedOn: string
  jobCardId: string | null
  cartonName: string | null
  operatorName: string | null
  conditionAfter: string | null
  notes: string | null
}

type MaintenanceLog = {
  id: string
  actionType: string
  performedAt: string
  conditionBefore: string | null
  conditionAfter: string | null
  notes: string | null
  cost: number | null
}

type DyeDetail = {
  id: string
  dyeNumber: number
  dyeType: string
  ups: number
  sheetSize: string
  cartonSize: string
  location: string | null
  impressionCount: number
  maxImpressions: number
  conditionRating: string | null
  condition: string
  lastUsedDate: string | null
  lastSharpenedDate: string | null
  sharpenCount: number
  usageLogs: UsageLog[]
  maintenanceLogs: MaintenanceLog[]
}

export default function DyeEditPage() {
  const params = useParams()
  const id = params.id as string

  const [dye, setDye] = useState<DyeDetail | null>(null)
  const [tab, setTab] = useState<'overview' | 'usage' | 'maintenance'>('overview')
  const [saving, setSaving] = useState(false)

  const [showUsage, setShowUsage] = useState(false)
  const [showMaintenance, setShowMaintenance] = useState(false)
  const [usageForm, setUsageForm] = useState({
    impressions: '',
    usedOn: new Date().toISOString().slice(0, 10),
    cartonName: '',
    operatorName: '',
    conditionAfter: '',
    notes: '',
  })
  const [maintForm, setMaintForm] = useState({
    actionType: 'Sharpen',
    performedAt: new Date().toISOString().slice(0, 16),
    conditionBefore: '',
    conditionAfter: '',
    notes: '',
    cost: '',
  })

  useEffect(() => {
    fetch(`/api/masters/dyes/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data || data.error) throw new Error(data.error || 'Failed to load dye')
        setDye(data)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [id])

  async function handleSaveOverview(e: React.FormEvent) {
    e.preventDefault()
    if (!dye) return
    setSaving(true)
    try {
      const res = await fetch(`/api/masters/dyes/${dye.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dyeType: dye.dyeType,
          ups: dye.ups,
          sheetSize: dye.sheetSize,
          cartonSize: dye.cartonSize,
          location: dye.location,
          maxImpressions: dye.maxImpressions,
          conditionRating: dye.conditionRating ?? dye.condition,
          condition: dye.condition ?? dye.conditionRating ?? 'Good',
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Save failed')
      toast.success('Dye updated')
      setDye((d) => (d ? { ...d, ...json } : null))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleAddUsage(e: React.FormEvent) {
    e.preventDefault()
    const impressions = Number(usageForm.impressions)
    if (impressions < 0) {
      toast.error('Impressions must be ≥ 0')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/masters/dyes/${id}/usage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          impressions,
          usedOn: usageForm.usedOn || undefined,
          cartonName: usageForm.cartonName.trim() || null,
          operatorName: usageForm.operatorName.trim() || null,
          conditionAfter: usageForm.conditionAfter.trim() || null,
          notes: usageForm.notes.trim() || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to add usage')
      toast.success('Usage logged')
      setShowUsage(false)
      setUsageForm({
        impressions: '',
        usedOn: new Date().toISOString().slice(0, 10),
        cartonName: '',
        operatorName: '',
        conditionAfter: '',
        notes: '',
      })
      const updated = await fetch(`/api/masters/dyes/${id}`).then((r) => r.json())
      if (updated && !updated.error) setDye(updated)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add usage')
    } finally {
      setSaving(false)
    }
  }

  async function handleAddMaintenance(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch(`/api/masters/dyes/${id}/maintenance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: maintForm.actionType.trim(),
          performedAt: maintForm.performedAt || undefined,
          conditionBefore: maintForm.conditionBefore.trim() || null,
          conditionAfter: maintForm.conditionAfter.trim() || null,
          notes: maintForm.notes.trim() || null,
          cost: maintForm.cost ? Number(maintForm.cost) : null,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to add maintenance')
      toast.success('Maintenance logged')
      setShowMaintenance(false)
      setMaintForm({
        actionType: 'Sharpen',
        performedAt: new Date().toISOString().slice(0, 16),
        conditionBefore: '',
        conditionAfter: '',
        notes: '',
        cost: '',
      })
      const updated = await fetch(`/api/masters/dyes/${id}`).then((r) => r.json())
      if (updated && !updated.error) setDye(updated)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add maintenance')
    } finally {
      setSaving(false)
    }
  }

  if (!dye) return <div className="text-slate-400">Loading…</div>

  const lifePct =
    dye.maxImpressions > 0
      ? Math.min(100, Math.round((dye.impressionCount / dye.maxImpressions) * 100))
      : 0
  let barColor = 'bg-green-500'
  if (lifePct >= 80) barColor = 'bg-red-500'
  else if (lifePct >= 50) barColor = 'bg-amber-500'

  const conditionDisplay = dye.conditionRating ?? dye.condition ?? 'Good'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/masters/dyes"
            className="text-slate-400 hover:text-white text-sm"
          >
            ← Dye Master
          </Link>
          <h2 className="text-lg font-semibold text-white">Dye #{dye.dyeNumber}</h2>
        </div>
      </div>

      <div className="flex gap-2 border-b border-slate-700 pb-2">
        {(['overview', 'usage', 'maintenance'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-t text-sm capitalize ${
              tab === t ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <form onSubmit={handleSaveOverview} className="space-y-4 max-w-xl">
          <div className="grid md:grid-cols-2 gap-4 bg-slate-900 rounded-lg border border-slate-700 p-4 text-sm">
            <div>
              <label className="block text-slate-400 mb-1">Dye number</label>
              <input
                type="number"
                value={dye.dyeNumber}
                disabled
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-400"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Type</label>
              <select
                value={dye.dyeType}
                onChange={(e) => setDye({ ...dye, dyeType: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
              >
                {DYE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-slate-400 mb-1">UPS</label>
              <input
                type="number"
                min={1}
                value={dye.ups}
                onChange={(e) => setDye({ ...dye, ups: Number(e.target.value) || 1 })}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Sheet size</label>
              <input
                type="text"
                value={dye.sheetSize}
                onChange={(e) => setDye({ ...dye, sheetSize: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Carton size</label>
              <input
                type="text"
                value={dye.cartonSize}
                onChange={(e) => setDye({ ...dye, cartonSize: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Location</label>
              <input
                type="text"
                value={dye.location ?? ''}
                onChange={(e) => setDye({ ...dye, location: e.target.value || null })}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Max impressions</label>
              <input
                type="number"
                min={1}
                value={dye.maxImpressions}
                onChange={(e) =>
                  setDye({
                    ...dye,
                    maxImpressions: Number(e.target.value) || dye.maxImpressions,
                  })
                }
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Condition</label>
              <input
                type="text"
                value={conditionDisplay}
                onChange={(e) =>
                  setDye({
                    ...dye,
                    conditionRating: e.target.value || null,
                    condition: e.target.value || 'Good',
                  })
                }
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
              />
            </div>
          </div>
          <div className="mb-4">
            <span className="text-slate-400 text-sm">Impressions </span>
            <div className="h-3 rounded-full bg-slate-800 overflow-hidden mt-1">
              <div
                className={`h-full ${barColor}`}
                style={{ width: `${lifePct}%` }}
              />
            </div>
            <span className="text-xs text-slate-400">
              {dye.impressionCount.toLocaleString()} / {dye.maxImpressions.toLocaleString()}
              {dye.lastUsedDate && ` · Last used: ${dye.lastUsedDate.slice(0, 10)}`}
              {dye.lastSharpenedDate && ` · Sharpened: ${dye.lastSharpenedDate.slice(0, 10)} (${dye.sharpenCount}×)`}
            </span>
          </div>
          <div className="flex justify-end gap-2">
            <Link
              href="/masters/dyes"
              className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}

      {tab === 'usage' && (
        <div>
          <div className="flex justify-end mb-2">
            <button
              type="button"
              onClick={() => setShowUsage(true)}
              className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm"
            >
              Add usage
            </button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-slate-700">
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-slate-300">
                <tr>
                  <th className="px-4 py-2 text-left">Date</th>
                  <th className="px-4 py-2 text-left">Impressions</th>
                  <th className="px-4 py-2 text-left">Carton</th>
                  <th className="px-4 py-2 text-left">Operator</th>
                  <th className="px-4 py-2 text-left">Condition after</th>
                  <th className="px-4 py-2 text-left">Notes</th>
                </tr>
              </thead>
              <tbody className="text-white">
                {(dye.usageLogs ?? []).map((u) => (
                  <tr key={u.id} className="border-t border-slate-700">
                    <td className="px-4 py-2">{u.usedOn.slice(0, 10)}</td>
                    <td className="px-4 py-2">{u.impressions.toLocaleString()}</td>
                    <td className="px-4 py-2 text-slate-300">{u.cartonName ?? '—'}</td>
                    <td className="px-4 py-2 text-slate-300">{u.operatorName ?? '—'}</td>
                    <td className="px-4 py-2 text-slate-300">{u.conditionAfter ?? '—'}</td>
                    <td className="px-4 py-2 text-slate-300">{u.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(!dye.usageLogs || dye.usageLogs.length === 0) && (
            <p className="text-slate-400 text-sm mt-2">No usage logged yet.</p>
          )}

          {showUsage && (
            <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
              <form
                onSubmit={handleAddUsage}
                className="bg-slate-900 border border-slate-700 rounded-lg p-4 max-w-md w-full space-y-3"
              >
                <h3 className="text-white font-medium">Log usage</h3>
                <div>
                  <label className="block text-slate-400 text-sm mb-1">Impressions *</label>
                  <input
                    type="number"
                    min={0}
                    value={usageForm.impressions}
                    onChange={(e) => setUsageForm((f) => ({ ...f, impressions: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 text-sm mb-1">Date</label>
                  <input
                    type="date"
                    value={usageForm.usedOn}
                    onChange={(e) => setUsageForm((f) => ({ ...f, usedOn: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 text-sm mb-1">Carton name</label>
                  <input
                    type="text"
                    value={usageForm.cartonName}
                    onChange={(e) => setUsageForm((f) => ({ ...f, cartonName: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 text-sm mb-1">Operator</label>
                  <input
                    type="text"
                    value={usageForm.operatorName}
                    onChange={(e) => setUsageForm((f) => ({ ...f, operatorName: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 text-sm mb-1">Condition after</label>
                  <input
                    type="text"
                    value={usageForm.conditionAfter}
                    onChange={(e) => setUsageForm((f) => ({ ...f, conditionAfter: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 text-sm mb-1">Notes</label>
                  <input
                    type="text"
                    value={usageForm.notes}
                    onChange={(e) => setUsageForm((f) => ({ ...f, notes: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowUsage(false)}
                    className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm"
                  >
                    {saving ? 'Saving…' : 'Add'}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}

      {tab === 'maintenance' && (
        <div>
          <div className="flex justify-end mb-2">
            <button
              type="button"
              onClick={() => setShowMaintenance(true)}
              className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm"
            >
              Add maintenance
            </button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-slate-700">
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-slate-300">
                <tr>
                  <th className="px-4 py-2 text-left">Date</th>
                  <th className="px-4 py-2 text-left">Action</th>
                  <th className="px-4 py-2 text-left">Condition before</th>
                  <th className="px-4 py-2 text-left">Condition after</th>
                  <th className="px-4 py-2 text-left">Cost</th>
                  <th className="px-4 py-2 text-left">Notes</th>
                </tr>
              </thead>
              <tbody className="text-white">
                {(dye.maintenanceLogs ?? []).map((m) => (
                  <tr key={m.id} className="border-t border-slate-700">
                    <td className="px-4 py-2">{m.performedAt.slice(0, 16).replace('T', ' ')}</td>
                    <td className="px-4 py-2">{m.actionType}</td>
                    <td className="px-4 py-2 text-slate-300">{m.conditionBefore ?? '—'}</td>
                    <td className="px-4 py-2 text-slate-300">{m.conditionAfter ?? '—'}</td>
                    <td className="px-4 py-2 text-slate-300">
                      {m.cost != null ? `₹${m.cost}` : '—'}
                    </td>
                    <td className="px-4 py-2 text-slate-300">{m.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(!dye.maintenanceLogs || dye.maintenanceLogs.length === 0) && (
            <p className="text-slate-400 text-sm mt-2">No maintenance logged yet.</p>
          )}

          {showMaintenance && (
            <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
              <form
                onSubmit={handleAddMaintenance}
                className="bg-slate-900 border border-slate-700 rounded-lg p-4 max-w-md w-full space-y-3"
              >
                <h3 className="text-white font-medium">Log maintenance</h3>
                <div>
                  <label className="block text-slate-400 text-sm mb-1">Action type *</label>
                  <input
                    type="text"
                    value={maintForm.actionType}
                    onChange={(e) => setMaintForm((f) => ({ ...f, actionType: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
                    placeholder="e.g. Sharpen, Inspect, Repair"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 text-sm mb-1">Performed at</label>
                  <input
                    type="datetime-local"
                    value={maintForm.performedAt}
                    onChange={(e) => setMaintForm((f) => ({ ...f, performedAt: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 text-sm mb-1">Condition before</label>
                  <input
                    type="text"
                    value={maintForm.conditionBefore}
                    onChange={(e) => setMaintForm((f) => ({ ...f, conditionBefore: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 text-sm mb-1">Condition after</label>
                  <input
                    type="text"
                    value={maintForm.conditionAfter}
                    onChange={(e) => setMaintForm((f) => ({ ...f, conditionAfter: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 text-sm mb-1">Cost (₹)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={maintForm.cost}
                    onChange={(e) => setMaintForm((f) => ({ ...f, cost: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 text-sm mb-1">Notes</label>
                  <input
                    type="text"
                    value={maintForm.notes}
                    onChange={(e) => setMaintForm((f) => ({ ...f, notes: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowMaintenance(false)}
                    className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm"
                  >
                    {saving ? 'Saving…' : 'Add'}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
