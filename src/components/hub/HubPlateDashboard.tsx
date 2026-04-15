'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { HubCategoryNav } from '@/components/hub/HubCategoryNav'
import { safeJsonParse, safeJsonParseArray, safeJsonStringify } from '@/lib/safe-json'

type TriageRow = {
  id: string
  poLineId?: string | null
  requirementCode: string
  cartonName: string
  artworkCode: string | null
  artworkVersion: string | null
  newPlatesNeeded: number
  status: string
  plateColours: string[]
}

type CtpRow = {
  id: string
  poLineId?: string | null
  requirementCode: string
  jobCardId: string | null
  cartonName: string
  artworkCode: string | null
  artworkVersion: string | null
  plateColours: string[]
  status: string
}

type PlateCard = {
  id: string
  plateSetCode: string
  cartonName: string
  artworkCode: string | null
  artworkVersion: string | null
  artworkId: string | null
  jobCardId: string | null
  slotNumber: string | null
  rackLocation: string | null
  status: string
  issuedTo: string | null
  issuedAt: string | null
  totalImpressions: number
  customer: { id: string; name: string } | null
}

type DashboardPayload = {
  triage: TriageRow[]
  ctpQueue: CtpRow[]
  inventory: PlateCard[]
  custody: PlateCard[]
}

type MachineOpt = { id: string; machineCode: string; name: string }
type UserOpt = { id: string; name: string }
type CustomerOpt = { id: string; name: string }

type PlateLookupColour = { name: string; type?: string }
type PlateLookupOk = {
  found: true
  awCode: string
  cartonName: string | null
  cartonId: string | null
  artworkId: string | null
  artworkVersion: string | null
  setNumber: string | null
  sheetSize: string | null
  colours: PlateLookupColour[]
  customerId: string | null
}

function parseIssuedTo(issuedTo: string | null): { machine: string; operator: string } {
  if (!issuedTo?.trim()) return { machine: '—', operator: '—' }
  const parts = issuedTo.split(/\s*\/\s*/)
  return { machine: parts[0]?.trim() || '—', operator: parts[1]?.trim() || '—' }
}

function safeReadDashboard(text: string): DashboardPayload | null {
  try {
    const v = JSON.parse(text) as unknown
    if (!v || typeof v !== 'object') return null
    const o = v as Record<string, unknown>
    return {
      triage: Array.isArray(o.triage) ? (o.triage as TriageRow[]) : [],
      ctpQueue: Array.isArray(o.ctpQueue) ? (o.ctpQueue as CtpRow[]) : [],
      inventory: Array.isArray(o.inventory) ? (o.inventory as PlateCard[]) : [],
      custody: Array.isArray(o.custody) ? (o.custody as PlateCard[]) : [],
    }
  } catch {
    return null
  }
}

