'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, History, Inbox, RefreshCw, Send } from 'lucide-react'
import { toast } from 'sonner'
import {
  shadeCardAgeTier,
  shadeCardIsApproachingHardExpiry,
  shadeCardIsFadingStandard,
} from '@/lib/shade-card-age'
import { SHADE_SUBSTRATE_VALUES, shadeSubstrateLabel } from '@/lib/shade-card-substrate'
import type { HubToolType } from '@/lib/hub-types'
import { HubCategoryNav } from '@/components/hub/HubCategoryNav'
import { custodyBadgeClass, custodyLabel, SHADE_MASTER_RACK_LOCATION } from '@/lib/inventory-hub-custody'
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
import { ShadeSmartRemark } from '@/components/hub/ShadeSmartRemark'
import { EnterpriseTableShell } from '@/components/ui/EnterpriseTableShell'
import { shadeCardPhysicalLabel } from '@/lib/shade-card-custody-condition'

const shadeMono =
  'font-[family-name:var(--font-designing-queue),ui-monospace,monospace] tabular-nums tracking-tight'

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
  productId?: string | null
  productMaster: string | null
  masterArtworkRef: string | null
  remarks: string | null
  remarksEditedAt?: string | null
  remarksEditedByName?: string | null
  updatedAt?: string
  currentHolder: string | null
  impressionCount: number
  custodyStatus: string
  cardStatusLabel?: string
  locationLabel?: string
  entryDate?: string
  createdAt?: string
  mfgDate?: string | null
  currentAgeMonths?: number | null
  product?: {
    id: string
    cartonName: string
    artworkCode: string | null
    customer: { id: string; name: string }
  } | null
  customer?: { id: string; name: string } | null
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

