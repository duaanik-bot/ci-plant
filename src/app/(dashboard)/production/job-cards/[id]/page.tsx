'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowLeft,
  Boxes,
  CalendarClock,
  Check,
  ChevronDown,
  ClipboardList,
  Clock3,
  Download,
  Eye,
  Factory,
  FileText,
  Image as ImageIcon,
  Layers3,
  MoreVertical,
  PackageCheck,
  Pause,
  Pencil,
  Play,
  Printer,
  Search,
  ShieldCheck,
  Sparkles,
  StickyNote,
  TableProperties,
  Undo2,
  Wrench,
  XCircle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from '@/store/toastStore'
import { getPostPressRouting, isEmbossingRequired } from '@/lib/emboss-conditions'
import { resolveRequirementFromLine, resolveSheetSize, resolveUps } from '@/lib/production-os-resolvers'
import { SpecPackPanel } from '@/components/spec-pack/SpecPackPanel'

type Stage = {
  id: string
  stageName: string
  status: string
  operator: string | null
  counter: number | null
  sheetSize: string | null
  completedAt: string | null
  requiredSheets?: number | null
  totalSheets?: number | null
  stageData?: Record<string, unknown> | null
  createdAt?: string | null
  inProgressSince?: string | null
}

type CartonSpecs = {
  id?: string
  artworkCode?: string | null
  coatingType: string | null
  laminateType: string | null
  foilType: string | null
  embossingLeafing: string | null
  embossBlockId: string | null
  colourBreakdown?: unknown
  printingType?: string | null
  pastingStyle?: string | null
} | null

type PoLine = {
  id: string
  cartonId: string | null
  cartonName: string
  cartonSize: string | null
  quantity: number
  artworkCode?: string | null
  paperType: string | null
  coatingType: string | null
  otherCoating?: string | null
  embossingLeafing: string | null
  gsm: number | null
  dyeId: string | null
  remarks?: string | null
  specOverrides?: Record<string, unknown> | null
  specPack?: unknown
  po: { poNumber: string; poDate?: string | null; deliveryRequiredBy?: string | null }
  carton: CartonSpecs
  materialQueue?: {
    sheetLengthMm: unknown
    sheetWidthMm: unknown
    ups: number
    grainDirection: string
    totalSheets: number
    boardType?: string
    gsm?: number
  } | null
  shadeCard?: unknown
} | null

type BoardMaterial = {
  requiredSheets: number
  issuedToFloorSheets: number
  balanceSheets: number
  sheetsIssuedJobField: number
  batchLotNumber: string | null
  boardStatus: 'available' | 'out_of_stock'
  materialShortage: boolean
  paperWarehouseSheetsForSpec: number
  planningMaterialGateStatus: string
  materialPendingWatermark: boolean
  warehouseHandshake: { issuedAt: string; custodianName: string } | null
  ledgerLink: { gsm: number; board: string } | null
  reservedSheets?: number
  shortageSheets?: number
  availableStock?: number
  openPoQty?: number
  incomingQty?: number
  netRequirement?: number
  procurementStatus?: string
  linkedPoNumber?: string | null
  expectedArrivalDate?: string | null
  grnPosted?: boolean
}

type MaterialReadiness = {
  requiredSheets: number
  reservedSheets: number
  shortageSheets: number
  availableStock: number
  openPoQty?: number
  incomingQty?: number
  netRequirement?: number
  procurementStatus?: string
  linkedPoNumber?: string | null
  expectedArrivalDate?: string | null
  grnPosted?: boolean
  prStatus: string
  grnEta: string | null
  status: string
  materialCode?: string | null
  materialId?: string | null
  planningId?: string | null
}

type MaterialTimelineEvent = {
  at: string
  event: string
  detail: string
}

export type PostPressRouting = {
  chemicalCoating?: boolean
  lamination?: boolean
  spotUv?: boolean
  leafing?: boolean
  embossing?: boolean
  printPlan?: {
    lane: 'triage' | 'machine'
    machineId?: string | null
    order: number
    updatedAt?: string
  }
}

type ProductionBible = {
  sheetSizeLabel: string | null
  ups: number | null
  grainDirection: string | null
  toolingKit: {
    plate: {
      code: string
      coordinates: string
      hubStatus: string
    } | null
    die: {
      code: string
      coordinates: string
      custodyStatus: string
    } | null
    emboss: {
      code: string
      coordinates: string
      custodyStatus: string
    } | null
    shade: {
      shadeCode: string
      ageMonths: number
      expired: boolean
      custodyStatus: string
    } | null
  }
  shadeCard: {
    shadeCode: string
    ageMonths: number
    expired: boolean
    custodyStatus: string
  } | null
}

type AuditTimelineEntry = {
  id: string
  at: string
  action: string
  tableName: string
  userName: string | null
  summary: string
}

type JobCard = {
  id: string
  jobCardNumber: number
  setNumber: string | null
  customer: { id: string; name: string }
  requiredSheets: number
  wastageSheets: number
  totalSheets: number
  sheetsIssued: number
  assignedOperator: string | null
  shiftOperator?: { id: string; name: string } | null
  machineId?: string | null
  machine?: { id: string; name: string; machineCode: string } | null
  batchNumber: string | null
  status: string
  artworkApproved: boolean
  firstArticlePass: boolean
  finalQcPass: boolean
  qaReleased: boolean
  postPressRouting: PostPressRouting | null
  plateSetId: string | null
  embossBlockId: string | null
  stages: Stage[]
  poLine: PoLine
  productionBible?: ProductionBible
  boardMaterial?: BoardMaterial
  issuedStockDisplay?: string | null
  inventoryLocationPointer?: string | null
  grainFitStatus?: string
  auditTimeline?: AuditTimelineEntry[]
  fileUrl?: string | null
  jobDate?: string | null
  createdAt?: string
  updatedAt?: string
}

type MachineOption = {
  id: string
  machineCode: string
  name: string
}

function formatDateDisplay(value: string | Date | null | undefined): string {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleDateString('en-GB')
}

function formatDateTimeDisplay(value: string | Date | null | undefined): string {
  if (!value) return 'Not available'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return 'Not available'
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatQty(value: unknown, unit = ''): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return 'Not available'
  return `${Math.round(n).toLocaleString('en-IN')}${unit ? ` ${unit}` : ''}`
}

function cleanText(value: unknown, fallback = 'Not available'): string {
  if (value == null) return fallback
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
    return fallback
  }
  return trimmed
}

function titleize(value: string | null | undefined, fallback = 'Not available'): string {
  const safe = cleanText(value, fallback)
  if (safe === fallback) return safe
  return safe
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())
}

function getStatusTone(status: string): string {
  const key = status.toLowerCase().replace(/\s+/g, '_')
  if (key === 'completed' || key === 'ready' || key === 'released') return 'bg-[var(--success-bg)] text-[var(--success)]'
  if (key === 'in_progress' || key === 'printing') return 'bg-[var(--info-bg)] text-[var(--info)]'
  if (key === 'waiting' || key === 'ready_to_start') return 'bg-ds-warning/10 text-ds-warning'
  if (key === 'on_hold' || key === 'hold') return 'bg-[var(--error-bg)] text-[var(--error)]'
  return 'bg-ds-main text-ds-ink-muted'
}

function getReadinessStatus(required: number, reserved: number, available: number, incoming: number): 'Ready' | 'Waiting' | 'Not Ready' {
  if (required <= 0) return 'Waiting'
  if (reserved + available >= required) return 'Ready'
  if (incoming > 0) return 'Waiting'
  return 'Not Ready'
}

function getOperationBalance(planned: number, done: number): number {
  return Math.max(0, planned - done)
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-ds-elevated text-neutral-500',
  ready: 'bg-ds-warning/10 text-ds-warning',
  in_progress: 'bg-[var(--info-bg)] text-[var(--info)]',
  completed: 'bg-[var(--success-bg)] text-[var(--success)]',
}

const mono = 'font-designing-queue tabular-nums tracking-tight'
const fieldClass =
  'w-full rounded bg-ds-main px-2 py-1.5 text-xs text-ds-ink transition focus:outline-none focus:ring-1 focus:ring-ds-brand/40'

const POST_PRESS_LABELS: { key: keyof PostPressRouting; label: string }[] = [
  { key: 'chemicalCoating', label: 'Chemical coating' },
  { key: 'lamination', label: 'Lamination' },
  { key: 'spotUv', label: 'Spot UV' },
  { key: 'leafing', label: 'Leafing / foiling' },
  { key: 'embossing', label: 'Embossing' },
]

function suggestPostPressRouting(poLine: PoLine): PostPressRouting {
  if (!poLine) return {}
  const carton = poLine.carton
  const routing = getPostPressRouting({
    embossingLeafing: carton?.embossingLeafing ?? poLine.embossingLeafing,
    coatingType: carton?.coatingType ?? poLine.coatingType,
    laminateType: carton?.laminateType ?? null,
  })
  const foil = (carton?.foilType ?? '').toLowerCase()
  return {
    chemicalCoating: routing.needsChemicalCoating,
    lamination: routing.needsLamination,
    spotUv: routing.needsSpotUv,
    leafing: foil !== '' && foil !== 'none',
    embossing: routing.needsEmbossing,
  }
}

function stageAppliesToRouting(
  stageName: string,
  routing: PostPressRouting,
  embossRequired: boolean,
): boolean {
  const r = routing
  switch (stageName) {
    case 'Cutting':
    case 'Printing':
    case 'Dye Cutting':
    case 'Pasting':
      return true
    case 'Chemical Coating':
      return !!r.chemicalCoating
    case 'Lamination':
      return !!r.lamination
    case 'Spot UV':
      return !!r.spotUv
    case 'Leafing':
      return !!r.leafing
    case 'Embossing':
      return !!r.embossing && embossRequired
    default:
      return false
  }
}