export default function HubPlateDashboard() {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<DashboardPayload>({
    triage: [],
    ctpQueue: [],
    inventory: [],
    custody: [],
  })
  const [machines, setMachines] = useState<MachineOpt[]>([])
  const [users, setUsers] = useState<UserOpt[]>([])
  const [customers, setCustomers] = useState<CustomerOpt[]>([])

  const [addStockOpen, setAddStockOpen] = useState(false)
  const [addAw, setAddAw] = useState('')
  const [addCustomerId, setAddCustomerId] = useState('')
  const [addCartonName, setAddCartonName] = useState('')
  const [addSheetSize, setAddSheetSize] = useState('')
  const [addSetNumber, setAddSetNumber] = useState('')
  const [addArtworkId, setAddArtworkId] = useState('')
  const [addCartonId, setAddCartonId] = useState('')
  const [addColoursJson, setAddColoursJson] = useState<string>('[]')
  const [addLookupError, setAddLookupError] = useState('')
  const [addLookupLoading, setAddLookupLoading] = useState(false)
  const lookupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [scrapOpen, setScrapOpen] = useState(false)
  const [scrapPlateId, setScrapPlateId] = useState('')

  const [issueAwCode, setIssueAwCode] = useState('')
  const [issueLookupError, setIssueLookupError] = useState('')
  const [issueLookupLoading, setIssueLookupLoading] = useState(false)

  const [invSearch, setInvSearch] = useState('')
  const [custSearch, setCustSearch] = useState('')

  const [stockModal, setStockModal] = useState<TriageRow | null>(null)
  const [stockPlateId, setStockPlateId] = useState('')
  const [stockRackSlot, setStockRackSlot] = useState('')

  const [issueModal, setIssueModal] = useState<{
    source: 'ctp' | 'inventory'
    plateId: string
  } | null>(null)
  const [issueMachineId, setIssueMachineId] = useState('')
  const [issueOperatorId, setIssueOperatorId] = useState('')

  const [returnModal, setReturnModal] = useState<PlateCard | null>(null)
  const [returnImpressions, setReturnImpressions] = useState<number | ''>('')
  const [returnCondition, setReturnCondition] = useState<'Good' | 'Damaged' | 'Needs Repair'>('Good')
  const [returnRackSlot, setReturnRackSlot] = useState('')
  const [returnOperatorId, setReturnOperatorId] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [dRes, mRes, uRes, cRes] = await Promise.all([
        fetch('/api/plate-hub/dashboard'),
        fetch('/api/machines'),
        fetch('/api/users'),
        fetch('/api/customers?limit=200'),
      ])
      const dText = await dRes.text()
      const mText = await mRes.text()
      const uText = await uRes.text()
      const cText = await cRes.text()

      const parsed = safeReadDashboard(dText)
      if (!parsed) {
        toast.error('Unexpected dashboard response')
        setData({ triage: [], ctpQueue: [], inventory: [], custody: [] })
      } else {
        setData(parsed)
      }
      if (!dRes.ok) {
        try {
          const err = safeJsonParse<{ error?: string }>(dText, {})
          toast.error(err.error ?? `Dashboard load failed (${dRes.status})`)
        } catch {
          toast.error(`Dashboard load failed (${dRes.status})`)
        }
      }

      setMachines(safeJsonParseArray<MachineOpt>(mText, []))
      setUsers(safeJsonParseArray<UserOpt>(uText, []))
      setCustomers(safeJsonParseArray<CustomerOpt>(cText, []))
    } catch (e) {
      console.error(e)
      toast.error('Failed to load plate hub')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!addStockOpen) return
    const aw = addAw.trim()
    if (!aw || aw.length < 2) {
      setAddLookupError('')
      return
    }
    if (lookupTimerRef.current) clearTimeout(lookupTimerRef.current)
    lookupTimerRef.current = setTimeout(() => {
      void (async () => {
        setAddLookupLoading(true)
        setAddLookupError('')
        try {
          const params = new URLSearchParams({ awCode: aw })
          if (addCustomerId.trim()) params.set('customerId', addCustomerId.trim())
          const r = await fetch(`/api/plate-hub/plate-lookup?${params}`)
          const j = (await r.json()) as { found?: boolean; error?: string } & Partial<PlateLookupOk>
          if (!r.ok || !j.found) {
            setAddLookupError(j.error || 'AW Code not found in Master.')
            return
          }
          const ok = j as PlateLookupOk
          setAddCartonName(ok.cartonName || '')
          setAddSheetSize(ok.sheetSize || '')
          setAddSetNumber(ok.setNumber || '')
          setAddArtworkId(ok.artworkId || '')
          setAddCartonId(ok.cartonId || '')
          setAddColoursJson(
            safeJsonStringify(
              (ok.colours || []).map((c) => ({ name: c.name, type: c.type || 'process' })),
            ),
          )
        } catch {
          setAddLookupError('Lookup failed')
        } finally {
          setAddLookupLoading(false)
        }
      })()
    }, 450)
    return () => {
      if (lookupTimerRef.current) clearTimeout(lookupTimerRef.current)
    }
  }, [addStockOpen, addAw, addCustomerId])

  function resetAddStockForm() {
    setAddAw('')
    setAddCustomerId('')
    setAddCartonName('')
    setAddSheetSize('')
    setAddSetNumber('')
    setAddArtworkId('')
    setAddCartonId('')
    setAddColoursJson('[]')
    setAddLookupError('')
  }

  async function recallPrepress(requirementId: string) {
    setSaving(true)
    try {
      const r = await fetch(`/api/plate-requirements/${requirementId}/recall-prepress`, {
        method: 'POST',
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Recall failed')
        return
      }
      toast.success('Recalled to pre-press')
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function sendBackTriage(requirementId: string) {
    setSaving(true)
    try {
      const r = await fetch(`/api/plate-requirements/${requirementId}/send-back-triage`, {
        method: 'POST',
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Send back failed')
        return
      }
      toast.success('Sent back to triage')
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function submitAddStock() {
    const aw = addAw.trim()
    if (!aw) {
      toast.error('AW code is required')
      return
    }
    if (!addCartonName.trim()) {
      toast.error('Carton name is required')
      return
    }
    const coloursRaw = safeJsonParse<PlateLookupColour[]>(addColoursJson, [])
    if (!coloursRaw.length) {
      toast.error('At least one colour/plate channel is required')
      return
    }
    const colours = coloursRaw.map((c) => ({
      name: String(c.name || '').trim() || 'Plate',
      type: c.type || 'process',
      status: 'new' as const,
    }))
    setSaving(true)
    try {
      const r = await fetch('/api/plate-store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          cartonName: addCartonName.trim(),
          artworkCode: aw,
          customerId: addCustomerId.trim() || null,
          cartonId: addCartonId.trim() || null,
          artworkId: addArtworkId.trim() || null,
          numberOfColours: colours.length,
          colours,
          rackLocation: addSheetSize.trim() || null,
          slotNumber: addSetNumber.trim() || null,
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Save failed')
        return
      }
      toast.success('Saved to rack')
      setAddStockOpen(false)
      resetAddStockForm()
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function submitScrapFromRack() {
    const id = scrapPlateId.trim()
    if (!id) {
      toast.error('Select a plate set')
      return
    }
    setSaving(true)
    try {
      const r = await fetch(`/api/plate-store/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({ status: 'destroyed' }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Remove failed')
        return
      }
      toast.success('Plate set removed / scrapped')
      setScrapOpen(false)
      setScrapPlateId('')
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function lookupIssueAw() {
    const aw = issueAwCode.trim()
    if (!aw) {
      setIssueLookupError('')
      return
    }
    setIssueLookupLoading(true)
    setIssueLookupError('')
    try {
      const r = await fetch(`/api/plate-hub/plate-lookup?${new URLSearchParams({ awCode: aw })}`)
      const j = (await r.json()) as { found?: boolean; error?: string } & Partial<PlateLookupOk>
      if (!r.ok || !j.found) {
        setIssueLookupError(j.error || 'AW Code not found in Master.')
        return
      }
      const ok = j as PlateLookupOk
      const match = data.inventory.find(
        (p) =>
          (p.artworkCode && p.artworkCode.toLowerCase() === aw.toLowerCase()) ||
          (ok.artworkId && p.artworkId === ok.artworkId),
      )
      if (match) {
        setIssueModal((prev) => (prev ? { ...prev, plateId: match.id } : prev))
        toast.message(`Matched rack plate ${match.plateSetCode}`)
      } else {
        setIssueLookupError('No matching plate in live inventory for this AW code.')
      }
    } finally {
      setIssueLookupLoading(false)
    }
  }

  const filteredInventory = useMemo(() => {
    const q = invSearch.trim().toLowerCase()
    const list = data.inventory
    if (!q) return list
    return list.filter(
      (p) =>
        p.plateSetCode.toLowerCase().includes(q) ||
        p.cartonName.toLowerCase().includes(q) ||
        (p.artworkCode?.toLowerCase().includes(q) ?? false),
    )
  }, [data.inventory, invSearch])

  const filteredCustody = useMemo(() => {
    const q = custSearch.trim().toLowerCase()
    const list = data.custody
    if (!q) return list
    return list.filter(
      (p) =>
        p.plateSetCode.toLowerCase().includes(q) ||
        p.cartonName.toLowerCase().includes(q) ||
        (p.issuedTo?.toLowerCase().includes(q) ?? false),
    )
  }, [data.custody, custSearch])

  async function patchTriage(id: string, channel: 'inhouse_ctp' | 'outside_vendor' | 'stock_available', rackSlot?: string) {
    if (!id?.trim()) {
      toast.error('Missing requirement id')
      return
    }
    setSaving(true)
    try {
      const body: Record<string, unknown> = { channel }
      if (channel === 'stock_available' && rackSlot?.trim()) body.rackSlot = rackSlot.trim()
      const r = await fetch(`/api/plate-requirements/${id}/triage`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify(body),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Triage update failed')
        return
      }
      toast.success('Updated')
      setStockModal(null)
      setStockPlateId('')
      setStockRackSlot('')
      await load()
    } catch (e) {
      console.error(e)
      toast.error('Triage update failed')
    } finally {
      setSaving(false)
    }
  }

  function openIssueFromInventory(plateId: string) {
    if (!plateId?.trim()) {
      toast.error('Missing plate id')
      return
    }
    setIssueAwCode('')
    setIssueLookupError('')
    setIssueModal({ source: 'inventory', plateId })
    setIssueMachineId('')
    setIssueOperatorId('')
  }

  function openIssueFromCtp() {
    setIssueAwCode('')
    setIssueLookupError('')
    setIssueModal({ source: 'ctp', plateId: '' })
    setIssueMachineId('')
    setIssueOperatorId('')
  }

  async function submitCustodyIssue() {
    if (!issueModal) return
    const plateId = issueModal.plateId?.trim()
    if (!plateId) {
      toast.error('Select a plate set')
      return
    }
    if (!issueMachineId.trim()) {
      toast.error('Machine is required')
      return
    }
    if (!issueOperatorId.trim()) {
      toast.error('Operator is required')
      return
    }
    const invPlate = data.inventory.find((p) => p.id === plateId)
    if (!invPlate) {
      toast.error('Plate not found in inventory')
      return
    }
    if (!invPlate.artworkId?.trim()) {
      toast.error('Plate set must have artwork linked before issue')
      return
    }
    if (!invPlate.jobCardId?.trim()) {
      toast.error('Plate set must have a job card linked before issue')
      return
    }
    const setNum = (invPlate.slotNumber ?? '').trim() || '01'
    setSaving(true)
    try {
      const r = await fetch(`/api/plate-store/${plateId}/custody-issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          machineId: issueMachineId,
          operatorUserId: issueOperatorId,
          artworkId: invPlate.artworkId,
          jobCardId: invPlate.jobCardId,
          setNumber: setNum,
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Issue failed')
        return
      }
      toast.success('Issued to machine')
      setIssueModal(null)
      await load()
    } catch (e) {
      console.error(e)
      toast.error('Issue failed')
    } finally {
      setSaving(false)
    }
  }

  async function submitReturn() {
    if (!returnModal?.id?.trim()) {
      toast.error('Missing plate id')
      return
    }
    if (returnImpressions === '' || Number(returnImpressions) < 0) {
      toast.error('Enter impressions run (0 or more)')
      return
    }
    if (!returnRackSlot.trim()) {
      toast.error('Rack slot / location is required')
      return
    }
    if (!returnOperatorId.trim()) {
      toast.error('Operator is required')
      return
    }
    setSaving(true)
    try {
      const r = await fetch(`/api/plate-store/${returnModal.id}/custody-return`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          impressionsRun: Number(returnImpressions),
          plateCondition: returnCondition,
          rackSlot: returnRackSlot.trim(),
          operatorUserId: returnOperatorId,
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Return failed')
        return
      }
      toast.success('Returned to rack')
      setReturnModal(null)
      await load()
    } catch (e) {
      console.error(e)
      toast.error('Return failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-black text-zinc-100 p-4 md:p-6">
      <div className="max-w-[1600px] mx-auto space-y-6">
        <HubCategoryNav active="plates" />

        <header className="flex flex-col gap-1 border-b border-zinc-700 pb-4">
          <h1 className="text-2xl font-bold tracking-tight text-white">Plate Hub</h1>
          <p className="text-sm text-zinc-400">Triage → CTP / Inventory / custody. High-contrast layout for floor speed.</p>
        </header>

        {loading ? (
          <p className="text-zinc-500">Loading…</p>
        ) : (
          <>
            {/* ZONE 1 — Triage */}
            <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400 mb-3">Incoming triage</h2>
              <pre className="sr-only">Designer queue — AW / job codes</pre>
              <div className="space-y-3">
                {data.triage.length === 0 ? (
                  <p className="text-zinc-500 text-sm">No jobs awaiting triage.</p>
                ) : (
                  data.triage.map((row) => (
                    <div
                      key={row.id}
                      className="flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-4 rounded-lg border border-zinc-700 bg-black px-3 py-3"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-mono text-amber-300 text-sm">{row.requirementCode}</p>
                        <p className="text-white font-medium truncate">{row.cartonName}</p>
                        <p className="text-zinc-400 text-xs mt-1">
                          Plates required: <span className="text-white font-semibold">{row.newPlatesNeeded}</span>
                          {row.plateColours.length > 0 && (
                            <span className="text-zinc-500"> · {row.plateColours.join(' · ')}</span>
                          )}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void patchTriage(row.id, 'inhouse_ctp')}
                          className="px-3 py-2 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-sm font-semibold disabled:opacity-50"
                        >
                          In-house CTP
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => {
                            setStockModal(row)
                            setStockPlateId('')
                            setStockRackSlot('')
                          }}
                          className="px-3 py-2 rounded-md border border-zinc-500 bg-zinc-900 hover:bg-zinc-800 text-sm font-medium"
                        >
                          Take from stock
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void patchTriage(row.id, 'outside_vendor')}
                          className="px-3 py-2 rounded-md border border-zinc-600 text-zinc-300 hover:bg-zinc-900 text-sm"
                        >
                          Send to vendor
                        </button>
                        <button
                          type="button"
                          disabled={saving || row.status === 'plates_ready'}
                          title={
                            row.status === 'plates_ready'
                              ? 'Plates already marked ready — cannot recall'
                              : 'Send job back to designer queue'
                          }
                          onClick={() => void recallPrepress(row.id)}
                          className="px-3 py-2 rounded-md border border-rose-700/80 bg-rose-950/80 text-rose-100 hover:bg-rose-900 text-sm font-medium disabled:opacity-40"
                        >
                          Recall to Pre-Press
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* 3 Lanes */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
              {/* CTP */}
              <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-4 min-h-[280px]">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400 mb-3">CTP queue</h2>
                <ul className="space-y-3 text-sm">
                  {data.ctpQueue.length === 0 ? (
                    <li className="text-zinc-500">Empty.</li>
                  ) : (
                    data.ctpQueue.map((job) => (
                      <li key={job.id} className="rounded-lg border border-zinc-700 bg-black p-3">
                        <p className="font-mono text-amber-300">{job.requirementCode}</p>
                        <p className="text-zinc-400 text-xs mt-1">
                          {job.plateColours.length > 0 ? job.plateColours.join(' · ') : '—'}
                        </p>
                        <button
                          type="button"
                          className="mt-2 w-full px-2 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold"
                          onClick={() => openIssueFromCtp()}
                        >
                          Issue to machine
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void sendBackTriage(job.id)}
                          className="mt-2 w-full px-2 py-2 rounded border border-amber-700/80 bg-zinc-900 text-amber-100 hover:bg-zinc-800 text-xs font-semibold"
                        >
                          Send back to Triage
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              </section>

              {/* Inventory */}
              <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-4 min-h-[280px] flex flex-col">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400 mb-2">Live inventory</h2>
                <div className="flex flex-wrap gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => {
                      resetAddStockForm()
                      setAddStockOpen(true)
                    }}
                    className="px-3 py-2 rounded-md bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold"
                  >
                    + Add Plate Stock
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setScrapPlateId('')
                      setScrapOpen(true)
                    }}
                    className="px-3 py-2 rounded-md border border-rose-700/80 bg-rose-950/60 text-rose-100 hover:bg-rose-900/80 text-xs font-bold"
                  >
                    − Remove / Scrap
                  </button>
                </div>
                <input
                  value={invSearch}
                  onChange={(e) => setInvSearch(e.target.value)}
                  placeholder="Search…"
                  className="mb-3 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm placeholder:text-zinc-500"
                />
                <ul className="space-y-2 flex-1 overflow-y-auto max-h-[420px] pr-1">
                  {filteredInventory.length === 0 ? (
                    <li className="text-zinc-500 text-sm">No plates in rack.</li>
                  ) : (
                    filteredInventory.map((p) => (
                      <li key={p.id} className="rounded border border-zinc-800 bg-black p-2">
                        <p className="font-mono text-amber-300 text-xs">{p.plateSetCode}</p>
                        <p className="text-white text-xs truncate">{p.cartonName}</p>
                        <p className="text-zinc-500 text-[10px]">{p.rackLocation ?? '—'}</p>
                        <button
                          type="button"
                          className="mt-1 w-full py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold"
                          onClick={() => openIssueFromInventory(p.id)}
                        >
                          Issue to machine
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              </section>

              {/* Custody */}
              <section className="rounded-xl border-2 border-zinc-600 bg-zinc-950 p-4 min-h-[280px] flex flex-col">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400 mb-2">Custody floor</h2>
                <input
                  value={custSearch}
                  onChange={(e) => setCustSearch(e.target.value)}
                  placeholder="Search…"
                  className="mb-3 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm placeholder:text-zinc-500"
                />
                <ul className="space-y-2 flex-1 overflow-y-auto max-h-[420px] pr-1">
                  {filteredCustody.length === 0 ? (
                    <li className="text-zinc-500 text-sm">Nothing on floor.</li>
                  ) : (
                    filteredCustody.map((p) => {
                      const { machine, operator } = parseIssuedTo(p.issuedTo)
                      return (
                        <li key={p.id} className="rounded border border-zinc-800 bg-black p-2">
                          <p className="font-mono text-amber-300 text-xs">{p.plateSetCode}</p>
                          <p className="text-white text-xs truncate">{p.cartonName}</p>
                          <p className="text-zinc-400 text-[10px] mt-1">
                            Machine: <span className="text-zinc-200">{machine}</span> · Op:{' '}
                            <span className="text-zinc-200">{operator}</span>
                          </p>
                          <button
                            type="button"
                            className="mt-1 w-full py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold"
                            onClick={() => {
                              setReturnModal(p)
                              setReturnImpressions('')
                              setReturnCondition('Good')
                              setReturnRackSlot(p.rackLocation ?? '')
                              setReturnOperatorId('')
                            }}
                          >
                            Return to rack
                          </button>
                          <button
                            type="button"
                            className="mt-1 w-full py-1.5 rounded border border-amber-700/70 bg-zinc-900 text-amber-100 hover:bg-zinc-800 text-xs font-semibold"
                            onClick={() => {
                              setReturnModal(p)
                              setReturnImpressions(0)
                              setReturnCondition('Good')
                              setReturnRackSlot(p.rackLocation ?? '')
                              setReturnOperatorId('')
                            }}
                          >
                            Recall to inventory
                          </button>
                        </li>
                      )
                    })
                  )}
                </ul>
              </section>
            </div>
          </>
        )}
      </div>

      {/* Add plate stock — tabular entry */}
      {addStockOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-lg rounded-xl border border-zinc-600 bg-zinc-950 p-4 space-y-3 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-white">Add plate stock</h3>
            <p className="text-zinc-500 text-xs">
              Enter AW code — fields auto-fill from master when found. Edit before save.
            </p>
            <label className="block text-sm text-zinc-300">
              Customer (optional — narrows lookup)
              <select
                value={addCustomerId}
                onChange={(e) => setAddCustomerId(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              >
                <option value="">Any</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm text-zinc-300">
              AW / product code
              <input
                value={addAw}
                onChange={(e) => setAddAw(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                placeholder="e.g. R234"
              />
            </label>
            {addLookupLoading ? (
              <p className="text-xs text-zinc-500">Looking up…</p>
            ) : null}
            {addLookupError ? (
              <p className="text-xs text-red-400">{addLookupError}</p>
            ) : null}
            <label className="block text-sm text-zinc-300">
              Carton name
              <input
                value={addCartonName}
                onChange={(e) => setAddCartonName(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Sheet size
              <input
                value={addSheetSize}
                onChange={(e) => setAddSheetSize(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                placeholder="e.g. 19x20"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Set #
              <input
                value={addSetNumber}
                onChange={(e) => setAddSetNumber(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Colours JSON (C/M/Y/K/P — edit if needed)
              <textarea
                value={addColoursJson}
                onChange={(e) => setAddColoursJson(e.target.value)}
                rows={4}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white font-mono text-xs"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => {
                  setAddStockOpen(false)
                  resetAddStockForm()
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                className="px-3 py-2 rounded bg-emerald-600 text-white font-medium disabled:opacity-50"
                onClick={() => void submitAddStock()}
              >
                Save to rack
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove / scrap from rack */}
      {scrapOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-600 bg-zinc-950 p-4 space-y-3">
            <h3 className="text-lg font-semibold text-white">Remove / scrap plate set</h3>
            <p className="text-zinc-500 text-xs">Marks the plate set as destroyed in the ledger.</p>
            <label className="block text-sm text-zinc-300">
              Plate set
              <select
                value={scrapPlateId}
                onChange={(e) => setScrapPlateId(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              >
                <option value="">Select…</option>
                {data.inventory.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.plateSetCode} — {p.cartonName}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => setScrapOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving || !scrapPlateId.trim()}
                className="px-3 py-2 rounded bg-rose-700 text-white font-medium disabled:opacity-50"
                onClick={() => void submitScrapFromRack()}
              >
                Confirm scrap
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stock modal */}
      {stockModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-600 bg-zinc-950 p-4 space-y-3">
            <h3 className="text-lg font-semibold text-white">Take from stock</h3>
            <p className="text-slate-400 text-sm">Link a plate set from rack to this job.</p>
            <label className="block text-sm text-zinc-300">
              Plate set
              <select
                value={stockPlateId}
                onChange={(e) => setStockPlateId(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              >
                <option value="">Select…</option>
                {data.inventory.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.plateSetCode} — {p.cartonName}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm text-zinc-300">
              Rack slot (optional)
              <input
                value={stockRackSlot}
                onChange={(e) => setStockRackSlot(e.target.value)}
                placeholder="e.g. 2-3"
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="px-3 py-2 rounded border border-zinc-600 text-zinc-300" onClick={() => setStockModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={saving || !stockPlateId.trim()}
                className="px-3 py-2 rounded bg-amber-600 text-white font-medium disabled:opacity-50"
                onClick={() => {
                  if (!stockModal?.id) {
                    toast.error('Missing requirement id')
                    return
                  }
                  void patchTriage(stockModal.id, 'stock_available', stockRackSlot)
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Issue modal (CTP picks plate from inventory; inventory pre-fills) */}
      {issueModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-600 bg-zinc-950 p-4 space-y-3">
            <h3 className="text-lg font-semibold text-white">Issue to machine</h3>
            <p className="text-zinc-500 text-xs">Custody update runs in a single DB transaction.</p>
            <div className="rounded-lg border border-zinc-700 bg-black/60 p-2 space-y-2">
              <p className="text-[11px] text-zinc-500 uppercase tracking-wide">Quick AW lookup → pick rack plate</p>
              <div className="flex gap-2">
                <input
                  value={issueAwCode}
                  onChange={(e) => setIssueAwCode(e.target.value)}
                  placeholder="AW code"
                  className="flex-1 px-3 py-2 rounded-md bg-black border border-zinc-600 text-white text-sm"
                />
                <button
                  type="button"
                  disabled={issueLookupLoading}
                  onClick={() => void lookupIssueAw()}
                  className="px-3 py-2 rounded-md bg-zinc-700 text-white text-xs font-medium"
                >
                  {issueLookupLoading ? '…' : 'Lookup'}
                </button>
              </div>
              {issueLookupError ? <p className="text-xs text-red-400">{issueLookupError}</p> : null}
            </div>
            {issueModal.source === 'ctp' ? (
              <label className="block text-sm text-zinc-300">
                Plate set (from inventory)
                <select
                  value={issueModal.plateId}
                  onChange={(e) => setIssueModal({ ...issueModal, plateId: e.target.value })}
                  className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                >
                  <option value="">Select…</option>
                  {data.inventory.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.plateSetCode} — {p.cartonName}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="text-xs text-zinc-400">
                Plate set:{' '}
                <span className="text-amber-300 font-mono">
                  {data.inventory.find((p) => p.id === issueModal.plateId)?.plateSetCode ?? issueModal.plateId}
                </span>
                <span className="text-zinc-500">
                  {' '}
                  — {data.inventory.find((p) => p.id === issueModal.plateId)?.cartonName ?? ''}
                </span>
              </p>
            )}
            <label className="block text-sm text-zinc-300">
              Machine
              <select
                value={issueMachineId}
                onChange={(e) => setIssueMachineId(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              >
                <option value="">Select…</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.machineCode} — {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm text-zinc-300">
              Operator
              <select
                value={issueOperatorId}
                onChange={(e) => setIssueOperatorId(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              >
                <option value="">Select…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="px-3 py-2 rounded border border-zinc-600 text-zinc-300" onClick={() => setIssueModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                className="px-3 py-2 rounded bg-blue-600 text-white font-medium disabled:opacity-50"
                onClick={() => void submitCustodyIssue()}
              >
                Issue
              </button>
            </div>
          </div>
        </div>
      )}

      {returnModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-600 bg-zinc-950 p-4 space-y-3">
            <h3 className="text-lg font-semibold text-white">Return to rack</h3>
            <p className="text-zinc-500 text-xs">Updates impressions and returns plate to live inventory.</p>
            <label className="block text-sm text-zinc-300">
              Impressions run
              <input
                type="number"
                min={0}
                value={returnImpressions}
                onChange={(e) => setReturnImpressions(e.target.value === '' ? '' : Number(e.target.value))}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Condition
              <select
                value={returnCondition}
                onChange={(e) => setReturnCondition(e.target.value as 'Good' | 'Damaged' | 'Needs Repair')}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              >
                <option value="Good">Good</option>
                <option value="Damaged">Damaged</option>
                <option value="Needs Repair">Needs Repair</option>
              </select>
            </label>
            <label className="block text-sm text-zinc-300">
              Rack slot / location
              <input
                value={returnRackSlot}
                onChange={(e) => setReturnRackSlot(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Recorded by (operator)
              <select
                value={returnOperatorId}
                onChange={(e) => setReturnOperatorId(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              >
                <option value="">Select…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="px-3 py-2 rounded border border-zinc-600 text-zinc-300" onClick={() => setReturnModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                className="px-3 py-2 rounded bg-emerald-600 text-white font-medium disabled:opacity-50"
                onClick={() => void submitReturn()}
              >
                Return to rack
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
