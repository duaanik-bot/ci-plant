'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { AlertTriangle, Check, Search } from 'lucide-react'
import {
  computeTotalPlates,
  defaultDesignerCommand,
  mergeDesignerCommandFromHistory,
  parseDesignerCommand,
  type DesignerCommand,
} from '@/lib/designer-command'
import { getPostPressRouting, isEmbossingRequired } from '@/lib/emboss-conditions'
import {
  HUB_DIE_PUSH_SPECS_MISSING_TOAST,
  HUB_EMBOSS_PUSH_SPECS_MISSING_TOAST,
  HUB_TECHNICAL_DATA_MISSING_TOAST,
  validateDieHubMinimalPushPayload,
  validateEmbossHubMinimalPushPayload,
  validatePayload,
} from '@/lib/validate-hub-payload'
import { safeJsonStringify } from '@/lib/safe-json'
import { PastingStyle } from '@prisma/client'
import { masterDieTypeLabel } from '@/lib/master-die-type'
import { parseCartonSizeToDims } from '@/lib/die-hub-dimensions'
import type { AuthorityPushPayload } from '@/lib/tooling-hub-dispatch-schema'
import { pantoneContrastFg, pantoneHexApprox } from '@/lib/pantone-hex-approx'
import {
  SmartMatchDieModal,
  type SmartMatchDieRow,
} from '@/components/designing/SmartMatchDieModal'

type SpecOverrides = {
  assignedDesignerId?: string
  artworkVersion?: string
  customerApprovalPharma?: boolean
  shadeCardQaTextApproval?: boolean
  numberOfColours?: number
  batchSpace?: string
  ups?: number
  numberOfUps?: number
  actualSheetSize?: string
  prePressRemarks?: string
  laminateType?: string
  artworkId?: string
  jobType?: 'new' | 'repeat'
  /** Linked emboss block (store) when resolved */
  embossBlockId?: string
  [k: string]: unknown
} | null

type CartonMasterDims = {
  id: string
  dieMasterId?: string | null
  dyeId?: string | null
  finishedLength: unknown
  finishedWidth: unknown
  finishedHeight: unknown
  /** Preprinted batch / pharma coding area (mm) from carton master */
  batchSpaceL?: unknown
  batchSpaceW?: unknown
  dieMaster?: {
    id: string
    dyeNumber: number
    dyeType: string
    pastingStyle: PastingStyle | null
  } | null
} | null

type LineDieMaster = {
  id: string
  dyeNumber: number
  dyeType: string
  condition: string
  location: string | null
  cartonSize: string | null
  dimLengthMm: unknown
  dimWidthMm: unknown
  dimHeightMm: unknown
} | null

type DesigningDetail = {
  line: {
    id: string
    cartonId?: string | null
    cartonName: string
    cartonSize: string | null
    quantity: number
    gsm: number | null
    paperType: string | null
    coatingType: string | null
    embossingLeafing: string | null
    artworkCode?: string | null
    dyeId?: string | null
    dieMasterId?: string | null
    dieMaster?: LineDieMaster
    toolingLocked?: boolean
    lineDieType?: string | null
    setNumber: string | null
    planningStatus: string
    specOverrides: SpecOverrides
    carton?: CartonMasterDims
    po: {
      poNumber: string
      customer: { id: string; name: string }
    }
  }
  checks: Record<string, boolean>
  links: { po: string; planning: string; jobCard: string | null }
  /** Production job card linked to this PO line (from API — use `.id` for hub APIs, not `links.jobCard` URL). */
  jobCard?: { id: string } | null
}

/** Batch coding area: explicit spec string, RFQ-style object, spec mm fields, or carton master L×W. */
function formatPreprintedBatchSpace(line: DesigningDetail['line']): string {
  const spec = (line.specOverrides || {}) as Record<string, unknown>
  const direct = spec.batchSpace
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    const o = direct as Record<string, unknown>
    const w = o.w ?? o.W ?? o.width
    const h = o.h ?? o.H ?? o.length ?? o.l ?? o.L
    if (w != null && h != null && String(w).trim() && String(h).trim()) {
      return `${w} × ${h} mm`
    }
  }
  const sl = spec.batchSpaceL
  const sw = spec.batchSpaceW
  if (sl != null && sw != null && String(sl).trim() && String(sw).trim()) {
    return `${sl} × ${sw} mm`
  }
  const c = line.carton
  if (c?.batchSpaceL != null && c?.batchSpaceW != null) {
    const l = c.batchSpaceL
    const w = c.batchSpaceW
    if (String(l).trim() && String(w).trim()) return `${l} × ${w} mm`
  }
  return '-'
}

type User = { id: string; name: string }

const manualInputClass =
  'mt-1 w-full px-2 py-1.5 rounded bg-black text-white text-sm border border-white/20 focus:border-amber-500/80 focus:outline-none focus:ring-1 focus:ring-amber-500/40 placeholder:text-slate-600'

const monoInputClass = `${manualInputClass} font-mono tabular-nums tracking-tight`

/** L×W×H for hub push validation (PO line + carton master). */
function fmtLineCartonSizeLwh(line: {
  cartonSize?: string | null
  carton?: CartonMasterDims | null
}): string {
  if (line.cartonSize?.trim()) return line.cartonSize.trim()
  const c = line.carton
  if (!c) return ''
  const fmt = (v: unknown) => {
    if (v == null || v === '') return ''
    const n = Number(v)
    return Number.isFinite(n) ? String(n) : String(v)
  }
  const L = fmt(c.finishedLength)
  const W = fmt(c.finishedWidth)
  const H = fmt(c.finishedHeight)
  if (L && W && H) return `${L}×${W}×${H}`
  return ''
}

function CartonDimensionsRow({
  carton,
  right,
}: {
  carton: CartonMasterDims | null | undefined
  right?: ReactNode
}) {
  const fmt = (v: unknown) => {
    if (v == null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? String(n) : String(v)
  }
  const L = fmt(carton?.finishedLength)
  const W = fmt(carton?.finishedWidth)
  const H = fmt(carton?.finishedHeight)
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 sm:col-span-3 border-b border-white/10 sm:border-0 pb-2 sm:pb-0">
      <span className="text-slate-500 shrink-0 text-xs">Carton dimensions (L × W × H)</span>
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <span className="flex flex-wrap items-center gap-x-2 text-slate-100 text-sm font-mono tabular-nums tracking-tight min-w-0">
          <span>{L ?? '—'}</span>
          <span className="text-slate-500">×</span>
          <span>{W ?? '—'}</span>
          <span className="text-slate-500">×</span>
          <span>{H ?? '—'}</span>
        </span>
        {right}
      </div>
    </div>
  )
}

function fmtDieDimsMm(dm: NonNullable<LineDieMaster>): string {
  if (dm.dimLengthMm != null && dm.dimWidthMm != null && dm.dimHeightMm != null) {
    return `${dm.dimLengthMm}×${dm.dimWidthMm}×${dm.dimHeightMm}`
  }
  return (dm.cartonSize || '').trim() || '—'
}

function buildAuthorityPush(
  line: DesigningDetail['line'],
  remarksTrim: string,
): {
  directorLabel: string
  specialRemarks?: string
  linkedDieMaster?: {
    id: string
    dyeNumber: number
    dyeType: string
    condition?: string
    location?: string | null
    cartonSize?: string | null
    dimsMm?: string
  }
} {
  const dm = line.dieMaster
  const cm = line.carton?.dieMaster
  const linked = dm
    ? {
        id: dm.id,
        dyeNumber: dm.dyeNumber,
        dyeType: dm.dyeType,
        condition: dm.condition,
        location: dm.location,
        cartonSize: dm.cartonSize,
        dimsMm: fmtDieDimsMm(dm),
      }
    : cm
      ? {
          id: cm.id,
          dyeNumber: cm.dyeNumber,
          dyeType: cm.dyeType,
          dimsMm: '—',
        }
      : undefined
  return {
    directorLabel: 'Anik Dua',
    specialRemarks: remarksTrim || undefined,
    linkedDieMaster: linked,
  }
}

function formatHubSentAt(iso?: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('en-IN', {
      dateStyle: 'short',
      timeStyle: 'short',
    })
  } catch {
    return iso
  }
}

