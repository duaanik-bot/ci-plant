'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { getPostPressRouting, isEmbossingRequired } from '@/lib/emboss-conditions'
import { resolveSheetSize, resolveUps } from '@/lib/production-os-resolvers'

type Stage = {
  id: string
  stageName: string
  status: string
  operator: string | null
  counter: number | null
  sheetSize: string | null
  completedAt: string | null
}

type CartonSpecs = {
  id?: string
  artworkCode?: string | null
  coatingType: string | null
  laminateType: string | null
  foilType: string | null
  embossingLeafing: string | null
  embossBlockId: string | null
} | null

type PoLine = {
  id: string
  cartonId: string | null
  cartonName: string
  cartonSize: string | null
  quantity: number
  paperType: string | null
  coatingType: string | null
  embossingLeafing: string | null
  gsm: number | null
  dyeId: string | null
  po: { poNumber: string }
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
}

type MaterialReadiness = {
  requiredSheets: number
  reservedSheets: number
  shortageSheets: number
  availableStock: number
  prStatus: string
  grnEta: string | null
  status: string
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
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'border-ds-line/50 text-neutral-500',
  ready: 'border-ds-warning text-ds-warning',
  in_progress: 'border-sky-600 text-sky-200',
  completed: 'border-emerald-600 text-emerald-200',
}

