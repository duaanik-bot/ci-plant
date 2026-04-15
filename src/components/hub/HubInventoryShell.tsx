'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { HubToolType } from '@/lib/hub-types'
import { HubCategoryNav } from '@/components/hub/HubCategoryNav'
import { custodyBadgeClass, custodyLabel } from '@/lib/inventory-hub-custody'
import { safeJsonParse, safeJsonParseArray, safeJsonStringify } from '@/lib/safe-json'
import { TableExportMenu } from '@/components/hub/TableExportMenu'
import {
  inventoryDieExportColumns,
  inventoryDieExcelExtraColumns,
  inventoryEmbossExportColumns,
  inventoryEmbossExcelExtraColumns,
  inventoryShadeExportColumns,
  inventoryShadeExcelExtraColumns,
} from '@/lib/hub-ledger-export-columns'

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
  issuedAt?: string | null
  issuedOperator?: string | null
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
  issuedAt?: string | null
  issuedOperator?: string | null
  createdAt?: string | null
}

type ShadeRow = {
  id: string
  shadeCode: string
  productMaster: string | null
  masterArtworkRef: string | null
  remarks: string | null
  currentHolder: string | null
  impressionCount: number
  custodyStatus: string
  cardStatusLabel?: string
  locationLabel?: string
  entryDate?: string
  createdAt?: string
}

type CartonHit = {
  id: string
  cartonName: string
  customer: { name: string }
  artworkCode: string | null
}