function ribbonTone(
  kind: 'ok' | 'warn' | 'bad' | 'na',
): { bar: string; text: string } {
  switch (kind) {
    case 'ok':
      return { bar: 'bg-[var(--success-bg)]', text: 'text-[var(--success)]' }
    case 'warn':
      return { bar: 'bg-ds-warning', text: 'text-ds-warning' }
    case 'bad':
      return { bar: 'bg-[var(--error-bg)]', text: 'text-[var(--error)]' }
    default:
      return { bar: 'bg-ds-line/40', text: 'text-neutral-500' }
  }
}

export default function JobCardDetailPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const id = params.id as string

  const [jc, setJc] = useState<JobCard | null>(null)
  const [shiftOperators, setShiftOperators] = useState<{ id: string; name: string }[]>([])
  const [machines, setMachines] = useState<MachineOption[]>([])
  const [saving, setSaving] = useState(false)
  const [artworkVersion, setArtworkVersion] = useState('R0')
  const [plateCheck, setPlateCheck] = useState<{
    status: 'all_new' | 'all_available' | 'partial'
    plateSetCode: string | null
    message: string
    newNeeded: number
    oldAvailable: number
  } | null>(null)
  const [dyeDetail, setDyeDetail] = useState<{
    dyeNumber: number
    condition: string
    impressionCount: number
    maxImpressions: number
    active: boolean
  } | null | 'unavailable'>(null)
  const [embossDetail, setEmbossDetail] = useState<{
    blockCode: string
    condition: string
    impressionCount: number
    maxImpressions: number
    active: boolean
  } | null | 'unavailable'>(null)
  const [enqueueingCut, setEnqueueingCut] = useState(false)
  const [designerUserId, setDesignerUserId] = useState('')
  const [prePressRemarks, setPrePressRemarks] = useState('')
  const [boardReadiness, setBoardReadiness] = useState<'ready' | 'waiting' | 'not_ready'>('waiting')
  const [sheetSizeOverride, setSheetSizeOverride] = useState('')
  const [priority, setPriority] = useState<'Normal' | 'Urgent'>('Normal')
  const [activeSection, setActiveSection] = useState<'summary' | 'spec' | 'board' | 'tooling' | 'execution' | 'validation' | 'material' | 'printing' | 'operations' | 'media' | 'notes' | 'history'>('summary')
  const [hubPushing, setHubPushing] = useState(false)
  const [livePushing, setLivePushing] = useState(false)
  const [queuePushing, setQueuePushing] = useState<string | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [materialReadiness, setMaterialReadiness] = useState<MaterialReadiness | null>(null)
  const [materialTimeline, setMaterialTimeline] = useState<MaterialTimelineEvent[]>([])
  const [jobSearch, setJobSearch] = useState('')
  const [operationSearch, setOperationSearch] = useState('')
  const [initialForm, setInitialForm] = useState<{
    designerUserId: string
    prePressRemarks: string
    boardReadiness: 'ready' | 'waiting' | 'not_ready'
    sheetSizeOverride: string
    priority: 'Normal' | 'Urgent'
    artworkApproved: boolean
    finalQcPass: boolean
  } | null>(null)
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const [dieStoreCheck, setDieStoreCheck] = useState<{
    status: 'available' | 'needs_attention' | 'end_of_life' | 'not_available'
    message: string
    dieCode?: string
    dieNumber?: number | null
    lifeRemaining?: number
  } | null>(null)

  useEffect(() => {
    fetch(`/api/job-cards/${id}?auditTimeline=1`)
      .then((r) => r.json())
      .then((data) => {
        if (!data || data.error) throw new Error(data.error || 'Failed to load')
        setJc(data)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [id])

  useEffect(() => {
    fetch(`/api/job-cards/${id}/material-readiness`)
      .then((r) => r.json())
      .then((data) => {
        if (!data || data.error) return
        setMaterialReadiness(data as MaterialReadiness)
      })
      .catch(() => {})
  }, [id, lastSavedAt])

  useEffect(() => {
    fetch(`/api/job-cards/${id}/material-timeline`)
      .then((r) => r.json())
      .then((data) => setMaterialTimeline(Array.isArray(data?.events) ? (data.events as MaterialTimelineEvent[]) : []))
      .catch(() => setMaterialTimeline([]))
  }, [id, lastSavedAt])

  useEffect(() => {
    fetch('/api/users')
      .then((r) => r.json())
      .then((list) => setShiftOperators(Array.isArray(list) ? list : []))
      .catch(() => setShiftOperators([]))
  }, [])

  useEffect(() => {
    fetch('/api/machines')
      .then((r) => r.json())
      .then((list) => setMachines(Array.isArray(list) ? list : []))
      .catch(() => setMachines([]))
  }, [])

  useEffect(() => {
    if (!jc) return
    const setup = ((jc.postPressRouting as Record<string, unknown> | null)?.executionSetup ?? {}) as Record<
      string,
      unknown
    >
    setDesignerUserId(jc.shiftOperator?.id ?? '')
    setPrePressRemarks(typeof setup.prePressRemarks === 'string' ? setup.prePressRemarks : '')
    setSheetSizeOverride(typeof setup.sheetSize === 'string' ? setup.sheetSize : '')
    const bm = jc.boardMaterial
    const boardCovered =
      bm?.boardStatus === 'available' ||
      ((bm?.reservedSheets ?? 0) > 0 && (bm?.reservedSheets ?? 0) >= (bm?.requiredSheets ?? 1))
    const derivedBoard = boardCovered ? 'ready' : 'waiting'
    setBoardReadiness(
      setup.boardReadiness === 'ready' || setup.boardReadiness === 'waiting' || setup.boardReadiness === 'not_ready'
        ? setup.boardReadiness
        : derivedBoard,
    )
    setPriority(setup.priority === 'Urgent' ? 'Urgent' : 'Normal')
    const init = {
      designerUserId: jc.shiftOperator?.id ?? '',
      prePressRemarks: typeof setup.prePressRemarks === 'string' ? setup.prePressRemarks : '',
      boardReadiness:
        setup.boardReadiness === 'ready' || setup.boardReadiness === 'waiting' || setup.boardReadiness === 'not_ready'
          ? setup.boardReadiness
          : derivedBoard,
      sheetSizeOverride: typeof setup.sheetSize === 'string' ? setup.sheetSize : '',
      priority: setup.priority === 'Urgent' ? 'Urgent' : 'Normal',
      artworkApproved: jc.artworkApproved,
      finalQcPass: jc.finalQcPass,
    } as const
    setInitialForm(init)
  }, [jc])

  useEffect(() => {
    const key = `job-card-full-edit-scroll:${id}`
    const saved = window.sessionStorage.getItem(key)
    if (saved) {
      const y = Number(saved)
      if (Number.isFinite(y) && y > 0) window.requestAnimationFrame(() => window.scrollTo({ top: y }))
    }
    const onScroll = () => window.sessionStorage.setItem(key, String(window.scrollY))
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [id])

  useEffect(() => {
    const next = searchParams.get('section')
    if (
      next === 'summary' ||
      next === 'spec' ||
      next === 'board' ||
      next === 'tooling' ||
      next === 'execution' ||
      next === 'validation'
    ) {
      setActiveSection(next)
      sectionRefs.current[next]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [searchParams])

  const cartonId = jc?.poLine?.cartonId ?? jc?.poLine?.carton?.id ?? null
  const embossBlockId = jc?.embossBlockId ?? jc?.poLine?.carton?.embossBlockId ?? null
  const embossRequired = isEmbossingRequired(jc?.poLine?.carton?.embossingLeafing ?? jc?.poLine?.embossingLeafing)
  const bible = jc?.productionBible
  const effectiveRouting = {
    ...suggestPostPressRouting(jc?.poLine ?? null),
    ...(jc?.postPressRouting ?? {}),
  }

  useEffect(() => {
    if (!cartonId || !artworkVersion.trim()) {
      setPlateCheck(null)
      return
    }
    const artworkCode = (jc?.poLine?.carton?.artworkCode || jc?.poLine?.cartonName || '').trim()
    fetch(`/api/plate-store/check?${new URLSearchParams({ cartonId, artworkCode, artworkVersion: artworkVersion.trim() })}`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.error) throw new Error(data.error)
        setPlateCheck(data)
      })
      .catch(() => setPlateCheck(null))
  }, [cartonId, artworkVersion, jc?.poLine?.carton?.artworkCode, jc?.poLine?.cartonName])

  useEffect(() => {
    const dyeId = jc?.poLine?.dyeId ?? null
    if (!dyeId) {
      setDyeDetail(null)
      return
    }
    fetch(`/api/masters/dyes/${dyeId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.error) throw new Error(data.error)
        setDyeDetail({
          dyeNumber: data.dyeNumber,
          condition: data.condition ?? data.conditionRating ?? 'Good',
          impressionCount: data.impressionCount ?? 0,
          maxImpressions: data.maxImpressions ?? 500000,
          active: data.active !== false,
        })
      })
      .catch(() => setDyeDetail(null))
  }, [jc?.poLine?.dyeId])

  useEffect(() => {
    if (!jc?.poLine) {
      setDieStoreCheck(null)
      return
    }
    fetch(`/api/die-store/check?${new URLSearchParams({
      cartonId: cartonId ?? '',
      cartonSize: jc.poLine.cartonSize ?? '',
      dieType: 'BSO',
      ups: '1',
      sheetSize: '',
    })}`)
      .then((r) => r.json())
      .then((data) => setDieStoreCheck(data))
      .catch(() => setDieStoreCheck(null))
  }, [cartonId, jc?.poLine?.cartonSize, jc?.poLine])

  useEffect(() => {
    if (!embossBlockId) {
      setEmbossDetail(null)
      return
    }
    fetch(`/api/masters/emboss-blocks/${embossBlockId}`)
      .then((r) => {
        if (!r.ok) throw new Error('Unavailable')
        return r.json()
      })
      .then((data) => {
        if (data?.error) throw new Error(data.error)
        setEmbossDetail({
          blockCode: data.blockCode,
          condition: data.condition ?? 'Good',
          impressionCount: data.impressionCount ?? 0,
          maxImpressions: data.maxImpressions ?? 100000,
          active: data.active !== false,
        })
      })
      .catch(() => setEmbossDetail('unavailable'))
  }, [embossBlockId])

  const stageByLabel = useMemo(() => {
    const map = new Map<string, Stage>()
    ;(jc?.stages || []).forEach((s) => map.set(s.stageName, s))
    return map
  }, [jc])

  const visibleStages = useMemo(() => {
    if (!jc) return []
    return [...jc.stages].filter((s) => stageAppliesToRouting(s.stageName, effectiveRouting, embossRequired))
  }, [jc, effectiveRouting, embossRequired])

  const stageChain = useMemo(() => {
    if (!jc || visibleStages.length === 0) return []
    const n = visibleStages.length
    const wpt = n > 1 ? jc.wastageSheets / (n - 1) : 0
    let prev = jc.totalSheets
    return visibleStages.map((s) => {
      const expectedInput = Math.round(prev)
      const afterWaste = Math.max(0, Math.round(expectedInput - wpt))
      const out = s.counter != null ? s.counter : afterWaste
      prev = out
      return {
        stage: s,
        expectedInput,
        afterWaste,
      }
    })
  }, [jc, visibleStages])

  const cumulativeWastePct =
    jc && jc.requiredSheets > 0 ? (jc.wastageSheets / jc.requiredSheets) * 100 : 0
  const wasteHot = cumulativeWastePct > 5

  const readinessRibbon = useMemo(() => {
    let plates: 'ok' | 'warn' | 'bad' | 'na' = 'na'
    if (plateCheck) {
      if (plateCheck.status === 'all_available') plates = 'ok'
      else if (plateCheck.status === 'partial') plates = 'warn'
      else plates = 'bad'
    }
    let die: 'ok' | 'warn' | 'bad' | 'na' = 'na'
    if (dieStoreCheck) {
      if (dieStoreCheck.status === 'available') die = 'ok'
      else if (dieStoreCheck.status === 'needs_attention') die = 'warn'
      else die = 'bad'
    }
    let block: 'ok' | 'warn' | 'bad' | 'na' = 'na'
    if (!embossRequired) block = 'na'
    else if (embossDetail === 'unavailable' || !embossBlockId) block = 'bad'
    else if (embossDetail) {
      const life = embossDetail.maxImpressions
        ? (embossDetail.impressionCount / embossDetail.maxImpressions) * 100
        : 0
      if (!embossDetail.active) block = 'bad'
      else if (life > 85) block = 'warn'
      else block = 'ok'
    }
    return { plates, die, block }
  }, [plateCheck, dieStoreCheck, embossDetail, embossRequired, embossBlockId])

  const update = <K extends keyof JobCard>(key: K, value: JobCard[K]) => {
    setJc((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  async function persistApprovalFlag(field: 'artworkApproved' | 'finalQcPass', value: boolean) {
    if (!jc) return
    const prev = jc[field]
    update(field, value as JobCard[typeof field])
    const ok = await saveChanges({ [field]: value })
    if (!ok) {
      update(field, prev as JobCard[typeof field])
    }
  }

  const updateStage = (stageId: string, patch: Partial<Stage>) => {
    setJc((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        stages: prev.stages.map((s) => (s.id === stageId ? { ...s, ...patch } : s)),
      }
    })
  }

  async function saveChanges(payload: Record<string, unknown>) {
    if (!jc) return
    setSaving(true)
    try {
      const res = await fetch(`/api/job-cards/${jc.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Save failed')
      toast.success('Updated')
      const refreshed = await fetch(`/api/job-cards/${jc.id}?auditTimeline=1`).then((r) => r.json())
      setJc(refreshed)
      setLastSavedAt(Date.now())
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
      return false
    } finally {
      setSaving(false)
    }
  }

  async function enqueueCutting() {
    if (!jc) return
    setEnqueueingCut(true)
    try {
      const res = await fetch(`/api/job-cards/${jc.id}/enqueue-cutting-queue`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed')
      toast.success(json.idempotent ? 'Already on cutting queue' : 'Enqueued for cutting')
      const refreshed = await fetch(`/api/job-cards/${jc.id}?auditTimeline=1`).then((r) => r.json())
      setJc(refreshed)
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
      return false
    } finally {
      setEnqueueingCut(false)
    }
  }

  async function pushToHubsFromJobCard() {
    if (!jc?.poLine?.id) {
      toast.error('PO line reference missing')
      return
    }
    const spec = (jc.poLine.specOverrides || {}) as Record<string, unknown>
    const artworkId =
      String(spec.artworkId || '').trim() ||
      String(jc.poLine.artworkCode || '').trim() ||
      String(jc.poLine.id).trim()
    const payload = {
      poLineId: jc.poLine.id,
      jobCardId: jc.id,
      artworkId,
      setNumber: String(jc.setNumber || '1'),
      dieId: jc.poLine.dyeId || null,
      embossBlockId: jc.embossBlockId || jc.poLine.carton?.embossBlockId || null,
      plateSetId: jc.plateSetId || null,
      dispatchDie: true,
      dispatchEmboss: isEmbossingRequired(jc.poLine.embossingLeafing ?? jc.poLine.carton?.embossingLeafing),
      dieSource: jc.poLine.dyeId ? 'OLD' : 'NEW',
      embossSource: (jc.embossBlockId || jc.poLine.carton?.embossBlockId) ? 'OLD' : 'NEW',
    } as const
    setHubPushing(true)
    try {
      const res = await fetch('/api/tooling-hub/unified-dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error || 'Failed to push hubs')
      toast.success('Pushed to hubs successfully')
      setLastSavedAt(Date.now())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to push hubs')
    } finally {
      setHubPushing(false)
    }
  }

  async function runReservationAction(action: 'reserve' | 'release' | 'reverse') {
    if (!jc?.poLine?.id || !materialReadiness?.materialId) {
      toast.error('Reservation API not connected yet')
      return
    }
    setSaving(true)
    try {
      const requiredSheets = Number(materialReadiness.requiredSheets || requiredDisplay || 0)
      const currentReserved = Number(materialReadiness.reservedSheets || 0)
      const body =
        action === 'reserve'
          ? {
              action: 'adjust',
              materialId: materialReadiness.materialId,
              requiredSheets,
              targetReserveQty: requiredSheets,
              prQty: Math.max(0, requiredSheets - currentReserved),
              reason: 'Job card reservation',
            }
          : {
              action: 'release',
              materialId: materialReadiness.materialId,
              requiredSheets,
              releaseQty: currentReserved,
              prImpactAction: action === 'reverse' ? 'cancel_if_no_shortage' : 'reduce',
            }
      const res = await fetch(`/api/planning/po-lines/${jc.poLine.id}/reservation-control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.success === false) throw new Error(json?.message || json?.error || 'Reservation action failed')
      toast.success(action === 'reserve' ? 'Material reserved' : action === 'reverse' ? 'Reservation reversed' : 'Material released')
      const readiness = await fetch(`/api/job-cards/${jc.id}/material-readiness`).then((r) => r.json())
      if (!readiness?.error) setMaterialReadiness(readiness as MaterialReadiness)
      setLastSavedAt(Date.now())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reservation action failed')
    } finally {
      setSaving(false)
    }
  }

  async function saveExecution(release: boolean, forceRelease = false) {
    if (!jc) return
    if (release) {
      const firstBlocking =
        !sheetDefined ? 'spec' : boardStatus !== 'ready' ? 'board' : !toolingReady ? 'tooling' : !awPoMatch ? 'validation' : null
      if (firstBlocking && !forceRelease) {
        setActiveSection(firstBlocking)
        sectionRefs.current[firstBlocking]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        toast.error('Resolve validation items before release')
        return false
      }
    }
    const nextRouting = {
      ...(jc.postPressRouting ?? {}),
      executionSetup: {
        prePressRemarks: prePressRemarks || null,
        boardReadiness,
        sheetSize: sheetSizeOverride || null,
        priority,
      },
    }
    return await saveChanges({
      shiftOperatorUserId: designerUserId || null,
      artworkApproved: jc.artworkApproved,
      finalQcPass: jc.finalQcPass,
      qaReleased: release ? true : jc.qaReleased,
      status: release ? 'qa_released' : jc.status,
      postPressRouting: nextRouting,
    })
  }

  async function pushToLiveProduction() {
    if (!jc) return
    setLivePushing(true)
    try {
      let released = await saveExecution(true)
      if (!released) {
        const proceed = window.confirm(
          'Some readiness checks are pending. Continue push to Print Planning + Cutting in trial override mode?',
        )
        if (!proceed) return
        released = await saveExecution(true, true)
      }
      if (!released) return
      const cutOk = await enqueueCutting()
      if (!cutOk) return
      toast.success('Pushed to Print Planning and Cutting')
    } finally {
      setLivePushing(false)
    }
  }

  async function queueStageReady(stageName: string) {
    if (!jc) return false
    const stage = jc.stages.find((s) => s.stageName === stageName)
    if (!stage) return true
    if (stage.status === 'ready' || stage.status === 'in_progress' || stage.status === 'completed') return true
    return await saveChanges({
      stages: [{ id: stage.id, status: 'ready' }],
    })
  }

  async function stampExecutionQueue(stepKey: string) {
    if (!jc) return false
    const prevRouting =
      jc.postPressRouting && typeof jc.postPressRouting === 'object'
        ? (jc.postPressRouting as Record<string, unknown>)
        : {}
    const existingExec =
      prevRouting.executionOrchestration && typeof prevRouting.executionOrchestration === 'object'
        ? (prevRouting.executionOrchestration as Record<string, unknown>)
        : {}
    return await saveChanges({
      postPressRouting: {
        ...prevRouting,
        executionOrchestration: {
          ...existingExec,
          [`${stepKey}QueuedAt`]: new Date().toISOString(),
        },
      },
    })
  }

  async function pushQueueStep(stepKey: string) {
    if (!jc) return
    setQueuePushing(stepKey)
    try {
      if (stepKey === 'cutting') {
        const ok = await enqueueCutting()
        if (!ok) return
        await stampExecutionQueue(stepKey)
        toast.success('Queued to Cutting')
        return
      }
      if (stepKey === 'printing') {
        const ok = await saveExecution(true)
        if (!ok) return
        await stampExecutionQueue(stepKey)
        toast.success('Queued to Print Planning')
        return
      }
      if (stepKey === 'dispatch') {
        const ok = await saveChanges({ status: 'final_qc' })
        if (!ok) return
        await stampExecutionQueue(stepKey)
        toast.success('Queued to Dispatch Readiness')
        return
      }
      if (stepKey === 'billing') {
        await stampExecutionQueue(stepKey)
        router.push(`/billing/new?jobCardId=${jc.id}`)
        return
      }
      const stageMap: Record<string, string> = {
        chemical_coating: 'Chemical Coating',
        lamination: 'Lamination',
        spot_uv: 'Spot UV',
        leafing: 'Leafing',
        embossing: 'Embossing',
        dye_cutting: 'Dye Cutting',
        pasting: 'Pasting',
      }
      const mapped = stageMap[stepKey]
      if (!mapped) return
      const ok = await queueStageReady(mapped)
      if (!ok) return
      await stampExecutionQueue(stepKey)
      toast.success(`Queued to ${mapped}`)
    } finally {
      setQueuePushing(null)
    }
  }

  const returnTo = searchParams.get('returnTo') || '/production/job-cards'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveExecution(false)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        router.push(returnTo)
        return
      }
      if (e.key === ']' || e.key === '[') {
        const raw = window.sessionStorage.getItem('job-card-visible-order')
        if (!raw) return
        const ids = raw.split(',').filter(Boolean)
        const idx = ids.indexOf(id)
        if (idx < 0) return
        const nextIdx = e.key === ']' ? idx + 1 : idx - 1
        if (nextIdx < 0 || nextIdx >= ids.length) return
        e.preventDefault()
        router.push(`/production/job-cards/${ids[nextIdx]}?returnTo=${encodeURIComponent(returnTo)}`)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, returnTo, router, jc, saveExecution])

  useEffect(() => {
    const timer = window.setInterval(() => setLastSavedAt(Date.now()), 15000)
    return () => window.clearInterval(timer)
  }, [])

  if (!jc) {
    return (
      <div className={`min-h-screen bg-background p-5 text-ds-ink ${mono}`}>
        <div className="mx-auto max-w-[1600px] space-y-4">
          <div className="h-24 animate-pulse rounded-[16px] border border-ds-line bg-card shadow-ds-depth-sm" />
          <div className="grid grid-cols-5 gap-3">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-[14px] border border-ds-line bg-card shadow-ds-depth-sm" />
            ))}
          </div>
          <div className="grid grid-cols-12 gap-4">
            <div className="col-span-8 grid grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-44 animate-pulse rounded-[16px] border border-ds-line bg-card shadow-ds-depth-sm" />
              ))}
            </div>
            <div className="col-span-4 space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-44 animate-pulse rounded-[16px] border border-ds-line bg-card shadow-ds-depth-sm" />
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const productName = jc.poLine?.cartonName ?? 'Not linked'
  const resolvedSheetSize = resolveSheetSize({
    ...(jc.poLine || {}),
    specOverrides: jc.poLine?.specOverrides || {},
    product: jc.poLine?.carton || {},
    carton: jc.poLine?.carton || {},
    materialQueue: jc.poLine?.materialQueue || {},
  })
  const sheetSizeDisplay = bible?.sheetSizeLabel ?? (resolvedSheetSize !== '-' ? resolvedSheetSize : '—')
  const resolvedUps = resolveUps({
    ...(jc.poLine || {}),
    specOverrides: jc.poLine?.specOverrides || {},
    product: jc.poLine?.carton || {},
    carton: jc.poLine?.carton || {},
    materialQueue: jc.poLine?.materialQueue || {},
  })
  const upsDisplay = bible?.ups ?? resolvedUps ?? '—'
  const planningRequirement = resolveRequirementFromLine({
    line: {
      ...(jc.poLine || {}),
      specOverrides: jc.poLine?.specOverrides || {},
      product: jc.poLine?.carton || {},
      carton: jc.poLine?.carton || {},
      materialQueue: jc.poLine?.materialQueue || {},
    },
    qtyOverride: jc.poLine?.quantity ?? undefined,
  })
  const grainDisplay = bible?.grainDirection ?? jc.poLine?.materialQueue?.grainDirection ?? '—'
  const poDateDisplay = formatDateDisplay(jc.poLine?.po?.poDate)
  const lineSpec = (jc.poLine?.specOverrides || {}) as Record<string, unknown>
  const orderQty = Number(jc.poLine?.quantity || 0)
  const fgUseEnabled = lineSpec.fgUseEnabled === true
  const fgUsed = (() => {
    if (!fgUseEnabled) return 0
    const raw = Number(lineSpec.fgUseQty)
    const want = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
    return Math.max(0, Math.min(want, Math.max(0, orderQty)))
  })()
  const fgNetToProduce = Math.max(0, orderQty - fgUsed)
  const asSpecText = (...vals: unknown[]) => {
    for (const v of vals) {
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return null
  }
  const asSpecNum = (...vals: unknown[]) => {
    for (const v of vals) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return null
  }
  const planningCore = (lineSpec.planningCore && typeof lineSpec.planningCore === 'object'
    ? (lineSpec.planningCore as Record<string, unknown>)
    : {}) as Record<string, unknown>
  const colourSpec =
    asSpecText(
      lineSpec.colorSpec,
      lineSpec.colourSpec,
      lineSpec.colour,
      lineSpec.color,
      lineSpec.printingType,
      jc.poLine?.carton?.printingType,
    ) ||
    '—'
  const shadeFromCarton =
    jc.poLine?.carton?.colourBreakdown && typeof jc.poLine.carton.colourBreakdown === 'object'
      ? JSON.stringify(jc.poLine.carton.colourBreakdown)
      : ''
  const colorDisplay = colourSpec !== '—' ? colourSpec : shadeFromCarton || '—'
  const gsmDisplay =
    asSpecNum(
      lineSpec.gsm,
      planningCore.gsm,
      jc.poLine?.gsm,
      jc.poLine?.materialQueue?.gsm,
      jc.boardMaterial?.ledgerLink?.gsm,
    ) ?? '—'
  const paperDisplay =
    asSpecText(
      lineSpec.paperType,
      lineSpec.boardType,
      planningCore.boardType,
      jc.poLine?.paperType,
      jc.poLine?.materialQueue?.boardType,
      jc.boardMaterial?.ledgerLink?.board,
    ) ??
    '—'
  const materialCodeDisplay =
    materialReadiness?.materialCode ||
    jc.issuedStockDisplay ||
    jc.boardMaterial?.batchLotNumber ||
    'Not linked'
  const requiredDisplay =
    materialReadiness?.requiredSheets ??
    asSpecNum(lineSpec.requiredSheets, planningCore.requiredSheets) ??
    jc.poLine?.materialQueue?.totalSheets ??
    planningRequirement.requiredSheets ??
    jc.requiredSheets
  const wastageDisplay =
    jc.wastageSheets > 0
      ? jc.wastageSheets
      : (asSpecNum(lineSpec.wastageSheets, planningCore.wastageSheets) ?? planningRequirement.wastageSheets)
  const reservedDisplay =
    materialReadiness?.reservedSheets ??
    asSpecNum(lineSpec.reservedSheets, planningCore.reservedSheets) ??
    jc.boardMaterial?.reservedSheets ??
    0
  const shortageDisplay =
    materialReadiness?.shortageSheets ??
    asSpecNum(lineSpec.shortageSheets, planningCore.shortageSheets) ??
    jc.boardMaterial?.shortageSheets ??
    0
  const availableDisplay =
    materialReadiness?.availableStock ??
    asSpecNum(lineSpec.availableSheets, planningCore.availableSheets) ??
    jc.boardMaterial?.availableStock ??
    0
  const coatingDisplay = asSpecText(lineSpec.coatingType, jc.poLine?.coatingType, jc.poLine?.carton?.coatingType) ?? '—'
  const otherCoatingDisplay = asSpecText(lineSpec.otherCoating, jc.poLine?.otherCoating, jc.poLine?.carton?.laminateType) ?? 'None'
  const embossDisplay = asSpecText(lineSpec.embossingLeafing, jc.poLine?.embossingLeafing, jc.poLine?.carton?.embossingLeafing) ?? 'None'
  const pastingDisplay = asSpecText(lineSpec.pastingStyle, jc.poLine?.carton?.pastingStyle) ?? 'BSO'
  const artworkDisplay = asSpecText(lineSpec.artworkCode, jc.poLine?.artworkCode, jc.poLine?.carton?.artworkCode) ?? '—'
  const poDateFinal = poDateDisplay !== '-' ? poDateDisplay : formatDateDisplay(asSpecText(lineSpec.poDate, planningCore.poDate))

  const incomingDisplay =
    materialReadiness?.openPoQty ??
    jc.boardMaterial?.openPoQty ??
    (materialReadiness?.prStatus && materialReadiness.prStatus !== 'not_created' ? materialReadiness.shortageSheets : 0)
  const expectedArrival =
    materialReadiness?.expectedArrivalDate ??
    materialReadiness?.grnEta ??
    jc.boardMaterial?.expectedArrivalDate ??
    null
  const materialReadyStatus = getReadinessStatus(
    Number(requiredDisplay || 0),
    Number(reservedDisplay || 0),
    Number(availableDisplay || 0),
    Number(incomingDisplay || 0),
  )
  const procurementStatus =
    materialReadiness?.procurementStatus ??
    jc.boardMaterial?.procurementStatus ??
    (materialReadyStatus === 'Ready' ? 'Ready for Production' : incomingDisplay > 0 ? 'Material Under Procurement' : 'Waiting for Material')
  const boardStatus = materialReadyStatus === 'Ready' ? 'ready' : boardReadiness
  const toolRows = [
    { name: 'Die', id: bible?.toolingKit.die?.code ?? '—', source: 'Tooling Hub', linked: !!bible?.toolingKit.die },
    { name: 'Plate', id: bible?.toolingKit.plate?.code ?? plateCheck?.plateSetCode ?? '—', source: 'Plate Hub', linked: !!bible?.toolingKit.plate || !!plateCheck?.plateSetCode },
    ...(embossRequired
      ? [{ name: 'Emboss', id: bible?.toolingKit.emboss?.code ?? '—', source: 'Tooling Hub', linked: !!bible?.toolingKit.emboss }]
      : []),
    { name: 'Shade Card', id: bible?.toolingKit.shade?.shadeCode ?? bible?.shadeCard?.shadeCode ?? '—', source: 'Tooling Hub', linked: !!(bible?.toolingKit.shade || bible?.shadeCard) },
  ]
  const toolingReady = toolRows.every((t) => t.linked)
  const effectiveSheetSize = sheetSizeDisplay !== '—' ? sheetSizeDisplay : sheetSizeOverride
  const sheetDefined = effectiveSheetSize.trim() !== ''
  const awPoMatch = !!jc.poLine?.po.poNumber && !!jc.poLine?.id
  const releaseBlocked = !(sheetDefined && boardStatus === 'ready' && toolingReady && awPoMatch)
  const isDirty =
    !!initialForm &&
    (designerUserId !== initialForm.designerUserId ||
      prePressRemarks !== initialForm.prePressRemarks ||
      boardReadiness !== initialForm.boardReadiness ||
      sheetSizeOverride !== initialForm.sheetSizeOverride ||
      priority !== initialForm.priority ||
      jc.artworkApproved !== initialForm.artworkApproved ||
      jc.finalQcPass !== initialForm.finalQcPass)
  const statusLabel = jc.status === 'qa_released' || jc.status === 'closed' ? 'Released' : jc.status === 'in_progress' || jc.status === 'final_qc' ? 'Ready' : titleize(jc.status, 'Draft')
  const statusTone = getStatusTone(statusLabel)
  const machineMap = new Map<string, MachineOption>()
  machines.forEach((m) => {
    machineMap.set(m.id, m)
    machineMap.set(m.machineCode, m)
  })
  const operatorMap = new Map(shiftOperators.map((u) => [u.id, u.name]))
  const resolveMachineName = (value: unknown) => {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (!raw) return 'Machine not linked'
    const m = machineMap.get(raw)
    return m ? `${m.machineCode} ${m.name}` : /^[0-9a-f-]{24,}$/i.test(raw) ? 'Machine not linked' : raw
  }
  const resolveOperatorName = (value: unknown) => {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (!raw) return 'Operator not linked'
    return operatorMap.get(raw) ?? (/^[0-9a-f-]{24,}$/i.test(raw) ? 'Operator not linked' : raw)
  }
  const currentStage = visibleStages.find((s) => s.status === 'in_progress')?.stageName ?? visibleStages.find((s) => s.status === 'ready')?.stageName ?? statusLabel
  const completedQty = Math.max(...visibleStages.map((s) => Number(s.counter || 0)), 0)
  const plannedQty = fgNetToProduce || Number(jc.poLine?.quantity || jc.requiredSheets || 0)
  const balanceQty = getOperationBalance(plannedQty, completedQty)
  const totalSheetsDisplay = Number(requiredDisplay || 0) + Number(wastageDisplay || 0)
  const canUseReservationApi = !!(jc.poLine?.id && materialReadiness?.materialId)
  const searchNeedle = jobSearch.trim().toLowerCase()
  const textMatches = (parts: unknown[]) => !searchNeedle || parts.some((p) => String(p ?? '').toLowerCase().includes(searchNeedle))
  const rows = (...items: Array<readonly [string, unknown]>) => items
  const operations = stageChain.map((row, index) => {
    const machineId =
      row.stage.stageData?.machineId ??
      row.stage.stageData?.machineCode ??
      (row.stage.stageName === 'Printing' ? jc.postPressRouting?.printPlan?.machineId : null) ??
      jc.machineId
    const done = Number(row.stage.counter || 0)
    const planned = Number(row.stage.totalSheets || row.stage.requiredSheets || plannedQty || 0)
    return {
      index: index + 1,
      id: row.stage.id,
      operation: row.stage.stageName,
      machine: resolveMachineName(machineId),
      operator: resolveOperatorName(row.stage.operator),
      planned,
      done,
      balance: getOperationBalance(planned, done),
      wastage: Math.max(0, row.expectedInput - (row.stage.counter ?? row.afterWaste)),
      status: row.stage.status === 'pending' ? 'Not Pushed Yet' : titleize(row.stage.status, 'Not Started'),
      start: row.stage.inProgressSince ?? row.stage.createdAt ?? null,
      end: row.stage.completedAt ?? null,
    }
  })
  const visibleOperations = operations.filter((op) => {
    const q = operationSearch.trim().toLowerCase()
    if (!q) return true
    return [op.operation, op.machine, op.operator, op.status].some((p) => p.toLowerCase().includes(q))
  })
  const orchestration =
    jc.postPressRouting && typeof jc.postPressRouting === 'object'
      ? (((jc.postPressRouting as Record<string, unknown>).executionOrchestration ?? {}) as Record<string, unknown>)
      : {}
  const isQueued = (key: string) => typeof orchestration[`${key}QueuedAt`] === 'string'
  const kpis: Array<{ label: string; value: string; unit?: string; icon: LucideIcon; tone?: string }> = [
    { label: 'PO Quantity', value: formatQty(jc.poLine?.quantity, 'pcs'), icon: ClipboardList },
    { label: 'Planned Quantity', value: formatQty(plannedQty, 'pcs'), icon: Factory },
    { label: 'Required Sheets', value: formatQty(requiredDisplay), icon: CalendarClock },
    { label: 'Reserved Sheets', value: formatQty(reservedDisplay), icon: PackageCheck, tone: 'text-[var(--success)]' },
    { label: 'Available Stock', value: formatQty(availableDisplay), icon: Boxes, tone: 'text-[var(--success)]' },
    { label: 'Wastage Sheets', value: formatQty(wastageDisplay), icon: Layers3, tone: wasteHot ? 'text-ds-warning' : undefined },
    { label: 'Completed Qty', value: formatQty(completedQty, 'pcs'), icon: Check, tone: 'text-ds-brand' },
    { label: 'Balance Qty', value: formatQty(balanceQty, 'pcs'), icon: Clock3, tone: 'text-ds-brand' },
    { label: 'Current Stage', value: cleanText(currentStage, 'Pending'), icon: Sparkles, tone: 'text-ds-brand' },
    { label: 'Material Status', value: materialReadyStatus, icon: ShieldCheck, tone: materialReadyStatus === 'Ready' ? 'text-[var(--success)]' : materialReadyStatus === 'Waiting' ? 'text-ds-warning' : 'text-[var(--error)]' },
  ]
  type SummaryCard = { title: string; preview?: boolean; rows: Array<readonly [string, unknown]> }
  const summaryCards: SummaryCard[] = [
    {
      title: 'Customer & PO Details',
      rows: rows(
        ['Customer', jc.customer.name],
        ['PO No', jc.poLine?.po.poNumber ?? 'Not linked'],
        ['PO Date', poDateFinal],
        ['Delivery Date', formatDateDisplay(jc.poLine?.po.deliveryRequiredBy) === '-' ? 'Not available' : formatDateDisplay(jc.poLine?.po.deliveryRequiredBy)],
        ['Sales Order', 'Not linked'],
        ['Contact Person', 'Not linked'],
        ['Phone', 'Not linked'],
      ),
    },
    {
      title: 'Product / Carton Details',
      preview: true,
      rows: rows(
        ['Product Name', productName],
        ['Product Code', artworkDisplay],
        ['Carton Type', pastingDisplay],
        ['Color / Print Spec', colorDisplay],
        ['UPS / Gang', cleanText(String(upsDisplay), 'Not configured')],
      ),
    },
    {
      title: 'Size / Board / Paper Details',
      rows: rows(
        ['Sheet Size', sheetSizeDisplay],
        ['Cut Size', jc.poLine?.cartonSize ?? 'Not configured'],
        ['Board', paperDisplay],
        ['GSM', gsmDisplay],
        ['Paper', paperDisplay],
        ['Board / GSM', `${paperDisplay} / ${gsmDisplay}`],
      ),
    },
    {
      title: 'Quantity & Sheet Calculation',
      rows: rows(
        ['PO Quantity', formatQty(jc.poLine?.quantity, 'pcs')],
        ['Planned Quantity', formatQty(plannedQty, 'pcs')],
        ['Ups / Gang', cleanText(String(upsDisplay), 'Not configured')],
        ['Required Sheets', formatQty(requiredDisplay)],
        ['Wastage Sheets', `${formatQty(wastageDisplay)}${cumulativeWastePct ? ` (${cumulativeWastePct.toFixed(1)}%)` : ''}`],
        ['Total Sheets', formatQty(totalSheetsDisplay)],
        ['Available Stock', formatQty(availableDisplay)],
        ['Reserved Sheets', formatQty(reservedDisplay)],
        ['Shortage Sheets', formatQty(shortageDisplay)],
      ),
    },
    {
      title: 'Priority / Status / Timeline',
      rows: rows(
        ['Priority', priority],
        ['Status', statusLabel],
        ['Current Stage', currentStage],
        ['Job Card Created On', formatDateTimeDisplay(jc.createdAt ?? jc.jobDate)],
        ['Planned Start Date', 'Not available'],
        ['Planned Completion', 'Not available'],
        ['Assigned To', jc.shiftOperator?.name ?? resolveOperatorName(jc.assignedOperator)],
      ),
    },
    {
      title: 'Other Details',
      rows: rows(
        ['Set No', jc.setNumber ?? 'Not linked'],
        ['Gang Set', cleanText(asSpecText(lineSpec.gangSet, planningCore.gangSet), 'Not linked')],
        ['Designer', jc.shiftOperator?.name ?? 'Not linked'],
        ['Planning By', cleanText(asSpecText(planningCore.planningBy, lineSpec.planningBy), 'Not linked')],
        ['Remarks', cleanText(jc.poLine?.remarks ?? prePressRemarks, 'Not available')],
        ['Internal Ref', cleanText(jc.batchNumber, 'Not linked')],
      ),
    },
  ].filter((card) => textMatches([card.title, ...card.rows.flat()]))
  const mediaFiles = [
    jc.fileUrl ? { label: 'Artwork File', name: jc.fileUrl.split('/').pop() || 'Artwork file', icon: FileText } : null,
    artworkDisplay !== '—' && artworkDisplay !== 'Not available' ? { label: 'Artwork Reference', name: artworkDisplay, icon: FileText } : null,
    jc.poLine?.po.poNumber ? { label: 'PO Document', name: `PO ${jc.poLine.po.poNumber}`, icon: FileText } : null,
    { label: 'Product Image', name: 'Not linked', icon: ImageIcon },
  ].filter((x): x is { label: string; name: string; icon: LucideIcon } => !!x)
  const noteItems = [
    ['Production Notes', prePressRemarks ? 1 : 0],
    ['QC Notes', jc.finalQcPass ? 1 : 0],
    ['Customer Notes', cleanText(jc.poLine?.remarks, '') ? 1 : 0],
    ['Internal Notes', jc.batchNumber ? 1 : 0],
    ['Operator Instructions', jc.assignedOperator ? 1 : 0],
  ] as const
  const historyEvents = [
    ...(jc.auditTimeline ?? []).map((ev) => ({
      title: ev.summary || titleize(ev.action),
      at: ev.at,
      source: ev.userName ?? 'System',
      remarks: titleize(ev.tableName),
    })),
    ...materialTimeline.map((ev) => ({
      title: ev.event,
      at: ev.at,
      source: 'System',
      remarks: ev.detail,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at))

  const Pill = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
    <span className={`inline-flex h-5 items-center rounded-full px-2 text-[10px] font-medium ${className}`}>{children}</span>
  )
  const Card = ({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) => (
    <section className="bp-card rounded-[14px] p-2.5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-ds-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
  const FieldGrid = ({ rows }: { rows: Array<readonly [string, unknown]> }) => (
    <div className="bp-field-grid bp-field-grid-compact grid gap-x-3 gap-y-1 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <p className="bp-label">{label}</p>
          <p className="bp-value min-w-0 break-words">{cleanText(value, 'Not available')}</p>
        </div>
      ))}
    </div>
  )
  const QueueButton = ({ stepKey, label, tone }: { stepKey: string; label: string; tone: 'purple' | 'blue' | 'green' }) => {
    const done = stepKey === 'cutting' ? isQueued('cutting') || stageByLabel.get('Cutting')?.status !== 'pending' : isQueued(stepKey)
    const color =
      tone === 'green'
        ? 'border-[var(--success)]/20 bg-[var(--success-bg)] text-[var(--success)]'
        : tone === 'purple'
          ? 'border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-500/25 dark:bg-purple-500/10 dark:text-purple-200'
          : 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/25 dark:bg-blue-500/10 dark:text-blue-200'
    return (
      <button
        type="button"
        onClick={() => void pushQueueStep(stepKey)}
        disabled={saving || enqueueingCut || livePushing || queuePushing !== null}
        className={`inline-flex h-7 items-center justify-between gap-2 rounded-[8px] border px-2.5 text-[11px] font-medium transition hover:opacity-85 disabled:opacity-50 ${color}`}
        title={done ? 'Already pushed or linked' : 'Push using existing workflow'}
      >
        <span>{queuePushing === stepKey ? 'Pushing...' : label}</span>
        {done ? <Check className="h-3 w-3" /> : <Clock3 className="h-3 w-3" />}
      </button>
    )
  }

  return (
    <div className="job-card-blueprint min-h-screen pb-8 text-ds-ink">
      <div className="mx-auto max-w-[1680px] space-y-2.5 px-4 py-2.5">
        <header className="bp-shell sticky top-0 z-30 rounded-[16px] px-4 py-2.5 backdrop-blur">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <button type="button" onClick={() => (window.history.length > 1 ? router.back() : router.push(returnTo))} className="mb-1 inline-flex items-center gap-1 text-[11px] font-medium text-ds-ink-faint hover:text-ds-ink">
                <ArrowLeft className="h-3 w-3" /> Back to Job Cards
              </button>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className={`text-[21px] font-semibold leading-none text-ds-ink ${mono}`}>Job Card</h1>
                <span className="text-[19px] font-semibold leading-none text-ds-brand">JC-{jc.jobCardNumber}</span>
                <Pill className={statusTone}>{statusLabel}</Pill>
                <Pill className={priority === 'Urgent' ? 'bg-[var(--error-bg)] text-[var(--error)]' : 'bg-ds-warning/10 text-ds-warning'}>{priority} Priority</Pill>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[10.5px] text-ds-ink-faint">
                <span>Customer <b className="ml-1 text-ds-ink">{cleanText(jc.customer.name)}</b></span>
                <span>PO No <b className="ml-1 text-ds-ink">{jc.poLine?.po.poNumber ?? 'Not linked'}</b></span>
                <span>Product <b className="ml-1 text-ds-ink">{productName}</b></span>
                <span>Last updated <b className="ml-1 text-ds-ink">{formatDateTimeDisplay(jc.updatedAt ?? (lastSavedAt ? new Date(lastSavedAt) : null))}</b></span>
                <span>{isDirty ? 'Unsaved changes' : 'No pending changes'}</span>
              </div>
            </div>
            <div className="flex max-w-[780px] flex-wrap items-center justify-end gap-1.5">
              <label className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ds-ink-faint" />
                <input value={jobSearch} onChange={(e) => setJobSearch(e.target.value)} placeholder="Search in job card..." className="h-8 w-64 rounded-[9px] border border-ds-line bg-background pl-8 pr-3 text-xs outline-none transition focus:border-ds-brand" />
              </label>
              <button type="button" onClick={() => void saveExecution(false)} className="inline-flex h-8 items-center gap-1.5 rounded-[9px] border border-ds-line bg-card px-2.5 text-xs font-medium hover:bg-ds-main"><Pencil className="h-3.5 w-3.5" /> Edit Job Card</button>
              <button type="button" title={canUseReservationApi ? 'Reserve material' : 'Reservation API not connected yet'} disabled={!canUseReservationApi || saving} onClick={() => void runReservationAction('reserve')} className="inline-flex h-8 items-center gap-1.5 rounded-[9px] border border-ds-line bg-card px-2.5 text-xs font-medium hover:bg-ds-main disabled:opacity-50"><PackageCheck className="h-3.5 w-3.5" /> Reserve Material</button>
              <button type="button" title={canUseReservationApi ? 'Release material' : 'Reservation API not connected yet'} disabled={!canUseReservationApi || saving} onClick={() => void runReservationAction('release')} className="inline-flex h-8 items-center gap-1.5 rounded-[9px] border border-ds-line bg-card px-2.5 text-xs font-medium hover:bg-ds-main disabled:opacity-50"><Undo2 className="h-3.5 w-3.5" /> Release Material</button>
              <button type="button" onClick={() => window.print()} className="inline-flex h-8 items-center gap-1.5 rounded-[9px] border border-ds-line bg-card px-2.5 text-xs font-medium hover:bg-ds-main"><Printer className="h-3.5 w-3.5" /> Print Job Card <ChevronDown className="h-3 w-3" /></button>
              <a href={`/api/job-cards/${jc.id}/card-pdf`} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-[9px] border border-ds-line bg-card px-2.5 text-xs font-medium hover:bg-ds-main"><Download className="h-3.5 w-3.5" /> Export PDF</a>
              <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-[9px] border border-ds-line bg-card px-2.5 text-xs font-medium hover:bg-ds-main"><MoreVertical className="h-3.5 w-3.5" /> More <ChevronDown className="h-3 w-3" /></button>
            </div>
          </div>
        </header>

        <section className="bp-shell grid grid-cols-2 gap-0 rounded-[14px] p-1.5 md:grid-cols-5 xl:grid-cols-10">
          {kpis.map(({ label, value, icon: Icon, tone }) => (
            <div key={label} className="flex min-h-[50px] items-center gap-2.5 px-2 py-1.5 xl:border-r xl:last:border-r-0" style={{ borderColor: 'var(--jc-border-soft)' }}>
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-ds-main text-ds-brand"><Icon className="h-3.5 w-3.5" /></span>
              <div className="min-w-0">
                <p className="truncate text-[9.5px] font-medium text-ds-ink-faint">{label}</p>
                <p className={`truncate text-[14px] font-semibold leading-tight ${mono} ${tone ?? 'text-ds-ink'}`}>{value}</p>
              </div>
            </div>
          ))}
        </section>

        <nav className="bp-shell rounded-[13px] px-2">
          <div className="flex overflow-x-auto">
            {[
              ['summary', 'Job Summary', ClipboardList, 'summary'],
              ['material', 'Material & Sheet Config', Boxes, 'board'],
              ['printing', 'Printing & Finishing', Printer, 'spec'],
              ['operations', 'Operations', TableProperties, 'execution'],
              ['tooling', 'Tooling Readiness', Wrench, 'tooling'],
              ['media', 'Media Files', FileText, 'media'],
              ['notes', 'Notes', StickyNote, 'notes'],
              ['history', 'History', Clock3, 'history'],
            ].map(([key, label, Icon, refKey]) => (
              <button
                key={String(key)}
                type="button"
                onClick={() => {
                  setActiveSection(key as typeof activeSection)
                  sectionRefs.current[String(refKey)]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
                className={`inline-flex h-9 shrink-0 items-center gap-2 border-b-2 px-4 text-xs font-semibold transition ${
                  activeSection === key ? 'border-ds-brand text-ds-brand' : 'border-transparent text-ds-ink-muted hover:text-ds-ink'
                }`}
              >
                <Icon className="h-3.5 w-3.5" /> {String(label)}
              </button>
            ))}
          </div>
        </nav>

        <main className="grid grid-cols-1 gap-3 xl:grid-cols-12">
          <div className="space-y-3 xl:col-span-8 2xl:col-span-9">
            <div ref={(el) => { sectionRefs.current.summary = el }} className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {summaryCards.length === 0 ? (
                <div className="rounded-[16px] border border-ds-line bg-card p-6 text-sm text-ds-ink-faint shadow-ds-depth-sm xl:col-span-3">No matching job card fields.</div>
              ) : (
                summaryCards.map((card) => (
                  <Card key={card.title} title={card.title}>
                    {card.preview ? (
                      <div className="mb-2 grid gap-2.5 sm:grid-cols-[70px_1fr]">
                        <div className="grid h-[72px] min-w-0 place-items-center rounded-[10px] bg-ds-main text-ds-ink-faint">
                          <ImageIcon className="h-7 w-7" />
                        </div>
                        <FieldGrid rows={card.rows.slice(0, 3)} />
                      </div>
                    ) : null}
                    <FieldGrid rows={card.preview ? card.rows.slice(3) : card.rows} />
                  </Card>
                ))
              )}
            </div>

            {fgUseEnabled && fgUsed > 0 ? (
              <div className="rounded-[14px] border border-[var(--success)]/20 bg-[var(--success-bg)]/20 px-4 py-3 text-sm text-ds-ink">
                <span className="font-semibold text-[var(--success)]">Existing FG stock used:</span> {formatQty(fgUsed, 'pcs')} fulfilled from finished goods, produce {formatQty(fgNetToProduce, 'pcs')} of {formatQty(orderQty, 'pcs')} ordered.
              </div>
            ) : null}

            <Card title="Production Queue Flow">
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-[0.9fr_2fr_0.9fr]">
                <div>
                  <p className="mb-1.5 text-[11px] font-semibold text-purple-700 dark:text-purple-200">Pre-Press</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button type="button" disabled={hubPushing} onClick={() => void pushToHubsFromJobCard()} className="inline-flex h-7 items-center justify-between rounded-[8px] border border-purple-200 bg-purple-50 px-2.5 text-[11px] font-medium text-purple-700 disabled:opacity-50 dark:border-purple-500/25 dark:bg-purple-500/10 dark:text-purple-200">Push Artwork <Check className="h-3 w-3" /></button>
                    <button type="button" disabled={hubPushing} onClick={() => void pushToHubsFromJobCard()} className="inline-flex h-7 items-center justify-between rounded-[8px] border border-purple-200 bg-purple-50 px-2.5 text-[11px] font-medium text-purple-700 disabled:opacity-50 dark:border-purple-500/25 dark:bg-purple-500/10 dark:text-purple-200">Push Plate <Clock3 className="h-3 w-3" /></button>
                    <button type="button" disabled={hubPushing} onClick={() => void pushToHubsFromJobCard()} className="inline-flex h-7 items-center justify-between rounded-[8px] border border-purple-200 bg-purple-50 px-2.5 text-[11px] font-medium text-purple-700 disabled:opacity-50 dark:border-purple-500/25 dark:bg-purple-500/10 dark:text-purple-200">Push Die <Clock3 className="h-3 w-3" /></button>
                    <button type="button" disabled={hubPushing} onClick={() => void pushToHubsFromJobCard()} className="inline-flex h-7 items-center justify-between rounded-[8px] border border-purple-200 bg-purple-50 px-2.5 text-[11px] font-medium text-purple-700 disabled:opacity-50 dark:border-purple-500/25 dark:bg-purple-500/10 dark:text-purple-200">Push Shade Card <Clock3 className="h-3 w-3" /></button>
                  </div>
                </div>
                <div>
                  <p className="mb-1.5 text-[11px] font-semibold text-blue-700 dark:text-blue-200">Production</p>
                  <div className="grid grid-cols-2 gap-1.5 xl:grid-cols-3">
                    {[
                      ['cutting', 'Push Cutting'],
                      ['printing', 'Push Printing'],
                      ['chemical_coating', 'Push Coating'],
                      ['lamination', 'Push Lamination'],
                      ['spot_uv', 'Push Spot UV'],
                      ['leafing', 'Push Leafing'],
                      ['embossing', 'Push Emboss'],
                      ['dye_cutting', 'Push Die Cutting'],
                      ['pasting', 'Push Pasting'],
                    ].map(([key, label]) => <QueueButton key={key} stepKey={key} label={label} tone="blue" />)}
                  </div>
                </div>
                <div>
                  <p className="mb-1.5 text-[11px] font-semibold text-[var(--success)]">Post-Production</p>
                  <div className="grid gap-1.5">
                    <QueueButton stepKey="dispatch" label="Push Dispatch" tone="green" />
                    <QueueButton stepKey="billing" label="Push Billing" tone="green" />
                  </div>
                </div>
              </div>
            </Card>

            <div ref={(el) => { sectionRefs.current.spec = el }}>
              <Card title="Printing & Finishing">
                <div className="mb-4">
                  <SpecPackPanel specPack={jc.poLine?.specPack ?? null} specOverrides={jc.poLine?.specOverrides ?? null} />
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-5">
                  <FieldGrid rows={[['Coating', coatingDisplay], ['Other Coating', otherCoatingDisplay], ['Emboss / Leaf', embossDisplay], ['Paper', paperDisplay], ['Color / Spec', colorDisplay], ['Sheet Size', sheetSizeDisplay], ['UPS', upsDisplay], ['GSM', gsmDisplay], ['Dye Details', dyeDetail && dyeDetail !== 'unavailable' ? dyeDetail.dyeNumber : 'Not linked'], ['Pasting', pastingDisplay]]} />
                </div>
              </Card>
            </div>

            <div ref={(el) => { sectionRefs.current.execution = el }}>
              <Card
                title="Operations"
                action={
                  <label className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ds-ink-faint" />
                    <input value={operationSearch} onChange={(e) => setOperationSearch(e.target.value)} placeholder="Search operations..." className="h-8 w-56 rounded-[10px] border border-ds-line bg-background pl-9 pr-3 text-xs outline-none focus:border-ds-brand" />
                  </label>
                }
              >
                <div className="overflow-x-auto">
                  <table className="min-w-[1100px] w-full text-xs">
                    <thead className="bg-ds-main/50 text-ds-ink-faint">
                      <tr>
                        {['#', 'Operation', 'Machine Name', 'Operator', 'Planned Qty', 'Done Qty', 'Balance Qty', 'Wastage', 'Status', 'Start Time', 'End Time', 'Action'].map((h) => (
                          <th key={h} className="px-2 py-2 text-left font-semibold">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ds-line">
                      {visibleOperations.length === 0 ? (
                        <tr><td colSpan={12} className="px-3 py-6 text-center text-ds-ink-faint">No operations found.</td></tr>
                      ) : visibleOperations.map((op) => (
                        <tr key={op.id} className="align-middle">
                          <td className="px-2 py-2">{op.index}</td>
                          <td className="px-2 py-2 font-medium">{op.operation}</td>
                          <td className="px-2 py-2">{op.machine}</td>
                          <td className="px-2 py-2">{op.operator}</td>
                          <td className={`px-2 py-2 ${mono}`}>{formatQty(op.planned)}</td>
                          <td className={`px-2 py-2 ${mono}`}>{formatQty(op.done)}</td>
                          <td className={`px-2 py-2 ${mono}`}>{formatQty(op.balance)}</td>
                          <td className={`px-2 py-2 ${mono}`}>{formatQty(op.wastage)}</td>
                          <td className="px-2 py-2"><Pill className={getStatusTone(op.status)}>{op.status}</Pill></td>
                          <td className="px-2 py-2">{formatDateTimeDisplay(op.start)}</td>
                          <td className="px-2 py-2">{op.end ? formatDateTimeDisplay(op.end) : 'Pending'}</td>
                          <td className="px-2 py-2">
                            <div className="flex gap-1">
                              <button type="button" onClick={() => void saveChanges({ stages: [{ id: op.id, status: 'in_progress' }] })} className="grid h-7 w-7 place-items-center rounded border border-ds-line hover:bg-ds-main" aria-label={`Start ${op.operation}`}><Play className="h-3.5 w-3.5" /></button>
                              <button type="button" disabled title="Pause API not connected yet" className="grid h-7 w-7 place-items-center rounded border border-ds-line opacity-45" aria-label={`Pause ${op.operation}`}><Pause className="h-3.5 w-3.5" /></button>
                              <button type="button" onClick={() => void saveChanges({ stages: [{ id: op.id, status: 'completed' }] })} className="grid h-7 w-7 place-items-center rounded border border-ds-line hover:bg-ds-main" aria-label={`Complete ${op.operation}`}><Check className="h-3.5 w-3.5" /></button>
                              <button type="button" disabled title="Hold API not connected yet" className="grid h-7 w-7 place-items-center rounded border border-ds-line opacity-45" aria-label={`Hold ${op.operation}`}><XCircle className="h-3.5 w-3.5" /></button>
                              <button type="button" disabled title="Log entry workflow opens from production terminal" className="grid h-7 w-7 place-items-center rounded border border-ds-line opacity-45" aria-label={`Log entry for ${op.operation}`}><FileText className="h-3.5 w-3.5" /></button>
                              <button type="button" className="grid h-7 w-7 place-items-center rounded border border-ds-line hover:bg-ds-main" aria-label={`View ${op.operation}`}><Eye className="h-3.5 w-3.5" /></button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>

            <div ref={(el) => { sectionRefs.current.history = el }}>
              <Card title="History Timeline">
                {historyEvents.length === 0 ? (
                  <p className="text-sm text-ds-ink-faint">No timeline events yet.</p>
                ) : (
                  <div className="flex gap-3 overflow-x-auto pb-1">
                    {historyEvents.slice(0, 12).map((ev, index) => (
                      <div key={`${ev.at}-${index}`} className="min-w-[180px] border-l-2 border-ds-brand pl-3">
                        <p className="text-xs font-semibold text-ds-ink">{ev.title}</p>
                        <p className="mt-1 text-[11px] text-ds-ink-faint">{formatDateTimeDisplay(ev.at)}</p>
                        <p className="text-[11px] text-ds-ink-muted">by {ev.source}</p>
                        {ev.remarks ? <p className="mt-1 text-[11px] text-ds-ink-faint">{ev.remarks}</p> : null}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          </div>

          <aside className="space-y-3 xl:col-span-4 2xl:col-span-3">
            <div ref={(el) => { sectionRefs.current.board = el }}>
              <Card title="Material Readiness" action={<Pill className={getStatusTone(materialReadyStatus)}>{materialReadyStatus}</Pill>}>
                <FieldGrid rows={[
                  ['Choose Paper', paperDisplay],
                  ['Cut Size', effectiveSheetSize || 'Not configured'],
                  ['Required Sheets', formatQty(requiredDisplay)],
                  ['Wastage Sheets', formatQty(wastageDisplay)],
                  ['Total Sheets', formatQty(totalSheetsDisplay)],
                  ['Available Stock', formatQty(availableDisplay)],
                  ['Reserved Stock', formatQty(reservedDisplay)],
                  ['Incoming PO Qty', formatQty(incomingDisplay)],
                  ['Linked PO', materialReadiness?.linkedPoNumber ?? jc.boardMaterial?.linkedPoNumber ?? 'Pending'],
                  ['Expected Arrival', expectedArrival ? formatDateDisplay(expectedArrival) : 'Pending'],
                  ['Procurement Status', procurementStatus],
                  ['GRN Posted', materialReadiness?.grnPosted || jc.boardMaterial?.grnPosted ? 'Yes' : 'No'],
                  ['Shortage Qty', formatQty(shortageDisplay)],
                  ['Paper Divide', cleanText(String(upsDisplay), 'Not configured')],
                  ['Material Code', materialCodeDisplay],
                  ['Board / GSM', `${paperDisplay} / ${gsmDisplay}`],
                ]} />
                <div className="mt-3 grid grid-cols-3 gap-1.5">
                  <button type="button" disabled={!canUseReservationApi || saving} title={canUseReservationApi ? 'Reserve Stock' : 'Reservation API not connected yet'} onClick={() => void runReservationAction('reserve')} className="h-8 rounded-[9px] bg-[var(--success-bg)] px-2 text-[11px] font-semibold text-[var(--success)] disabled:opacity-50">Reserve Stock</button>
                  <button type="button" disabled={!canUseReservationApi || saving} title={canUseReservationApi ? 'Release Stock' : 'Reservation API not connected yet'} onClick={() => void runReservationAction('release')} className="h-8 rounded-[9px] bg-ds-warning/10 px-2 text-[11px] font-semibold text-ds-warning disabled:opacity-50">Release Stock</button>
                  <button type="button" disabled={!canUseReservationApi || saving} title={canUseReservationApi ? 'Reverse Reservation' : 'Reservation API not connected yet'} onClick={() => void runReservationAction('reverse')} className="h-8 rounded-[9px] bg-[var(--error-bg)] px-2 text-[11px] font-semibold text-[var(--error)] disabled:opacity-50">Reverse Reservation</button>
                </div>
              </Card>
            </div>

            <div ref={(el) => { sectionRefs.current.tooling = el }}>
              <Card title="Tooling Readiness" action={<button type="button" onClick={() => void pushToHubsFromJobCard()} className="text-xs font-medium text-ds-brand">View All</button>}>
                <div className="space-y-1.5">
                  {[
                    ['Artwork File', artworkDisplay, jc.artworkApproved ? 'Ready' : 'Waiting', FileText],
                    ['Plate', bible?.toolingKit.plate?.code ?? 'Not linked', bible?.toolingKit.plate ? 'Ready' : 'Missing', Layers3],
                    ['Die', bible?.toolingKit.die?.code ?? 'Not linked', bible?.toolingKit.die ? 'Ready' : 'Waiting', Wrench],
                    ['Emboss Block', embossRequired ? bible?.toolingKit.emboss?.code ?? 'Not linked' : 'Not required', embossRequired ? (bible?.toolingKit.emboss ? 'Ready' : 'Missing') : 'Not Required', Wrench],
                    ['Shade Card', bible?.toolingKit.shade?.shadeCode ?? 'Not linked', bible?.toolingKit.shade ? 'Ready' : 'Waiting', Sparkles],
                    ['Sheet Cutting Config', sheetSizeDisplay, sheetDefined ? 'Ready' : 'Missing', TableProperties],
                  ].map(([name, ref, status, Icon]) => (
                    <div key={String(name)} className="grid grid-cols-[22px_1fr_auto_24px] items-center gap-2 text-xs">
                      <span className="grid h-[22px] w-[22px] place-items-center rounded bg-ds-main text-ds-brand"><Icon className="h-3.5 w-3.5" /></span>
                      <div className="min-w-0">
                        <p className="font-medium text-ds-ink">{String(name)}</p>
                        <p className="truncate text-[11px] text-ds-ink-faint">{cleanText(ref, 'Not linked')}</p>
                      </div>
                      <Pill className={getStatusTone(String(status))}>{String(status)}</Pill>
                      <button type="button" className="grid h-6 w-6 place-items-center rounded hover:bg-ds-main" aria-label={`View ${String(name)}`}><Eye className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            <div ref={(el) => { sectionRefs.current.media = el }}>
              <Card title="Media Files" action={<span className="text-xs text-ds-brand">View All</span>}>
                <div className="grid grid-cols-2 gap-2">
                  {mediaFiles.map(({ label, name, icon: Icon }) => (
                    <div key={`${label}-${name}`} className="rounded-[12px] border border-ds-line bg-background p-3">
                      <Icon className="mb-2 h-6 w-6 text-ds-brand" />
                      <p className="text-xs font-semibold text-ds-ink">{label}</p>
                      <p className="mt-1 truncate text-[11px] text-ds-ink-faint">{name}</p>
                    </div>
                  ))}
                  <div className="rounded-[12px] border border-dashed border-ds-line bg-background p-3 text-center text-xs text-ds-ink-faint" title="Upload support not connected on this page">
                    <Download className="mx-auto mb-2 h-5 w-5" />
                    Upload File
                    <p className="mt-1 text-[10px]">Not configured</p>
                  </div>
                </div>
              </Card>
            </div>

            <div ref={(el) => { sectionRefs.current.notes = el }}>
              <Card title="Notes" action={<span className="text-xs text-ds-brand">View All</span>}>
                <div className="grid grid-cols-2 gap-2">
                  {noteItems.map(([label, count]) => (
                    <div key={label} className="rounded-[12px] bg-ds-main p-3">
                      <p className="text-xs font-semibold text-ds-ink">{label}</p>
                      <p className="mt-1 text-[11px] text-ds-ink-faint">{count > 0 ? `${count} note${count === 1 ? '' : 's'}` : 'No notes yet'}</p>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </aside>
        </main>
      </div>
    </div>
  )
}