const mono = 'font-designing-queue tabular-nums tracking-tight'
const fieldClass =
  'w-full rounded border border-ds-line/50 bg-ds-main px-2 py-1.5 text-xs text-ds-ink transition focus:outline-none focus:ring-1 focus:ring-ds-brand/40 hover:border-ds-line'

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
      return { bar: 'bg-emerald-500', text: 'text-emerald-300' }
    case 'warn':
      return { bar: 'bg-ds-warning', text: 'text-ds-warning' }
    case 'bad':
      return { bar: 'bg-rose-500', text: 'text-rose-200' }
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
  const [machineId, setMachineId] = useState('')
  const [priority, setPriority] = useState<'Normal' | 'Urgent'>('Normal')
  const [targetStartDate, setTargetStartDate] = useState('')
  const [plannedCompletion, setPlannedCompletion] = useState('')
  const [activeSection, setActiveSection] = useState<'summary' | 'spec' | 'board' | 'tooling' | 'execution' | 'validation' | 'material' | 'printing' | 'machine' | 'flow' | 'operations' | 'media' | 'notes' | 'history'>('summary')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [materialReadiness, setMaterialReadiness] = useState<MaterialReadiness | null>(null)
  const [materialTimeline, setMaterialTimeline] = useState<MaterialTimelineEvent[]>([])
  const [initialForm, setInitialForm] = useState<{
    designerUserId: string
    prePressRemarks: string
    boardReadiness: 'ready' | 'waiting' | 'not_ready'
    sheetSizeOverride: string
    machineId: string
    priority: 'Normal' | 'Urgent'
    targetStartDate: string
    plannedCompletion: string
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
    if (!jc) return
    const setup = ((jc.postPressRouting as Record<string, unknown> | null)?.executionSetup ?? {}) as Record<
      string,
      unknown
    >
    setDesignerUserId(jc.shiftOperator?.id ?? '')
    setPrePressRemarks(typeof setup.prePressRemarks === 'string' ? setup.prePressRemarks : '')
    setSheetSizeOverride(typeof setup.sheetSize === 'string' ? setup.sheetSize : '')
    const derivedBoard = jc.boardMaterial?.boardStatus === 'available' ? 'ready' : 'waiting'
    setBoardReadiness(
      setup.boardReadiness === 'ready' || setup.boardReadiness === 'waiting' || setup.boardReadiness === 'not_ready'
        ? setup.boardReadiness
        : derivedBoard,
    )
    setMachineId(typeof jc.postPressRouting?.printPlan?.machineId === 'string' ? jc.postPressRouting.printPlan.machineId : '')
    setPriority(setup.priority === 'Urgent' ? 'Urgent' : 'Normal')
    setTargetStartDate(typeof setup.targetStartDate === 'string' ? setup.targetStartDate : '')
    setPlannedCompletion(typeof setup.plannedCompletion === 'string' ? setup.plannedCompletion : '')
    const init = {
      designerUserId: jc.shiftOperator?.id ?? '',
      prePressRemarks: typeof setup.prePressRemarks === 'string' ? setup.prePressRemarks : '',
      boardReadiness:
        setup.boardReadiness === 'ready' || setup.boardReadiness === 'waiting' || setup.boardReadiness === 'not_ready'
          ? setup.boardReadiness
          : derivedBoard,
      sheetSizeOverride: typeof setup.sheetSize === 'string' ? setup.sheetSize : '',
      machineId:
        typeof jc.postPressRouting?.printPlan?.machineId === 'string' ? jc.postPressRouting.printPlan.machineId : '',
      priority: setup.priority === 'Urgent' ? 'Urgent' : 'Normal',
      targetStartDate: typeof setup.targetStartDate === 'string' ? setup.targetStartDate : '',
      plannedCompletion: typeof setup.plannedCompletion === 'string' ? setup.plannedCompletion : '',
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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setEnqueueingCut(false)
    }
  }

  async function saveExecution(release: boolean) {
    if (!jc) return
    if (release) {
      const firstBlocking =
        !sheetDefined ? 'spec' : boardStatus !== 'ready' ? 'board' : !toolingReady ? 'tooling' : !awPoMatch ? 'validation' : null
      if (firstBlocking) {
        setActiveSection(firstBlocking)
        sectionRefs.current[firstBlocking]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        toast.error('Resolve validation items before release')
        return
      }
    }
    const nextRouting = {
      ...(jc.postPressRouting ?? {}),
      ...(release || jc.postPressRouting?.printPlan
        ? {
            printPlan: {
              ...(jc.postPressRouting?.printPlan ?? { lane: 'triage' as const, order: 0 }),
              machineId: machineId || null,
            },
          }
        : {}),
      executionSetup: {
        prePressRemarks: prePressRemarks || null,
        boardReadiness,
        sheetSize: sheetSizeOverride || null,
        priority,
        targetStartDate: targetStartDate || null,
        plannedCompletion: plannedCompletion || null,
      },
    }
    await saveChanges({
      shiftOperatorUserId: designerUserId || null,
      artworkApproved: jc.artworkApproved,
      finalQcPass: jc.finalQcPass,
      qaReleased: release ? true : jc.qaReleased,
      status: release ? 'qa_released' : jc.status,
      postPressRouting: nextRouting,
    })
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

  if (!jc) {
    return (
      <div className={`min-h-[30vh] p-4 text-ds-ink-faint bg-background ${mono}`}>Loading…</div>
    )
  }

  const productName = jc.poLine?.cartonName ?? '—'
  const resolvedSheetSize = resolveSheetSize({
    ...(jc.poLine || {}),
    specOverrides: {},
    product: jc.poLine?.carton || {},
    carton: jc.poLine?.carton || {},
    materialQueue: jc.poLine?.materialQueue || {},
  })
  const sheetSizeDisplay = bible?.sheetSizeLabel ?? (resolvedSheetSize !== '-' ? resolvedSheetSize : '—')
  const resolvedUps = resolveUps({
    ...(jc.poLine || {}),
    specOverrides: {},
    product: jc.poLine?.carton || {},
    carton: jc.poLine?.carton || {},
    materialQueue: jc.poLine?.materialQueue || {},
  })
  const upsDisplay = bible?.ups ?? resolvedUps ?? '—'
  const grainDisplay = bible?.grainDirection ?? jc.poLine?.materialQueue?.grainDirection ?? '—'

  const boardStatus = boardReadiness
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
      machineId !== initialForm.machineId ||
      priority !== initialForm.priority ||
      targetStartDate !== initialForm.targetStartDate ||
      plannedCompletion !== initialForm.plannedCompletion ||
      jc.artworkApproved !== initialForm.artworkApproved ||
      jc.finalQcPass !== initialForm.finalQcPass)
  const statusLabel = jc.status === 'qa_released' || jc.status === 'closed' ? 'Released' : jc.status === 'in_progress' || jc.status === 'final_qc' ? 'Ready' : 'Draft'
  const statusTone =
    statusLabel === 'Released'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
      : statusLabel === 'Ready'
        ? 'border-ds-warning/40 bg-ds-warning/10 text-ds-warning'
        : 'border-ds-line/50 bg-ds-main text-ds-ink-faint'

  return (
    <div className="min-h-screen bg-background text-ds-ink pb-24">
      <div className="max-w-7xl mx-auto px-4 py-4 space-y-6">
        <div className="rounded-xl border border-ds-line/40 bg-card px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <button type="button" onClick={() => router.push(returnTo)} className="mb-2 text-xs text-ds-ink-faint hover:text-ds-ink">← Back to Job Cards</button>
              <h1 className={`text-2xl leading-none font-semibold text-ds-ink ${mono}`}>Production / Job Cards / JC-{jc.jobCardNumber}</h1>
              <p className="text-sm font-semibold mt-1">{productName}</p>
              <p className="text-xs text-ds-ink-faint">{jc.customer.name} | PO {jc.poLine?.po.poNumber ?? '—'} | Set {jc.setNumber ?? '—'}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded border px-2 py-0.5 text-xs ${statusTone}`}>{statusLabel}</span>
              <select
                className="rounded border border-ds-line/50 bg-ds-main px-2 py-1.5 text-xs text-ds-ink transition focus:outline-none focus:ring-1 focus:ring-ds-brand/40 hover:border-ds-line"
                value={designerUserId}
                onChange={(e) => setDesignerUserId(e.target.value)}
              >
                <option value="">Designer…</option>
                {shiftOperators.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              <label className="inline-flex items-center gap-1 text-xs"><input type="checkbox" checked={jc.artworkApproved} onChange={(e) => update('artworkApproved', e.target.checked)} /> Customer OK</label>
              <label className="inline-flex items-center gap-1 text-xs"><input type="checkbox" checked={jc.finalQcPass} onChange={(e) => update('finalQcPass', e.target.checked)} /> QA OK</label>
              <a href={`/api/designing/po-lines/${jc.poLine?.id}/job-spec-pdf`} target="_blank" rel="noopener noreferrer" className="rounded border border-ds-line/50 px-3 py-1.5 text-xs">Job spec PDF</a>
              <Link href="/orders/purchase-orders" className="rounded border border-ds-line/50 px-3 py-1.5 text-xs">Open PO</Link>
              <button type="button" onClick={() => window.print()} className="rounded border border-ds-line px-3 py-1.5 text-xs text-ds-ink transition hover:bg-ds-main focus:outline-none focus:ring-1 focus:ring-ds-brand/40">Print</button>
              <span className="text-xs text-ds-ink-faint">{isDirty ? 'Unsaved changes' : lastSavedAt ? `Saved ${new Date(lastSavedAt).toLocaleTimeString()}` : 'No pending changes'}</span>
            </div>
          </div>
        </div>

        <div className="sticky top-16 z-20 rounded-lg border border-ds-line/40 bg-ds-card/95 px-3 py-2 backdrop-blur">
          <div className="flex flex-wrap gap-2">
            {[
              ['summary', 'Job Summary', 'summary'],
              ['material', 'Material & Sheet Config', 'board'],
              ['printing', 'Printing & Finishing', 'spec'],
              ['machine', 'Machine Setup', 'execution'],
              ['flow', 'Production Flow', 'tooling'],
              ['operations', 'Operations', 'execution'],
              ['media', 'Media Files', 'validation'],
              ['notes', 'Notes', 'spec'],
              ['history', 'History', 'board'],
            ].map(([key, label, refKey]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setActiveSection(key as typeof activeSection)
                  sectionRefs.current[refKey]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
                className={`rounded px-2 py-1 text-xs transition ${
                  activeSection === key ? 'bg-ds-brand text-white' : 'border border-ds-line/50 text-ds-ink hover:bg-ds-main'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div ref={(el) => { sectionRefs.current.summary = el }} className="space-y-3">
          <h2 className="text-sm font-semibold text-ds-ink">Job Summary</h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              ['Job Card No', `JC-${jc.jobCardNumber}`],
              ['Set No', jc.setNumber ?? '—'],
              ['Client', jc.customer.name],
              ['PO No', jc.poLine?.po.poNumber ?? '—'],
              ['PO Date', ((jc.poLine as unknown as { po?: { poDate?: string } })?.po?.poDate || '-')],
              ['Carton', productName],
              ['Size', jc.poLine?.cartonSize ?? '—'],
              ['Qty', Number(jc.poLine?.quantity || 0).toLocaleString('en-IN')],
              ['Priority', priority],
              ['Status', statusLabel],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-ds-line/40 bg-card px-3 py-2.5">
                <p className="text-xs uppercase tracking-wide text-ds-ink-faint">{k}</p>
                <p className="text-sm mt-1">{v}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
          <div className="xl:col-span-2 space-y-6">
            <div ref={(el) => { sectionRefs.current.spec = el }} className="rounded-xl border border-ds-line/40 bg-card p-4 space-y-3">
              <h2 className="text-sm font-semibold text-ds-ink">Printing & Finishing</h2>
              <div className="grid md:grid-cols-5 gap-3 text-xs">
                <div><p className="text-ds-ink-faint mb-1">Coating</p><p>{jc.poLine?.coatingType ?? '—'}</p></div>
                <div><p className="text-ds-ink-faint mb-1">Other Coating</p><p>{jc.poLine?.carton?.laminateType ?? 'None'}</p></div>
                <div><p className="text-ds-ink-faint mb-1">Emboss / Leaf</p><p>{jc.poLine?.embossingLeafing ?? 'None'}</p></div>
                <div><p className="text-ds-ink-faint mb-1">Paper</p><p>{jc.poLine?.paperType ?? '—'}</p></div>
                <div><p className="text-ds-ink-faint mb-1">Color</p><p>{bible?.shadeCard?.shadeCode ? 'CMYK + P' : '—'}</p></div>
              </div>
              <div className="grid md:grid-cols-5 gap-3 text-xs">
                <div>
                  <p className="text-ds-ink-faint mb-1">Sheet Size</p>
                  {sheetSizeDisplay !== '—' ? (
                    <p>{sheetSizeDisplay}</p>
                  ) : (
                    <input
                      type="text"
                      value={sheetSizeOverride}
                      onChange={(e) => setSheetSizeOverride(e.target.value)}
                      placeholder="L x W mm"
                      className={fieldClass}
                    />
                  )}
                </div>
                <div><p className="text-ds-ink-faint mb-1">UPS</p><p>{upsDisplay}</p></div>
                <div><p className="text-ds-ink-faint mb-1">GSM</p><p>{jc.poLine?.gsm ?? '—'}</p></div>
                <div><p className="text-ds-ink-faint mb-1">Dye Details</p><p>{dyeDetail && dyeDetail !== 'unavailable' ? `${dyeDetail.dyeNumber}` : '—'}</p></div>
                <div><p className="text-ds-ink-faint mb-1">Pasting</p><p>BSO</p></div>
                <div><p className="text-ds-ink-faint mb-1">Artwork</p><p>{jc.poLine?.carton?.artworkCode ?? '—'}</p></div>
              </div>
              <div>
                <label className="block text-xs text-ds-ink-faint mb-1">Notes</label>
                <textarea value={prePressRemarks} onChange={(e) => setPrePressRemarks(e.target.value)} className="w-full rounded border border-ds-line/50 bg-ds-main px-3 py-2 text-xs text-ds-ink transition focus:outline-none focus:ring-1 focus:ring-ds-brand/40 hover:border-ds-line" rows={3} />
              </div>
            </div>

            <div ref={(el) => { sectionRefs.current.execution = el }} className="rounded-xl border border-ds-line/40 bg-card p-4 space-y-3">
              <h2 className="text-sm font-semibold text-ds-ink">Machine Setup</h2>
              <div className="grid md:grid-cols-4 gap-3 text-xs">
                <div>
                  <label className="block text-ds-ink-faint mb-1">Coating Machine</label>
                  <select
                    className={fieldClass}
                    value={machineId}
                    onChange={(e) => setMachineId(e.target.value)}
                  >
                    <option value="">Auto-assign</option>
                    {machineId ? <option value={machineId}>{machineId}</option> : null}
                  </select>
                </div>
                <div><label className="block text-ds-ink-faint mb-1">Other Coating Machine</label><input readOnly value="None" className={fieldClass} /></div>
                <div><label className="block text-ds-ink-faint mb-1">Roll Used</label><input readOnly value="0" className={fieldClass} /></div>
                <div><label className="block text-ds-ink-faint mb-1">Window Cutting</label><input readOnly value="None" className={fieldClass} /></div>
                <div><label className="block text-ds-ink-faint mb-1">Dye Machine</label><input readOnly value={dieStoreCheck?.dieCode ?? 'Manual'} className={fieldClass} /></div>
                <div><label className="block text-ds-ink-faint mb-1">Embossing / Leafing</label><input readOnly value={embossRequired ? 'Required' : 'None'} className={fieldClass} /></div>
                <div>
                  <label className="block text-ds-ink-faint mb-1">Priority</label>
                  <select className={fieldClass} value={priority} onChange={(e) => setPriority(e.target.value as 'Normal' | 'Urgent')}><option>Normal</option><option>Urgent</option></select>
                </div>
                <div><label className="block text-ds-ink-faint mb-1">Target Start Date</label><input type="date" value={targetStartDate} onChange={(e) => setTargetStartDate(e.target.value)} className={fieldClass} /></div>
                <div><label className="block text-ds-ink-faint mb-1">Planned Completion</label><input type="date" value={plannedCompletion} onChange={(e) => setPlannedCompletion(e.target.value)} className={fieldClass} /></div>
              </div>
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ds-ink-faint">Operations</h3>
              <div className="overflow-x-auto rounded border border-ds-line/40">
                <table className="min-w-full text-xs">
                  <thead className="bg-ds-main/40 text-ds-ink-faint">
                    <tr>
                      <th className="px-2 py-2 text-left">Operation</th>
                      <th className="px-2 py-2 text-left">Machine</th>
                      <th className="px-2 py-2 text-right">Planned</th>
                      <th className="px-2 py-2 text-right">Done</th>
                      <th className="px-2 py-2 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stageChain.slice(0, 6).map((row) => (
                      <tr key={row.stage.id} className="border-t border-ds-line/30">
                        <td className="px-2 py-2">{row.stage.stageName}</td>
                        <td className="px-2 py-2">{machineId || '—'}</td>
                        <td className={`px-2 py-2 text-right ${mono}`}>{Number(jc.poLine?.quantity || 0).toLocaleString('en-IN')}</td>
                        <td className={`px-2 py-2 text-right ${mono}`}>{Number(row.stage.counter || 0).toLocaleString('en-IN')}</td>
                        <td className="px-2 py-2">{row.stage.status.replace(/_/g, ' ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div ref={(el) => { sectionRefs.current.board = el }} className="rounded-xl border border-ds-line/40 bg-card p-4 space-y-3">
              <h2 className="text-sm font-semibold text-ds-ink">Material & Sheet Config</h2>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div><p className="text-ds-ink-faint mb-1">Choose Paper</p><p>{jc.poLine?.paperType ?? '—'}</p></div>
                <div><p className="text-ds-ink-faint mb-1">Cut Size</p><p>{effectiveSheetSize || '—'}</p></div>
                <div><p className="text-ds-ink-faint mb-1">Required Sheets</p><p>{jc.requiredSheets.toLocaleString('en-IN')}</p></div>
                <div><p className="text-ds-ink-faint mb-1">Wastage Sheets</p><p>{jc.wastageSheets.toLocaleString('en-IN')}</p></div>
                <div><p className="text-ds-ink-faint mb-1">Paper Divide</p><p>{upsDisplay}</p></div>
                <div><p className="text-ds-ink-faint mb-1">Total Sheets</p><p>{jc.totalSheets.toLocaleString('en-IN')}</p></div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                {[
                  ['ready', 'Ready'],
                  ['waiting', 'Waiting'],
                  ['not_ready', 'Not Ready'],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setBoardReadiness(key as 'ready' | 'waiting' | 'not_ready')}
                    className={`rounded border px-2 py-1 ${
                      boardStatus === key ? 'border-ds-warning bg-ds-warning/10 text-ds-warning' : 'border-ds-line/40'
                    } transition hover:bg-ds-main focus:outline-none focus:ring-1 focus:ring-ds-brand/40`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="rounded-lg border border-ds-line/40 bg-ds-main/30 p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ds-ink-faint">Material Readiness</p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>Required Sheets: <span className="text-ds-ink">{materialReadiness?.requiredSheets ?? '-'}</span></div>
                  <div>Reserved Sheets: <span className="text-ds-ink">{materialReadiness?.reservedSheets ?? '-'}</span></div>
                  <div>Available Stock: <span className="text-ds-ink">{materialReadiness?.availableStock ?? '-'}</span></div>
                  <div>Shortage: <span className="text-ds-ink">{materialReadiness?.shortageSheets ?? '-'}</span></div>
                  <div>Incoming (PR): <span className="text-ds-ink">{materialReadiness?.prStatus ?? '-'}</span></div>
                  <div>GRN ETA: <span className="text-ds-ink">{materialReadiness?.grnEta ? new Date(materialReadiness.grnEta).toLocaleDateString() : '-'}</span></div>
                </div>
                <div className="mt-3">
                  <p className="mb-1 text-[11px] uppercase tracking-wide text-ds-ink-faint">History</p>
                  <div className="max-h-44 space-y-1 overflow-auto rounded border border-ds-line/30 bg-background/40 p-2">
                    {materialTimeline.length === 0 ? (
                      <p className="text-xs text-ds-ink-faint">No material timeline events yet.</p>
                    ) : (
                      materialTimeline.map((ev, idx) => (
                        <div key={`${ev.at}-${idx}`} className="text-xs">
                          <span className="text-ds-ink-faint">{new Date(ev.at).toLocaleString()}</span>{' '}
                          <span className="font-medium text-ds-ink">{ev.event}</span>{' '}
                          <span className="text-ds-ink-muted">{ev.detail}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
              {boardStatus !== 'ready' ? <div className="rounded border border-ds-warning/40 bg-ds-warning/10 px-3 py-2 text-xs text-ds-warning">Expected board delivery: {jc.boardMaterial?.warehouseHandshake?.issuedAt ? new Date(jc.boardMaterial.warehouseHandshake.issuedAt).toLocaleDateString() : 'TBD'}</div> : null}
            </div>

            <div ref={(el) => { sectionRefs.current.tooling = el }} className="rounded-xl border border-ds-line/40 bg-card p-4 space-y-3">
              <h2 className="text-sm font-semibold text-ds-ink">Production Flow</h2>
              <div className="space-y-2 text-xs">
                {toolRows.map((row) => (
                  <div key={row.name} className="flex items-center justify-between rounded border border-ds-line/30 px-2 py-2">
                    <div><p className="font-medium">{row.name}</p><p className="text-ds-ink-faint">{row.id} · {row.source}</p></div>
                    <span className={`rounded border px-2 py-0.5 text-xs ${row.linked ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300'}`}>{row.linked ? 'Linked' : 'Missing'}</span>
                  </div>
                ))}
              </div>
            </div>

            <div ref={(el) => { sectionRefs.current.validation = el }} className="rounded-xl border border-ds-line/40 bg-card p-4 space-y-3">
              <h2 className="text-sm font-semibold text-ds-ink">Media Files</h2>
              <div className="flex flex-wrap gap-2 text-xs">
                {[
                  (jc as { fileUrl?: string }).fileUrl ? 'Artwork file' : null,
                  jc.poLine?.carton?.artworkCode ? `Dieline ${jc.poLine.carton.artworkCode}` : null,
                  'Reference files',
                ]
                  .filter((x): x is string => !!x)
                  .map((f) => (
                    <span key={f} className="rounded border border-ds-line/50 bg-ds-main px-3 py-1">{f}</span>
                  ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 border-t border-ds-line/40 bg-card/95 backdrop-blur px-4 py-2.5">
        <div className="max-w-7xl mx-auto flex items-center justify-end gap-2">
          <button type="button" disabled={saving} onClick={() => void saveExecution(false)} className="rounded-md border border-ds-line/50 px-3 py-1.5 text-xs text-ds-ink transition hover:bg-ds-main focus:outline-none focus:ring-1 focus:ring-ds-brand/40 disabled:opacity-50">Save Job Card</button>
          <button type="button" onClick={() => window.print()} className="rounded-md border border-ds-line/50 px-3 py-1.5 text-xs text-ds-ink transition hover:bg-ds-main focus:outline-none focus:ring-1 focus:ring-ds-brand/40">Print Job Card</button>
          <button type="button" disabled={releaseBlocked || saving} onClick={() => void saveExecution(true)} className="rounded-md bg-ds-brand px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-95 focus:outline-none focus:ring-1 focus:ring-ds-brand/40 disabled:opacity-40">Release to Production</button>
        </div>
      </div>
    </div>
  )
}
