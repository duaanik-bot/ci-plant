'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  computeTotalPlates,
  defaultDesignerCommand,
  mergeDesignerCommandFromHistory,
  parseDesignerCommand,
  type DesignerCommand,
} from '@/lib/designer-command'
import { getPostPressRouting, isEmbossingRequired } from '@/lib/emboss-conditions'
import {
  HUB_TECHNICAL_DATA_MISSING_TOAST,
  validatePayload,
} from '@/lib/validate-hub-payload'
import { assertNonEmptyPayload, stringifyPayload } from '@/lib/defensive-payload'
import { safeJsonStringify } from '@/lib/safe-json'

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
  /** Carton batch number preprinting (flexo / coding) */
  batchNumberPreprinting?: boolean
  batchPreprintingTotalBatches?: number | null
  batchPreprintingBatchSize?: number | null
  [k: string]: unknown
} | null

type CartonMasterDims = {
  id: string
  finishedLength: unknown
  finishedWidth: unknown
  finishedHeight: unknown
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
type User = { id: string; name: string }

/** Merge batch preprinting from local form state; if enabled but values incomplete/invalid, returns {} so prior spec values stay. */
function buildBatchPreprintingOverlay(
  enabled: boolean,
  totalStr: string,
  sizeStr: string,
): Partial<{
  batchNumberPreprinting: boolean
  batchPreprintingTotalBatches: number | null
  batchPreprintingBatchSize: number | null
}> {
  if (!enabled) {
    return {
      batchNumberPreprinting: false,
      batchPreprintingTotalBatches: null,
      batchPreprintingBatchSize: null,
    }
  }
  const t = totalStr.trim()
  const s = sizeStr.trim()
  if (!t || !s) return {}
  const total = Math.floor(Number(t))
  const size = Math.floor(Number(s))
  if (!Number.isFinite(total) || total < 1 || !Number.isFinite(size) || size < 1) return {}
  return {
    batchNumberPreprinting: true,
    batchPreprintingTotalBatches: total,
    batchPreprintingBatchSize: size,
  }
}

const manualInputClass =
  'mt-1 w-full px-2 py-1.5 rounded bg-slate-900 text-white text-sm border-2 border-slate-400/85 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-500/35 placeholder:text-slate-500'

function CartonDimensionsRow({ carton }: { carton: CartonMasterDims | null | undefined }) {
  const fmt = (v: unknown) => {
    if (v == null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? String(n) : String(v)
  }
  const L = fmt(carton?.finishedLength)
  const W = fmt(carton?.finishedWidth)
  const H = fmt(carton?.finishedHeight)
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 sm:col-span-3 border-b border-slate-800/80 sm:border-0 pb-2 sm:pb-0">
      <span className="text-slate-500 shrink-0 text-xs">Carton dimensions (L × W × H)</span>
      <span className="flex flex-wrap items-center gap-x-2 text-slate-100 text-sm font-mono tabular-nums min-w-0">
        <span>{L ?? '—'}</span>
        <span className="text-slate-500">×</span>
        <span>{W ?? '—'}</span>
        <span className="text-slate-500">×</span>
        <span>{H ?? '—'}</span>
      </span>
    </div>
  )
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
  const [batchPreprintingEnabled, setBatchPreprintingEnabled] = useState(false)
  const [batchTotalBatchesInput, setBatchTotalBatchesInput] = useState('')
  const [batchBatchSizeInput, setBatchBatchSizeInput] = useState('')
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
  const [sendingUnified, setSendingUnified] = useState(false)
  const [plateHubSent, setPlateHubSent] = useState(false)
  const [unifiedSendSent, setUnifiedSendSent] = useState(false)
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
    setBatchPreprintingEnabled(!!spec.batchNumberPreprinting)
    const tb = spec.batchPreprintingTotalBatches
    setBatchTotalBatchesInput(
      tb != null && Number.isFinite(Number(tb)) ? String(Math.floor(Number(tb))) : '',
    )
    const bs = spec.batchPreprintingBatchSize
    setBatchBatchSizeInput(
      bs != null && Number.isFinite(Number(bs)) ? String(Math.floor(Number(bs))) : '',
    )
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
        ...buildBatchPreprintingOverlay(
          batchPreprintingEnabled,
          batchTotalBatchesInput,
          batchBatchSizeInput,
        ),
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
          ...buildBatchPreprintingOverlay(
            batchPreprintingEnabled,
            batchTotalBatchesInput,
            batchBatchSizeInput,
          ),
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
    [data, poLineId, batchPreprintingEnabled, batchTotalBatchesInput, batchBatchSizeInput],
  )

  const persistDesignerCommand = useCallback(
    async (next: DesignerCommand, options?: { skipLoading?: boolean }) => {
      if (!data) return
      if (!options?.skipLoading) setSavingDesignerCommand(true)
      try {
        const specOverrides = {
          ...(data.line.specOverrides || {}),
          ...buildBatchPreprintingOverlay(
            batchPreprintingEnabled,
            batchTotalBatchesInput,
            batchBatchSizeInput,
          ),
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
    [data, poLineId, jobType, batchPreprintingEnabled, batchTotalBatchesInput, batchBatchSizeInput],
  )

  const persistJobType = useCallback(
    async (next: 'new' | 'repeat') => {
      if (!data) return
      setJobType(next)
      try {
        const specOverrides = {
          ...(data.line.specOverrides || {}),
          ...buildBatchPreprintingOverlay(
            batchPreprintingEnabled,
            batchTotalBatchesInput,
            batchBatchSizeInput,
          ),
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
    [data, poLineId, batchPreprintingEnabled, batchTotalBatchesInput, batchBatchSizeInput],
  )

  type ToolingApiBody = {
    toolType: 'DIE' | 'BLOCK'
    jobId: string
    jobCardId: string
    artworkId: string
    setNumber: string
    source: 'NEW' | 'OLD'
  }

  const buildToolingBody = (tool: 'die' | 'emboss'): ToolingApiBody | null => {
    if (!data?.line) return null
    const artworkId =
      String(data.line.specOverrides?.artworkId ?? '').trim() || resolvedArtworkId?.trim() || ''
    const setNumber = setNumberInput.trim()
    const jobCardId = data.jobCard?.id?.trim() || ''
    if (!artworkId || !setNumber || !jobCardId) return null
    const src = tool === 'die' ? designerCommand.dieSource : designerCommand.embossSource
    if (!src) return null
    return {
      toolType: tool === 'die' ? 'DIE' : 'BLOCK',
      jobId: data.line.id,
      jobCardId,
      artworkId,
      setNumber,
      source: src === 'new' ? 'NEW' : 'OLD',
    }
  }

  const assertToolingPayload = (body: ToolingApiBody | null): body is ToolingApiBody => {
    if (!body) {
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
    const body = buildToolingBody('die')
    if (!assertToolingPayload(body)) return
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
    const body = buildToolingBody('emboss')
    if (!assertToolingPayload(body)) return
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

  const sendAllUnifiedToolingHub = async () => {
    if (!data) return
    const embossReq = isEmbossingRequired(data.line.embossingLeafing)
    const artworkId =
      String(data.line.specOverrides?.artworkId ?? '').trim() || resolvedArtworkId?.trim() || ''
    const jobCardId = data.jobCard?.id?.trim() || ''
    const setNumber = setNumberInput.trim()
    if (!setNumberInput.trim()) {
      toast.error('Set # is required before sending to the tooling hub.')
      return
    }
    if (!jobCardId) {
      toast.error(
        'Create or link a job card for this PO line before sending to the unified tooling hub.',
      )
      return
    }
    if (!artworkId) {
      toast.error(
        'Link artwork first: enter an AW code that matches a job artwork file for this customer.',
      )
      return
    }
    if (!validatePayload({ artworkId, jobCardId, setNumber }).ok) {
      toast.error(HUB_TECHNICAL_DATA_MISSING_TOAST)
      return
    }

    const spec = data.line.specOverrides
    const unifiedPayload = {
      poLineId: data.line.id,
      jobCardId,
      artworkId,
      setNumber,
      dieId: data.line.dyeId ?? null,
      embossBlockId: spec?.embossBlockId?.trim() || null,
      plateSetId: null as string | null,
      dispatchDie: !!designerCommand.dieSource,
      dispatchEmboss: embossReq && !!designerCommand.embossSource,
      dieSource: designerCommand.dieSource
        ? designerCommand.dieSource === 'new'
          ? ('NEW' as const)
          : ('OLD' as const)
        : null,
      embossSource:
        embossReq && designerCommand.embossSource
          ? designerCommand.embossSource === 'new'
            ? ('NEW' as const)
            : ('OLD' as const)
          : null,
    }

    if (!assertNonEmptyPayload(unifiedPayload, 'sendAllUnified')) {
      toast.error(HUB_TECHNICAL_DATA_MISSING_TOAST)
      return
    }
    const bodyStr = stringifyPayload(unifiedPayload, 'sendAllUnified')
    if (!bodyStr) {
      toast.error(HUB_TECHNICAL_DATA_MISSING_TOAST)
      return
    }

    setSendingUnified(true)
    try {
      console.log('Dispatch Payload:', unifiedPayload)
      const now = new Date().toISOString()
      const res = await fetch('/api/tooling/dispatch-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyStr,
      })
      const json = (await res.json()) as {
        error?: string
        fields?: Record<string, string>
        ok?: boolean
      }
      if (!res.ok) throw new Error(apiErrorMessage(json))

      const next: DesignerCommand = {
        ...designerCommand,
        plateHubDispatchAt: now,
        ...(designerCommand.dieSource
          ? {
              dieLastIntent: designerCommand.dieSource === 'new' ? ('die_hub' as const) : ('store_retrieval' as const),
              dieLastIntentAt: now,
            }
          : {}),
        ...(embossReq && designerCommand.embossSource
          ? {
              embossLastIntent:
                designerCommand.embossSource === 'new' ? ('emboss_hub' as const) : ('store_retrieval' as const),
              embossLastIntentAt: now,
            }
          : {}),
      }
      await persistDesignerCommand(next, { skipLoading: true })
      setUnifiedSendSent(true)
      toast.success('Data successfully routed to Tooling Hubs')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Dispatch failed')
    } finally {
      setSendingUnified(false)
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
      const specOverrides = {
        ...(data.line.specOverrides || {}),
        ...buildBatchPreprintingOverlay(
          batchPreprintingEnabled,
          batchTotalBatchesInput,
          batchBatchSizeInput,
        ),
        artworkId,
      }
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
    [
      data?.line,
      poLineId,
      batchPreprintingEnabled,
      batchTotalBatchesInput,
      batchBatchSizeInput,
    ],
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

  const resolveBatchPreprintingForSave = useCallback(():
    | { error: string }
    | {
        batchNumberPreprinting: boolean
        batchPreprintingTotalBatches: number | null
        batchPreprintingBatchSize: number | null
      } => {
    if (!batchPreprintingEnabled) {
      return {
        batchNumberPreprinting: false,
        batchPreprintingTotalBatches: null,
        batchPreprintingBatchSize: null,
      }
    }
    const t = batchTotalBatchesInput.trim()
    const s = batchBatchSizeInput.trim()
    if (!t || !s) {
      return {
        error:
          'Total batches and batch size are required when batch number preprinting is enabled.',
      }
    }
    const total = Math.floor(Number(t))
    const size = Math.floor(Number(s))
    if (!Number.isFinite(total) || total < 1 || !Number.isFinite(size) || size < 1) {
      return { error: 'Total batches and batch size must be positive whole numbers.' }
    }
    return {
      batchNumberPreprinting: true,
      batchPreprintingTotalBatches: total,
      batchPreprintingBatchSize: size,
    }
  }, [batchPreprintingEnabled, batchTotalBatchesInput, batchBatchSizeInput])

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
      const batchPart = resolveBatchPreprintingForSave()
      if ('error' in batchPart) {
        toast.error(batchPart.error)
        setSavingSetAw(false)
        return
      }
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
        ...batchPart,
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
      const batchPart = resolveBatchPreprintingForSave()
      if ('error' in batchPart) {
        toast.error(batchPart.error)
        setSavingSpecs(false)
        return
      }
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
        ...batchPart,
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
    [designerCommand.plateRequirement],
  )

  const effectiveArtworkId = useMemo(
    () =>
      String(data?.line?.specOverrides?.artworkId ?? '').trim() || resolvedArtworkId?.trim() || '',
    [data?.line?.specOverrides, resolvedArtworkId],
  )

  const canSendAllToHub =
    !!setNumberInput.trim() &&
    !!effectiveArtworkId &&
    !!(data?.jobCard?.id && String(data.jobCard.id).trim())

  if (!data || !line) return <div className="p-4 text-slate-400">Loading...</div>

  const showNewProductSetHint =
    historyNoMatch && !setNumberInput.trim() && !!artworkCodeInput.trim()
  const showRepeatJobBadge = setLookupState === 'matched' || artworkRepeatJob

  return (
    <div className="flex flex-col min-h-[calc(100dvh-0px)]">
      <header className="sticky top-0 z-30 border-b border-slate-700 bg-slate-950/95 backdrop-blur-sm px-3 py-2">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between lg:gap-4 max-w-7xl mx-auto w-full">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg sm:text-xl font-bold text-amber-400 break-words leading-tight">{line.cartonName}</h1>
            <p className="text-xs sm:text-sm text-slate-400">
              {line.po.customer.name} | PO {line.po.poNumber} | Qty {line.quantity}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] items-center">
              <span className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-900 text-slate-200">
                AW: {artworkCodeInput.trim() || '—'}
              </span>
              <span className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-900 text-slate-200">
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
                className="inline-flex flex-wrap items-center gap-2 sm:gap-3 rounded-lg border border-slate-700 bg-slate-900/80 px-2 py-1.5"
                role="group"
                aria-label="Designer and approvals"
              >
                <select
                  value={designerId}
                  onChange={(e) => saveDesigner(e.target.value || undefined)}
                  disabled={savingDesigner}
                  className="px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white text-xs min-w-[140px] max-w-[200px]"
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
          <section className="rounded-xl bg-slate-900 border border-slate-700 p-3">
            <h2 className="text-sm font-semibold text-slate-200 mb-2">Section 1 — Identification &amp; spec</h2>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="text-[11px] text-slate-500 shrink-0">Job type</span>
              <div className="inline-flex rounded-lg border border-slate-600 overflow-hidden">
                <button
                  type="button"
                  onClick={() => void persistJobType('new')}
                  className={`px-3 py-1.5 text-xs font-medium ${
                    jobType === 'new'
                      ? 'bg-amber-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  New product
                </button>
                <button
                  type="button"
                  onClick={() => void persistJobType('repeat')}
                  className={`px-3 py-1.5 text-xs font-medium border-l border-slate-600 ${
                    jobType === 'repeat'
                      ? 'bg-amber-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
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
                  className={`mt-1 w-full px-2 py-1.5 rounded bg-slate-800 text-white text-sm border ${
                    showNewProductSetHint
                      ? 'border-amber-500/90 ring-1 ring-amber-600/35'
                      : 'border-slate-600'
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
                  className="mt-1 w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-white text-sm"
                  placeholder="Manual artwork / revision code"
                />
                {artworkCodeInput.trim() ? (
                  <p
                    className={`mt-1 text-[10px] ${effectiveArtworkId ? 'text-emerald-500/80' : 'text-amber-500/85'}`}
                  >
                    {effectiveArtworkId
                      ? 'Artwork linked for die / emboss / send-all dispatch.'
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
                  className={manualInputClass}
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
                  className={manualInputClass}
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
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-sm border-t border-slate-700 pt-3">
              <CartonDimensionsRow carton={line.carton} />
              <KV label="Paper" value={line.paperType || '-'} />
              <KV label="GSM" value={line.gsm ? String(line.gsm) : '-'} />
              <KV label="Coating" value={line.coatingType || '-'} />
              <KV label="Colours" value={String(line.specOverrides?.numberOfColours || 4)} />
              <KV label="Emboss / leaf" value={line.embossingLeafing || 'None'} />
              <KV label="Batch space" value={String(line.specOverrides?.batchSpace || '-')} />
              {line.specOverrides?.batchNumberPreprinting ? (
                <KV
                  label="Batch preprinting"
                  value={`${line.specOverrides.batchPreprintingTotalBatches ?? '—'} batches · size ${line.specOverrides.batchPreprintingBatchSize ?? '—'}`}
                />
              ) : null}
            </div>
            <div className="mt-3 pt-3 border-t border-slate-700 space-y-3">
              <label className="flex items-start gap-2 text-xs text-slate-200 cursor-pointer max-w-xl">
                <input
                  type="checkbox"
                  className="rounded border-slate-600 mt-0.5 shrink-0"
                  checked={batchPreprintingEnabled}
                  onChange={(e) => {
                    const on = e.target.checked
                    setBatchPreprintingEnabled(on)
                    if (!on) {
                      setBatchTotalBatchesInput('')
                      setBatchBatchSizeInput('')
                    }
                  }}
                />
                <span>
                  <span className="font-medium text-slate-100">Carton has batch number preprinting</span>
                  <span className="block text-[11px] text-slate-500 font-normal mt-0.5">
                    Enable if batch / lot coding is printed on the carton; save with &quot;Save set &amp; AW code&quot;
                    or &quot;Save specs&quot;.
                  </span>
                </span>
              </label>
              {batchPreprintingEnabled ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:max-w-md pl-0 sm:pl-7">
                  <label className="block text-xs text-slate-400">
                    Total batches
                    <input
                      type="text"
                      inputMode="numeric"
                      value={batchTotalBatchesInput}
                      onChange={(e) => setBatchTotalBatchesInput(e.target.value.replace(/\D/g, ''))}
                      className={manualInputClass}
                      placeholder="e.g. 12"
                      autoComplete="off"
                    />
                  </label>
                  <label className="block text-xs text-slate-400">
                    Batch size
                    <input
                      type="text"
                      inputMode="numeric"
                      value={batchBatchSizeInput}
                      onChange={(e) => setBatchBatchSizeInput(e.target.value.replace(/\D/g, ''))}
                      className={manualInputClass}
                      placeholder="e.g. 5000"
                      autoComplete="off"
                    />
                  </label>
                </div>
              ) : null}
            </div>
            <label className="block text-xs text-slate-400 mt-3 pt-3 border-t border-slate-700">
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

        <section className="rounded-xl bg-slate-900 border border-slate-700 p-3 space-y-3">
          <h2 className="text-sm font-semibold text-slate-200 border-b border-slate-800 pb-2">
            Section 2 — Tooling (die · emboss · plate requirement)
          </h2>

          <div className="grid md:grid-cols-2 gap-3">
            <div className="space-y-3 rounded-lg border border-slate-700/80 bg-slate-950/40 p-3">
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
                <div className="flex flex-wrap gap-2 justify-start">
                  <button
                    type="button"
                    disabled={savingDesignerCommand || designerCommand.dieSource === 'old'}
                    onClick={() => void dieSendToVendor()}
                    className="px-2.5 py-1.5 rounded-md bg-violet-700/90 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium text-balance max-w-[11rem] sm:max-w-none"
                  >
                    Send to Vendor
                  </button>
                  <button
                    type="button"
                    disabled={savingDesignerCommand}
                    onClick={() => void diePushToHub()}
                    className="px-2.5 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium text-balance max-w-[11rem] sm:max-w-none"
                  >
                    Push to Die Hub
                  </button>
                </div>
              ) : (
                <span className="text-[11px] text-slate-500">Select New or Old to show actions.</span>
              )}
            </div>

            {embossRequired ? (
              <div className="space-y-3 rounded-lg border border-slate-700/80 bg-slate-950/40 p-3">
                <h3 className="text-xs font-semibold text-amber-200/95 uppercase tracking-wide">
                  Emboss blocks
                </h3>
                <ToolSourceRow
                  label="Source"
                  value={designerCommand.embossSource}
                  historyValue={historyDesignerCommand?.embossSource ?? null}
                  onChange={(v) => setDesignerCommand((p) => ({ ...p, embossSource: v }))}
                />
                {designerCommand.embossSource ? (
                  <div className="flex flex-wrap gap-2 justify-start">
                    <button
                      type="button"
                      disabled={savingDesignerCommand || designerCommand.embossSource === 'old'}
                      onClick={() => void embossSendToVendor()}
                      className="px-2.5 py-1.5 rounded-md bg-violet-700/90 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium text-balance max-w-[11rem] sm:max-w-none"
                    >
                      Send to Vendor
                    </button>
                    <button
                      type="button"
                      disabled={savingDesignerCommand}
                      onClick={() => void embossPushToHub()}
                      className="px-2.5 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium text-balance max-w-[11rem] sm:max-w-none"
                    >
                      Push to Embossing Hub
                    </button>
                  </div>
                ) : (
                  <span className="text-[11px] text-slate-500">Select New or Old to show actions.</span>
                )}
              </div>
            ) : (
              <div className="rounded-lg border border-slate-800 bg-slate-950/20 p-3 text-[11px] text-slate-500">
                Emboss tooling not required for this carton (no embossing on spec).
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-lg border border-slate-700/80 bg-slate-950/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2 mb-2">
              <h3 className="text-xs font-semibold text-amber-200/95 uppercase tracking-wide">
                Plate hub — requirement
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center rounded-md border border-cyan-600/60 bg-cyan-950/50 px-2 py-0.5 text-[11px] font-semibold text-cyan-100">
                  Total plates: {totalPlatesLive}
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
            <div className="flex flex-wrap gap-3 items-center">
              <span className="text-[11px] text-slate-400 shrink-0">Standard</span>
              {(
                [
                  ['standardC', 'C'],
                  ['standardM', 'M'],
                  ['standardY', 'Y'],
                  ['standardK', 'K'],
                ] as const
              ).map(([key, lab]) => (
                <label key={key} className="flex items-center gap-1.5 text-xs text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    className="rounded border-slate-600"
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
                    <span className="text-[10px] text-emerald-400/90">Previously used</span>
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
              ).map(([key, lab]) => (
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
                  />
                  {historyDesignerCommand?.plateRequirement[key] ? (
                    <span className="text-[10px] text-emerald-400/90">Previously used</span>
                  ) : null}
                </label>
              ))}
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

        <button
          type="button"
          disabled={
            savingDesignerCommand || sendingUnified || !canSendAllToHub || unifiedSendSent
          }
          title={
            unifiedSendSent
              ? 'Already sent to unified tooling hub'
              : !canSendAllToHub
                ? 'Set #, linked artwork (AW code), and a job card for this line are required'
                : undefined
          }
          onClick={() => void sendAllUnifiedToolingHub()}
          className="w-full py-2 rounded-lg border border-emerald-500/80 bg-emerald-800 hover:bg-emerald-700 text-white text-xs font-bold tracking-wide disabled:opacity-45 disabled:cursor-not-allowed"
        >
          {unifiedSendSent
            ? 'Sent ✅'
            : sendingUnified
              ? 'Sending…'
              : 'SEND ALL TO UNIFIED TOOLING HUB'}
        </button>

        <section className="rounded-xl bg-slate-900 border border-slate-700 px-3 py-2">
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

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-1 py-1 border-b border-slate-800/80 sm:border-0">
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
