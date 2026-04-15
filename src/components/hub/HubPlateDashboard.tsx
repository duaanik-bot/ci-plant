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
  serialNumber?: string | null
  outputNumber?: string | null
  rackNumber?: string | null
  ups?: number | null
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

type CartonSearchHit = {
  id: string
  cartonName: string
  artworkCode: string | null
  customerId: string
  customer: { id: string; name: string }
  ups: number | null
}

type DashboardPayload = {
  triage: TriageRow[]
  ctpQueue: CtpRow[]
  vendorQueue: CtpRow[]
  inventory: PlateCard[]
  custody: PlateCard[]
}

type MachineOpt = { id: string; machineCode: string; name: string }
type UserOpt = { id: string; name: string }

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
      vendorQueue: Array.isArray(o.vendorQueue) ? (o.vendorQueue as CtpRow[]) : [],
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
    vendorQueue: [],
    inventory: [],
    custody: [],
  })
  const [machines, setMachines] = useState<MachineOpt[]>([])
  const [users, setUsers] = useState<UserOpt[]>([])

  const [addStockOpen, setAddStockOpen] = useState(false)
  const [addCartonQuery, setAddCartonQuery] = useState('')
  const [addCartonResults, setAddCartonResults] = useState<CartonSearchHit[]>([])
  const [addCartonLoading, setAddCartonLoading] = useState(false)
  const [addSelectedCarton, setAddSelectedCarton] = useState<CartonSearchHit | null>(null)
  const [addAwCode, setAddAwCode] = useState('')
  const [addSerial, setAddSerial] = useState('')
  const [addAutoSerial, setAddAutoSerial] = useState(true)
  const [addOutputNumber, setAddOutputNumber] = useState('')
  const [addRackNumber, setAddRackNumber] = useState('')
  const [addSetNumber, setAddSetNumber] = useState('')
  const [addUps, setAddUps] = useState('')
  const [addArtworkId, setAddArtworkId] = useState('')
  const [stdC, setStdC] = useState(true)
  const [stdM, setStdM] = useState(true)
  const [stdY, setStdY] = useState(true)
  const [stdK, setStdK] = useState(true)
  const [pantoneOn, setPantoneOn] = useState(false)
  const [pantoneCount, setPantoneCount] = useState(1)
  const cartonSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    source: 'ctp' | 'vendor' | 'inventory'
    plateId: string
  } | null>(null)
  const [issueMachineId, setIssueMachineId] = useState('')
  const [issueOperatorId, setIssueOperatorId] = useState('')

  const [returnModal, setReturnModal] = useState<PlateCard | null>(null)
  const [returnFlow, setReturnFlow] = useState<'return' | 'receive'>('return')
  const [returnImpressions, setReturnImpressions] = useState<number | ''>('')
  const [returnCondition, setReturnCondition] = useState<'Good' | 'Damaged' | 'Needs Repair'>('Good')
  const [returnRackSlot, setReturnRackSlot] = useState('')
  const [returnOperatorId, setReturnOperatorId] = useState('')
  const [reverseModal, setReverseModal] = useState<PlateCard | null>(null)
  const [reverseRack, setReverseRack] = useState('')
  const [addStockFieldErrors, setAddStockFieldErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [dRes, mRes, uRes] = await Promise.all([
        fetch('/api/plate-hub/dashboard'),
        fetch('/api/machines'),
        fetch('/api/users'),
      ])
      const dText = await dRes.text()
      const mText = await mRes.text()
      const uText = await uRes.text()

      const parsed = safeReadDashboard(dText)
      if (!parsed) {
        toast.error('Unexpected dashboard response')
        setData({ triage: [], ctpQueue: [], vendorQueue: [], inventory: [], custody: [] })
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
    const q = addCartonQuery.trim()
    if (q.length < 2) {
      setAddCartonResults([])
      return
    }
    if (cartonSearchTimerRef.current) clearTimeout(cartonSearchTimerRef.current)
    cartonSearchTimerRef.current = setTimeout(() => {
      void (async () => {
        setAddCartonLoading(true)
        try {
          const r = await fetch(`/api/plate-hub/cartons-search?q=${encodeURIComponent(q)}`)
          const list = safeJsonParseArray<CartonSearchHit>(await r.text(), [])
          setAddCartonResults(Array.isArray(list) ? list : [])
        } catch {
          setAddCartonResults([])
        } finally {
          setAddCartonLoading(false)
        }
      })()
    }, 300)
    return () => {
      if (cartonSearchTimerRef.current) clearTimeout(cartonSearchTimerRef.current)
    }
  }, [addStockOpen, addCartonQuery])

  const addStockTotalPlates = useMemo(() => {
    let n = 0
    if (stdC) n += 1
    if (stdM) n += 1
    if (stdY) n += 1
    if (stdK) n += 1
    if (pantoneOn) n += Math.max(0, Math.min(12, Math.floor(Number(pantoneCount) || 0)))
    return n
  }, [stdC, stdM, stdY, stdK, pantoneOn, pantoneCount])

  function resetAddStockForm() {
    setAddCartonQuery('')
    setAddCartonResults([])
    setAddSelectedCarton(null)
    setAddAwCode('')
    setAddSerial('')
    setAddAutoSerial(true)
    setAddOutputNumber('')
    setAddRackNumber('')
    setAddSetNumber('')
    setAddUps('')
    setAddArtworkId('')
    setStdC(true)
    setStdM(true)
    setStdY(true)
    setStdK(true)
    setPantoneOn(false)
    setPantoneCount(1)
    setAddStockFieldErrors({})
  }

  function applyCartonSelection(hit: CartonSearchHit) {
    setAddSelectedCarton(hit)
    setAddCartonQuery(hit.cartonName)
    setAddCartonResults([])
    setAddAwCode(hit.artworkCode?.trim() || '')
    setAddUps(hit.ups != null && hit.ups > 0 ? String(hit.ups) : '')
    setAddArtworkId('')
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

  async function sendVendorBackTriage(requirementId: string) {
    setSaving(true)
    try {
      const r = await fetch(`/api/plate-requirements/${requirementId}/vendor-send-back-triage`, {
        method: 'POST',
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Send back failed')
        return
      }
      toast.success('Returned to triage (vendor path cleared)')
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function receiveVendorToTriage(requirementId: string) {
    setSaving(true)
    try {
      const r = await fetch(`/api/plate-requirements/${requirementId}/vendor-received`, {
        method: 'POST',
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Receive failed')
        return
      }
      toast.success('Received — job back in incoming triage')
      await load()
    } finally {
      setSaving(false)
    }
  }

  function buildAddStockColours(): { name: string; type: string; status: 'new' }[] {
    const colours: { name: string; type: string; status: 'new' }[] = []
    if (stdC) colours.push({ name: 'Cyan', type: 'process', status: 'new' })
    if (stdM) colours.push({ name: 'Magenta', type: 'process', status: 'new' })
    if (stdY) colours.push({ name: 'Yellow', type: 'process', status: 'new' })
    if (stdK) colours.push({ name: 'Black', type: 'process', status: 'new' })
    if (pantoneOn) {
      const n = Math.max(1, Math.min(12, Math.floor(Number(pantoneCount) || 0)))
      for (let i = 1; i <= n; i += 1) {
        colours.push({ name: `Pantone ${i}`, type: 'pantone', status: 'new' })
      }
    }
    return colours
  }

  async function submitAddStock() {
    setAddStockFieldErrors({})
    if (!addSelectedCarton) {
      toast.error('Select a carton from the search results')
      return
    }
    const aw = addAwCode.trim()
    if (!aw) {
      toast.error('AW code is required')
      return
    }
    if (!addAutoSerial) {
      const sn = addSerial.trim()
      if (!sn) {
        toast.error('Serial number is required when auto-generate is off')
        setAddStockFieldErrors({ serialNumber: 'Required when auto-generate is off' })
        return
      }
    }
    const colours = buildAddStockColours()
    if (!colours.length) {
      toast.error('Select at least one colour (C/M/Y/K or Pantone)')
      return
    }
    let ups: number | null = null
    if (addUps.trim()) {
      const u = parseInt(addUps, 10)
      if (!Number.isFinite(u) || u < 1) {
        toast.error('No. of UPS must be a positive whole number')
        setAddStockFieldErrors({ ups: 'Must be a positive integer' })
        return
      }
      ups = u
    }

    setSaving(true)
    try {
      const r = await fetch('/api/plate-store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          cartonName: addSelectedCarton.cartonName,
          artworkCode: aw,
          customerId: addSelectedCarton.customerId,
          cartonId: addSelectedCarton.id,
          artworkId: addArtworkId.trim() || null,
          autoGenerateSerial: addAutoSerial,
          serialNumber: addAutoSerial ? null : addSerial.trim(),
          outputNumber: addOutputNumber.trim() || null,
          rackNumber: addRackNumber.trim() || null,
          ups,
          numberOfColours: colours.length,
          colours,
          rackLocation: addRackNumber.trim() || null,
          slotNumber: addSetNumber.trim() || null,
        }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string; fields?: Record<string, string> }>(t, {})
      if (!r.ok) {
        if (j.fields && typeof j.fields === 'object') setAddStockFieldErrors(j.fields)
        toast.error(j.error ?? 'Save failed')
        return
      }
      toast.success('Saved to rack')
      setAddStockOpen(false)
      resetAddStockForm()
      await load()
    } catch (e) {
      console.error(e)
      toast.error('Save failed — check connection and try again')
    } finally {
      setSaving(false)
    }
  }

  async function submitReverseIssue() {
    if (!reverseModal?.id?.trim()) {
      toast.error('Missing plate id')
      return
    }
    if (!reverseRack.trim()) {
      toast.error('Rack number is required to reverse an issue')
      return
    }
    setSaving(true)
    try {
      const r = await fetch(`/api/plate-store/${reverseModal.id}/reverse-issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({ rackNumber: reverseRack.trim() }),
      })
      const t = await r.text()
      const j = safeJsonParse<{ error?: string }>(t, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Reverse issue failed')
        return
      }
      toast.success('Issue reversed — plate back on rack')
      setReverseModal(null)
      setReverseRack('')
      await load()
    } catch (e) {
      console.error(e)
      toast.error('Reverse issue failed')
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
        (p.artworkCode?.toLowerCase().includes(q) ?? false) ||
        (p.serialNumber?.toLowerCase().includes(q) ?? false),
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

  function openIssueFromVendor() {
    setIssueAwCode('')
    setIssueLookupError('')
    setIssueModal({ source: 'vendor', plateId: '' })
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
          <p className="text-sm text-zinc-400">
            Triage → CTP / outside vendor / inventory / custody. High-contrast layout for floor speed.
          </p>
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

            {/* Lanes: CTP · outside vendor · rack · custody */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 lg:gap-6">
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

              {/* Outside vendor */}
              <section className="rounded-xl border-2 border-violet-900/80 bg-zinc-950 p-4 min-h-[280px]">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-violet-300 mb-1">
                  Outside vendor
                </h2>
                <p className="text-[11px] text-zinc-500 mb-3">Awaiting delivery · two-way decisions</p>
                <ul className="space-y-3 text-sm">
                  {data.vendorQueue.length === 0 ? (
                    <li className="text-zinc-500">None at vendor.</li>
                  ) : (
                    data.vendorQueue.map((job) => (
                      <li key={job.id} className="rounded-lg border border-violet-800/50 bg-black p-3">
                        <p className="font-mono text-violet-200">{job.requirementCode}</p>
                        <p className="text-white text-xs font-medium truncate mt-0.5">{job.cartonName}</p>
                        <p className="text-zinc-400 text-xs mt-1">
                          {job.plateColours.length > 0 ? job.plateColours.join(' · ') : '—'}
                        </p>
                        <p className="text-[10px] text-zinc-500 mt-1 capitalize">
                          {job.status.replace(/_/g, ' ')}
                        </p>
                        <button
                          type="button"
                          className="mt-2 w-full px-2 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold"
                          onClick={() => openIssueFromVendor()}
                        >
                          Issue to machine
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void receiveVendorToTriage(job.id)}
                          className="mt-2 w-full px-2 py-2 rounded bg-emerald-900/80 hover:bg-emerald-800 border border-emerald-700/60 text-emerald-100 text-xs font-semibold"
                        >
                          Received → Triage
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void sendVendorBackTriage(job.id)}
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
                        {p.serialNumber ? (
                          <p className="text-zinc-500 text-[10px] font-mono">SN {p.serialNumber}</p>
                        ) : null}
                        <p className="text-white text-xs truncate">{p.cartonName}</p>
                        <p className="text-zinc-500 text-[10px]">
                          Rack: {p.rackNumber ?? p.rackLocation ?? '—'}
                          {p.ups != null && p.ups > 0 ? ` · UPS ${p.ups}` : ''}
                        </p>
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
                              setReturnFlow('receive')
                              setReturnModal(p)
                              setReturnImpressions('')
                              setReturnCondition('Good')
                              setReturnRackSlot(
                                (p.rackNumber ?? p.rackLocation ?? '').trim() || '',
                              )
                              setReturnOperatorId('')
                            }}
                          >
                            Receive from floor
                          </button>
                          <button
                            type="button"
                            className="mt-1 w-full py-1.5 rounded border border-rose-800/80 bg-rose-950/50 text-rose-100 hover:bg-rose-950 text-xs font-semibold"
                            onClick={() => {
                              setReverseModal(p)
                              setReverseRack((p.rackNumber ?? p.rackLocation ?? '').trim())
                            }}
                          >
                            Reverse issue
                          </button>
                          <button
                            type="button"
                            className="mt-1 w-full py-1.5 rounded border border-amber-700/70 bg-zinc-900 text-amber-100 hover:bg-zinc-800 text-xs font-semibold"
                            onClick={() => {
                              setReturnFlow('return')
                              setReturnModal(p)
                              setReturnImpressions(0)
                              setReturnCondition('Good')
                              setReturnRackSlot(
                                (p.rackNumber ?? p.rackLocation ?? '').trim() || '',
                              )
                              setReturnOperatorId('')
                            }}
                          >
                            Quick return (0 impressions)
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

      {/* Add plate stock — master-linked */}
      {addStockOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-lg max-h-[90vh] rounded-xl border border-zinc-600 bg-zinc-950 flex flex-col shadow-2xl">
            <div className="p-4 pb-2 shrink-0 border-b border-zinc-800 z-20 relative">
            <h3 className="text-lg font-semibold text-white">Add plate stock</h3>
            <p className="text-zinc-500 text-xs">
              Search carton master first — AW code and UPS fill from the selected carton. Edit before save.
            </p>
            <div className="relative mt-3">
              <label className="block text-sm text-zinc-300">
                Carton name
                <input
                  value={addCartonQuery}
                  onChange={(e) => {
                    const v = e.target.value
                    setAddCartonQuery(v)
                    if (addSelectedCarton && v.trim() !== addSelectedCarton.cartonName) {
                      setAddSelectedCarton(null)
                    }
                  }}
                  className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                  placeholder="Type at least 2 characters…"
                  autoComplete="off"
                />
              </label>
              {addCartonLoading ? <p className="text-xs text-zinc-500 mt-1">Searching…</p> : null}
              {addCartonResults.length > 0 ? (
                <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-zinc-600 bg-zinc-900 shadow-lg">
                  {addCartonResults.map((hit) => (
                    <li key={hit.id}>
                      <button
                        type="button"
                        className="w-full px-3 py-2 text-left text-sm text-white hover:bg-zinc-800 border-b border-zinc-800 last:border-0"
                        onClick={() => applyCartonSelection(hit)}
                      >
                        <span className="font-medium block truncate">{hit.cartonName}</span>
                        <span className="text-[11px] text-zinc-400">
                          {hit.customer.name}
                          {hit.artworkCode ? ` · ${hit.artworkCode}` : ''}
                          {hit.ups != null && hit.ups > 0 ? ` · UPS ${hit.ups}` : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            {addSelectedCarton ? (
              <p className="text-[11px] text-emerald-400/90">
                Linked: {addSelectedCarton.customer.name}
              </p>
            ) : (
              <p className="text-[11px] text-zinc-500">Pick a row above to link carton + customer.</p>
            )}
            </div>
            <div className="p-4 pt-3 space-y-3 overflow-y-auto flex-1 min-h-0">
            <label className="block text-sm text-zinc-300">
              AW code
              <input
                value={addAwCode}
                onChange={(e) => setAddAwCode(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                placeholder="e.g. R234"
              />
            </label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="block text-sm text-zinc-300 flex-1">
                Serial number
                <input
                  value={addSerial}
                  onChange={(e) => setAddSerial(e.target.value)}
                  disabled={addAutoSerial}
                  className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white disabled:opacity-50"
                  placeholder={addAutoSerial ? 'Auto-generated on save' : 'Enter serial'}
                />
                {addStockFieldErrors.serialNumber ? (
                  <span className="text-xs text-red-400">{addStockFieldErrors.serialNumber}</span>
                ) : null}
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-300 pb-2 sm:pb-0 shrink-0 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={addAutoSerial}
                  onChange={(e) => {
                    setAddAutoSerial(e.target.checked)
                    if (e.target.checked) setAddSerial('')
                  }}
                  className="rounded border-zinc-600"
                />
                Auto-generate
              </label>
            </div>
            <label className="block text-sm text-zinc-300">
              Output number
              <input
                value={addOutputNumber}
                onChange={(e) => setAddOutputNumber(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Rack number
              <input
                value={addRackNumber}
                onChange={(e) => setAddRackNumber(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
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
              No. of UPS
              <input
                value={addUps}
                onChange={(e) => setAddUps(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                placeholder="From dye / carton master"
                inputMode="numeric"
              />
              {addStockFieldErrors.ups ? (
                <span className="text-xs text-red-400">{addStockFieldErrors.ups}</span>
              ) : null}
            </label>
            <div>
              <p className="text-sm text-zinc-300 mb-2">Colours on plate</p>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ['C', stdC, setStdC],
                    ['M', stdM, setStdM],
                    ['Y', stdY, setStdY],
                    ['K', stdK, setStdK],
                  ] as const
                ).map(([label, on, setOn]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setOn(!on)}
                    className={`min-w-[2.5rem] px-3 py-2 rounded-md text-sm font-bold border ${
                      on
                        ? 'bg-amber-600 border-amber-500 text-white'
                        : 'bg-zinc-900 border-zinc-600 text-zinc-500'
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setPantoneOn(!pantoneOn)}
                  className={`px-3 py-2 rounded-md text-sm font-bold border ${
                    pantoneOn
                      ? 'bg-violet-700 border-violet-500 text-white'
                      : 'bg-zinc-900 border-zinc-600 text-zinc-500'
                  }`}
                >
                  Pantone
                </button>
              </div>
              {pantoneOn ? (
                <label className="block text-sm text-zinc-300 mt-3">
                  How many Pantones?
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={pantoneCount}
                    onChange={(e) => setPantoneCount(Number(e.target.value) || 1)}
                    className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                  />
                </label>
              ) : null}
            </div>
            <div className="rounded-lg border border-zinc-700 bg-black/50 px-3 py-2 flex items-center justify-between">
              <span className="text-sm text-zinc-400">Total plates required</span>
              <span className="text-lg font-bold text-amber-300 tabular-nums">{addStockTotalPlates}</span>
            </div>
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
            {issueModal.source === 'ctp' || issueModal.source === 'vendor' ? (
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
            <h3 className="text-lg font-semibold text-white">
              {returnFlow === 'receive' ? 'Receive from floor' : 'Return to rack'}
            </h3>
            <p className="text-zinc-500 text-xs">
              {returnFlow === 'receive'
                ? 'Confirm rack number, impressions, and operator to move this set back into live inventory.'
                : 'Updates impressions and returns plate to live inventory.'}
            </p>
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
              {returnFlow === 'receive' ? 'Rack number / slot' : 'Rack slot / location'}
              <input
                value={returnRackSlot}
                onChange={(e) => setReturnRackSlot(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                placeholder="e.g. A-12"
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
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => setReturnModal(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                className="px-3 py-2 rounded bg-emerald-600 text-white font-medium disabled:opacity-50"
                onClick={() => void submitReturn()}
              >
                {returnFlow === 'receive' ? 'Receive to rack' : 'Return to rack'}
              </button>
            </div>
          </div>
        </div>
      )}

      {reverseModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-600 bg-zinc-950 p-4 space-y-3">
            <h3 className="text-lg font-semibold text-white">Reverse issue</h3>
            <p className="text-zinc-500 text-xs">
              Undo a mistaken issue and put the plate set straight back on the rack (no custody return).
            </p>
            <p className="text-xs text-amber-300 font-mono">{reverseModal.plateSetCode}</p>
            <p className="text-xs text-zinc-400 truncate">{reverseModal.cartonName}</p>
            <label className="block text-sm text-zinc-300">
              Rack number
              <input
                value={reverseRack}
                onChange={(e) => setReverseRack(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-md bg-black border border-zinc-600 text-white"
                placeholder="Where it should sit in live inventory"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-3 py-2 rounded border border-zinc-600 text-zinc-300"
                onClick={() => {
                  setReverseModal(null)
                  setReverseRack('')
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                className="px-3 py-2 rounded bg-rose-800 text-white font-medium disabled:opacity-50"
                onClick={() => void submitReverseIssue()}
              >
                Reverse issue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