type ShadeAuditPayload = {
  shadeCard: { id: string; shadeCode: string; productMaster: string | null }
  events: Array<{ id: string; actionType: string; details: unknown; createdAt: string }>
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

  const [addShadeOpen, setAddShadeOpen] = useState(false)
  const [addProductLabel, setAddProductLabel] = useState('')
  const [addAwCode, setAddAwCode] = useState('')
  const [addQuantity, setAddQuantity] = useState(1)
  const [addRemarks, setAddRemarks] = useState('')
  const [cartonQuery, setCartonQuery] = useState('')
  const [cartonHits, setCartonHits] = useState<CartonHit[]>([])
  const [cartonSearchLoading, setCartonSearchLoading] = useState(false)

  const [auditOpen, setAuditOpen] = useState(false)
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditPayload, setAuditPayload] = useState<ShadeAuditPayload | null>(null)

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

  useEffect(() => {
    if (!addShadeOpen) {
      setCartonHits([])
      setCartonQuery('')
      return
    }
    const q = cartonQuery.trim()
    if (q.length < 2) {
      setCartonHits([])
      return
    }
    const t = setTimeout(() => {
      void (async () => {
        setCartonSearchLoading(true)
        try {
          const r = await fetch(`/api/cartons?q=${encodeURIComponent(q)}`)
          const text = await r.text()
          const list = safeJsonParseArray<CartonHit>(text, [])
          setCartonHits(Array.isArray(list) ? list.slice(0, 12) : [])
        } catch {
          setCartonHits([])
        } finally {
          setCartonSearchLoading(false)
        }
      })()
    }, 280)
    return () => clearTimeout(t)
  }, [cartonQuery, addShadeOpen])

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
        (s?.masterArtworkRef?.toLowerCase().includes(q) ?? false) ||
        (s?.remarks?.toLowerCase().includes(q) ?? false) ||
        (s?.locationLabel?.toLowerCase().includes(q) ?? false),
    )
  }, [shades, search])

  const inventoryExportFilterSummary = useMemo(() => {
    if (!search.trim()) return []
    return [`Search: "${search.trim()}"`]
  }, [search])

  const dieExportColumns = useMemo(() => inventoryDieExportColumns(), [])
  const dieExcelExtraColumns = useMemo(() => inventoryDieExcelExtraColumns(), [])
  const embossExportColumns = useMemo(() => inventoryEmbossExportColumns(), [])
  const embossExcelExtraColumns = useMemo(() => inventoryEmbossExcelExtraColumns(), [])
  const shadeExportColumns = useMemo(() => inventoryShadeExportColumns(), [])
  const shadeExcelExtraColumns = useMemo(() => inventoryShadeExcelExtraColumns(), [])

  function openIssue(id: string) {
    setIssueToolId(id)
    setMachineId('')
    setOperatorId('')
    setIssueOpen(true)
  }

  function openReceive(id: string) {
    setReceiveToolId(id)
    setFinalImpressions(toolType === 'shade_cards' ? 0 : '')
    setReceiveCondition('Good')
    setReceiveOpen(true)
  }

  function openAddShadeModal() {
    setAddProductLabel('')
    setAddAwCode('')
    setAddQuantity(1)
    setAddRemarks('')
    setCartonQuery('')
    setCartonHits([])
    setAddShadeOpen(true)
  }

  async function openShadeAudit(id: string) {
    setAuditOpen(true)
    setAuditLoading(true)
    setAuditPayload(null)
    try {
      const r = await fetch(`/api/inventory-hub/shade-cards/${id}/events`)
      const text = await r.text()
      const j = safeJsonParse<ShadeAuditPayload & { error?: string }>(text, {} as ShadeAuditPayload)
      if (!r.ok) {
        toast.error((j as { error?: string }).error ?? 'Could not load history')
        setAuditOpen(false)
        return
      }
      setAuditPayload(j)
    } catch (e) {
      console.error(e)
      toast.error('Could not load history')
      setAuditOpen(false)
    } finally {
      setAuditLoading(false)
    }
  }

  function shadeEventSummary(ev: { actionType: string; details: unknown }): string {
    const d = ev.details && typeof ev.details === 'object' ? (ev.details as Record<string, unknown>) : {}
    switch (ev.actionType) {
      case 'CREATED':
        return 'Recorded in ledger'
      case 'ISSUED': {
        const op = typeof d.operatorName === 'string' ? d.operatorName : '—'
        const mc = typeof d.machineCode === 'string' ? d.machineCode : '—'
        const mn = typeof d.machineName === 'string' ? d.machineName : ''
        return `Issued to ${op} · machine ${mc}${mn ? ` (${mn})` : ''}`
      }
      case 'RECEIVED': {
        const imp = typeof d.finalImpressions === 'number' ? d.finalImpressions : 0
        const cond = typeof d.condition === 'string' ? d.condition : '—'
        if (imp === 0 && cond === 'Good') return 'Received to rack'
        return `Received to rack · +${imp} impressions · ${cond}`
      }
      case 'VENDOR_RECEIVED': {
        const notes = typeof d.notes === 'string' && d.notes.trim() ? d.notes.trim() : null
        return notes ? `Received from vendor · ${notes}` : 'Received from vendor'
      }
      default:
        return ev.actionType
    }
  }

  async function submitAddShade() {
    const productMaster = addProductLabel.trim()
    const masterArtworkRef = addAwCode.trim()
    if (!productMaster) {
      toast.error('Product name is required')
      return
    }
    if (!masterArtworkRef) {
      toast.error('AW code is required')
      return
    }
    if (addQuantity < 1 || addQuantity > 99) {
      toast.error('Quantity must be between 1 and 99')
      return
    }
    try {
      const r = await fetch('/api/inventory-hub/shade-cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          autoGenerateCode: true,
          productMaster,
          masterArtworkRef,
          quantity: addQuantity,
          remarks: addRemarks.trim() || null,
        }),
      })
      const text = await r.text()
      const j = safeJsonParse<{ error?: string; count?: number; shadeCode?: string }>(text, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Create failed')
        return
      }
      toast.success(
        (j.count ?? 1) > 1 ? `${j.count} shade cards created (${j.shadeCode ?? ''} …)` : `Shade card ${j.shadeCode ?? ''} created`,
      )
      setAddShadeOpen(false)
      await load()
    } catch (err) {
      console.error(err)
      toast.error('Create failed')
    }
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
    if (toolType !== 'shade_cards') {
      if (finalImpressions === '' || Number.isNaN(Number(finalImpressions)) || Number(finalImpressions) < 0) {
        toast.error('Enter final impressions (non-negative number)')
        return
      }
    }
    const path =
      toolType === 'dies'
        ? `/api/inventory-hub/dies/${receiveToolId}/receive`
        : toolType === 'blocks'
          ? `/api/inventory-hub/emboss-blocks/${receiveToolId}/receive`
          : `/api/inventory-hub/shade-cards/${receiveToolId}/receive`
    try {
      const body = safeJsonStringify({
        finalImpressions: toolType === 'shade_cards' ? 0 : Number(finalImpressions),
        condition: toolType === 'shade_cards' ? 'Good' : receiveCondition,
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

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-4">
      <HubCategoryNav active={toolType} />

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-xl font-bold text-amber-400">{title}</h1>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center flex-wrap">
          {toolType === 'shade_cards' && (
            <button
              type="button"
              onClick={() => openAddShadeModal()}
              className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium whitespace-nowrap"
            >
              + Add Shade Card
            </button>
          )}
          {toolType === 'dies' ? (
            <TableExportMenu
              rows={filteredDies}
              columns={dieExportColumns}
              excelOnlyColumns={dieExcelExtraColumns}
              fileBase="die-inventory-ledger"
              reportTitle="Die inventory — Master ledger"
              sheetName="Dies"
              filterSummary={inventoryExportFilterSummary}
              disabled={loading}
              buttonClassName="!border-slate-600 !bg-slate-800 hover:!bg-slate-700 !text-slate-100"
              menuClassName="!border-slate-600 !bg-slate-900 [&_button]:hover:!bg-slate-800"
            />
          ) : toolType === 'blocks' ? (
            <TableExportMenu
              rows={filteredEmboss}
              columns={embossExportColumns}
              excelOnlyColumns={embossExcelExtraColumns}
              fileBase="emboss-inventory-ledger"
              reportTitle="Emboss block inventory — Master ledger"
              sheetName="Emboss blocks"
              filterSummary={inventoryExportFilterSummary}
              disabled={loading}
              buttonClassName="!border-slate-600 !bg-slate-800 hover:!bg-slate-700 !text-slate-100"
              menuClassName="!border-slate-600 !bg-slate-900 [&_button]:hover:!bg-slate-800"
            />
          ) : (
            <TableExportMenu
              rows={filteredShades}
              columns={shadeExportColumns}
              excelOnlyColumns={shadeExcelExtraColumns}
              fileBase="shade-cards-ledger"
              reportTitle="Shade card inventory — Master ledger"
              sheetName="Shade cards"
              filterSummary={inventoryExportFilterSummary}
              disabled={loading}
              buttonClassName="!border-slate-600 !bg-slate-800 hover:!bg-slate-700 !text-slate-100"
              menuClassName="!border-slate-600 !bg-slate-900 [&_button]:hover:!bg-slate-800"
            />
          )}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm max-w-md"
          />
        </div>
      </div>

      <p className="text-sm text-slate-400">
        {toolType === 'shade_cards' ? (
          <>
            Master ledger: one row per physical card. <span className="text-slate-300">Issue</span> and{' '}
            <span className="text-slate-300">Receive</span> move custody between rack and floor. Click the product name for a history of when it was issued and to whom.
          </>
        ) : (
          <>
            Issue and Receive (floor) update custody in one transaction. Receive from vendor moves tools from At Vendor (yellow)
            back to In Stock (green). Status: In Stock, On Floor, At Vendor.
          </>
        )}
      </p>

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
          <table className="w-full text-[11px] text-left leading-tight">
            <thead className="bg-slate-800 text-slate-300">
              <tr>
                <th className="px-1.5 py-1.5 whitespace-nowrap">Entry date</th>
                <th className="px-1.5 py-1.5 min-w-[9rem]">Client / product</th>
                <th className="px-1.5 py-1.5 whitespace-nowrap">AW code</th>
                <th className="px-1.5 py-1.5 whitespace-nowrap">Card status</th>
                <th className="px-1.5 py-1.5 min-w-[7rem]">Current location</th>
                <th className="px-1.5 py-1.5 min-w-[6rem]">Remarks</th>
                <th className="px-1.5 py-1.5 whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredShades.map((s) => {
                const status = s.custodyStatus ?? ''
                const label =
                  s.cardStatusLabel ??
                  (status === 'in_stock' ? 'In-Stock' : status === 'on_floor' ? 'Issued' : custodyLabel(status))
                const loc = s.locationLabel ?? (status === 'in_stock' ? 'Rack' : status === 'at_vendor' ? 'Vendor' : s.currentHolder ?? '—')
                const entry = s.entryDate ?? (s.createdAt ? s.createdAt.slice(0, 10) : '—')
                return (
                  <tr key={s.id} className="border-t border-slate-800">
                    <td className="px-1.5 py-1 text-slate-400 whitespace-nowrap">{entry}</td>
                    <td className="px-1.5 py-1">
                      <button
                        type="button"
                        onClick={() => void openShadeAudit(s.id)}
                        className="text-left text-sky-300 hover:text-sky-200 hover:underline block w-full"
                      >
                        <span className="block">{s.productMaster?.trim() || '—'}</span>
                        {s.shadeCode ? (
                          <span className="block text-[10px] font-mono text-amber-300/80 font-normal">{s.shadeCode}</span>
                        ) : null}
                      </button>
                    </td>
                    <td className="px-1.5 py-1 font-mono text-slate-200">{s.masterArtworkRef ?? '—'}</td>
                    <td className="px-1.5 py-1">
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded border text-[10px] ${custodyBadgeClass(status)}`}
                      >
                        {label}
                      </span>
                    </td>
                    <td className="px-1.5 py-1 text-slate-300">{loc}</td>
                    <td className="px-1.5 py-1 text-slate-400 max-w-[10rem] truncate" title={s.remarks ?? ''}>
                      {s.remarks?.trim() || '—'}
                    </td>
                    <td className="px-1.5 py-1 space-x-1 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => openIssue(s.id)}
                        disabled={status !== 'in_stock'}
                        className="text-blue-400 hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Issue
                      </button>
                      <button
                        type="button"
                        onClick={() => openReceive(s.id)}
                        disabled={status !== 'on_floor'}
                        className="text-emerald-400 hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Receive
                      </button>
                    </td>
                  </tr>
                )
              })}
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
            {toolType !== 'shade_cards' && (
              <>
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
              </>
            )}
            {toolType === 'shade_cards' && (
              <p className="text-slate-400 text-xs">Confirms the shade card is back in rack stock (no extra fields required).</p>
            )}
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

      {addShadeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-lg rounded-lg border border-slate-600 bg-slate-900 p-4 space-y-3 text-sm max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-white">Add shade card</h2>
            <p className="text-xs text-slate-500">Codes are auto-generated (SC-####). Add one row per physical card or set quantity for a batch.</p>
            <label className="block text-slate-300">
              Product name (search cartons)
              <input
                value={cartonQuery}
                onChange={(e) => setCartonQuery(e.target.value)}
                placeholder="Type at least 2 characters…"
                className="mt-1 w-full px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </label>
            {cartonSearchLoading && <p className="text-xs text-slate-500">Searching…</p>}
            {cartonHits.length > 0 && (
              <ul className="max-h-36 overflow-y-auto rounded border border-slate-700 divide-y divide-slate-800 text-xs">
                {cartonHits.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="w-full text-left px-2 py-1.5 hover:bg-slate-800 text-slate-200"
                      onClick={() => {
                        setAddProductLabel(`${c.customer.name} / ${c.cartonName}`)
                        setAddAwCode((prev) => (prev.trim() ? prev : (c.artworkCode?.trim() ?? '')))
                      }}
                    >
                      <span className="text-slate-400">{c.customer.name}</span> · {c.cartonName}
                      {c.artworkCode ? <span className="ml-1 font-mono text-amber-200/80">({c.artworkCode})</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label className="block text-slate-300">
              Client / product name
              <input
                value={addProductLabel}
                onChange={(e) => setAddProductLabel(e.target.value)}
                placeholder="e.g. Acme Pharma / Carton SKU"
                className="mt-1 w-full px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </label>
            <label className="block text-slate-300">
              AW code
              <input
                value={addAwCode}
                onChange={(e) => setAddAwCode(e.target.value)}
                placeholder="Artwork / AW reference"
                className="mt-1 w-full px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white font-mono"
              />
            </label>
            <label className="block text-slate-300">
              Quantity
              <input
                type="number"
                min={1}
                max={99}
                value={addQuantity}
                onChange={(e) => setAddQuantity(Math.min(99, Math.max(1, Number(e.target.value) || 1)))}
                className="mt-1 w-full px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </label>
            <label className="block text-slate-300">
              Remarks
              <textarea
                value={addRemarks}
                onChange={(e) => setAddRemarks(e.target.value)}
                rows={2}
                placeholder="Optional"
                className="mt-1 w-full px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white resize-y"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setAddShadeOpen(false)} className="px-3 py-1.5 rounded border border-slate-600 text-slate-200">
                Cancel
              </button>
              <button type="button" onClick={() => void submitAddShade()} className="px-3 py-1.5 rounded bg-amber-600 text-white">
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {auditOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border border-slate-600 bg-slate-900 p-4 space-y-3 text-sm max-h-[85vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-white">Shade card history</h2>
            {auditLoading && <p className="text-slate-400 text-xs">Loading…</p>}
            {!auditLoading && auditPayload && (
              <>
                <p className="text-xs text-slate-400">
                  <span className="font-mono text-amber-300">{auditPayload.shadeCard.shadeCode}</span>
                  {auditPayload.shadeCard.productMaster ? ` · ${auditPayload.shadeCard.productMaster}` : ''}
                </p>
                {auditPayload.events.length === 0 ? (
                  <p className="text-slate-500 text-xs">No events yet.</p>
                ) : (
                  <ul className="space-y-2 text-xs border-t border-slate-800 pt-2">
                    {auditPayload.events.map((ev) => (
                      <li key={ev.id} className="border-b border-slate-800/80 pb-2">
                        <div className="text-slate-500">{new Date(ev.createdAt).toLocaleString()}</div>
                        <div className="text-slate-200">{shadeEventSummary(ev)}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            <div className="flex justify-end pt-2">
              <button type="button" onClick={() => setAuditOpen(false)} className="px-3 py-1.5 rounded border border-slate-600 text-slate-200">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
