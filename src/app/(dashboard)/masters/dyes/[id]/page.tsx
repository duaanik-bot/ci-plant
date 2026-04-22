'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import DyeForm from '@/components/masters/DyeForm'

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

function parseDimensions(sheetSize: string, cartonSize: string) {
  const sp = (sheetSize || '').split(/[x×]/i)
  const cp = (cartonSize || '').split(/[x×]/i)
  return {
    sheetLength: sp[0]?.trim() || '',
    sheetWidth: sp[1]?.trim() || '',
    cartonL: cp[0]?.trim() || '',
    cartonW: cp[1]?.trim() || '',
    cartonH: cp[2]?.trim() || '',
  }
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

  async function handleAddUsage(e: React.FormEvent) {
    e.preventDefault()
    const impressions = Number(usageForm.impressions)
    if (impressions < 0) { toast.error('Impressions must be >= 0'); return }
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
      setUsageForm({ impressions: '', usedOn: new Date().toISOString().slice(0, 10), cartonName: '', operatorName: '', conditionAfter: '', notes: '' })
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
      setMaintForm({ actionType: 'Sharpen', performedAt: new Date().toISOString().slice(0, 16), conditionBefore: '', conditionAfter: '', notes: '', cost: '' })
      const updated = await fetch(`/api/masters/dyes/${id}`).then((r) => r.json())
      if (updated && !updated.error) setDye(updated)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add maintenance')
    } finally {
      setSaving(false)
    }
  }

  if (!dye) return <div className="text-ds-ink-muted">Loading...</div>

  const dims = parseDimensions(dye.sheetSize, dye.cartonSize)

  const lifePct = dye.maxImpressions > 0 ? Math.min(100, Math.round((dye.impressionCount / dye.maxImpressions) * 100)) : 0
  let barColor = 'bg-green-500'
  if (lifePct >= 80) barColor = 'bg-red-500'
  else if (lifePct >= 50) barColor = 'bg-ds-warning'

  const cls = 'w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground'

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/masters/dyes" className="text-ds-ink-muted hover:text-foreground text-sm">
          &larr; Dye Master
        </Link>
        <h2 className="text-lg font-semibold text-foreground">Die #{dye.dyeNumber}</h2>
      </div>

      {/* Impression bar */}
      <div className="mb-2">
        <span className="text-ds-ink-muted text-sm">Impressions</span>
        <div className="h-3 rounded-full bg-ds-elevated overflow-hidden mt-1">
          <div className={`h-full ${barColor}`} style={{ width: `${lifePct}%` }} />
        </div>
        <span className="text-xs text-ds-ink-muted">
          {dye.impressionCount.toLocaleString()} / {dye.maxImpressions.toLocaleString()}
          {dye.lastUsedDate && ` · Last used: ${dye.lastUsedDate.slice(0, 10)}`}
          {dye.lastSharpenedDate && ` · Sharpened: ${dye.lastSharpenedDate.slice(0, 10)} (${dye.sharpenCount}×)`}
        </span>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-ds-line/50 pb-2">
        {(['overview', 'usage', 'maintenance'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-t text-sm capitalize ${tab === t ? 'bg-ds-elevated text-foreground' : 'text-ds-ink-muted hover:text-foreground'}`}>
            {t}
          </button>
        ))}
      </div>

      {/* Overview — DyeForm handles the form rendering */}
      {tab === 'overview' && (
        <DyeForm
          mode="EDIT"
          initialData={{
            id: dye.id,
            dyeNumber: String(dye.dyeNumber),
            dyeType: dye.dyeType,
            ups: String(dye.ups),
            sheetLength: dims.sheetLength,
            sheetWidth: dims.sheetWidth,
            cartonL: dims.cartonL,
            cartonW: dims.cartonW,
            cartonH: dims.cartonH,
            location: dye.location ?? '',
            maxImpressions: String(dye.maxImpressions),
            condition: dye.conditionRating ?? dye.condition ?? 'Good',
          }}
        />
      )}

      {/* Usage Tab */}
      {tab === 'usage' && (
        <div>
          <div className="flex justify-end mb-2">
            <button type="button" onClick={() => setShowUsage(true)} className="px-3 py-1.5 rounded-lg bg-ds-warning hover:bg-ds-warning text-primary-foreground text-sm">Add usage</button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-ds-line/50">
            <table className="w-full text-sm">
              <thead className="bg-ds-elevated text-ds-ink-muted">
                <tr>
                  <th className="px-4 py-2 text-left">Date</th>
                  <th className="px-4 py-2 text-left">Impressions</th>
                  <th className="px-4 py-2 text-left">Carton</th>
                  <th className="px-4 py-2 text-left">Operator</th>
                  <th className="px-4 py-2 text-left">Condition after</th>
                  <th className="px-4 py-2 text-left">Notes</th>
                </tr>
              </thead>
              <tbody className="text-foreground">
                {(dye.usageLogs ?? []).map((u) => (
                  <tr key={u.id} className="border-t border-ds-line/50">
                    <td className="px-4 py-2">{u.usedOn.slice(0, 10)}</td>
                    <td className="px-4 py-2">{u.impressions.toLocaleString()}</td>
                    <td className="px-4 py-2 text-ds-ink-muted">{u.cartonName ?? '—'}</td>
                    <td className="px-4 py-2 text-ds-ink-muted">{u.operatorName ?? '—'}</td>
                    <td className="px-4 py-2 text-ds-ink-muted">{u.conditionAfter ?? '—'}</td>
                    <td className="px-4 py-2 text-ds-ink-muted">{u.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(!dye.usageLogs || dye.usageLogs.length === 0) && <p className="text-ds-ink-muted text-sm mt-2">No usage logged yet.</p>}

          {showUsage && (
            <div className="fixed inset-0 bg-background/60 flex items-center justify-center z-50 p-4">
              <form onSubmit={handleAddUsage} className="bg-ds-card border border-ds-line/50 rounded-lg p-4 max-w-md w-full space-y-3">
                <h3 className="text-foreground font-medium">Log usage</h3>
                <div>
                  <label className="block text-ds-ink-muted text-sm mb-1">Impressions *</label>
                  <input type="number" min={0} value={usageForm.impressions} onChange={(e) => setUsageForm((g) => ({ ...g, impressions: e.target.value }))} className={cls} />
                </div>
                <div>
                  <label className="block text-ds-ink-muted text-sm mb-1">Date</label>
                  <input type="date" value={usageForm.usedOn} onChange={(e) => setUsageForm((g) => ({ ...g, usedOn: e.target.value }))} className={cls} />
                </div>
                <div>
                  <label className="block text-ds-ink-muted text-sm mb-1">Carton name</label>
                  <input type="text" value={usageForm.cartonName} onChange={(e) => setUsageForm((g) => ({ ...g, cartonName: e.target.value }))} className={cls} />
                </div>
                <div>
                  <label className="block text-ds-ink-muted text-sm mb-1">Operator</label>
                  <input type="text" value={usageForm.operatorName} onChange={(e) => setUsageForm((g) => ({ ...g, operatorName: e.target.value }))} className={cls} />
                </div>
                <div>
                  <label className="block text-ds-ink-muted text-sm mb-1">Condition after</label>
                  <input type="text" value={usageForm.conditionAfter} onChange={(e) => setUsageForm((g) => ({ ...g, conditionAfter: e.target.value }))} className={cls} />
                </div>
                <div>
                  <label className="block text-ds-ink-muted text-sm mb-1">Notes</label>
                  <input type="text" value={usageForm.notes} onChange={(e) => setUsageForm((g) => ({ ...g, notes: e.target.value }))} className={cls} />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button type="button" onClick={() => setShowUsage(false)} className="px-3 py-1.5 rounded-lg border border-ds-line/60 text-ds-ink text-sm">Cancel</button>
                  <button type="submit" disabled={saving} className="px-4 py-1.5 rounded-lg bg-ds-warning hover:bg-ds-warning text-primary-foreground text-sm">{saving ? 'Saving...' : 'Add'}</button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}

      {/* Maintenance Tab */}
      {tab === 'maintenance' && (
        <div>
          <div className="flex justify-end mb-2">
            <button type="button" onClick={() => setShowMaintenance(true)} className="px-3 py-1.5 rounded-lg bg-ds-warning hover:bg-ds-warning text-primary-foreground text-sm">Add maintenance</button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-ds-line/50">
            <table className="w-full text-sm">
              <thead className="bg-ds-elevated text-ds-ink-muted">
                <tr>
                  <th className="px-4 py-2 text-left">Date</th>
                  <th className="px-4 py-2 text-left">Action</th>
                  <th className="px-4 py-2 text-left">Condition before</th>
                  <th className="px-4 py-2 text-left">Condition after</th>
                  <th className="px-4 py-2 text-left">Cost</th>
                  <th className="px-4 py-2 text-left">Notes</th>
                </tr>
              </thead>
              <tbody className="text-foreground">
                {(dye.maintenanceLogs ?? []).map((m) => (
                  <tr key={m.id} className="border-t border-ds-line/50">
                    <td className="px-4 py-2">{m.performedAt.slice(0, 16).replace('T', ' ')}</td>
                    <td className="px-4 py-2">{m.actionType}</td>
                    <td className="px-4 py-2 text-ds-ink-muted">{m.conditionBefore ?? '—'}</td>
                    <td className="px-4 py-2 text-ds-ink-muted">{m.conditionAfter ?? '—'}</td>
                    <td className="px-4 py-2 text-ds-ink-muted">{m.cost != null ? `₹${m.cost}` : '—'}</td>
                    <td className="px-4 py-2 text-ds-ink-muted">{m.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(!dye.maintenanceLogs || dye.maintenanceLogs.length === 0) && <p className="text-ds-ink-muted text-sm mt-2">No maintenance logged yet.</p>}

          {showMaintenance && (
            <div className="fixed inset-0 bg-background/60 flex items-center justify-center z-50 p-4">
              <form onSubmit={handleAddMaintenance} className="bg-ds-card border border-ds-line/50 rounded-lg p-4 max-w-md w-full space-y-3">
                <h3 className="text-foreground font-medium">Log maintenance</h3>
                <div>
                  <label className="block text-ds-ink-muted text-sm mb-1">Action type *</label>
                  <input type="text" value={maintForm.actionType} onChange={(e) => setMaintForm((g) => ({ ...g, actionType: e.target.value }))} className={cls} placeholder="e.g. Sharpen, Inspect, Repair" />
                </div>
                <div>
                  <label className="block text-ds-ink-muted text-sm mb-1">Performed at</label>
                  <input type="datetime-local" value={maintForm.performedAt} onChange={(e) => setMaintForm((g) => ({ ...g, performedAt: e.target.value }))} className={cls} />
                </div>
                <div>
                  <label className="block text-ds-ink-muted text-sm mb-1">Condition before</label>
                  <input type="text" value={maintForm.conditionBefore} onChange={(e) => setMaintForm((g) => ({ ...g, conditionBefore: e.target.value }))} className={cls} />
                </div>
                <div>
                  <label className="block text-ds-ink-muted text-sm mb-1">Condition after</label>
                  <input type="text" value={maintForm.conditionAfter} onChange={(e) => setMaintForm((g) => ({ ...g, conditionAfter: e.target.value }))} className={cls} />
                </div>
                <div>
                  <label className="block text-ds-ink-muted text-sm mb-1">Cost (Rs)</label>
                  <input type="number" step="0.01" value={maintForm.cost} onChange={(e) => setMaintForm((g) => ({ ...g, cost: e.target.value }))} className={cls} />
                </div>
                <div>
                  <label className="block text-ds-ink-muted text-sm mb-1">Notes</label>
                  <input type="text" value={maintForm.notes} onChange={(e) => setMaintForm((g) => ({ ...g, notes: e.target.value }))} className={cls} />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button type="button" onClick={() => setShowMaintenance(false)} className="px-3 py-1.5 rounded-lg border border-ds-line/60 text-ds-ink text-sm">Cancel</button>
                  <button type="submit" disabled={saving} className="px-4 py-1.5 rounded-lg bg-ds-warning hover:bg-ds-warning text-primary-foreground text-sm">{saving ? 'Saving...' : 'Add'}</button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