type JobCardHit = {
  id: string
  jobCardNumber: number
  status: string
  customer: { name: string }
}

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
  const [issueJobCardId, setIssueJobCardId] = useState('')
  const [issueJobCardNumber, setIssueJobCardNumber] = useState<number | null>(null)
  const [jobCardQuery, setJobCardQuery] = useState('')
  const [jobCardHits, setJobCardHits] = useState<JobCardHit[]>([])
  const [jobCardLoading, setJobCardLoading] = useState(false)

  const [receiveOpen, setReceiveOpen] = useState(false)
  const [receiveToolId, setReceiveToolId] = useState<string | null>(null)
  const [finalImpressions, setFinalImpressions] = useState<number | ''>('')
  const [receiveCondition, setReceiveCondition] = useState<(typeof RECEIVE_CONDITIONS)[number]>('Good')
  const [shadeIssueInitialCondition, setShadeIssueInitialCondition] = useState<
    'mint' | 'used' | 'minor_damage'
  >('mint')
  const [issueOperatorSearch, setIssueOperatorSearch] = useState('')
  const [receiveOperatorId, setReceiveOperatorId] = useState('')
  const [receiveOperatorSearch, setReceiveOperatorSearch] = useState('')
  const [shadeReceiveEndCondition, setShadeReceiveEndCondition] = useState<'mint' | 'used' | 'minor_damage'>(
    'mint',
  )

  const [vendorOpen, setVendorOpen] = useState(false)
  const [vendorToolId, setVendorToolId] = useState<string | null>(null)
  const [vendorNotes, setVendorNotes] = useState('')
  const [vendorCondition, setVendorCondition] = useState<(typeof RECEIVE_CONDITIONS)[number]>('Good')

  const [addShadeOpen, setAddShadeOpen] = useState(false)
  const [addProductId, setAddProductId] = useState<string | null>(null)
  const [addSelectedLabel, setAddSelectedLabel] = useState('')
  const [addMfgDate, setAddMfgDate] = useState('')
  const [addAwCode, setAddAwCode] = useState('')
  const [addQuantity, setAddQuantity] = useState(1)
  const [addRemarks, setAddRemarks] = useState('')
  const [addSubstrate, setAddSubstrate] = useState<(typeof SHADE_SUBSTRATE_VALUES)[number]>('FBB')
  const [addLabL, setAddLabL] = useState('')
  const [addLabA, setAddLabA] = useState('')
  const [addLabB, setAddLabB] = useState('')
  const [cartonQuery, setCartonQuery] = useState('')
  const [cartonHits, setCartonHits] = useState<CartonHit[]>([])
  const [cartonSearchLoading, setCartonSearchLoading] = useState(false)

  const [auditOpen, setAuditOpen] = useState(false)
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditPayload, setAuditPayload] = useState<ShadeAuditPayload | null>(null)

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
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
    if (toolType !== 'shade_cards') return
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load({ silent: true })
    }, 12_000)
    return () => window.clearInterval(id)
  }, [toolType, load])

  useEffect(() => {
    if (!issueOpen || toolType !== 'shade_cards') return
    const q = jobCardQuery.trim()
    const t = window.setTimeout(() => {
      void (async () => {
        setJobCardLoading(true)
        try {
          const r = await fetch(`/api/inventory-hub/job-cards-quick?q=${encodeURIComponent(q)}`)
          const j = (await r.json()) as { rows?: JobCardHit[] }
          setJobCardHits(Array.isArray(j.rows) ? j.rows : [])
        } catch {
          setJobCardHits([])
        } finally {
          setJobCardLoading(false)
        }
      })()
    }, q ? 220 : 0)
    return () => window.clearTimeout(t)
  }, [issueOpen, toolType, jobCardQuery])

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

  const shadeFadingStandardsCount = useMemo(() => {
    const list = Array.isArray(shades) ? shades : []
    return list.filter((s) => shadeCardIsFadingStandard(s.currentAgeMonths ?? null)).length
  }, [shades])

  const filteredShades = useMemo(() => {
    const list = Array.isArray(shades) ? shades : []
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter((s) => {
      const client = (s.product?.customer?.name ?? s.customer?.name ?? '').toLowerCase()
      const prodName = (s.product?.cartonName ?? s.productMaster ?? '').toLowerCase()
      const pid = (s.productId ?? '').toLowerCase()
      return (
        (s?.shadeCode ?? '').toLowerCase().includes(q) ||
        (s?.productMaster?.toLowerCase().includes(q) ?? false) ||
        (s?.masterArtworkRef?.toLowerCase().includes(q) ?? false) ||
        (s?.remarks?.toLowerCase().includes(q) ?? false) ||
        (s?.locationLabel?.toLowerCase().includes(q) ?? false) ||
        client.includes(q) ||
        prodName.includes(q) ||
        pid.includes(q)
      )
    })
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

  const filteredIssueOperators = useMemo(() => {
    const q = issueOperatorSearch.trim().toLowerCase()
    if (!q) return users
    return users.filter((u) => u.name.toLowerCase().includes(q))
  }, [users, issueOperatorSearch])

  const filteredReceiveOperators = useMemo(() => {
    const q = receiveOperatorSearch.trim().toLowerCase()
    if (!q) return users
    return users.filter((u) => u.name.toLowerCase().includes(q))
  }, [users, receiveOperatorSearch])

  function openIssue(id: string) {
    setIssueToolId(id)
    setMachineId('')
    setOperatorId('')
    setIssueOperatorSearch('')
    setShadeIssueInitialCondition('mint')
    setIssueJobCardId('')
    setIssueJobCardNumber(null)
    setJobCardQuery('')
    setJobCardHits([])
    setIssueOpen(true)
  }

  function openReceive(id: string) {
    setReceiveToolId(id)
    setFinalImpressions(toolType === 'shade_cards' ? 0 : '')
    setReceiveCondition('Good')
    setReceiveOperatorId('')
    setReceiveOperatorSearch('')
    setShadeReceiveEndCondition('mint')
    setReceiveOpen(true)
  }

  function openAddShadeModal() {
    setAddProductId(null)
    setAddSelectedLabel('')
    setAddMfgDate(new Date().toISOString().slice(0, 10))
    setAddSubstrate('FBB')
    setAddLabL('')
    setAddLabA('')
    setAddLabB('')
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
        const jn = typeof d.jobCardNumber === 'number' ? d.jobCardNumber : null
        const jc = jn != null ? ` · JC #${jn}` : ''
        return `Issued to ${op} · machine ${mc}${mn ? ` (${mn})` : ''}${jc}`
      }
      case 'RECEIVED': {
        const imp = typeof d.finalImpressions === 'number' ? d.finalImpressions : 0
        const cond = typeof d.condition === 'string' ? d.condition : '—'
        const loc = typeof d.returnLocation === 'string' ? d.returnLocation : null
        const tail = [loc ? `→ ${loc}` : null, imp > 0 ? `+${imp} imp` : null, cond !== '—' ? cond : null]
          .filter(Boolean)
          .join(' · ')
        if (!tail) return 'Received to rack'
        return `Received to rack · ${tail}`
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
    if (!addProductId?.trim()) {
      toast.error('Select a product from Product Master')
      return
    }
    if (!addMfgDate.trim()) {
      toast.error('Manufacturing date is required')
      return
    }
    if (addQuantity < 1 || addQuantity > 99) {
      toast.error('Quantity must be between 1 and 99')
      return
    }
    const l = Number(addLabL)
    const a = Number(addLabA)
    const b = Number(addLabB)
    if (!Number.isFinite(l) || !Number.isFinite(a) || !Number.isFinite(b)) {
      toast.error('CIE L*, a*, b* are required (numbers)')
      return
    }
    try {
      const r = await fetch('/api/inventory-hub/shade-cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
          autoGenerateCode: true,
          productId: addProductId.trim(),
          mfgDate: addMfgDate.trim(),
          substrateType: addSubstrate,
          labL: l,
          labA: a,
          labB: b,
          masterArtworkRef: addAwCode.trim() || null,
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
    if (toolType === 'shade_cards' && !issueJobCardId.trim()) {
      toast.error('Link an active production job (job card) — required for custody handshake')
      return
    }
    const path =
      toolType === 'dies'
        ? `/api/inventory-hub/dies/${issueToolId}/issue`
        : toolType === 'blocks'
          ? `/api/inventory-hub/emboss-blocks/${issueToolId}/issue`
          : `/api/inventory-hub/shade-cards/${issueToolId}/issue`
    try {
      const body =
        toolType === 'shade_cards'
          ? safeJsonStringify({
              machineId,
              operatorUserId: operatorId,
              jobCardId: issueJobCardId.trim(),
              initialCondition: shadeIssueInitialCondition,
            })
          : safeJsonStringify({ machineId, operatorUserId: operatorId })
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const text = await r.text()
      const j = safeJsonParse<{ error?: string; duplicate?: boolean; code?: string }>(text, {})
      if (!r.ok) {
        if (j.code === 'SHADE_EXPIRED') {
          toast.error(j.error ?? 'Shade card expired — replace before issuing to floor')
        } else {
          toast.error(j.error ?? 'Issue failed')
        }
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
      if (toolType === 'shade_cards' && !receiveOperatorId.trim()) {
        toast.error('Select returning operator')
        return
      }
      const body =
        toolType === 'shade_cards'
          ? safeJsonStringify({
              finalImpressions: 0,
              endCondition: shadeReceiveEndCondition,
              returningOperatorUserId: receiveOperatorId,
            })
          : safeJsonStringify({
              finalImpressions: Number(finalImpressions),
              condition: receiveCondition,
            })
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const text = await r.text()
      const j = safeJsonParse<{ error?: string; duplicate?: boolean; damageReport?: boolean }>(text, {})
      if (!r.ok) {
        toast.error(j.error ?? 'Receive failed')
        return
      }
      if (j.duplicate) toast.message('Duplicate receive ignored')
      else toast.success('Received to rack')
      if (toolType === 'shade_cards' && j.damageReport) {
        toast.warning('Damage report logged — end condition below checkout baseline.')
      }
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
    <div
      className={`p-4 max-w-7xl mx-auto space-y-4 ${
        toolType === 'shade_cards' ? 'min-h-screen bg-background text-foreground' : ''
      }`}
    >
      <HubCategoryNav active={toolType} />

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold text-ds-warning">{title}</h1>
          {toolType === 'shade_cards' ? (
            <div
              className={`rounded-lg border border-orange-900/40 bg-ds-main px-3 py-2 ${shadeMono}`}
              title="ΔE Limit Enforced < 2.0"
            >
              <p className="text-[9px] uppercase tracking-wider text-neutral-500">Fading Standards</p>
              <p className="text-xl font-bold text-orange-400 tabular-nums leading-tight">{shadeFadingStandardsCount}</p>
            </div>
          ) : null}
        </div>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center flex-wrap">
          {toolType === 'shade_cards' && (
            <button
              type="button"
              onClick={() => openAddShadeModal()}
              className="px-3 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium whitespace-nowrap font-sans"
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
              buttonClassName="!border-ds-line/60 !bg-ds-elevated hover:!bg-ds-elevated !text-ds-ink"
              menuClassName="!border-ds-line/60 !bg-ds-card [&_button]:hover:!bg-ds-elevated"
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
              buttonClassName="!border-ds-line/60 !bg-ds-elevated hover:!bg-ds-elevated !text-ds-ink"
              menuClassName="!border-ds-line/60 !bg-ds-card [&_button]:hover:!bg-ds-elevated"
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
              buttonClassName="!border-ds-line/60 !bg-ds-elevated hover:!bg-ds-elevated !text-ds-ink"
              menuClassName="!border-ds-line/60 !bg-ds-card [&_button]:hover:!bg-ds-elevated"
            />
          )}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className={`px-3 py-2 rounded bg-background border border-input text-foreground text-sm max-w-md ${
              toolType === 'shade_cards' ? shadeMono : ''
            }`}
          />
        </div>
      </div>

      <p className="text-sm text-ds-ink-muted">
        {toolType === 'shade_cards' ? (
          <>
            Master ledger: one row per physical card. <span className="text-ds-ink-muted">Issue</span> and{' '}
            <span className="text-ds-ink-muted">Receive</span> move custody between rack and floor. Click the product name for a history of when it was issued and to whom.
          </>
        ) : (
          <>
            Issue and Receive (floor) update custody in one transaction. Receive from vendor moves tools from At Vendor (yellow)
            back to In Stock (green). Status: In Stock, On Floor, At Vendor.
          </>
        )}
      </p>

      {loading ? (
        <p className="text-ds-ink-muted text-sm">Loading…</p>
      ) : toolType === 'dies' ? (
        <EnterpriseTableShell>
          <table className="w-full border-collapse text-left text-sm text-neutral-900 dark:text-ds-ink">
            <thead className="border-b border-border bg-card text-xs font-semibold uppercase tracking-wider text-ds-ink-faint dark:text-ds-ink-muted">
              <tr>
                <th className="px-4 py-3">ID</th>
                <th className="px-4 py-3">Carton</th>
                <th className="px-4 py-3">L × W × H</th>
                <th className="px-4 py-3">Ups</th>
                <th className="px-4 py-3">Knife H (mm)</th>
                <th className="px-4 py-3">Rack</th>
                <th className="px-4 py-3">Impressions</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 bg-card dark:divide-ds-line/30">
              {filteredDies.map((d) => (
                <tr key={d.id} className="transition-colors hover:bg-neutral-50 dark:hover:bg-ds-elevated/50">
                  <td className="px-4 py-3 font-designing-queue text-ds-warning dark:text-ds-warning">{d.dyeNumber}</td>
                  <td className="px-4 py-3">{d.cartonName ?? '—'}</td>
                  <td className="px-4 py-3">{d.cartonSize ?? '—'}</td>
                  <td className="px-4 py-3">{d.ups ?? '—'}</td>
                  <td className="px-4 py-3">{d.knifeHeightMm ?? '—'}</td>
                  <td className="px-4 py-3">{d.location ?? '—'}</td>
                  <td className="px-4 py-3">{(d.impressionCount ?? 0).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded border px-2 py-0.5 text-xs ${custodyBadgeClass(d.custodyStatus ?? '')}`}
                    >
                      {custodyLabel(d.custodyStatus ?? '')}
                    </span>
                  </td>
                  <td className="space-x-1 whitespace-nowrap px-4 py-3">
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
                      className="text-ds-warning hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      From vendor
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </EnterpriseTableShell>
      ) : toolType === 'blocks' ? (
        <EnterpriseTableShell>
          <table className="w-full border-collapse text-left text-sm text-neutral-900 dark:text-ds-ink">
            <thead className="border-b border-border bg-card text-xs font-semibold uppercase tracking-wider text-ds-ink-faint dark:text-ds-ink-muted">
              <tr>
                <th className="px-4 py-3">ID</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Material</th>
                <th className="px-4 py-3">Rack</th>
                <th className="px-4 py-3">Impressions</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 bg-card dark:divide-ds-line/30">
              {filteredEmboss.map((b) => (
                <tr key={b.id} className="transition-colors hover:bg-neutral-50 dark:hover:bg-ds-elevated/50">
                  <td className="px-4 py-3 font-designing-queue text-ds-warning dark:text-ds-warning">{b.blockCode ?? '—'}</td>
                  <td className="px-4 py-3">{b.blockType ?? '—'}</td>
                  <td className="px-4 py-3">{b.blockMaterial ?? '—'}</td>
                  <td className="px-4 py-3">{b.storageLocation ?? '—'}</td>
                  <td className="px-4 py-3">{(b.impressionCount ?? 0).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded border px-2 py-0.5 text-xs ${custodyBadgeClass(b.custodyStatus ?? '')}`}
                    >
                      {custodyLabel(b.custodyStatus ?? '')}
                    </span>
                  </td>
                  <td className="space-x-1 whitespace-nowrap px-4 py-3">
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
                      className="text-ds-warning hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      From vendor
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </EnterpriseTableShell>
      ) : (
        <EnterpriseTableShell className="bg-card ring-border">
          <table className={`w-full border-collapse bg-card text-left text-sm leading-tight text-card-foreground ${shadeMono}`}>
            <thead className="bg-card border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-2 h-[44px] align-middle whitespace-nowrap">MFG / entry</th>
                <th className="px-2 h-[44px] align-middle min-w-[10rem] font-sans">Client / product</th>
                <th className="px-2 h-[44px] align-middle whitespace-nowrap min-w-[7rem]">Shade · AW</th>
                <th className="px-2 h-[44px] align-middle whitespace-nowrap">Card age</th>
                <th className="px-2 h-[44px] align-middle whitespace-nowrap font-sans">Status / loc</th>
                <th className="px-2 h-[44px] align-middle min-w-[5rem] max-w-[8rem] font-sans">Remarks</th>
                <th className="px-2 h-[44px] align-middle w-[72px] text-right"> </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {filteredShades.map((s) => {
                const status = s.custodyStatus ?? ''
                const entry = s.entryDate ?? (s.createdAt ? s.createdAt.slice(0, 10) : '—')
                const mfg = s.mfgDate?.trim()
                const dateLine = mfg ? mfg : entry
                const months = s.currentAgeMonths ?? null
                const tier = shadeCardAgeTier(months)
                const ageLabel = months == null ? '—' : months.toFixed(2)
                const label =
                  tier === 'expired'
                    ? 'STATUS: EXPIRED'
                    : (s.cardStatusLabel ??
                      (status === 'in_stock' ? 'In-Stock' : status === 'on_floor' ? 'Issued' : custodyLabel(status)))
                const loc =
                  s.locationLabel ??
                  (status === 'in_stock' ? 'Master Rack' : status === 'at_vendor' ? 'Vendor' : s.currentHolder ?? '—')
                const clientName = s.product?.customer?.name?.trim() || s.customer?.name?.trim() || '—'
                const productName =
                  s.product?.cartonName?.trim() || s.productMaster?.trim() || '—'
                const productLinkId = s.product?.id ?? s.productId ?? null
                const awCode =
                  (s.masterArtworkRef?.trim() || s.product?.artworkCode?.trim() || '—') as string

                return (
                  <tr
                    key={s.id}
                    className={`h-[44px] max-h-[44px] hover:bg-ds-main/50 ${
                      tier === 'expired' ? 'bg-[rgba(225,29,72,0.15)]' : ''
                    }`}
                  >
                    <td className={`px-2 align-middle text-neutral-500 whitespace-nowrap ${shadeMono}`}>
                      {dateLine}
                    </td>
                    <td className="px-2 align-middle min-w-0">
                      <div className="flex items-start gap-1.5 min-w-0">
                        <button
                          type="button"
                          onClick={() => void openShadeAudit(s.id)}
                          className="shrink-0 mt-0.5 text-neutral-500 hover:text-sky-400 p-0.5 rounded"
                          title="Custody history"
                          aria-label="Open custody history"
                        >
                          <History className="h-3.5 w-3.5" />
                        </button>
                        {productLinkId ? (
                          <Link
                            href={`/product/${productLinkId}`}
                            className="min-w-0 flex-1 block rounded hover:bg-ds-card/50 -m-0.5 p-0.5"
                          >
                            <p className="font-bold text-emerald-400 truncate leading-tight font-sans">{clientName}</p>
                            <p className="text-[14px] text-foreground truncate leading-snug font-sans">{productName}</p>
                          </Link>
                        ) : (
                          <div className="min-w-0">
                            <p className="font-bold text-emerald-400 truncate leading-tight font-sans">{clientName}</p>
                            <p className="text-[14px] text-foreground truncate leading-snug font-sans">{productName}</p>
                          </div>
                        )}
                      </div>
                    </td>
                    <td className={`px-2 align-middle text-neutral-400 ${shadeMono}`}>
                      <div className="leading-tight">
                        <p className="text-[11px] text-ds-warning/95 whitespace-nowrap">{s.shadeCode}</p>
                        <p className="text-[10px] text-neutral-500 whitespace-nowrap">{awCode}</p>
                      </div>
                    </td>
                    <td className="px-2 align-middle whitespace-nowrap">
                      {months == null ? (
                        <span className="text-neutral-600">—</span>
                      ) : tier === 'fresh' ? (
                        <span className={`text-[10px] font-medium text-emerald-500 ${shadeMono}`}>{ageLabel} mo</span>
                      ) : tier === 'reverify' ? (
                        <span className={`inline-flex items-center gap-1 text-[10px] font-medium text-ds-warning ${shadeMono}`}>
                          {shadeCardIsApproachingHardExpiry(months) ? (
                            <span
                              className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full border border-ds-warning/60 bg-ds-warning/8 px-0.5 text-[9px] font-black text-ds-warning animate-pulse"
                              title="Approaching 12-month expiry. Prepare replacement."
                            >
                              !
                            </span>
                          ) : null}
                          <RefreshCw className="h-3 w-3 shrink-0 animate-pulse" aria-hidden />
                          {ageLabel} mo
                        </span>
                      ) : (
                        <span className={`inline-flex items-center gap-1 text-[10px] font-medium text-rose-500 ${shadeMono}`}>
                          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                          EXPIRED · {ageLabel} mo
                        </span>
                      )}
                    </td>
                    <td className="px-2 align-middle">
                      <div className="flex flex-wrap gap-1">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-medium border font-sans ${
                            tier === 'expired'
                              ? 'bg-rose-950/80 text-rose-100 border-rose-500/40'
                              : 'bg-ds-elevated text-ds-ink border-ds-line/50'
                          }`}
                        >
                          {label}
                        </span>
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-medium bg-ds-elevated text-neutral-400 border border-ds-line/50 ${shadeMono}`}
                        >
                          {loc}
                        </span>
                      </div>
                    </td>
                    <td className="px-2 align-middle max-w-[8rem]">
                      <ShadeSmartRemark
                        text={s.remarks}
                        editedBy={s.remarksEditedByName}
                        editedAtIso={s.remarksEditedAt}
                        updatedAtIso={s.updatedAt}
                        monoClass={shadeMono}
                      />
                    </td>
                    <td className="px-2 align-middle text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => openIssue(s.id)}
                        disabled={status !== 'in_stock' || tier === 'expired'}
                        title={tier === 'expired' ? 'Card expired (≥12 mo) — replace before issue' : 'Issue to machine'}
                        className="inline-flex p-1.5 rounded text-sky-400 hover:bg-ds-card disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <Send className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => openReceive(s.id)}
                        disabled={status !== 'on_floor'}
                        title="Receive to rack"
                        className="inline-flex p-1.5 rounded text-emerald-400 hover:bg-ds-card disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <Inbox className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </EnterpriseTableShell>
      )}

      {issueOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4">
          <div
            className={`w-full max-w-md rounded-lg border border-ds-line/60 bg-ds-card p-4 space-y-3 text-sm ${
              toolType === 'shade_cards' ? shadeMono : ''
            }`}
          >
            <h2 className="text-lg font-semibold text-foreground font-sans">
              {toolType === 'shade_cards' ? 'Issue to floor (live custody)' : 'Issue to machine'}
            </h2>
            {toolType === 'shade_cards' ? (
              <>
                <label className="block text-ds-ink-muted font-sans">
                  Job card link <span className="text-ds-warning font-normal">(required)</span>
                  <input
                    value={jobCardQuery}
                    onChange={(e) => {
                      setJobCardQuery(e.target.value)
                      setIssueJobCardId('')
                      setIssueJobCardNumber(null)
                    }}
                    placeholder="Search # or customer…"
                    className="mt-1 w-full px-2 py-2 rounded bg-background border border-input text-foreground"
                  />
                </label>
                {issueJobCardId && issueJobCardNumber != null ? (
                  <p className="text-xs text-emerald-300 font-sans">
                    <span className={shadeMono}>JC #{issueJobCardNumber}</span> linked
                    <button
                      type="button"
                      className="ml-2 text-sky-400 underline font-sans"
                      onClick={() => {
                        setIssueJobCardId('')
                        setIssueJobCardNumber(null)
                        setJobCardQuery('')
                      }}
                    >
                      Clear
                    </button>
                  </p>
                ) : null}
                {jobCardLoading ? <p className="text-xs text-ds-ink-faint font-sans">Searching…</p> : null}
                {!issueJobCardId && jobCardHits.length > 0 ? (
                  <ul className="max-h-32 overflow-y-auto rounded border border-ds-line/50 divide-y divide-ds-line/30 text-xs font-sans">
                    {jobCardHits.map((jc) => (
                      <li key={jc.id}>
                        <button
                          type="button"
                          className="w-full text-left px-2 py-1.5 hover:bg-ds-elevated text-ds-ink"
                          onClick={() => {
                            setIssueJobCardId(jc.id)
                            setIssueJobCardNumber(jc.jobCardNumber)
                            setJobCardQuery(`#${jc.jobCardNumber} · ${jc.customer.name}`)
                          }}
                        >
                          <span className={shadeMono}>JC #{jc.jobCardNumber}</span>
                          <span className="text-ds-ink-faint"> · </span>
                          {jc.customer.name}
                          <span className="text-ds-ink-faint"> · {jc.status}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
            <label className="block text-ds-ink-muted font-sans">
              {toolType === 'shade_cards' ? 'Assign to machine' : 'Machine'}
              <select
                value={machineId}
                onChange={(e) => setMachineId(e.target.value)}
                className="mt-1 w-full px-2 py-2 rounded bg-background border border-input text-foreground"
              >
                <option value="">Select machine</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.machineCode} — {m.name}
                  </option>
                ))}
              </select>
            </label>
            {toolType === 'shade_cards' ? (
              <label className="block text-ds-ink-muted font-sans">
                Initial condition (checkout)
                <select
                  value={shadeIssueInitialCondition}
                  onChange={(e) =>
                    setShadeIssueInitialCondition(e.target.value as 'mint' | 'used' | 'minor_damage')
                  }
                  className={`mt-1 w-full px-2 py-2 rounded bg-background border border-input text-foreground ${shadeMono}`}
                >
                  <option value="mint">{shadeCardPhysicalLabel('mint')}</option>
                  <option value="used">{shadeCardPhysicalLabel('used')}</option>
                  <option value="minor_damage">{shadeCardPhysicalLabel('minor_damage')}</option>
                </select>
              </label>
            ) : null}
            {toolType === 'shade_cards' ? (
              <label className="block text-ds-ink-muted font-sans">
                Operator search
                <input
                  value={issueOperatorSearch}
                  onChange={(e) => setIssueOperatorSearch(e.target.value)}
                  placeholder="Filter staff…"
                  className={`mt-1 w-full px-2 py-2 rounded bg-background border border-input text-foreground ${shadeMono}`}
                />
              </label>
            ) : null}
            <label className="block text-ds-ink-muted font-sans">
              Operator
              <select
                value={operatorId}
                onChange={(e) => setOperatorId(e.target.value)}
                className="mt-1 w-full px-2 py-2 rounded bg-background border border-input text-foreground"
              >
                <option value="">Select operator</option>
                {(toolType === 'shade_cards' ? filteredIssueOperators : users).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            {toolType === 'shade_cards' ? (
              <p className="text-[10px] text-ds-ink-faint font-sans">
                Sets custody to <span className="text-ds-ink-muted">On-Floor</span> and location to the machine code.
              </p>
            ) : null}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setIssueOpen(false)} className="px-3 py-1.5 rounded border border-ds-line/60 text-ds-ink font-sans">
                Cancel
              </button>
              <button type="button" onClick={() => void submitIssue()} className="px-3 py-1.5 rounded bg-primary text-primary-foreground font-sans">
                {toolType === 'shade_cards' ? 'Confirm issue' : 'Issue to machine'}
              </button>
            </div>
          </div>
        </div>
      )}

      {vendorOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4">
          <div className="w-full max-w-md rounded-lg border border-ds-warning/30 bg-ds-card p-4 space-y-3 text-sm">
            <h2 className="text-lg font-semibold text-foreground">Receive from vendor</h2>
            <p className="text-ds-ink-muted text-xs">Confirms the tool is back from the vendor and returns it to <span className="text-emerald-300">In Stock</span>.</p>
            <label className="block text-ds-ink-muted">
              Notes (optional)
              <textarea
                value={vendorNotes}
                onChange={(e) => setVendorNotes(e.target.value)}
                rows={3}
                placeholder="PO ref, triage notes…"
                className="mt-1 w-full px-2 py-2 rounded bg-background border border-input text-foreground resize-y"
              />
            </label>
            {toolType !== 'shade_cards' && (
              <label className="block text-ds-ink-muted">
                Condition
                <select
                  value={vendorCondition}
                  onChange={(e) => setVendorCondition(e.target.value as (typeof RECEIVE_CONDITIONS)[number])}
                  className="mt-1 w-full px-2 py-2 rounded bg-background border border-input text-foreground"
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
              <button type="button" onClick={() => setVendorOpen(false)} className="px-3 py-1.5 rounded border border-ds-line/60 text-ds-ink">
                Cancel
              </button>
              <button type="button" onClick={() => void submitVendorReceive()} className="px-3 py-1.5 rounded bg-primary text-primary-foreground">
                Receive to stock
              </button>
            </div>
          </div>
        </div>
      )}

      {receiveOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4">
          <div className="w-full max-w-md rounded-lg border border-ds-line/60 bg-ds-card p-4 space-y-3 text-sm">
            <h2 className="text-lg font-semibold text-foreground">Receive to rack</h2>
            {toolType !== 'shade_cards' && (
              <>
                <label className="block text-ds-ink-muted">
                  Final impressions (added to total)
                  <input
                    type="number"
                    min={0}
                    value={finalImpressions}
                    onChange={(e) => setFinalImpressions(e.target.value === '' ? '' : Number(e.target.value))}
                    className="mt-1 w-full px-2 py-2 rounded bg-background border border-input text-foreground"
                  />
                </label>
                <label className="block text-ds-ink-muted">
                  Condition
                  <select
                    value={receiveCondition}
                    onChange={(e) => setReceiveCondition(e.target.value as (typeof RECEIVE_CONDITIONS)[number])}
                    className="mt-1 w-full px-2 py-2 rounded bg-background border border-input text-foreground"
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
              <div className="space-y-3 font-sans">
                <p className="text-ds-ink-muted text-xs">Return the card to master rack stock and set custody to In-Stock.</p>
                <label className="block text-ds-ink-muted text-sm">
                  Returning operator (verify)
                  <input
                    value={receiveOperatorSearch}
                    onChange={(e) => setReceiveOperatorSearch(e.target.value)}
                    placeholder="Search staff…"
                    className={`mt-1 w-full px-2 py-2 rounded bg-background border border-input text-foreground ${shadeMono}`}
                  />
                </label>
                <label className="block text-ds-ink-muted text-sm">
                  Staff pick
                  <select
                    value={receiveOperatorId}
                    onChange={(e) => setReceiveOperatorId(e.target.value)}
                    className="mt-1 w-full px-2 py-2 rounded bg-background border border-input text-foreground"
                  >
                    <option value="">Select operator</option>
                    {filteredReceiveOperators.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-ds-ink-muted text-sm">
                  End condition
                  <select
                    value={shadeReceiveEndCondition}
                    onChange={(e) =>
                      setShadeReceiveEndCondition(e.target.value as 'mint' | 'used' | 'minor_damage')
                    }
                    className={`mt-1 w-full px-2 py-2 rounded bg-background border border-input text-foreground ${shadeMono}`}
                  >
                    <option value="mint">{shadeCardPhysicalLabel('mint')}</option>
                    <option value="used">{shadeCardPhysicalLabel('used')}</option>
                    <option value="minor_damage">{shadeCardPhysicalLabel('minor_damage')}</option>
                  </select>
                </label>
                <label className="block text-ds-ink-muted text-sm">
                  Return to rack
                  <input
                    readOnly
                    value={SHADE_MASTER_RACK_LOCATION}
                    className={`mt-1 w-full px-2 py-2 rounded bg-ds-main border border-ds-line/60 text-ds-ink-muted ${shadeMono}`}
                  />
                </label>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setReceiveOpen(false)} className="px-3 py-1.5 rounded border border-ds-line/60 text-ds-ink">
                Cancel
              </button>
              <button type="button" onClick={() => void submitReceive()} className="px-3 py-1.5 rounded bg-primary text-primary-foreground">
                Receive
              </button>
            </div>
          </div>
        </div>
      )}

      {addShadeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
          <div
            className={`w-full max-w-lg rounded-xl border border-border bg-card p-4 space-y-3 text-sm max-h-[90vh] overflow-y-auto ${shadeMono}`}
          >
            <h2 className="text-lg font-semibold text-ds-warning">Add shade card</h2>
            <p className="text-xs text-neutral-500">
              Card codes auto-generate (SC-####). Status defaults to <span className="text-neutral-400">In-Stock</span>,
              location <span className="text-neutral-400">Master Rack</span>.
            </p>
            <label className="block text-neutral-400 font-sans">
              Manufacturing date <span className="text-rose-400">*</span>
              <input
                type="date"
                required
                value={addMfgDate}
                onChange={(e) => setAddMfgDate(e.target.value)}
                className={`mt-1 w-full px-2 py-2 rounded-lg bg-background border border-input text-foreground ${shadeMono}`}
              />
            </label>
            <label className="block text-neutral-400 font-sans">
              Product Master <span className="text-rose-400">*</span>
              <input
                value={cartonQuery}
                onChange={(e) => setCartonQuery(e.target.value)}
                placeholder="Search by product or customer (2+ characters)…"
                className={`mt-1 w-full px-2 py-2 rounded-lg bg-background border border-input text-foreground ${shadeMono}`}
              />
            </label>
            {cartonSearchLoading && <p className="text-xs text-neutral-500 font-sans">Searching…</p>}
            {cartonHits.length > 0 && (
              <ul className="max-h-36 overflow-y-auto rounded-lg border border-ds-line/40 divide-y divide-ds-card text-xs font-sans">
                {cartonHits.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="w-full text-left px-2 py-1.5 hover:bg-ds-card text-ds-ink"
                      onClick={() => {
                        setAddProductId(c.id)
                        setAddSelectedLabel(`${c.customer.name} · ${c.cartonName}`)
                        setAddAwCode((prev) => (prev.trim() ? prev : (c.artworkCode?.trim() ?? '')))
                      }}
                    >
                      <span className="text-emerald-400 font-semibold">{c.customer.name}</span>
                      <span className="text-neutral-500"> · </span>
                      {c.cartonName}
                      {c.artworkCode ? (
                        <span className={`ml-1 text-ds-warning/90 ${shadeMono}`}>({c.artworkCode})</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {addProductId ? (
              <p className="text-xs text-neutral-500 font-sans rounded-lg border border-ds-line/40 bg-ds-main/80 px-2 py-1.5">
                Selected: <span className="text-ds-ink">{addSelectedLabel}</span>
                <span className={`block mt-0.5 text-[10px] text-neutral-600 ${shadeMono}`}>ID: {addProductId}</span>
              </p>
            ) : (
              <p className="text-[10px] text-neutral-600 font-sans">Pick a row above to link Product Master.</p>
            )}
            <label className="block text-neutral-400 font-sans">
              Substrate type <span className="text-rose-400">*</span>
              <select
                value={addSubstrate}
                onChange={(e) => setAddSubstrate(e.target.value as (typeof SHADE_SUBSTRATE_VALUES)[number])}
                className={`mt-1 w-full px-2 py-2 rounded-lg bg-background border border-input text-foreground ${shadeMono}`}
              >
                {SHADE_SUBSTRATE_VALUES.map((v) => (
                  <option key={v} value={v}>
                    {shadeSubstrateLabel(v)}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-3 gap-2">
              <label className="block text-neutral-400 font-sans col-span-1">
                L* <span className="text-rose-400">*</span>
                <input
                  value={addLabL}
                  onChange={(e) => setAddLabL(e.target.value)}
                  inputMode="decimal"
                  placeholder="e.g. 82.4"
                  className={`mt-1 w-full px-2 py-2 rounded-lg bg-background border border-input text-foreground ${shadeMono}`}
                />
              </label>
              <label className="block text-neutral-400 font-sans col-span-1">
                a* <span className="text-rose-400">*</span>
                <input
                  value={addLabA}
                  onChange={(e) => setAddLabA(e.target.value)}
                  inputMode="decimal"
                  placeholder="e.g. 2.1"
                  className={`mt-1 w-full px-2 py-2 rounded-lg bg-background border border-input text-foreground ${shadeMono}`}
                />
              </label>
              <label className="block text-neutral-400 font-sans col-span-1">
                b* <span className="text-rose-400">*</span>
                <input
                  value={addLabB}
                  onChange={(e) => setAddLabB(e.target.value)}
                  inputMode="decimal"
                  placeholder="e.g. -4.2"
                  className={`mt-1 w-full px-2 py-2 rounded-lg bg-background border border-input text-foreground ${shadeMono}`}
                />
              </label>
            </div>
            <label className="block text-neutral-400 font-sans">
              AW code <span className="text-neutral-500 font-normal">(optional override)</span>
              <input
                value={addAwCode}
                onChange={(e) => setAddAwCode(e.target.value)}
                placeholder="Defaults from product master"
                className={`mt-1 w-full px-2 py-2 rounded-lg bg-background border border-input text-foreground ${shadeMono}`}
              />
            </label>
            <label className="block text-neutral-400 font-sans">
              Quantity
              <input
                type="number"
                min={1}
                max={99}
                value={addQuantity}
                onChange={(e) => setAddQuantity(Math.min(99, Math.max(1, Number(e.target.value) || 1)))}
                className={`mt-1 w-full px-2 py-2 rounded-lg bg-background border border-input text-foreground ${shadeMono}`}
              />
            </label>
            <label className="block text-neutral-400 font-sans">
              Remarks
              <textarea
                value={addRemarks}
                onChange={(e) => setAddRemarks(e.target.value)}
                rows={3}
                placeholder="Lab notes, batch, etc."
                className="mt-1 w-full px-2 py-2 rounded-lg bg-ds-main border border-ds-line/50 text-ds-ink resize-y font-sans"
              />
            </label>
            <p className="text-[10px] text-neutral-600 font-sans border-t border-ds-line/30 pt-2">
              Color Integrity Audit Enabled - 12 Month Limit Enforced.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setAddShadeOpen(false)}
                className="px-3 py-1.5 rounded-lg border border-ds-line/50 text-neutral-400 hover:bg-ds-card font-sans"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitAddShade()}
                className="px-3 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground font-sans font-semibold"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {auditOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4">
          <div className="w-full max-w-md rounded-lg border border-ds-line/60 bg-ds-card p-4 space-y-3 text-sm max-h-[85vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-foreground">Shade card history</h2>
            {auditLoading && <p className="text-ds-ink-muted text-xs">Loading…</p>}
            {!auditLoading && auditPayload && (
              <>
                <p className="text-xs text-ds-ink-muted">
                  <span className="font-mono text-ds-warning">{auditPayload.shadeCard.shadeCode}</span>
                  {auditPayload.shadeCard.productMaster ? ` · ${auditPayload.shadeCard.productMaster}` : ''}
                </p>
                {auditPayload.events.length === 0 ? (
                  <p className="text-ds-ink-faint text-xs">No events yet.</p>
                ) : (
                  <ul className="space-y-2 text-xs border-t border-ds-line/40 pt-2">
                    {auditPayload.events.map((ev) => (
                      <li key={ev.id} className="border-b border-ds-line/50 pb-2">
                        <div className="text-ds-ink-faint">{new Date(ev.createdAt).toLocaleString()}</div>
                        <div className="text-ds-ink">{shadeEventSummary(ev)}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            <div className="flex justify-end pt-2">
              <button type="button" onClick={() => setAuditOpen(false)} className="px-3 py-1.5 rounded border border-ds-line/60 text-ds-ink">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {toolType === 'shade_cards' ? (
        <p className="text-center text-[10px] text-neutral-600 pt-6 border-t border-ds-line/30 font-sans">
          Color Integrity Audit Enabled - 12 Month Limit Enforced.
        </p>
      ) : null}
    </div>
  )
}
