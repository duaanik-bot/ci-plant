'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { getPostPressRouting, isEmbossingRequired } from '@/lib/emboss-conditions'

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

export type PostPressRouting = {
  chemicalCoating?: boolean
  lamination?: boolean
  spotUv?: boolean
  leafing?: boolean
  embossing?: boolean
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
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'border-ds-line/50 text-neutral-500',
  ready: 'border-ds-warning text-ds-warning',
  in_progress: 'border-sky-600 text-sky-200',
  completed: 'border-emerald-600 text-emerald-200',
}

const mono = 'font-designing-queue tabular-nums tracking-tight'

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
  const [dieStoreCheck, setDieStoreCheck] = useState<{
    status: 'available' | 'needs_attention' | 'end_of_life' | 'not_available'
    message: string
    dieCode?: string
    dieNumber?: number | null
    lifeRemaining?: number
  } | null>(null)

  useEffect(() => {
    fetch(`/api/job-cards/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data || data.error) throw new Error(data.error || 'Failed to load')
        setJc(data)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [id])

  useEffect(() => {
    fetch('/api/users')
      .then((r) => r.json())
      .then((list) => setShiftOperators(Array.isArray(list) ? list : []))
      .catch(() => setShiftOperators([]))
  }, [])

  const cartonId = jc?.poLine?.cartonId ?? jc?.poLine?.carton?.id ?? null
  const embossBlockId = jc?.embossBlockId ?? jc?.poLine?.carton?.embossBlockId ?? null
  const embossRequired = isEmbossingRequired(jc?.poLine?.carton?.embossingLeafing ?? jc?.poLine?.embossingLeafing)
  const bible = jc?.productionBible
  const effectiveRouting = {
    ...suggestPostPressRouting(jc?.poLine ?? null),
    ...(jc.postPressRouting ?? {}),
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
      const refreshed = await fetch(`/api/job-cards/${jc.id}`).then((r) => r.json())
      setJc(refreshed)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (!jc) {
    return (
      <div className={`min-h-[30vh] p-4 text-ds-ink-faint bg-background ${mono}`}>Loading…</div>
    )
  }

  const productName = jc.poLine?.cartonName ?? '—'
  const sheetSizeDisplay =
    bible?.sheetSizeLabel ??
    (jc.poLine?.materialQueue
      ? `${Number(jc.poLine.materialQueue.sheetLengthMm) || '—'}×${Number(jc.poLine.materialQueue.sheetWidthMm) || '—'} mm`
      : '—')
  const upsDisplay = bible?.ups ?? jc.poLine?.materialQueue?.ups ?? '—'
  const grainDisplay = bible?.grainDirection ?? jc.poLine?.materialQueue?.grainDirection ?? '—'

  return (
    <div className="min-h-screen bg-background text-ds-ink pb-10">
      <div className="max-w-6xl mx-auto px-3 py-4 space-y-4">
        {/* Intelligent header — Production Bible */}
        <div className="rounded-xl border border-border/40 bg-card p-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ds-ink-faint">
                Production Bible
              </p>
              <h1 className={`text-xl font-bold text-ds-warning ${mono}`}>JC #{jc.jobCardNumber}</h1>
              <p className="text-sm text-ds-ink-muted mt-1">
                <span className="text-ds-ink">{jc.customer.name}</span>
                <span className="text-ds-ink-faint"> · </span>
                <span>{productName}</span>
              </p>
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <div
                className={`rounded-lg border px-3 py-2 text-right ${
                  wasteHot
                    ? 'border-rose-500/60 bg-rose-500/10 animate-pulse'
                    : 'border-border/10 bg-ds-main/80'
                }`}
              >
                <p className="text-[9px] uppercase tracking-wide text-ds-ink-faint">Cumulative waste</p>
                <p
                  className={`text-lg font-semibold ${mono} ${
                    wasteHot ? 'text-rose-400' : 'text-ds-ink'
                  }`}
                >
                  {cumulativeWastePct.toFixed(1)}%
                </p>
              </div>
              <button
                type="button"
                onClick={() => router.push('/production/job-cards')}
                className="px-3 py-1.5 rounded-lg border border-border/50 text-sm text-ds-ink"
              >
                Back
              </button>
              <a
                href={`/api/job-cards/${jc.id}/card-pdf`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 rounded-lg bg-ds-warning hover:bg-ds-warning text-primary-foreground text-sm"
              >
                PDF
              </a>
              {jc.poLine && (
                <>
                  <a
                    href={`/api/designing/po-lines/${jc.poLine.id}/job-spec-pdf`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 rounded-lg border border-border/50 text-sm"
                  >
                    Job spec PDF
                  </a>
                  <Link
                    href={`/orders/designing/${jc.poLine.id}`}
                    className="px-3 py-1.5 rounded-lg border border-border/50 text-sm"
                  >
                    AW queue
                  </Link>
                </>
              )}
              <Link
                href={`/stores/issue?jobCardId=${jc.id}`}
                className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-primary-foreground text-sm"
              >
                Issue sheets
              </Link>
            </div>
          </div>

          <div
            className={`grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 text-xs border-t border-border/40 pt-3 ${mono}`}
          >
            <div>
              <p className="text-ds-ink-faint uppercase tracking-wide text-[9px]">Client</p>
              <p className="text-ds-ink">{jc.customer.name}</p>
            </div>
            <div>
              <p className="text-ds-ink-faint uppercase tracking-wide text-[9px]">Product</p>
              <p className="text-ds-ink truncate" title={productName}>
                {productName}
              </p>
            </div>
            <div>
              <p className="text-ds-ink-faint uppercase tracking-wide text-[9px]">Batch</p>
              <p className="text-ds-warning">{jc.batchNumber ?? '—'}</p>
            </div>
            <div>
              <p className="text-ds-ink-faint uppercase tracking-wide text-[9px]">Set</p>
              <p className="text-ds-warning">{jc.setNumber ?? '—'}</p>
            </div>
            <div>
              <p className="text-ds-ink-faint uppercase tracking-wide text-[9px]">Sheet size</p>
              <p>{sheetSizeDisplay}</p>
            </div>
            <div>
              <p className="text-ds-ink-faint uppercase tracking-wide text-[9px]">UPS</p>
              <p>{upsDisplay}</p>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <p className="text-ds-ink-faint uppercase tracking-wide text-[9px]">Grain</p>
              <p>{grainDisplay}</p>
            </div>
            {jc.poLine ? (
              <div>
                <p className="text-ds-ink-faint uppercase tracking-wide text-[9px]">PO</p>
                <p>{jc.poLine.po.poNumber}</p>
              </div>
            ) : null}
          </div>

          {/* Readiness ribbon */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-ds-ink-faint mb-2">
              Readiness ribbon · hubs
            </p>
            <div className="flex flex-wrap gap-2">
              {(['Plates', 'Die', 'Blocks'] as const).map((label, i) => {
                const key = i === 0 ? 'plates' : i === 1 ? 'die' : 'block'
                const state = readinessRibbon[key]
                const t = ribbonTone(state)
                const sub =
                  key === 'plates'
                    ? plateCheck?.message ?? '—'
                    : key === 'die'
                      ? dieStoreCheck?.message ?? '—'
                      : embossRequired
                        ? embossDetail && embossDetail !== 'unavailable'
                          ? `${embossDetail.blockCode} · ${embossDetail.condition}`
                          : '—'
                        : 'N/A'
                return (
                  <div
                    key={label}
                    className="flex-1 min-w-[7rem] rounded-lg border border-border/10 bg-ds-main/80 overflow-hidden"
                  >
                    <div className={`h-1 ${t.bar}`} />
                    <div className="px-2 py-1.5">
                      <p className={`text-[10px] font-semibold ${t.text}`}>{label}</p>
                      <p className="text-[9px] text-ds-ink-faint line-clamp-2">{sub}</p>
                    </div>
                  </div>
                )
              })}
            </div>
            {cartonId ? (
              <div className="mt-2 flex items-center gap-2">
                <label className="text-[10px] text-ds-ink-faint">Plate check · AW ver.</label>
                <input
                  type="text"
                  value={artworkVersion}
                  onChange={(e) => setArtworkVersion(e.target.value)}
                  className={`w-14 px-1.5 py-0.5 rounded border border-border/50 bg-card text-[10px] ${mono}`}
                />
              </div>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {/* Tooling kit — coordinates */}
        <div className="rounded-xl border border-border/40 bg-card p-4">
          <h2 className="text-sm font-semibold text-ds-warning mb-3">Tooling kit · coordinates</h2>
          <p className="text-[10px] text-ds-ink-faint mb-3">
            Physical rack / drawer from masters. Returns use Tooling Hub <strong>Receive</strong> — not this
            screen.
          </p>
          <div className="overflow-x-auto">
            <table className={`w-full text-xs ${mono}`}>
              <thead className="text-ds-ink-faint text-[10px] uppercase tracking-wide">
                <tr className="border-b border-border/40">
                  <th className="text-left py-2 pr-2">Asset</th>
                  <th className="text-left py-2 pr-2">ID</th>
                  <th className="text-left py-2">Rack / drawer / slot</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                <tr>
                  <td className="py-2 text-ds-ink-muted">Plates</td>
                  <td className="py-2 text-ds-ink">
                    {bible?.toolingKit.plate?.code ?? plateCheck?.plateSetCode ?? '—'}
                  </td>
                  <td className="py-2 text-emerald-200/90">
                    {bible?.toolingKit.plate?.coordinates ?? '—'}
                  </td>
                </tr>
                <tr>
                  <td className="py-2 text-ds-ink-muted">Die</td>
                  <td className="py-2 text-ds-ink">
                    {bible?.toolingKit.die?.code ??
                      (dieStoreCheck?.dieCode
                        ? `${dieStoreCheck.dieCode}${dieStoreCheck.dieNumber != null ? ` · ${dieStoreCheck.dieNumber}` : ''}`
                        : dyeDetail && dyeDetail !== 'unavailable'
                          ? `#${dyeDetail.dyeNumber}`
                          : '—')}
                  </td>
                  <td className="py-2 text-emerald-200/90">{bible?.toolingKit.die?.coordinates ?? '—'}</td>
                </tr>
                <tr>
                  <td className="py-2 text-ds-ink-muted">Emboss block</td>
                  <td className="py-2 text-ds-ink">
                    {embossRequired
                      ? bible?.toolingKit.emboss?.code ??
                        (embossDetail && embossDetail !== 'unavailable'
                          ? embossDetail.blockCode
                          : '—')
                      : 'N/A'}
                  </td>
                  <td className="py-2 text-emerald-200/90">
                    {embossRequired ? bible?.toolingKit.emboss?.coordinates ?? '—' : '—'}
                  </td>
                </tr>
                <tr>
                  <td className="py-2 text-ds-ink-muted">Shade card</td>
                  <td className="py-2 text-ds-ink">{bible?.shadeCard?.shadeCode ?? '—'}</td>
                  <td className="py-2">
                    {bible?.shadeCard ? (
                      <div>
                        <span className="text-ds-ink-muted">
                          Age {bible.shadeCard.ageMonths} mo · {bible.shadeCard.custodyStatus}
                        </span>
                        {bible.shadeCard.expired ? (
                          <div className="mt-1 rounded border border-rose-500 bg-rose-500/15 px-2 py-1 text-rose-200 font-semibold text-[10px] uppercase tracking-wide">
                            EXPIRED — DO NOT PRINT
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-ds-ink-faint">—</span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-[10px]">
            <Link href="/pre-press/plate-store" className="text-ds-warning hover:underline">
              Plate hub →
            </Link>
            <Link href="/hub/dies" className="text-ds-warning hover:underline">
              Die hub →
            </Link>
            <Link href="/hub/blocks" className="text-ds-warning hover:underline">
              Emboss hub →
            </Link>
          </div>
        </div>

        {/* Board status · material allocation */}
        <div className="rounded-xl border border-border/40 bg-background p-4">
          <h2 className="text-sm font-semibold text-ds-warning mb-1">Board status · material allocation</h2>
          <p className="text-[10px] text-ds-ink-faint mb-3">
            Mill / warehouse batch and floor issuance. Click the panel to open the paper ledger for this GSM / grade.
          </p>
          {jc.boardMaterial ? (
            <Link
              href={
                jc.boardMaterial.ledgerLink
                  ? `/inventory?ledgerGsm=${jc.boardMaterial.ledgerLink.gsm}&ledgerBoard=${encodeURIComponent(jc.boardMaterial.ledgerLink.board)}#paper-ledger`
                  : '/inventory#paper-ledger'
              }
              className="block rounded-lg border border-border/10 bg-ds-main/80 p-3 hover:border-ds-warning/40 hover:bg-ds-card/50 transition-colors"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <span className="text-[10px] uppercase tracking-wide text-ds-ink-faint">Status</span>
                <span
                  className={`text-xs font-semibold ${
                    jc.boardMaterial.boardStatus === 'available' ? 'text-emerald-400' : 'text-rose-500'
                  }`}
                >
                  {jc.boardMaterial.boardStatus === 'available' ? 'Available' : 'Out of stock'}
                </span>
              </div>
              <div className={`space-y-2 text-xs ${mono}`}>
                <div>
                  <span className="text-ds-ink-faint">Batch ID </span>
                  <span className="text-ds-warning">{jc.boardMaterial.batchLotNumber ?? '—'}</span>
                </div>
                <div className="text-ds-ink">
                  <span className="text-ds-ink-faint">Allocation </span>
                  Required: {jc.boardMaterial.requiredSheets} | Issued: {jc.boardMaterial.issuedToFloorSheets} |
                  Balance: {jc.boardMaterial.balanceSheets}
                </div>
                <div className="text-[10px] text-ds-ink-faint">
                  WH on-hand (spec){' '}
                  <span className="text-ds-ink-muted">{jc.boardMaterial.paperWarehouseSheetsForSpec}</span> sheets ·
                  Planning paper <span className="text-ds-ink-muted">{jc.boardMaterial.planningMaterialGateStatus}</span>
                </div>
              </div>
              {jc.boardMaterial.materialShortage ? (
                <p className="mt-3 text-sm font-bold text-rose-500">Material shortage</p>
              ) : null}
              {jc.boardMaterial.warehouseHandshake ? (
                <div className={`mt-3 pt-3 border-t border-border/40 text-[10px] text-ds-ink-muted ${mono}`}>
                  <p>
                    <span className="text-ds-ink-faint">Issued to floor </span>
                    {new Date(jc.boardMaterial.warehouseHandshake.issuedAt).toLocaleString()}
                  </p>
                  <p className="mt-1">
                    <span className="text-ds-ink-faint">Custodian (verified) </span>
                    <span className="text-ds-ink-muted">{jc.boardMaterial.warehouseHandshake.custodianName}</span>
                  </p>
                </div>
              ) : (
                <p className={`mt-3 text-[10px] text-ds-ink-faint ${mono}`}>No warehouse floor issue logged for this job yet.</p>
              )}
              <p className={`mt-3 text-[10px] text-ds-ink-faint border-t border-border/25 pt-2`}>
                Material Verified against Batch {jc.boardMaterial.batchLotNumber ?? '—'}. Board Status:{' '}
                {jc.boardMaterial.boardStatus === 'available' ? 'Available' : 'Out of stock'}.
              </p>
            </Link>
          ) : (
            <p className="text-xs text-ds-ink-faint">Loading board context…</p>
          )}
        </div>
        </div>

        {/* Material specification — inventory handshake (dims from allocated / issued batch) */}
        <div className="rounded-xl border border-border/40 bg-background p-4 space-y-3">
          <h2 className="text-sm font-semibold text-ds-warning">Material specification · inventory handshake</h2>
          <p className="text-[10px] text-ds-ink-faint">
            Sheet size and grain follow the allocated mill batch (FIFO). Validated against AW queue target sheet size.
          </p>
          {jc.grainFitStatus === 'critical_mismatch' ? (
            <div
              className="rounded-lg border border-rose-600 bg-rose-950/50 px-3 py-2 text-rose-400 text-sm font-bold"
              role="alert"
            >
              CRITICAL: STOCK SIZE MISMATCH — inventory sheet is smaller than AW target. Job card cannot be QA
              released until resolved.
            </div>
          ) : null}
          {jc.grainFitStatus === 'pre_trim_required' ? (
            <div className="rounded-lg border border-ds-warning/50 bg-ds-warning/10 px-3 py-1.5 text-ds-warning text-xs font-semibold">
              Pre-trim required — stock sheet larger than AW target layout.
            </div>
          ) : null}
          <div className={`rounded-lg border border-border/40 bg-ds-main/80 p-3 space-y-2 text-xs ${mono}`}>
            <p className="text-ds-ink">
              {jc.issuedStockDisplay?.trim() || (
                <span className="text-ds-ink-faint">No inventory dimensions synced yet — issue paper to floor or regenerate from planning.</span>
              )}
            </p>
            {jc.inventoryLocationPointer?.trim() ? (
              <p className="text-ds-ink-muted">{jc.inventoryLocationPointer.trim()}</p>
            ) : (
              <p className="text-ds-ink-faint">Location pointer: —</p>
            )}
          </div>
          <p className={`text-[10px] text-ds-ink-faint border-t border-border/25 pt-2 ${mono}`}>
            Inventory Handshake Verified. Material Batch {jc.boardMaterial?.batchLotNumber ?? '—'} locked for Job{' '}
            {jc.jobCardNumber}.
          </p>
        </div>

        {/* Routing from AW — read-only */}
        <div className="rounded-xl border border-border/10 bg-ds-main/40 p-4">
          <h2 className="text-sm font-semibold text-ds-ink mb-2">Smart routing · AW queue</h2>
          <p className="text-[10px] text-ds-ink-faint mb-2">
            Stages below follow toggles saved on this job card (from artwork / planning). Only applicable
            stages are shown.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {POST_PRESS_LABELS.map(({ key, label }) => {
              const on = effectiveRouting[key]
              const embossNa = key === 'embossing' && !embossRequired
              if (embossNa) return null
              if (!on) return null
              return (
                <span
                  key={key}
                  className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-200"
                >
                  {label}
                </span>
              )
            })}
            {!POST_PRESS_LABELS.some(({ key }) => {
              if (key === 'embossing' && !embossRequired) return false
              return !!effectiveRouting[key]
            }) ? (
              <span className="text-[10px] text-ds-ink-faint">Post-press: none · print → die-cut → paste</span>
            ) : null}
          </div>
        </div>

        <div className={`rounded-xl border border-border/40 bg-card p-3 flex flex-wrap gap-6 text-xs ${mono}`}>
          <div>
            <span className="text-ds-ink-faint">Required</span>{' '}
            <span className="text-ds-ink">{jc.requiredSheets}</span>
          </div>
          <div>
            <span className="text-ds-ink-faint">Wastage</span>{' '}
            <span className="text-ds-ink">{jc.wastageSheets}</span>
          </div>
          <div>
            <span className="text-ds-ink-faint">Total</span>{' '}
            <span className="text-ds-warning">{jc.totalSheets}</span>
          </div>
          <div>
            <span className="text-ds-ink-faint">Issued</span>{' '}
            <span className="text-ds-ink">{jc.sheetsIssued}</span>
          </div>
        </div>

        <div className="rounded-xl border border-orange-500/25 bg-card p-4">
          <h2 className="text-sm font-semibold text-orange-300 mb-2">Shift operator</h2>
          <select
            className={`w-full max-w-md px-3 py-2 rounded-lg bg-card border border-border/50 text-ds-ink text-sm ${mono}`}
            value={jc.shiftOperator?.id ?? ''}
            disabled={saving}
            onChange={(e) =>
              saveChanges({
                shiftOperatorUserId: e.target.value ? e.target.value : null,
              })
            }
          >
            <option value="">— Unassigned —</option>
            {shiftOperators.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>

        <div className="rounded-xl border border-border/10 bg-ds-main/50 p-4 text-sm space-y-3">
          <div className="grid md:grid-cols-4 gap-3">
            <div>
              <label className="block text-ds-ink-faint mb-1 text-xs">Assigned operator</label>
              <input
                type="text"
                value={jc.assignedOperator ?? ''}
                onChange={(e) => update('assignedOperator', e.target.value || null)}
                className={`w-full px-3 py-2 rounded-lg bg-card border border-border/50 text-foreground ${mono}`}
              />
            </div>
            <div>
              <label className="block text-ds-ink-faint mb-1 text-xs">Batch number</label>
              <input
                type="text"
                value={jc.batchNumber ?? ''}
                onChange={(e) => update('batchNumber', e.target.value || null)}
                className={`w-full px-3 py-2 rounded-lg bg-card border border-border/50 text-foreground ${mono}`}
              />
            </div>
            <div>
              <label className="block text-ds-ink-faint mb-1 text-xs">Required sheets</label>
              <input
                type="number"
                min={1}
                value={jc.requiredSheets}
                onChange={(e) => update('requiredSheets', Number(e.target.value) || jc.requiredSheets)}
                className={`w-full px-3 py-2 rounded-lg bg-card border border-border/50 text-foreground ${mono}`}
              />
            </div>
            <div>
              <label className="block text-ds-ink-faint mb-1 text-xs">Wastage sheets</label>
              <input
                type="number"
                min={0}
                value={jc.wastageSheets}
                onChange={(e) => update('wastageSheets', Number(e.target.value) || 0)}
                className={`w-full px-3 py-2 rounded-lg bg-card border border-border/50 text-foreground ${mono}`}
              />
            </div>
          </div>
          <div>
            <p className="text-ds-ink-faint text-xs mb-2">Compliance</p>
            <div className="flex flex-wrap gap-4 text-xs">
              {(
                [
                  ['artworkApproved', 'Artwork approved'],
                  ['firstArticlePass', 'First article pass'],
                  ['finalQcPass', 'Final QC pass'],
                  ['qaReleased', 'QA released'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-ds-ink">
                  <input
                    type="checkbox"
                    checked={
                      key === 'artworkApproved'
                        ? jc.artworkApproved
                        : key === 'firstArticlePass'
                          ? jc.firstArticlePass
                          : key === 'finalQcPass'
                            ? jc.finalQcPass
                            : jc.qaReleased
                    }
                    onChange={(e) => {
                      if (key === 'artworkApproved') update('artworkApproved', e.target.checked)
                      else if (key === 'firstArticlePass') update('firstArticlePass', e.target.checked)
                      else if (key === 'finalQcPass') update('finalQcPass', e.target.checked)
                      else update('qaReleased', e.target.checked)
                    }}
                    className="rounded border-border/20 bg-background"
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <button
              type="button"
              disabled={saving}
              onClick={() =>
                saveChanges({
                  assignedOperator: jc.assignedOperator,
                  batchNumber: jc.batchNumber,
                  requiredSheets: jc.requiredSheets,
                  wastageSheets: jc.wastageSheets,
                  artworkApproved: jc.artworkApproved,
                  firstArticlePass: jc.firstArticlePass,
                  finalQcPass: jc.finalQcPass,
                  qaReleased: jc.qaReleased,
                })
              }
              className="px-3 py-1.5 rounded-lg bg-ds-warning hover:bg-ds-warning disabled:opacity-50 text-primary-foreground text-xs"
            >
              {saving ? 'Saving…' : 'Save header'}
            </button>
            <button
              type="button"
              disabled={saving || jc.status === 'closed'}
              onClick={() => {
                if (!confirm('Close this job card? Confirm tooling received back in hubs via Receive.')) return
                void saveChanges({ status: 'closed' })
              }}
              className="px-3 py-1.5 rounded-lg border border-emerald-500/50 bg-emerald-500/10 text-emerald-200 text-xs hover:bg-emerald-500/20 disabled:opacity-40"
            >
              Mark job complete
            </button>
          </div>
        </div>

        {/* Stage tiles — filtered + sequential counts */}
        <div>
          <h2 className="text-sm font-semibold text-ds-ink mb-2">Production stages</h2>
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
            {stageChain.map(({ stage, expectedInput, afterWaste }) => {
              const cls = STATUS_COLORS[stage.status] ?? STATUS_COLORS.pending
              return (
                <div
                  key={stage.id}
                  className="rounded-lg border border-border/40 bg-card p-3 flex flex-col"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-ds-ink">{stage.stageName}</p>
                    <span className={`px-2 py-0.5 rounded text-[10px] border ${cls}`}>{stage.status}</span>
                  </div>
                  <div className={`mt-2 space-y-1 text-[10px] ${mono} text-ds-ink-muted`}>
                    <p>
                      <span className="text-ds-ink-faint">Input (expect)</span>{' '}
                      <span className="text-ds-ink">{expectedInput}</span>
                      <span className="text-ds-ink-faint"> · after wastage Δ </span>
                      <span className="text-ds-ink">{afterWaste}</span>
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                    <div>
                      <label className="block text-ds-ink-faint mb-1">Operator</label>
                      <input
                        type="text"
                        value={stage.operator ?? ''}
                        onChange={(e) => updateStage(stage.id, { operator: e.target.value || null })}
                        className="w-full px-2 py-1 rounded bg-card border border-border/50 text-foreground text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-ds-ink-faint mb-1">Output count</label>
                      <input
                        type="number"
                        value={stage.counter ?? ''}
                        onChange={(e) =>
                          updateStage(stage.id, {
                            counter: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                        className={`w-full px-2 py-1 rounded bg-card border border-border/50 text-foreground text-xs ${mono}`}
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-ds-ink-faint mb-1">Sheet size</label>
                      <input
                        type="text"
                        value={stage.sheetSize ?? ''}
                        onChange={(e) => updateStage(stage.id, { sheetSize: e.target.value || null })}
                        className={`w-full px-2 py-1 rounded bg-card border border-border/50 text-foreground text-xs ${mono}`}
                      />
                    </div>
                  </div>
                  <div className="flex gap-2 mt-3 mt-auto">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() =>
                        saveChanges({
                          stages: [
                            {
                              id: stage.id,
                              status: stage.status === 'in_progress' ? 'completed' : 'in_progress',
                              operator: stage.operator,
                              counter: stage.counter,
                              sheetSize: stage.sheetSize,
                            },
                          ],
                        })
                      }
                      className="px-3 py-1.5 rounded-lg bg-ds-elevated hover:bg-ds-elevated text-foreground text-xs disabled:opacity-50"
                    >
                      {stage.status === 'in_progress' ? 'Mark completed' : 'Start stage'}
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() =>
                        saveChanges({
                          stages: [
                            {
                              id: stage.id,
                              status: 'pending',
                              operator: stage.operator,
                              counter: stage.counter,
                              sheetSize: stage.sheetSize,
                            },
                          ],
                        })
                      }
                      className="px-3 py-1.5 rounded-lg border border-border/50 text-ds-ink text-xs"
                    >
                      Reset
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <footer className={`border-t border-border/40 pt-4 text-center text-[10px] text-ds-ink-faint ${mono}`}>
          Instruction Set Synchronized from Melbourne Strategy Hub.
        </footer>
      </div>
    </div>
  )
}
