'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { HubToolType } from '@/lib/hub-types'
import { HubCategoryNav } from '@/components/hub/HubCategoryNav'
import { custodyBadgeClass, custodyLabel } from '@/lib/inventory-hub-custody'
import { safeJsonParse, safeJsonParseArray, safeJsonStringify } from '@/lib/safe-json'

type MachineOpt = { id: string; machineCode: string; name: string }
type UserOpt = { id: string; name: string }

type DieRow = {
  id: string
  dyeNumber: number
  cartonName: string | null
  cartonSize: string
  ups: number
  location: string | null
  knifeHeightMm: number | null
  impressionCount: number
  custodyStatus: string
}

type EmbossRow = {
  id: string
  blockCode: string
  blockType: string
  blockMaterial: string
  cartonName: string | null
  storageLocation: string | null
  impressionCount: number
  custodyStatus: string
}

type ShadeRow = {
  id: string
  shadeCode: string
  productMaster: string | null
  masterArtworkRef: string | null
  approvalDate: string | null
  inkComponent: string | null
  currentHolder: string | null
  impressionCount: number
  custodyStatus: string
}

const RECEIVE_CONDITIONS = ['Good', 'Damaged', 'Needs Repair'] as const

export default function HubInventoryShell({ toolType }: { toolType: Exclude<HubToolType, 'plates'> }) {
  const [loading, setLoading] = useState(true)
  const [dies, setDies] = useState<DieRow[]>([])
  const [emboss, setEmboss] = useState<EmbossRow[]>([])
  const [shades, setShades] = useState<ShadeRow[]>([])
  const [machines, setMachines] = useState<MachineOpt[]>([])
  const [users, setUsers] = useState<UserOpt[]>([])

  const [search, setSearch] = useState('')

  const [issueOpen, setIssueOpen] = useState(false)
  const [issueToolId, setIssueToolId] = useState<string | null>(null)
  const [machineId, setMachineId] = useState('')
  const [operatorId, setOperatorId] = useState('')

  const [receiveOpen, setReceiveOpen] = useState(false)
  const [receiveToolId, setReceiveToolId] = useState<string | null>(null)
  const [finalImpressions, setFinalImpressions] = useState<number | ''>('')
  const [receiveCondition, setReceiveCondition] = useState<(typeof RECEIVE_CONDITIONS)[number]>('Good')

  const [vendorOpen, setVendorOpen] = useState(false)
  const [vendorToolId, setVendorToolId] = useState<string | null>(null)
  const [vendorNotes, setVendorNotes] = useState('')
  const [vendorCondition, setVendorCondition] = useState<(typeof RECEIVE_CONDITIONS)[number]>('Good')

  const [shadeForm, setShadeForm] = useState({
    manualCode: '',
    autoGen: true,
    productMaster: '',
    masterArtworkRef: '',
    approvalDate: '',
    inkComponent: '',
    currentHolder: '',
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [mRes, uRes] = await Promise.all([fetch('/api/machines'), fetch('/api/users')])
      const mText = await mRes.text()
      const uText = await uRes.text()
      setMachines(safeJsonParseArray<MachineOpt>(mText, []))
      setUsers(safeJsonParseArray<UserOpt>(uText, []))

      if (toolType === 'dies') {
        const r = await fetch('/api/inventory-hub/dies')
        const t = await r.text()
        setDies(safeJsonParseArray<DieRow>(t, []))
        if (!r.ok) {
          const err = safeJsonParse<{ error?: string }>(t, {})
          toast.error(err.error ?? `Could not load dies (${r.status})`)
        }
      } else if (toolType === 'blocks') {
        const r = await fetch('/api/inventory-hub/emboss-blocks')
        const t = await r.text()
        setEmboss(safeJsonParseArray<EmbossRow>(t, []))
        if (!r.ok) {
          const err = safeJsonParse<{ error?: string }>(t, {})
          toast.error(err.error ?? `Could not load emboss blocks (${r.status})`)
        }
      } else {
        const r = await fetch('/api/inventory-hub/shade-cards')
        const t = await r.text()
        setShades(safeJsonParseArray<ShadeRow>(t, []))
        if (!r.ok) {
          const err = safeJsonParse<{ error?: string }>(t, {})
          toast.error(err.error ?? `Could not load shade cards (${r.status})`)
        }
      }
    } catch (e) {
      console.error(e)
      toast.error('Failed to load inventory hub')
    } finally {
      setLoading(false)
    }
  }, [toolType])

  useEffect(() => {
    void load()
  }, [load])

  const title = useMemo(() => {
    if (toolType === 'dies') return 'Die inventory'
    if (toolType === 'blocks') return 'Emboss block inventory'
    return 'Shade card inventory'
  }, [toolType])

  const filteredDies = useMemo(() => {
    const list = Array.isArray(dies) ? dies : []
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (d) =>
        String(d?.dyeNumber ?? '').includes(q) ||
        (d?.cartonName?.toLowerCase().includes(q) ?? false) ||
        (d?.cartonSize ?? '').toLowerCase().includes(q),
    )
  }, [dies, search])

  const filteredEmboss = useMemo(() => {
    const list = Array.isArray(emboss) ? emboss : []
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (b) =>
        (b?.blockCode ?? '').toLowerCase().includes(q) ||
        (b?.cartonName?.toLowerCase().includes(q) ?? false) ||
        (b?.blockType ?? '').toLowerCase().includes(q),
    )
  }, [emboss, search])

  const filteredShades = useMemo(() => {
    const list = Array.isArray(shades) ? shades : []
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (s) =>
        (s?.shadeCode ?? '').toLowerCase().includes(q) ||
        (s?.productMaster?.toLowerCase().includes(q) ?? false) ||
        (s?.masterArtworkRef?.toLowerCase().includes(q) ?? false),
    )
  }, [shades, search])

  function openIssue(id: string) {
    setIssueToolId(id)
    setMachineId('')
    setOperatorId('')
    setIssueOpen(true)
  }

  function openReceive(id: string) {
    setReceiveToolId(id)
    setFinalImpressions('')
    setReceiveCondition('Good')
    setReceiveOpen(true)
  }

  function openVendorReceive(id: string) {
    setVendorToolId(id)
    setVendorNotes('')
    setVendorCondition('Good')
    setVendorOpen(true)
  }

  async function submitIssue() {
    if (!issueToolId) {
      toast.error('Missing tool')
      return
    }
    if (!machineId.trim()) {
      toast.error('Machine ID is required')
      return
    }
    if (!operatorId.trim()) {
      toast.error('Operator is required')
      return
    }
    const path =
      toolType === 'dies'
        ? `/api/inventory-hub/dies/${issueToolId}/issue`
        : toolType === 'blocks'
          ? `/api/inventory-hub/emboss-blocks/${issueToolId}/issue`
          : `/api/inventory-hub/shade-cards/${issueToolId}/issue`
    try {
      const body = safeJsonStringify({ machineId, operatorUserId: operatorId })
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const text = await r.text()
      const j = safeJsonParse<{ error?: string; duplicate?: boolean }>(text, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Issue failed')
        return
      }
      if (j.duplicate) toast.message('Duplicate issue ignored')
      else toast.success('Issued to machine')
      setIssueOpen(false)
      await load()
    } catch (e) {
      console.error(e)
      toast.error('Issue failed')
    }
  }

  async function submitReceive() {
    if (!receiveToolId) {
      toast.error('Missing tool')
      return
    }
    if (finalImpressions === '' || Number.isNaN(Number(finalImpressions)) || Number(finalImpressions) < 0) {
      toast.error('Enter final impressions (non-negative number)')
      return
    }
    const path =
      toolType === 'dies'
        ? `/api/inventory-hub/dies/${receiveToolId}/receive`
        : toolType === 'blocks'
          ? `/api/inventory-hub/emboss-blocks/${receiveToolId}/receive`
          : `/api/inventory-hub/shade-cards/${receiveToolId}/receive`
    try {
      const body = safeJsonStringify({
        finalImpressions: Number(finalImpressions),
        condition: receiveCondition,
      })
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const text = await r.text()
      const j = safeJsonParse<{ error?: string; duplicate?: boolean }>(text, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Receive failed')
        return
      }
      if (j.duplicate) toast.message('Duplicate receive ignored')
      else toast.success('Received to rack')
      setReceiveOpen(false)
      await load()
    } catch (e) {
      console.error(e)
      toast.error('Receive failed')
    }
  }

  async function submitVendorReceive() {
    if (!vendorToolId) {
      toast.error('Missing tool')
      return
    }
    const path =
      toolType === 'dies'
        ? `/api/inventory-hub/dies/${vendorToolId}/receive-from-vendor`
        : toolType === 'blocks'
          ? `/api/inventory-hub/emboss-blocks/${vendorToolId}/receive-from-vendor`
          : `/api/inventory-hub/shade-cards/${vendorToolId}/receive-from-vendor`
    try {
      const body = safeJsonStringify({
        notes: vendorNotes.trim() || null,
        ...(toolType === 'shade_cards' ? {} : { condition: vendorCondition }),
      })
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const text = await r.text()
      const j = safeJsonParse<{ error?: string; duplicate?: boolean }>(text, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Receive from vendor failed')
        return
      }
      if (j.duplicate) toast.message('Duplicate action ignored')
      else toast.success('Received from vendor — now in stock')
      setVendorOpen(false)
      await load()
    } catch (e) {
      console.error(e)
      toast.error('Receive from vendor failed')
    }
  }

  async function createShade(e: React.FormEvent) {
    e.preventDefault()
    try {
      const r = await fetch('/api/inventory-hub/shade-cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          autoGenerateCode: shadeForm.autoGen,
          shadeCode: shadeForm.autoGen ? undefined : shadeForm.manualCode.trim(),
          productMaster: shadeForm.productMaster || null,
          masterArtworkRef: shadeForm.masterArtworkRef || null,
          approvalDate: shadeForm.approvalDate || null,
          inkComponent: shadeForm.inkComponent || null,
          currentHolder: shadeForm.currentHolder || null,
        }),
      })
      const text = await r.text()
      const j = safeJsonParse<{ error?: string; shadeCode?: string }>(text, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Create failed')
        return
      }
      toast.success(`Shade card ${j.shadeCode ?? ''} created`)
      setShadeForm({
        manualCode: '',
        autoGen: true,
        productMaster: '',
        masterArtworkRef: '',
        approvalDate: '',
        inkComponent: '',
        currentHolder: '',
      })
      await load()
    } catch (err) {
      console.error(err)
      toast.error('Create failed')
    }
  }

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-4">
      <HubCategoryNav active={toolType} />

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-xl font-bold text-amber-400">{title}</h1>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm max-w-md"
        />
      </div>

      <p className="text-sm text-slate-400">
        Issue and Receive (floor) update custody in one transaction. Receive from vendor moves tools from At Vendor (yellow)
        back to In Stock (green). Status: In Stock, On Floor, At Vendor.
      </p>

      {toolType === 'shade_cards' && (
        <form
          onSubmit={createShade}
          className="rounded-lg border border-slate-700 bg-slate-900/50 p-4 grid md:grid-cols-3 lg:grid-cols-4 gap-2 text-xs"
        >
          <label className="flex items-center gap-2 md:col-span-2">
            <input
              type="checkbox"
              checked={shadeForm.autoGen}
              onChange={(e) => setShadeForm((s) => ({ ...s, autoGen: e.target.checked }))}
            />
            Auto-generate shade code
          </label>
          {!shadeForm.autoGen && (
            <input
              value={shadeForm.manualCode}
              onChange={(e) => setShadeForm((s) => ({ ...s, manualCode: e.target.value }))}
              placeholder="Manual SC number"
              className="px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
            />
          )}
          <input
            value={shadeForm.productMaster}
            onChange={(e) => setShadeForm((s) => ({ ...s, productMaster: e.target.value }))}
            placeholder="Product master"
            className="px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
          />
          <input
            value={shadeForm.masterArtworkRef}
            onChange={(e) => setShadeForm((s) => ({ ...s, masterArtworkRef: e.target.value }))}
            placeholder="Master ref artwork"
            className="px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
          />
          <input
            type="date"
            value={shadeForm.approvalDate}
            onChange={(e) => setShadeForm((s) => ({ ...s, approvalDate: e.target.value }))}
            className="px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
          />
          <input
            value={shadeForm.inkComponent}
            onChange={(e) => setShadeForm((s) => ({ ...s, inkComponent: e.target.value }))}
            placeholder="Ink component"
            className="px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
          />
          <input
            value={shadeForm.currentHolder}
            onChange={(e) => setShadeForm((s) => ({ ...s, currentHolder: e.target.value }))}
            placeholder="Current holder (optional)"
            className="px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
          />
          <button type="submit" className="px-3 py-2 rounded bg-amber-600 text-white font-medium">
            Add shade card
          </button>
        </form>
      )}

      {loading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : toolType === 'dies' ? (
        <div className="rounded-lg border border-slate-700 overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-slate-800 text-slate-300">
              <tr>
                <th className="px-2 py-2">ID</th>
                <th className="px-2 py-2">Carton</th>
                <th className="px-2 py-2">L × W × H</th>
                <th className="px-2 py-2">Ups</th>
                <th className="px-2 py-2">Knife H (mm)</th>
                <th className="px-2 py-2">Rack</th>
                <th className="px-2 py-2">Impressions</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredDies.map((d) => (
                <tr key={d.id} className="border-t border-slate-800">
                  <td className="px-2 py-2 font-mono text-amber-300">{d.dyeNumber}</td>
                  <td className="px-2 py-2">{d.cartonName ?? '—'}</td>
                  <td className="px-2 py-2">{d.cartonSize ?? '—'}</td>
                  <td className="px-2 py-2">{d.ups ?? '—'}</td>
                  <td className="px-2 py-2">{d.knifeHeightMm ?? '—'}</td>
                  <td className="px-2 py-2">{d.location ?? '—'}</td>
                  <td className="px-2 py-2">{(d.impressionCount ?? 0).toLocaleString()}</td>
                  <td className="px-2 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded border text-[10px] ${custodyBadgeClass(d.custodyStatus ?? '')}`}
                    >
                      {custodyLabel(d.custodyStatus ?? '')}
                    </span>
                  </td>
                  <td className="px-2 py-2 space-x-1 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => openIssue(d.id)}
                      disabled={(d.custodyStatus ?? '') !== 'in_stock'}
                      className="text-blue-400 hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Issue
                    </button>
                    <button
                      type="button"
                      onClick={() => openReceive(d.id)}
                      disabled={(d.custodyStatus ?? '') !== 'on_floor'}
                      className="text-emerald-400 hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Receive
                    </button>
                    <button
                      type="button"
                      onClick={() => openVendorReceive(d.id)}
                      disabled={(d.custodyStatus ?? '') !== 'at_vendor'}
                      className="text-amber-300 hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      From vendor
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : toolType === 'blocks' ? (
        <div className="rounded-lg border border-slate-700 overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-slate-800 text-slate-300">
              <tr>
                <th className="px-2 py-2">ID</th>
                <th className="px-2 py-2">Type</th>
                <th className="px-2 py-2">Material</th>
                <th className="px-2 py-2">Rack</th>
                <th className="px-2 py-2">Impressions</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredEmboss.map((b) => (
                <tr key={b.id} className="border-t border-slate-800">
                  <td className="px-2 py-2 font-mono text-amber-300">{b.blockCode ?? '—'}</td>
                  <td className="px-2 py-2">{b.blockType ?? '—'}</td>
                  <td className="px-2 py-2">{b.blockMaterial ?? '—'}</td>
                  <td className="px-2 py-2">{b.storageLocation ?? '—'}</td>
                  <td className="px-2 py-2">{(b.impressionCount ?? 0).toLocaleString()}</td>
                  <td className="px-2 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded border text-[10px] ${custodyBadgeClass(b.custodyStatus ?? '')}`}
                    >
                      {custodyLabel(b.custodyStatus ?? '')}
                    </span>
                  </td>
                  <td className="px-2 py-2 space-x-1 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => openIssue(b.id)}
                      disabled={(b.custodyStatus ?? '') !== 'in_stock'}
                      className="text-blue-400 hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Issue
                    </button>
                    <button
                      type="button"
                      onClick={() => openReceive(b.id)}
                      disabled={(b.custodyStatus ?? '') !== 'on_floor'}
                      className="text-emerald-400 hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Receive
                    </button>
                    <button
                      type="button"
                      onClick={() => openVendorReceive(b.id)}
                      disabled={(b.custodyStatus ?? '') !== 'at_vendor'}
                      className="text-amber-300 hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      From vendor
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-700 overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-slate-800 text-slate-300">
              <tr>
                <th className="px-2 py-2">ID</th>
                <th className="px-2 py-2">Product master</th>
                <th className="px-2 py-2">Master artwork</th>
                <th className="px-2 py-2">Approval</th>
                <th className="px-2 py-2">Ink</th>
                <th className="px-2 py-2">Holder</th>
                <th className="px-2 py-2">Impressions</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredShades.map((s) => (
                <tr key={s.id} className="border-t border-slate-800">
                  <td className="px-2 py-2 font-mono text-amber-300">{s.shadeCode ?? '—'}</td>
                  <td className="px-2 py-2">{s.productMaster ?? '—'}</td>
                  <td className="px-2 py-2">{s.masterArtworkRef ?? '—'}</td>
                  <td className="px-2 py-2">{s.approvalDate ?? '—'}</td>
                  <td className="px-2 py-2">{s.inkComponent ?? '—'}</td>
                  <td className="px-2 py-2">{s.currentHolder ?? '—'}</td>
                  <td className="px-2 py-2">{(s.impressionCount ?? 0).toLocaleString()}</td>
                  <td className="px-2 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded border text-[10px] ${custodyBadgeClass(s.custodyStatus ?? '')}`}
                    >
                      {custodyLabel(s.custodyStatus ?? '')}
                    </span>
                  </td>
                  <td className="px-2 py-2 space-x-1 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => openIssue(s.id)}
                      disabled={(s.custodyStatus ?? '') !== 'in_stock'}
                      className="text-blue-400 hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Issue
                    </button>
                    <button
                      type="button"
                      onClick={() => openReceive(s.id)}
                      disabled={(s.custodyStatus ?? '') !== 'on_floor'}
                      className="text-emerald-400 hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Receive
                    </button>
                    <button
                      type="button"
                      onClick={() => openVendorReceive(s.id)}
                      disabled={(s.custodyStatus ?? '') !== 'at_vendor'}
                      className="text-amber-300 hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      From vendor
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {issueOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border border-slate-600 bg-slate-900 p-4 space-y-3 text-sm">
            <h2 className="text-lg font-semibold text-white">Issue to machine</h2>
            <label className="block text-slate-300">
              Machine
              <select
                value={machineId}
                onChange={(e) => setMachineId(e.target.value)}
                className="mt-1 w-full px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="">Select machine</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.machineCode} — {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-slate-300">
              Operator
              <select
                value={operatorId}
                onChange={(e) => setOperatorId(e.target.value)}
                className="mt-1 w-full px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="">Select operator</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setIssueOpen(false)} className="px-3 py-1.5 rounded border border-slate-600 text-slate-200">
                Cancel
              </button>
              <button type="button" onClick={() => void submitIssue()} className="px-3 py-1.5 rounded bg-blue-600 text-white">
                Issue to machine
              </button>
            </div>
          </div>
        </div>
      )}

      {vendorOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border border-amber-700/50 bg-slate-900 p-4 space-y-3 text-sm">
            <h2 className="text-lg font-semibold text-white">Receive from vendor</h2>
            <p className="text-slate-400 text-xs">Confirms the tool is back from the vendor and returns it to <span className="text-emerald-300">In Stock</span>.</p>
            <label className="block text-slate-300">
              Notes (optional)
              <textarea
                value={vendorNotes}
                onChange={(e) => setVendorNotes(e.target.value)}
                rows={3}
                placeholder="PO ref, triage notes…"
                className="mt-1 w-full px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white resize-y"
              />
            </label>
            {toolType !== 'shade_cards' && (
              <label className="block text-slate-300">
                Condition
                <select
                  value={vendorCondition}
                  onChange={(e) => setVendorCondition(e.target.value as (typeof RECEIVE_CONDITIONS)[number])}
                  className="mt-1 w-full px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white"
                >
                  {RECEIVE_CONDITIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setVendorOpen(false)} className="px-3 py-1.5 rounded border border-slate-600 text-slate-200">
                Cancel
              </button>
              <button type="button" onClick={() => void submitVendorReceive()} className="px-3 py-1.5 rounded bg-amber-600 text-white">
                Receive to stock
              </button>
            </div>
          </div>
        </div>
      )}

      {receiveOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border border-slate-600 bg-slate-900 p-4 space-y-3 text-sm">
            <h2 className="text-lg font-semibold text-white">Receive to rack</h2>
            <label className="block text-slate-300">
              Final impressions (added to total)
              <input
                type="number"
                min={0}
                value={finalImpressions}
                onChange={(e) => setFinalImpressions(e.target.value === '' ? '' : Number(e.target.value))}
                className="mt-1 w-full px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </label>
            <label className="block text-slate-300">
              Condition
              <select
                value={receiveCondition}
                onChange={(e) => setReceiveCondition(e.target.value as (typeof RECEIVE_CONDITIONS)[number])}
                className="mt-1 w-full px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                {RECEIVE_CONDITIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setReceiveOpen(false)} className="px-3 py-1.5 rounded border border-slate-600 text-slate-200">
                Cancel
              </button>
              <button type="button" onClick={() => void submitReceive()} className="px-3 py-1.5 rounded bg-emerald-600 text-white">
                Receive
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