export default function DesigningDetailPage() {
  const params = useParams()
  const router = useRouter()
  const poLineId = params.poLineId as string
  const [data, setData] = useState<DesigningDetail | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [savingDesigner, setSavingDesigner] = useState(false)
  const [savingSpecs, setSavingSpecs] = useState(false)
  const [finalizing, setFinalizing] = useState(false)

  const [setNumberInput, setSetNumberInput] = useState('')
  const [artworkCodeInput, setArtworkCodeInput] = useState('')
  const [actualSheetSizeInput, setActualSheetSizeInput] = useState('')
  const [numberOfUpsInput, setNumberOfUpsInput] = useState('')
  const [prePressRemarksInput, setPrePressRemarksInput] = useState('')
  const [customerApproval, setCustomerApproval] = useState(false)
  const [qaTextApproval, setQaTextApproval] = useState(false)
  /** Smart set #: idle | loading | matched (history returned a set #) | empty (no history) */
  const [setLookupState, setSetLookupState] = useState<'idle' | 'loading' | 'matched' | 'empty'>('idle')
  /** True only when history API returned 404 (no plate/line history for carton). */
  const [historyNoMatch, setHistoryNoMatch] = useState(false)
  const [artworkRepeatJob, setArtworkRepeatJob] = useState(false)
  const [savingSetAw, setSavingSetAw] = useState(false)
  const [designerCommand, setDesignerCommand] = useState<DesignerCommand>(() => defaultDesignerCommand())
  const [historyDesignerCommand, setHistoryDesignerCommand] = useState<DesignerCommand | null>(null)
  const [savingDesignerCommand, setSavingDesignerCommand] = useState(false)
  const [jobType, setJobType] = useState<'new' | 'repeat'>('new')
  const [plateHubSent, setPlateHubSent] = useState(false)
  /** Resolved from DB: artwork.filename matches AW code for this PO customer */
  const [resolvedArtworkId, setResolvedArtworkId] = useState<string | null>(null)
  const historyDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    fetch(`/api/designing/po-lines/${poLineId}`)
      .then((r) => r.json())
      .then((json: DesigningDetail | { error?: string }) => {
        if ('error' in json && json.error) throw new Error(json.error)
        setData(json as DesigningDetail)
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [poLineId])

  useEffect(() => {
    if (!data?.line) return
    const spec = data.line.specOverrides || {}
    setSetNumberInput(data.line.setNumber?.trim() ?? '')
    setArtworkCodeInput((data.line.artworkCode || '').trim())
    setActualSheetSizeInput(
      typeof spec.actualSheetSize === 'string' ? spec.actualSheetSize : '',
    )
    const upsVal = spec.ups ?? spec.numberOfUps
    setNumberOfUpsInput(
      typeof upsVal === 'number' && Number.isFinite(upsVal) ? String(upsVal) : '',
    )
    setPrePressRemarksInput(typeof spec.prePressRemarks === 'string' ? spec.prePressRemarks : '')
    setCustomerApproval(!!spec.customerApprovalPharma)
    setQaTextApproval(!!spec.shadeCardQaTextApproval)
    setDesignerCommand(parseDesignerCommand(spec.designerCommand))
    setJobType(spec.jobType === 'repeat' ? 'repeat' : 'new')
    // Restore finalized state from DB so page refreshes show correct button
    if (spec.prePressSentToPlateHubAt) {
      setPlateHubSent(true)
    }
  }, [data?.line])

  useEffect(() => {
    fetch('/api/users')
      .then((r) => r.json())
      .then((list: unknown) => setUsers(Array.isArray(list) ? (list as User[]) : []))
      .catch(() => {})
  }, [])

  const saveDesigner = async (assignedDesignerId: string | undefined) => {
    if (!data) return
    setSavingDesigner(true)
    try {
      const specOverrides = {
        ...(data.line.specOverrides || {}),
        assignedDesignerId: assignedDesignerId || undefined,
      }
      const res = await fetch(`/api/planning/po-lines/${poLineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specOverrides }),
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Save failed')
      setData((prev) =>
        prev
          ? {
              ...prev,
              line: { ...prev.line, specOverrides },
            }
          : null,
      )
      toast.success('Designer updated')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSavingDesigner(false)
    }
  }

  const persistApprovals = useCallback(
    async (next: { customer: boolean; qa: boolean }) => {
      if (!data) return
      setSavingSpecs(true)
      try {
        const specOverrides = {
          ...(data.line.specOverrides || {}),
          customerApprovalPharma: next.customer,
          shadeCardQaTextApproval: next.qa,
        }
        const res = await fetch(`/api/planning/po-lines/${poLineId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ specOverrides }),
        })
        const json = (await res.json()) as { error?: string }
        if (!res.ok) throw new Error(json.error || 'Save failed')
        setData((prev) =>
          prev
            ? {
                ...prev,
                line: { ...prev.line, specOverrides },
              }
            : null,
        )
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to save')
      } finally {
        setSavingSpecs(false)
      }
    },
    [data, poLineId],
  )

  const persistDesignerCommand = useCallback(
    async (next: DesignerCommand, options?: { skipLoading?: boolean }) => {
      if (!data) return
      if (!options?.skipLoading) setSavingDesignerCommand(true)
      try {
        const specOverrides = {
          ...(data.line.specOverrides || {}),
          jobType,
          designerCommand: next,
        }
        const res = await fetch(`/api/planning/po-lines/${poLineId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ specOverrides }),
        })
        const json = (await res.json()) as { error?: string }
        if (!res.ok) throw new Error(json.error || 'Save failed')
        setDesignerCommand(next)
        setData((prev) =>
          prev
            ? {
                ...prev,
                line: { ...prev.line, specOverrides },
              }
            : null,
        )
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to save')
      } finally {
        if (!options?.skipLoading) setSavingDesignerCommand(false)
      }
    },
    [data, poLineId, jobType],
  )

  const persistJobType = useCallback(
    async (next: 'new' | 'repeat') => {
      if (!data) return
      setJobType(next)
      try {
        const specOverrides = {
          ...(data.line.specOverrides || {}),
          jobType: next,
        }
        const res = await fetch(`/api/planning/po-lines/${poLineId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ specOverrides }),
        })
        const json = (await res.json()) as { error?: string }
        if (!res.ok) throw new Error(json.error || 'Save failed')
        setData((prev) =>
          prev
            ? {
                ...prev,
                line: { ...prev.line, specOverrides },
              }
            : null,
        )
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to save job type')
      }
    },
    [data, poLineId],
  )

  const reloadLine = useCallback(async () => {
    try {
      const r = await fetch(`/api/designing/po-lines/${poLineId}`)
      const json = (await r.json()) as DesigningDetail | { error?: string }
      if ('error' in json && json.error) throw new Error(json.error)
      setData(json as DesigningDetail)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to refresh')
    }
  }, [poLineId])

  const [smartMatchOpen, setSmartMatchOpen] = useState(false)
  const [smartMatchRows, setSmartMatchRows] = useState<SmartMatchDieRow[]>([])
  const [smartMatchTarget, setSmartMatchTarget] = useState('')
  const [smartMatchTol, setSmartMatchTol] = useState(1)
  const [smartMatchBusyId, setSmartMatchBusyId] = useState<string | null>(null)

  const openSmartMatch = async () => {
    try {
      const r = await fetch(`/api/designing/po-lines/${poLineId}/smart-match-dies`)
      const j = (await r.json()) as {
        matches?: SmartMatchDieRow[]
        targetDims?: string
        toleranceMm?: number
        message?: string
        error?: string
      }
      if (!r.ok) throw new Error(j.message || j.error || 'Smart match failed')
      setSmartMatchRows(j.matches ?? [])
      setSmartMatchTarget(j.targetDims ?? '')
      setSmartMatchTol(j.toleranceMm ?? 1)
      setSmartMatchOpen(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Smart match failed')
    }
  }

  const linkDieFromSmartMatch = async (row: SmartMatchDieRow) => {
    setSmartMatchBusyId(row.id)
    try {
      const res = await fetch(`/api/planning/po-lines/${poLineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dieMasterId: row.id }),
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Link failed')
      await reloadLine()
      setSmartMatchOpen(false)
      toast.success(`Linked die master #${row.serialNumber}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Link failed')
    } finally {
      setSmartMatchBusyId(null)
    }
  }

  useEffect(() => {
    if (!data?.line) return
    if (data.line.setNumber?.trim()) return
    const aw = (data.line.artworkCode || '').trim()
    const cid = data.line.po.customer.id
    if (!aw || !cid) return
    let cancelled = false
    void (async () => {
      const r = await fetch(
        `/api/designing/customer-aw-set-history?customerId=${encodeURIComponent(cid)}&awCode=${encodeURIComponent(aw)}&excludeLineId=${encodeURIComponent(poLineId)}`,
      )
      const j = (await r.json()) as { setNumber?: string | null }
      if (cancelled || !j.setNumber?.trim()) return
      setSetNumberInput((prev) => (prev.trim() ? prev : j.setNumber!.trim()))
      toast.message(
        `Set # from latest ${data.line.po.customer.name} + AW (${aw}): ${j.setNumber}`,
      )
    })()
    return () => {
      cancelled = true
    }
  }, [data?.line?.id, data?.line?.artworkCode, data?.line?.setNumber, data?.line?.po.customer.id, poLineId])

  type ToolingApiBody = {
    toolType: 'DIE' | 'BLOCK'
    jobId: string
    jobCardId: string
    artworkId?: string
    awCode?: string
    actualSheetSize?: string
    ups?: number
    cartonSize?: string
    cartonId?: string
    setNumber: string
    source: 'NEW' | 'OLD'
    blockType?: string
    authorityPush: AuthorityPushPayload
  }

  const buildToolingBody = (tool: 'die' | 'emboss', forHub = false): ToolingApiBody | null => {
    if (!data?.line) return null
    const artworkIdRaw =
      String(data.line.specOverrides?.artworkId ?? '').trim() || resolvedArtworkId?.trim() || ''
    const artworkId = artworkIdRaw || undefined
    const setTrim = setNumberInput.trim()
    const jobCardIdStrict = data.jobCard?.id?.trim() || ''
    const hubJobCardId = jobCardIdStrict || data.line.id
    const setNumber = forHub ? setTrim || 'MANUAL' : setTrim
    const src = tool === 'die' ? designerCommand.dieSource : designerCommand.embossSource
    if (!src) return null
    if (!forHub) {
      if (!setTrim || !/^\d+$/.test(setTrim) || !jobCardIdStrict) return null
    }

    const authorityPush = buildAuthorityPush(data.line, prePressRemarksInput.trim())

    if (tool === 'emboss') {
      if (!forHub) {
        if (!artworkId) return null
        return {
          toolType: 'BLOCK',
          jobId: data.line.id,
          jobCardId: jobCardIdStrict,
          artworkId,
          setNumber,
          source: src === 'new' ? 'NEW' : 'OLD',
          authorityPush,
        }
      }
      const aw =
        artworkCodeInput.trim() ||
        (data.line.artworkCode || '').trim() ||
        'MANUAL'
      const sheet = actualSheetSizeInput.trim()
      const cartonSize = fmtLineCartonSizeLwh(data.line)
      if (!sheet || !cartonSize || !parseCartonSizeToDims(cartonSize)) return null
      const blockType = (data.line.embossingLeafing || 'Embossing').trim()
      return {
        toolType: 'BLOCK',
        jobId: data.line.id,
        jobCardId: hubJobCardId,
        setNumber,
        source: src === 'new' ? 'NEW' : 'OLD',
        ...(artworkId ? { artworkId } : {}),
        awCode: aw,
        actualSheetSize: sheet,
        blockType,
        cartonSize,
        ...(data.line.cartonId?.trim() ? { cartonId: data.line.cartonId.trim() } : {}),
        authorityPush,
      }
    }

    if (!forHub) {
      if (!artworkId) return null
      return {
        toolType: 'DIE',
        jobId: data.line.id,
        jobCardId: jobCardIdStrict,
        artworkId,
        setNumber,
        source: src === 'new' ? 'NEW' : 'OLD',
        authorityPush,
      }
    }

    const aw =
      artworkCodeInput.trim() ||
      (data.line.artworkCode || '').trim() ||
      'MANUAL'
    const sheet = actualSheetSizeInput.trim()
    const upsRaw = numberOfUpsInput.trim()
    const upsNum = upsRaw ? Number(upsRaw) : NaN
    const upsOk = Number.isFinite(upsNum) && upsNum >= 1 && Math.floor(upsNum) === upsNum
    const cartonSize = fmtLineCartonSizeLwh(data.line)
    if (!sheet || !upsOk || !cartonSize || !parseCartonSizeToDims(cartonSize)) return null

    return {
      toolType: 'DIE',
      jobId: data.line.id,
      jobCardId: hubJobCardId,
      setNumber,
      source: src === 'new' ? 'NEW' : 'OLD',
      ...(artworkId ? { artworkId } : {}),
      awCode: aw,
      actualSheetSize: sheet,
      ups: Math.floor(upsNum),
      cartonSize,
      ...(data.line.cartonId?.trim() ? { cartonId: data.line.cartonId.trim() } : {}),
      authorityPush,
    }
  }

  const assertDieHubPayload = (body: ToolingApiBody | null): body is ToolingApiBody => {
    if (!body || body.toolType !== 'DIE') {
      toast.error(HUB_DIE_PUSH_SPECS_MISSING_TOAST)
      return false
    }
    const v = validateDieHubMinimalPushPayload({
      actualSheetSize: body.actualSheetSize,
      ups: body.ups ?? numberOfUpsInput,
      cartonSize: body.cartonSize,
    })
    if (!v.ok) {
      toast.error(HUB_DIE_PUSH_SPECS_MISSING_TOAST)
      return false
    }
    return true
  }

  const assertEmbossHubPayload = (body: ToolingApiBody | null): body is ToolingApiBody => {
    if (!body || body.toolType !== 'BLOCK') {
      toast.error(HUB_EMBOSS_PUSH_SPECS_MISSING_TOAST)
      return false
    }
    const v = validateEmbossHubMinimalPushPayload({
      actualSheetSize: body.actualSheetSize,
      cartonSize: body.cartonSize,
    })
    if (!v.ok) {
      toast.error(HUB_EMBOSS_PUSH_SPECS_MISSING_TOAST)
      return false
    }
    return true
  }

  const assertToolingPayload = (body: ToolingApiBody | null): body is ToolingApiBody => {
    if (!body) {
      toast.error(HUB_TECHNICAL_DATA_MISSING_TOAST)
      return false
    }
    if (!body.artworkId?.trim()) {
      toast.error(HUB_TECHNICAL_DATA_MISSING_TOAST)
      return false
    }
    const v = validatePayload({
      artworkId: body.artworkId,
      jobCardId: body.jobCardId,
      setNumber: body.setNumber,
    })
    if (!v.ok) {
      toast.error(HUB_TECHNICAL_DATA_MISSING_TOAST)
      return false
    }
    return true
  }

  const apiErrorMessage = (json: { error?: string; fields?: Record<string, string> }) => {
    const f = json.fields && Object.values(json.fields)[0]
    return f || json.error || 'Request failed'
  }

  const dieSendToVendor = async () => {
    if (!data || designerCommand.dieSource !== 'new') return
    const body = buildToolingBody('die')
    if (!assertToolingPayload(body)) return
    setSavingDesignerCommand(true)
    try {
      const res = await fetch('/api/procurement/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify(body),
      })
      const json = (await res.json()) as { error?: string; fields?: Record<string, string> }
      if (!res.ok) throw new Error(apiErrorMessage(json))
      const now = new Date().toISOString()
      await persistDesignerCommand(
        {
          ...designerCommand,
          dieLastIntent: 'vendor_po',
          dieLastIntentAt: now,
        },
        { skipLoading: true },
      )
      toast.success('Send to vendor — procurement request logged')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Procurement failed')
    } finally {
      setSavingDesignerCommand(false)
    }
  }

  const diePushToHub = async () => {
    if (!data || !designerCommand.dieSource) return
    const body = buildToolingBody('die', true)
    if (!assertDieHubPayload(body)) return
    setSavingDesignerCommand(true)
    try {
      const res = await fetch('/api/tooling-hub/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify(body),
      })
      const json = (await res.json()) as { error?: string; fields?: Record<string, string> }
      if (!res.ok) throw new Error(apiErrorMessage(json))
      const now = new Date().toISOString()
      const intent =
        designerCommand.dieSource === 'new'
          ? ('die_hub' as const)
          : ('store_retrieval' as const)
      await persistDesignerCommand(
        {
          ...designerCommand,
          dieLastIntent: intent,
          dieLastIntentAt: now,
        },
        { skipLoading: true },
      )
      toast.success(
        designerCommand.dieSource === 'new'
          ? 'Pushed to Die Hub (internal prep)'
          : 'Inventory retrieval sent to tooling hub',
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Dispatch failed')
    } finally {
      setSavingDesignerCommand(false)
    }
  }

  const embossSendToVendor = async () => {
    if (!data || designerCommand.embossSource !== 'new') return
    const body = buildToolingBody('emboss')
    if (!assertToolingPayload(body)) return
    setSavingDesignerCommand(true)
    try {
      const res = await fetch('/api/procurement/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify(body),
      })
      const json = (await res.json()) as { error?: string; fields?: Record<string, string> }
      if (!res.ok) throw new Error(apiErrorMessage(json))
      const now = new Date().toISOString()
      await persistDesignerCommand(
        {
          ...designerCommand,
          embossLastIntent: 'vendor_po',
          embossLastIntentAt: now,
        },
        { skipLoading: true },
      )
      toast.success('Send to vendor — procurement request logged')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Procurement failed')
    } finally {
      setSavingDesignerCommand(false)
    }
  }

  const embossPushToHub = async () => {
    if (!data || !designerCommand.embossSource) return
    const body = buildToolingBody('emboss', true)
    if (!assertEmbossHubPayload(body)) return
    setSavingDesignerCommand(true)
    try {
      const res = await fetch('/api/tooling-hub/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify(body),
      })
      const json = (await res.json()) as { error?: string; fields?: Record<string, string> }
      if (!res.ok) throw new Error(apiErrorMessage(json))
      const now = new Date().toISOString()
      const intent =
        designerCommand.embossSource === 'new'
          ? ('emboss_hub' as const)
          : ('store_retrieval' as const)
      await persistDesignerCommand(
        {
          ...designerCommand,
          embossLastIntent: intent,
          embossLastIntentAt: now,
        },
        { skipLoading: true },
      )
      toast.success(
        designerCommand.embossSource === 'new'
          ? 'Pushed to Embossing Hub (internal prep)'
          : 'Inventory retrieval sent to tooling hub',
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Dispatch failed')
    } finally {
      setSavingDesignerCommand(false)
    }
  }

  const fetchHistorySmartSet = useCallback(
    async (awRaw: string, repeatMode: boolean) => {
      const aw = awRaw.trim()
      if (!aw) {
        setSetLookupState('idle')
        setHistoryDesignerCommand(null)
        setHistoryNoMatch(false)
        return
      }
      if (!repeatMode) {
        setSetLookupState('idle')
        setHistoryNoMatch(false)
        setHistoryDesignerCommand(null)
        return
      }
      const cid = data?.line?.cartonId?.trim()
      if (!cid) {
        setSetLookupState('idle')
        setHistoryNoMatch(false)
        return
      }
      setSetLookupState('loading')
      setHistoryNoMatch(false)
      try {
        const params = new URLSearchParams({
          cartonId: cid,
          awCode: aw,
          excludeLineId: poLineId,
        })
        const aid = (data?.line?.specOverrides?.artworkId as string | undefined)?.trim()
        if (aid) params.set('artworkId', aid)
        const r = await fetch(`/api/jobs/history-lookup?${params}`)
        if (r.status === 404) {
          setHistoryNoMatch(true)
          setHistoryDesignerCommand(null)
          setSetLookupState('empty')
          return
        }
        if (!r.ok) {
          setSetLookupState('idle')
          return
        }
        const json = (await r.json()) as {
          setNumber: string | null
          actualSheetSize: string | null
          numberOfUps: number | null
          previousDesignerCommand: DesignerCommand | null
        }
        const sn = json.setNumber?.trim()
        const sheet = json.actualSheetSize?.trim()
        const upsN = json.numberOfUps
        const hasHistory =
          !!sn ||
          !!sheet ||
          (upsN != null && Number.isFinite(upsN) && upsN > 0)
        if (sn) setSetNumberInput(sn)
        if (sheet) setActualSheetSizeInput(sheet)
        if (upsN != null && Number.isFinite(upsN) && upsN > 0) {
          setNumberOfUpsInput(String(upsN))
        }
        setHistoryDesignerCommand(json.previousDesignerCommand ?? null)
        setDesignerCommand((prev) =>
          mergeDesignerCommandFromHistory(prev, json.previousDesignerCommand ?? null),
        )
        setSetLookupState(hasHistory ? 'matched' : 'empty')
      } catch {
        setSetLookupState('idle')
      }
    },
    [poLineId, data?.line?.cartonId, data?.line?.specOverrides],
  )

  useEffect(() => {
    setArtworkRepeatJob(false)
  }, [artworkCodeInput])

  const persistArtworkIdIfNew = useCallback(
    async (artworkId: string) => {
      if (!data?.line) return
      if (String(data.line.specOverrides?.artworkId ?? '').trim()) return
      const specOverrides = { ...(data.line.specOverrides || {}), artworkId }
      try {
        const res = await fetch(`/api/planning/po-lines/${poLineId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ specOverrides }),
        })
        const json = (await res.json()) as { error?: string }
        if (!res.ok) throw new Error(json.error || 'Failed to save artwork link')
        setData((prev) =>
          prev ? { ...prev, line: { ...prev.line, specOverrides } } : null,
        )
      } catch {
        /* non-fatal — effective id still works from resolvedArtworkId */
      }
    },
    [data?.line, poLineId],
  )

  useEffect(() => {
    const aw = artworkCodeInput.trim()
    if (!aw || !poLineId) {
      setResolvedArtworkId(null)
      return
    }
    const t = window.setTimeout(() => {
      void fetch(
        `/api/designing/po-lines/${poLineId}/resolve-artwork?code=${encodeURIComponent(aw)}`,
      )
        .then((r) => r.json())
        .then((j: { artworkId?: string | null }) => {
          const aid = typeof j.artworkId === 'string' ? j.artworkId.trim() : ''
          setResolvedArtworkId(aid || null)
          if (aid) void persistArtworkIdIfNew(aid)
        })
        .catch(() => setResolvedArtworkId(null))
    }, 300)
    return () => window.clearTimeout(t)
  }, [artworkCodeInput, poLineId, persistArtworkIdIfNew])

  useEffect(() => {
    if (jobType !== 'repeat') return
    const aw = artworkCodeInput.trim()
    if (!aw) {
      setSetLookupState('idle')
      setHistoryNoMatch(false)
      return
    }
    if (historyDebounceRef.current) clearTimeout(historyDebounceRef.current)
    historyDebounceRef.current = setTimeout(() => {
      historyDebounceRef.current = null
      void fetchHistorySmartSet(artworkCodeInput, true)
    }, 400)
    return () => {
      if (historyDebounceRef.current) clearTimeout(historyDebounceRef.current)
    }
  }, [artworkCodeInput, fetchHistorySmartSet, jobType])

  const saveSetAndAwCode = async () => {
    if (!data) return
    const setTrim = setNumberInput.trim()
    const aw = artworkCodeInput.trim()
    if (!aw) {
      toast.error('Artwork code is required')
      return
    }
    if (setTrim && !/^\d+$/.test(setTrim)) {
      toast.error('Set number must be numeric')
      return
    }
    setSavingSetAw(true)
    try {
      const upsRaw = numberOfUpsInput.trim()
      const upsNum = upsRaw ? Number(upsRaw) : null
      if (upsRaw !== '' && (Number.isNaN(upsNum) || upsNum === null || upsNum < 0)) {
        toast.error('Number of UPS must be a valid non-negative number')
        setSavingSetAw(false)
        return
      }
      const specOverrides = {
        ...(data.line.specOverrides || {}),
        jobType,
        actualSheetSize: actualSheetSizeInput.trim() || null,
        ups: upsRaw === '' ? null : upsNum,
        prePressRemarks: prePressRemarksInput.trim() || null,
        designerCommand,
      }
      const res = await fetch(`/api/planning/po-lines/${poLineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          setNumber: setTrim || null,
          artworkCode: aw,
          specOverrides,
        }),
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Save failed')
      setData((prev) =>
        prev
          ? {
              ...prev,
              line: {
                ...prev.line,
                setNumber: setTrim || null,
                artworkCode: aw,
                specOverrides,
              },
            }
          : null,
      )
      toast.success('Set #, AW code & physical specs saved')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSavingSetAw(false)
    }
  }

  const saveAllSpecs = async () => {
    if (!data) return
    const setTrim = setNumberInput.trim()
    if (!setTrim || !/^\d+$/.test(setTrim)) {
      toast.error('Set number must be a non-empty number')
      return
    }
    const aw = artworkCodeInput.trim()
    if (!aw) {
      toast.error('Artwork code is required')
      return
    }
    setSavingSpecs(true)
    try {
      const upsRaw = numberOfUpsInput.trim()
      const upsNum = upsRaw ? Number(upsRaw) : null
      if (upsRaw !== '' && (Number.isNaN(upsNum) || upsNum === null || upsNum < 0)) {
        toast.error('Number of UPS must be a valid non-negative number')
        setSavingSpecs(false)
        return
      }
      const specOverrides = {
        ...(data.line.specOverrides || {}),
        jobType,
        customerApprovalPharma: customerApproval,
        shadeCardQaTextApproval: qaTextApproval,
        actualSheetSize: actualSheetSizeInput.trim() || null,
        ups: upsRaw === '' ? null : upsNum,
        prePressRemarks: prePressRemarksInput.trim() || null,
        designerCommand,
      }
      const res = await fetch(`/api/planning/po-lines/${poLineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          setNumber: setTrim,
          artworkCode: aw,
          specOverrides,
        }),
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Save failed')
      setData((prev) =>
        prev
          ? {
              ...prev,
              line: {
                ...prev.line,
                setNumber: setTrim,
                artworkCode: aw,
                specOverrides,
              },
            }
          : null,
      )
      toast.success('Specs saved')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSavingSpecs(false)
    }
  }

  const onArtworkCodeBlur = async () => {
    if (historyDebounceRef.current) {
      clearTimeout(historyDebounceRef.current)
      historyDebounceRef.current = null
    }
    const code = artworkCodeInput.trim()
    if (!code) {
      setSetLookupState('idle')
      setHistoryNoMatch(false)
      setArtworkRepeatJob(false)
      return
    }
    await fetchHistorySmartSet(code, jobType === 'repeat')
    try {
      const r = await fetch(
        `/api/designing/po-lines/${poLineId}/artwork-lookup?${new URLSearchParams({ code })}`,
      )
      const json = (await r.json()) as { repeat?: boolean }
      if (json.repeat) {
        setArtworkRepeatJob(true)
        setCustomerApproval(true)
        setQaTextApproval(true)
        await persistApprovals({ customer: true, qa: true })
        toast.message('Repeat job: artwork code exists — approvals pre-filled')
      } else {
        setArtworkRepeatJob(false)
      }
    } catch {
      setArtworkRepeatJob(false)
    }
    if (data?.line && !setNumberInput.trim()) {
      const cid = data.line.po.customer.id
      if (cid) {
        try {
          const r2 = await fetch(
            `/api/designing/customer-aw-set-history?customerId=${encodeURIComponent(cid)}&awCode=${encodeURIComponent(code)}&excludeLineId=${encodeURIComponent(poLineId)}`,
          )
          const j2 = (await r2.json()) as { setNumber?: string | null }
          const sn = j2.setNumber?.trim()
          if (sn) {
            setSetNumberInput(sn)
            toast.message(`Set # ${sn} from ${data.line.po.customer.name} + AW history`)
          }
        } catch {
          /* non-fatal */
        }
      }
    }
  }

  const line = data?.line ?? null
  const links = data?.links ?? {
    po: '/orders/purchase-orders',
    planning: '/orders/planning',
    jobCard: null,
  }
  const designerId = (line?.specOverrides?.assignedDesignerId as string | undefined) ?? ''

  const embossRequired = isEmbossingRequired(line?.embossingLeafing)
  const designerCommandComplete =
    !!designerCommand.dieSource &&
    !!designerCommand.setType &&
    (!embossRequired || !!designerCommand.embossSource)

  const canFinalize =
    !!setNumberInput.trim() &&
    /^\d+$/.test(setNumberInput.trim()) &&
    !!artworkCodeInput.trim() &&
    customerApproval &&
    qaTextApproval &&
    designerCommandComplete

  const submitPlateHubFinalize = async (navigateAfter: boolean) => {
    if (!canFinalize || !line) {
      toast.error(
        'Complete approvals, numeric set #, AW code, die/emboss sources, and plate set type before routing to Plate Hub.',
      )
      return
    }
    setFinalizing(true)
    const payload = {
      poLineId: line.id,
      setNumber: setNumberInput.trim(),
      awCode: artworkCodeInput.trim(),
      customerApproval: true,
      qaTextCheckApproval: true,
      assignedDesignerId: designerId || null,
      designerCommand,
      status: 'PUSH_TO_PRODUCTION_QUEUE' as const,
    }
    try {
      const res = await fetch('/api/plate-hub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = (await res.json()) as {
        error?: string
        requirementCode?: string
        fields?: Record<string, string>
      }
      if (res.status === 409) {
        setPlateHubSent(true)
        toast.info(json.error || 'Already sent to Plate Hub')
        if (navigateAfter) router.push('/hub/plates')
        return
      }
      if (!res.ok) {
        const msg =
          json.fields && Object.values(json.fields)[0]
            ? Object.values(json.fields)[0]
            : json.error || 'Finalize failed'
        throw new Error(msg)
      }
      setPlateHubSent(true)
      toast.success('Data successfully routed to Tooling Hubs')
      if (navigateAfter) router.push('/hub/plates')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Finalize failed')
    } finally {
      setFinalizing(false)
    }
  }

  const handleFinalize = async () => {
    await submitPlateHubFinalize(true)
  }

  const [undoing, setUndoing] = useState(false)

  const handleUndoFinalize = async () => {
    if (!line) return
    if (!window.confirm('Undo finalization? This will cancel the plate requirement and allow re-submission.')) return
    setUndoing(true)
    try {
      const res = await fetch('/api/plate-hub/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poLineId: line.id }),
      })
      const json = (await res.json()) as { error?: string; ok?: boolean }
      if (!res.ok) throw new Error(json.error || 'Undo failed')
      setPlateHubSent(false)
      // Clear the finalize stamp in local state
      setData((prev) =>
        prev
          ? {
              ...prev,
              line: {
                ...prev.line,
                specOverrides: prev.line.specOverrides
                  ? {
                      ...prev.line.specOverrides,
                      prePressSentToPlateHubAt: undefined,
                      lastPlateRequirementCode: undefined,
                      plateHubPayload: undefined,
                    }
                  : null,
              },
            }
          : null,
      )
      toast.success('Finalization reversed — job is back in designing')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Undo failed')
    } finally {
      setUndoing(false)
    }
  }

  const routing = getPostPressRouting({
    embossingLeafing: line?.embossingLeafing,
    coatingType: line?.coatingType,
    laminateType: line?.specOverrides?.laminateType as string | undefined,
  })

  const totalPlatesLive = useMemo(
    () => computeTotalPlates(designerCommand.plateRequirement),
    [
      designerCommand.plateRequirement,
      actualSheetSizeInput,
      numberOfUpsInput,
    ],
  )

  const effectiveArtworkId = useMemo(
    () =>
      String(data?.line?.specOverrides?.artworkId ?? '').trim() || resolvedArtworkId?.trim() || '',
    [data?.line?.specOverrides, resolvedArtworkId],
  )

  const hubCartonSizeLabel = useMemo(
    () => (data?.line ? fmtLineCartonSizeLwh(data.line) : ''),
    [data?.line],
  )

  const hubCartonDimsParsable = useMemo(
    () => !!hubCartonSizeLabel && parseCartonSizeToDims(hubCartonSizeLabel) != null,
    [hubCartonSizeLabel],
  )

  const dieManualSpecsComplete = useMemo(() => {
    const sheet = actualSheetSizeInput.trim()
    const upsRaw = numberOfUpsInput.trim()
    const upsNum = upsRaw ? Number(upsRaw) : NaN
    const upsOk = Number.isFinite(upsNum) && upsNum >= 1 && Math.floor(upsNum) === upsNum
    return !!sheet && upsOk && hubCartonDimsParsable
  }, [actualSheetSizeInput, numberOfUpsInput, hubCartonDimsParsable])

  const embossManualSpecsComplete = useMemo(() => {
    const sheet = actualSheetSizeInput.trim()
    return !!sheet && hubCartonDimsParsable
  }, [actualSheetSizeInput, hubCartonDimsParsable])

  const section1ManualHubOk = useMemo(
    () => dieManualSpecsComplete || (embossRequired && embossManualSpecsComplete),
    [dieManualSpecsComplete, embossRequired, embossManualSpecsComplete],
  )

  const diePushGateReady = useMemo(
    () => !!designerCommand.dieSource && dieManualSpecsComplete,
    [designerCommand.dieSource, dieManualSpecsComplete],
  )

  const dieDispatchedToHub =
    designerCommand.dieLastIntent === 'die_hub' ||
    designerCommand.dieLastIntent === 'store_retrieval'

  const embossPushGateReady = useMemo(
    () => !!designerCommand.embossSource && embossManualSpecsComplete,
    [designerCommand.embossSource, embossManualSpecsComplete],
  )

  const embossDispatchedToHub =
    designerCommand.embossLastIntent === 'emboss_hub' ||
    designerCommand.embossLastIntent === 'store_retrieval'

  if (!data || !line) return <div className="p-4 text-slate-400">Loading...</div>

  const showNewProductSetHint =
    historyNoMatch && !setNumberInput.trim() && !!artworkCodeInput.trim()
  const showRepeatJobBadge = setLookupState === 'matched' || artworkRepeatJob

  return (
    <div className="flex flex-col min-h-[calc(100dvh-0px)] bg-black text-slate-200">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-black backdrop-blur-sm px-3 py-2">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between lg:gap-4 max-w-7xl mx-auto w-full">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg sm:text-xl font-bold text-amber-400 break-words leading-tight">{line.cartonName}</h1>
            <p className="text-xs sm:text-sm text-slate-400">
              {line.po.customer.name} | PO {line.po.poNumber} | Qty {line.quantity}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] items-center">
              <span className="px-1.5 py-0.5 rounded border border-white/15 bg-black font-mono tabular-nums text-slate-200">
                AW: {artworkCodeInput.trim() || '—'}
              </span>
              <span className="px-1.5 py-0.5 rounded border border-white/15 bg-black text-slate-200">
                Status: {line.planningStatus}
              </span>
              {showRepeatJobBadge ? (
                <span className="px-1.5 py-0.5 rounded border border-amber-600/80 bg-amber-950/50 text-amber-200">
                  Repeat job
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-col gap-2 items-stretch lg:items-end shrink-0">
            <div className="flex flex-wrap items-center gap-2 justify-end">
              <Link
                href="/orders/designing"
                className="px-2.5 py-1.5 rounded-lg border border-slate-700 text-slate-200 text-sm"
              >
                Back
              </Link>
              <div
                className="inline-flex flex-wrap items-center gap-2 sm:gap-3 rounded-lg border border-white/15 bg-black px-2 py-1.5"
                role="group"
                aria-label="Designer and approvals"
              >
                <select
                  value={designerId}
                  onChange={(e) => saveDesigner(e.target.value || undefined)}
                  disabled={savingDesigner}
                  className="px-2 py-1 rounded bg-black border border-white/20 text-white text-xs min-w-[140px] max-w-[200px]"
                  title="Assigned designer"
                >
                  <option value="">Designer…</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
                <span className="hidden sm:block w-px h-5 bg-slate-600 shrink-0" aria-hidden />
                <label className="flex items-center gap-1.5 text-[11px] text-slate-200 cursor-pointer whitespace-nowrap">
                  <input
                    type="checkbox"
                    className="rounded border-slate-600"
                    checked={customerApproval}
                    onChange={(e) => {
                      const v = e.target.checked
                      setCustomerApproval(v)
                      void persistApprovals({ customer: v, qa: qaTextApproval })
                    }}
                    disabled={savingSpecs}
                  />
                  Customer OK
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-slate-200 cursor-pointer whitespace-nowrap">
                  <input
                    type="checkbox"
                    className="rounded border-slate-600"
                    checked={qaTextApproval}
                    onChange={(e) => {
                      const v = e.target.checked
                      setQaTextApproval(v)
                      void persistApprovals({ customer: customerApproval, qa: v })
                    }}
                    disabled={savingSpecs}
                  />
                  QA OK
                </label>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 justify-end">
              <a
                href={`/api/designing/po-lines/${poLineId}/job-spec-pdf`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-2.5 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm hover:bg-slate-800"
              >
                Job spec PDF
              </a>
              <Link
                href={links.po}
                target="_blank"
                rel="noopener noreferrer"
                className="px-2.5 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm hover:bg-slate-800"
              >
                Open PO
              </Link>
              <button
                type="button"
                disabled={savingSpecs}
                onClick={() => void saveAllSpecs()}
                className="px-2.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium"
              >
                {savingSpecs ? 'Saving…' : 'Save specs'}
              </button>
              <button
                type="button"
                disabled={!canFinalize || finalizing || plateHubSent}
                title={
                  plateHubSent
                    ? 'Already routed to Plate Hub'
                    : canFinalize
                      ? 'Queue job with tooling and plate decisions'
                      : !designerCommandComplete
                        ? 'Complete tooling: die source, plate set type' +
                          (embossRequired ? ', emboss source' : '') +
                          ', and approvals'
                        : 'Enter set #, artwork code, and both approvals'
                }
                onClick={() => void handleFinalize()}
                className="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed text-white text-sm font-medium"
              >
                {plateHubSent ? 'Sent ✅' : finalizing ? 'Sending…' : 'Finalize job'}
              </button>
              {plateHubSent && (
                <button
                  type="button"
                  disabled={undoing}
                  onClick={() => void handleUndoFinalize()}
                  className="px-2.5 py-1.5 rounded-lg border border-rose-600/70 bg-rose-900/30 hover:bg-rose-900/50 disabled:opacity-50 text-rose-200 text-sm font-medium"
                  title="Reverse finalization and cancel the plate requirement"
                >
                  {undoing ? 'Undoing…' : 'Undo finalize'}
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 p-3 max-w-7xl mx-auto w-full space-y-2 pb-6">
          <section className="rounded-xl bg-black border border-white/10 p-3">
            <h2 className="text-sm font-semibold text-slate-200 mb-2">Section 1 — Identification &amp; spec</h2>
            {!effectiveArtworkId && artworkCodeInput.trim() ? (
              <div
                className={`mb-3 flex items-start gap-2 border-l-2 pl-2 py-0.5 text-[11px] leading-snug ${
                  section1ManualHubOk
                    ? 'border-amber-500/80 text-slate-400'
                    : 'border-rose-500/80 text-slate-400'
                }`}
                role="status"
              >
                <AlertTriangle
                  className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${section1ManualHubOk ? 'text-amber-500' : 'text-rose-400'}`}
                  aria-hidden
                />
                <span>
                  {section1ManualHubOk ? (
                    <>
                      Manual triage: artwork row missing — Die Hub needs sheet + UPS
                      {embossRequired ? '; Emboss Hub needs sheet.' : '.'}
                    </>
                  ) : (
                    <>
                      Link artwork or complete sheet
                      {embossRequired ? ', UPS, and emboss sheet' : ' + UPS'} for hub push.
                    </>
                  )}
                </span>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="text-[11px] text-slate-500 shrink-0">Job type</span>
              <div className="inline-flex rounded-lg border border-white/15 overflow-hidden">
                <button
                  type="button"
                  onClick={() => void persistJobType('new')}
                  className={`px-3 py-1.5 text-xs font-medium ${
                    jobType === 'new'
                      ? 'bg-amber-600 text-white'
                      : 'bg-zinc-950 text-slate-300 hover:bg-zinc-900'
                  }`}
                >
                  New product
                </button>
                <button
                  type="button"
                  onClick={() => void persistJobType('repeat')}
                  className={`px-3 py-1.5 text-xs font-medium border-l border-white/15 ${
                    jobType === 'repeat'
                      ? 'bg-amber-600 text-white'
                      : 'bg-zinc-950 text-slate-300 hover:bg-zinc-900'
                  }`}
                >
                  Repeat product
                </button>
              </div>
              {jobType === 'repeat' ? (
                <span className="text-[11px] text-slate-500">
                  Set #, sheet size &amp; UPS fill from AW history when available.
                </span>
              ) : null}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
              <label className="block text-xs text-slate-400">
                Set # <span className="text-red-400">*</span>
                {setLookupState === 'loading' ? (
                  <span className="ml-2 text-slate-500 normal-case">Looking up…</span>
                ) : null}
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  required
                  value={setNumberInput}
                  onChange={(e) => setSetNumberInput(e.target.value.replace(/\D/g, ''))}
                  className={`${monoInputClass} ${
                    showNewProductSetHint
                      ? 'border-amber-500/90 ring-1 ring-amber-600/35'
                      : ''
                  }`}
                  placeholder="e.g. 1"
                  aria-invalid={showNewProductSetHint}
                />
                {showNewProductSetHint ? (
                  <p className="mt-1 text-[11px] text-amber-400/90">
                    New product — enter a set # (no plate history for this carton / artwork).
                  </p>
                ) : null}
              </label>
              <label className="block text-xs text-slate-400">
                AW code <span className="text-red-400">*</span>
                <input
                  type="text"
                  value={artworkCodeInput}
                  onChange={(e) => setArtworkCodeInput(e.target.value)}
                  onBlur={() => void onArtworkCodeBlur()}
                  className={manualInputClass}
                  placeholder="Manual artwork / revision code"
                />
                {artworkCodeInput.trim() ? (
                  <p
                    className={`mt-1 text-[10px] ${effectiveArtworkId ? 'text-emerald-500/80' : section1ManualHubOk ? 'text-amber-500/85' : 'text-rose-400/85'}`}
                  >
                    {effectiveArtworkId
                      ? 'Artwork linked for die / emboss / send-all dispatch.'
                      : section1ManualHubOk
                        ? 'No artwork row — manual specs can be used for Die / Emboss Hub triage.'
                        : 'No artwork record for this AW + customer (match filename in job artworks).'}
                  </p>
                ) : null}
              </label>
              <label className="block text-xs text-slate-400">
                Actual sheet size
                <input
                  type="text"
                  value={actualSheetSizeInput}
                  onChange={(e) => setActualSheetSizeInput(e.target.value)}
                  className={monoInputClass}
                  placeholder="e.g. 25 x 36"
                  autoComplete="off"
                />
              </label>
              <label className="block text-xs text-slate-400 sm:col-span-1">
                Number of UPS
                <input
                  type="text"
                  inputMode="numeric"
                  value={numberOfUpsInput}
                  onChange={(e) => setNumberOfUpsInput(e.target.value.replace(/\D/g, ''))}
                  className={monoInputClass}
                  placeholder="e.g. 4"
                  autoComplete="off"
                />
              </label>
              <div className="sm:col-span-2 flex flex-wrap gap-2 items-end justify-end pb-0.5">
                <button
                  type="button"
                  disabled={savingSetAw}
                  onClick={() => void saveSetAndAwCode()}
                  className="px-3 py-1.5 rounded-lg border border-amber-700/80 bg-amber-900/30 text-amber-100 text-xs font-medium hover:bg-amber-900/45 disabled:opacity-50"
                >
                  {savingSetAw ? 'Saving…' : 'Save set & AW code'}
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-sm border-t border-white/10 pt-3">
              <CartonDimensionsRow
                carton={line.carton}
                right={
                  <button
                    type="button"
                    onClick={() => void openSmartMatch()}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-sky-500/55 bg-sky-950/35 text-sky-100 text-[10px] font-semibold hover:bg-sky-950/60 shrink-0"
                    title="Match dies within ±1 mm on L×W×H"
                  >
                    <Search className="h-3 w-3 shrink-0" aria-hidden />
                    Smart Match
                  </button>
                }
              />
              {line.cartonId && !line.dieMasterId && !line.carton?.dieMasterId ? (
                <div className="sm:col-span-3 flex items-start gap-2 border-l-2 border-amber-600/60 pl-2 py-0.5 text-[11px] text-amber-200/95">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500 mt-0.5" aria-hidden />
                  <span>
                    Unlinked tooling — no die master on this line or product master. Use Smart Match or link from
                    masters.
                  </span>
                </div>
              ) : null}
              {line.dieMaster ? (
                <KV
                  label="Line die master"
                  value={`#${line.dieMaster.dyeNumber} · ${masterDieTypeLabel(line.dieMaster)}`}
                />
              ) : null}
              {line.carton?.dieMaster ? (
                <KV
                  label="Product die master"
                  value={`#${line.carton.dieMaster.dyeNumber} · ${masterDieTypeLabel(line.carton.dieMaster)}`}
                />
              ) : null}
              <KV label="Paper" value={line.paperType || '-'} />
              <KV label="GSM" value={line.gsm ? String(line.gsm) : '-'} />
              <KV label="Coating" value={line.coatingType || '-'} />
              <KV label="Colours" value={String(line.specOverrides?.numberOfColours || 4)} />
              <KV label="Emboss / leaf" value={line.embossingLeafing || 'None'} />
              <KV
                label="Preprinted batch area"
                value={formatPreprintedBatchSpace(line)}
                title="Reserved area for batch / coding print (typically L × W in mm from carton master or PO spec)."
              />
            </div>
            <label className="block text-xs text-slate-400 mt-3 pt-3 border-t border-white/10">
              Pre-press remarks
              <textarea
                value={prePressRemarksInput}
                onChange={(e) => setPrePressRemarksInput(e.target.value)}
                rows={2}
                className={`${manualInputClass} resize-y min-h-[3.5rem]`}
                placeholder="Notes for plate hub, CTP, or layout…"
              />
            </label>
          </section>

        <section className="rounded-xl bg-black border border-white/10 p-3 space-y-3">
          <h2 className="text-sm font-semibold text-slate-200 border-b border-white/10 pb-2">
            Section 2 — Tooling (die · emboss · plate requirement)
          </h2>

          <div className="grid md:grid-cols-2 gap-3">
            <div className="space-y-3 rounded-lg border border-white/10 bg-black p-3">
              <h3 className="text-xs font-semibold text-amber-200/95 uppercase tracking-wide">
                Die inventory
              </h3>
              <ToolSourceRow
                label="Source"
                value={designerCommand.dieSource}
                historyValue={historyDesignerCommand?.dieSource ?? null}
                onChange={(v) => setDesignerCommand((p) => ({ ...p, dieSource: v }))}
              />
              {designerCommand.dieSource ? (
                <div className="flex flex-wrap gap-2 justify-start items-center">
                  <button
                    type="button"
                    disabled={savingDesignerCommand || designerCommand.dieSource === 'old'}
                    onClick={() => void dieSendToVendor()}
                    className="px-2.5 py-1.5 rounded-md bg-violet-700/90 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium text-balance max-w-[11rem] sm:max-w-none"
                  >
                    Send to Vendor
                  </button>
                  {dieDispatchedToHub ? (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-emerald-500/45 bg-emerald-950/40 text-emerald-100 text-xs font-medium">
                      <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span>
                        Die Hub sent ·{' '}
                        <span className="font-mono tabular-nums text-[10px] text-emerald-200/90">
                          {formatHubSentAt(designerCommand.dieLastIntentAt)}
                        </span>
                      </span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={savingDesignerCommand}
                      title={
                        !diePushGateReady
                          ? 'Requires actual sheet size, integer UPS ≥ 1, and L×W×H dimensions (e.g. 100×50×30). Click to validate.'
                          : 'POST /api/tooling-hub/dispatch — includes director authority + die snapshot + remarks'
                      }
                      onClick={() => void diePushToHub()}
                      className="px-2.5 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-45 disabled:cursor-not-allowed text-white text-xs font-medium text-balance max-w-[11rem] sm:max-w-none"
                    >
                      Push to Die Hub
                    </button>
                  )}
                </div>
              ) : (
                <span className="text-[11px] text-slate-500">Select New or Old to show actions.</span>
              )}
            </div>

            {embossRequired ? (
              <div className="space-y-3 rounded-lg border border-white/10 bg-black p-3">
                <h3 className="text-xs font-semibold text-amber-200/95 uppercase tracking-wide">
                  Emboss blocks
                </h3>
                <ToolSourceRow
                  label="Source"
                  value={designerCommand.embossSource}
                  historyValue={historyDesignerCommand?.embossSource ?? null}
                  onChange={(v) => setDesignerCommand((p) => ({ ...p, embossSource: v }))}
                />
                {designerCommand.embossSource && !effectiveArtworkId && embossManualSpecsComplete ? (
                  <p className="flex items-start gap-1.5 text-[11px] text-slate-500 leading-snug" role="status">
                    <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500/90 mt-0.5" aria-hidden />
                    Manual emboss: artwork optional; push uses sheet + dimensions + block type from spec.
                  </p>
                ) : null}
                {designerCommand.embossSource ? (
                  <div className="flex flex-wrap gap-2 justify-start items-center">
                    <button
                      type="button"
                      disabled={savingDesignerCommand || designerCommand.embossSource === 'old'}
                      onClick={() => void embossSendToVendor()}
                      className="px-2.5 py-1.5 rounded-md bg-violet-700/90 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium text-balance max-w-[11rem] sm:max-w-none"
                    >
                      Send to Vendor
                    </button>
                    {embossDispatchedToHub ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-emerald-500/45 bg-emerald-950/40 text-emerald-100 text-xs font-medium">
                        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        <span>
                          Emboss Hub sent ·{' '}
                          <span className="font-mono tabular-nums text-[10px] text-emerald-200/90">
                            {formatHubSentAt(designerCommand.embossLastIntentAt)}
                          </span>
                        </span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={savingDesignerCommand}
                        title={
                          !embossPushGateReady
                            ? 'Requires actual sheet size and L×W×H dimensions on the line. Click to validate.'
                            : 'POST /api/tooling-hub/dispatch — includes director authority + die snapshot + remarks'
                        }
                        onClick={() => void embossPushToHub()}
                        className="px-2.5 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-45 disabled:cursor-not-allowed text-white text-xs font-medium text-balance max-w-[11rem] sm:max-w-none"
                      >
                        Push to Embossing Hub
                      </button>
                    )}
                  </div>
                ) : (
                  <span className="text-[11px] text-slate-500">Select New or Old to show actions.</span>
                )}
              </div>
            ) : (
              <div className="rounded-lg border border-white/10 bg-black p-3 text-[11px] text-slate-500">
                Emboss tooling not required for this carton (no embossing on spec).
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-lg border border-white/10 bg-black p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2 mb-2">
              <h3 className="text-xs font-semibold text-amber-200/95 uppercase tracking-wide">
                Plate hub — requirement
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-2 rounded-md border border-cyan-600/55 bg-cyan-950/35 px-2 py-0.5 text-[11px] font-semibold text-cyan-100">
                  <span>
                    Total plates:{' '}
                    <span className="font-mono tabular-nums text-cyan-50">{totalPlatesLive}</span>
                  </span>
                  <span className="hidden sm:inline text-cyan-600/80">·</span>
                  <span className="font-mono tabular-nums text-[10px] font-normal text-cyan-200/80">
                    Sheet {actualSheetSizeInput.trim() || '—'} · UPS {numberOfUpsInput.trim() || '—'}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={!canFinalize || finalizing || plateHubSent}
                  title={
                    plateHubSent
                      ? 'Already routed to Plate Hub'
                      : !canFinalize
                        ? 'Complete approvals, set #, AW code, die/emboss, and plate set type'
                        : 'POST /api/plate-hub with current Pantone and plate configuration'
                  }
                  onClick={() => void submitPlateHubFinalize(false)}
                  className="inline-flex items-center rounded-md border border-emerald-500/70 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-45 disabled:cursor-not-allowed px-2.5 py-0.5 text-[11px] font-semibold text-white"
                >
                  {plateHubSent ? 'Sent ✅' : finalizing ? 'Sending…' : 'Push to Plate Hub'}
                </button>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  className="rounded border-slate-600"
                  checked={designerCommand.plateRequirement.pantoneEnabled}
                  onChange={(e) =>
                    setDesignerCommand((p) => ({
                      ...p,
                      plateRequirement: {
                        ...p.plateRequirement,
                        pantoneEnabled: e.target.checked,
                        numberOfPantones: e.target.checked ? p.plateRequirement.numberOfPantones || 1 : 0,
                      },
                    }))
                  }
                />
                Pantone
              </label>
              {designerCommand.plateRequirement.pantoneEnabled ? (
                <label className="block text-[11px] text-slate-400">
                  Number of Pantones
                  <input
                    type="number"
                    min={0}
                    value={designerCommand.plateRequirement.numberOfPantones || ''}
                    onChange={(e) => {
                      const v = e.target.value === '' ? 0 : Number(e.target.value)
                      setDesignerCommand((p) => ({
                        ...p,
                        plateRequirement: {
                          ...p.plateRequirement,
                          numberOfPantones: Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0,
                        },
                      }))
                    }}
                    className={`${manualInputClass} mt-1 w-24`}
                  />
                </label>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-[11px] text-slate-400 shrink-0">Standard</span>
              {(
                [
                  ['standardC', 'C', 'border-cyan-500/70 bg-cyan-950/40 text-cyan-50'],
                  ['standardM', 'M', 'border-fuchsia-500/70 bg-fuchsia-950/40 text-fuchsia-50'],
                  ['standardY', 'Y', 'border-yellow-500/75 bg-yellow-950/35 text-yellow-50'],
                  ['standardK', 'K', 'border-zinc-500/80 bg-zinc-950/80 text-zinc-100'],
                ] as const
              ).map(([key, lab, box]) => (
                <label
                  key={key}
                  className={`flex items-center gap-1.5 text-xs cursor-pointer rounded-md border px-2 py-1 ${box}`}
                >
                  <input
                    type="checkbox"
                    className="rounded border-white/30 bg-black/40"
                    checked={designerCommand.plateRequirement[key]}
                    onChange={(e) =>
                      setDesignerCommand((p) => ({
                        ...p,
                        plateRequirement: { ...p.plateRequirement, [key]: e.target.checked },
                      }))
                    }
                  />
                  {lab}
                  {historyDesignerCommand?.plateRequirement[key] ? (
                    <span className="text-[10px] text-emerald-300/90">Prev</span>
                  ) : null}
                </label>
              ))}
            </div>
            <div className="grid sm:grid-cols-3 gap-3">
              {(
                [
                  ['pantone1', 'P1'],
                  ['pantone2', 'P2'],
                  ['pantone3', 'P3'],
                ] as const
              ).map(([key, lab]) => {
                const pHex = pantoneHexApprox(designerCommand.plateRequirement[key])
                return (
                <label key={key} className="block text-[11px] text-slate-400">
                  {lab} (Pantone code)
                  <input
                    type="text"
                    value={designerCommand.plateRequirement[key]}
                    onChange={(e) =>
                      setDesignerCommand((p) => ({
                        ...p,
                        plateRequirement: { ...p.plateRequirement, [key]: e.target.value },
                      }))
                    }
                    className={manualInputClass}
                    placeholder="e.g. 185 C"
                    style={
                      pHex
                        ? {
                            backgroundColor: pHex,
                            color: pantoneContrastFg(pHex),
                            borderColor: 'rgba(255,255,255,0.35)',
                          }
                        : undefined
                    }
                  />
                  {historyDesignerCommand?.plateRequirement[key] ? (
                    <span className="text-[10px] text-emerald-400/90">Previously used</span>
                  ) : null}
                </label>
                )
              })}
            </div>
            <label className="block text-[11px] text-slate-400">
              Special colour / effect note
              <input
                type="text"
                value={designerCommand.plateRequirement.specialColourNote}
                onChange={(e) =>
                  setDesignerCommand((p) => ({
                    ...p,
                    plateRequirement: { ...p.plateRequirement, specialColourNote: e.target.value },
                  }))
                }
                className={manualInputClass}
                placeholder="e.g. metallic gold, custom match to sample"
              />
            </label>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  className="rounded border-slate-600"
                  checked={designerCommand.plateRequirement.dripOffPlate}
                  onChange={(e) =>
                    setDesignerCommand((p) => ({
                      ...p,
                      plateRequirement: { ...p.plateRequirement, dripOffPlate: e.target.checked },
                    }))
                  }
                />
                Drip-off plate
                {historyDesignerCommand?.plateRequirement.dripOffPlate ? (
                  <span className="text-[10px] text-emerald-400/90">Previously used</span>
                ) : null}
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  className="rounded border-slate-600"
                  checked={designerCommand.plateRequirement.spotUvPlate}
                  onChange={(e) =>
                    setDesignerCommand((p) => ({
                      ...p,
                      plateRequirement: { ...p.plateRequirement, spotUvPlate: e.target.checked },
                    }))
                  }
                />
                Spot UV plate
                {historyDesignerCommand?.plateRequirement.spotUvPlate ? (
                  <span className="text-[10px] text-emerald-400/90">Previously used</span>
                ) : null}
              </label>
            </div>
            {historyDesignerCommand ? (
              <p className="text-[11px] text-slate-500 border-t border-slate-800 pt-2">
                Previous AW match summary: {formatPlateHistorySummary(historyDesignerCommand)}
              </p>
            ) : null}
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-1">
              <label className="text-[11px] text-slate-400 shrink-0">Set type</label>
              <select
                value={designerCommand.setType}
                onChange={(e) =>
                  setDesignerCommand((p) => ({
                    ...p,
                    setType: e.target.value as DesignerCommand['setType'],
                  }))
                }
                className="px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-white text-sm max-w-xs"
              >
                <option value="">Select…</option>
                <option value="new_set">New set</option>
                <option value="correction_plate">Correction plate</option>
                <option value="old_set_from_store">Old set from store</option>
              </select>
              {historyDesignerCommand?.setType &&
              historyDesignerCommand.setType === designerCommand.setType ? (
                <span className="text-[10px] text-emerald-400/90">Previously used</span>
              ) : null}
            </div>
          </div>
        </section>

        <section className="rounded-xl bg-black border border-white/10 px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[11px] font-semibold text-slate-200 shrink-0">Post-press routing</span>
            <div className="flex flex-wrap gap-1.5 text-xs">
              <RouteBadge label="Chemical coating" active={routing.needsChemicalCoating} />
              <RouteBadge label="Lamination" active={routing.needsLamination} />
              <RouteBadge label="Spot UV" active={routing.needsSpotUv} />
              <RouteBadge label="Leafing" active={routing.needsLeafing} />
              <RouteBadge label="Embossing" active={routing.needsEmbossing} />
            </div>
          </div>
        </section>

        <SmartMatchDieModal
          open={smartMatchOpen}
          onClose={() => setSmartMatchOpen(false)}
          targetDims={smartMatchTarget}
          toleranceMm={smartMatchTol}
          rows={smartMatchRows}
          busyId={smartMatchBusyId}
          onSelect={(row) => void linkDieFromSmartMatch(row)}
        />
      </div>
    </div>
  )
}

function ToolSourceRow({
  label,
  value,
  historyValue,
  onChange,
}: {
  label: string
  value: 'new' | 'old' | null
  historyValue: 'new' | 'old' | null
  onChange: (v: 'new' | 'old') => void
}) {
  return (
    <div>
      <span className="text-xs text-slate-400">{label}</span>
      <div className="flex flex-wrap gap-2 mt-1">
        {(['new', 'old'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onChange(k)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${
              value === k
                ? 'bg-amber-600/90 border-amber-500 text-white'
                : 'bg-slate-800 border-slate-600 text-slate-300'
            }`}
          >
            {k === 'new' ? 'New' : 'Old'}
            {historyValue === k ? (
              <span className="ml-1.5 text-[10px] font-normal text-emerald-300/95">Previously used</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}

function formatPlateHistorySummary(h: DesignerCommand): string {
  const p = h.plateRequirement
  const std = [p.standardC && 'C', p.standardM && 'M', p.standardY && 'Y', p.standardK && 'K']
    .filter(Boolean)
    .join(', ')
  const pantoneCount =
    p.pantoneEnabled && p.numberOfPantones > 0 ? `${p.numberOfPantones} Pantone(s)` : ''
  const pant = [p.pantone1 && `P1 ${p.pantone1}`, p.pantone2 && `P2 ${p.pantone2}`, p.pantone3 && `P3 ${p.pantone3}`]
    .filter(Boolean)
    .join(' · ')
  const spec = [p.dripOffPlate && 'Drip-off', p.spotUvPlate && 'Spot UV'].filter(Boolean).join(', ')
  const parts = [
    std ? `Std ${std}` : null,
    pantoneCount || null,
    pant || null,
    spec || null,
  ].filter(Boolean) as string[]
  return parts.length ? parts.join(' · ') : '—'
}

function KV({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div
      className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-1 py-1 border-b border-slate-800/80 sm:border-0"
      title={title}
    >
      <span className="text-slate-500 shrink-0 text-xs sm:text-sm">{label}</span>
      <span className="text-slate-100 text-sm text-right text-balance break-words max-w-full sm:max-w-[min(100%,20rem)]">
        {value}
      </span>
    </div>
  )
}

function RouteBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={`px-2 py-1 rounded border ${
        active ? 'bg-blue-900/30 border-blue-600 text-blue-200' : 'bg-slate-800 border-slate-700 text-slate-400'
      }`}
    >
      {label} {active ? '✓' : '—'}
    </span>
  )
}
