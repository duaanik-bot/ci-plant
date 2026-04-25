'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Layers, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { parseDesignerCommand } from '@/lib/designer-command'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type SpecOverrides = {
  assignedDesignerId?: string
  customerApprovalPharma?: boolean
  shadeCardQaTextApproval?: boolean
  prePressSentToPlateHubAt?: string
  revisionRequired?: boolean
  [k: string]: unknown
} | null

type Row = {
  id: string
  cartonName: string
  cartonSize?: string | null
  artworkCode?: string | null
  quantity: number
  setNumber: string | null
  paperType?: string | null
  coatingType?: string | null
  embossingLeafing?: string | null
  gsm?: number | null
  planningStatus: string
  specOverrides: SpecOverrides
  readiness: {
    pipelinePhase?: 'finalized' | 'revision' | 'awaiting_client' | 'drafting'
    prePressFinalized?: boolean
    approvalsComplete?: boolean
    artworkStatusLabel?: string
  }
  po: {
    id: string
    poNumber: string
    customer: { id: string; name: string }
  }
}

type User = { id: string; name: string }

type Props = {
  groupId: string
  rows: Row[]
  users: User[]
  isOpen: boolean
  onClose: () => void
  onRefresh: () => void
}

function pipelineDot(phase: Row['readiness']['pipelinePhase']) {
  switch (phase) {
    case 'finalized':      return 'bg-emerald-500'
    case 'revision':       return 'bg-rose-500'
    case 'awaiting_client': return 'bg-blue-500'
    default:               return 'bg-ds-ink-faint/50'
  }
}

function pipelineLabel(phase: Row['readiness']['pipelinePhase']) {
  switch (phase) {
    case 'finalized':      return 'Finalized'
    case 'revision':       return 'Revision'
    case 'awaiting_client': return 'Awaiting client'
    default:               return 'Drafting'
  }
}

type ItemState = {
  artworkCode: string
  setNumber: string
  ups: string
  specialRemarks: string
  standardC: boolean
  standardM: boolean
  standardY: boolean
  standardK: boolean
  pantoneEnabled: boolean
  numberOfPantones: string
  pantone1: string
  pantone2: string
  pantone3: string
  dripOffPlate: boolean
  spotUvPlate: boolean
  customerApproval: boolean
  qaTextApproval: boolean
}

export function AwGroupEditDrawer({ groupId, rows, users, isOpen, onClose, onRefresh }: Props) {
  const [saving, setSaving] = useState<Set<string>>(new Set())
  const [savingGroup, setSavingGroup] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  const [itemStates, setItemStates] = useState<Record<string, ItemState>>(() => {
    const s: Record<string, ItemState> = {}
    for (const r of rows) {
      const spec = r.specOverrides || {}
      const s = spec as Record<string, unknown>
      const dc = parseDesignerCommand(s.designerCommand)
      const pr = dc.plateRequirement
      const upsRaw = s.ups ?? s.numberOfUps
      s[r.id] = {
        artworkCode: r.artworkCode ?? '',
        setNumber: r.setNumber ?? '',
        ups: typeof upsRaw === 'number' && Number.isFinite(upsRaw) ? String(Math.floor(upsRaw)) : '',
        specialRemarks:
          typeof s.specialRemarks === 'string'
            ? s.specialRemarks
            : typeof s.prePressRemarks === 'string'
              ? s.prePressRemarks
              : '',
        standardC: !!pr.standardC,
        standardM: !!pr.standardM,
        standardY: !!pr.standardY,
        standardK: !!pr.standardK,
        pantoneEnabled: !!pr.pantoneEnabled,
        numberOfPantones: pr.numberOfPantones > 0 ? String(pr.numberOfPantones) : '',
        pantone1: pr.pantone1 || '',
        pantone2: pr.pantone2 || '',
        pantone3: pr.pantone3 || '',
        dripOffPlate: !!pr.dripOffPlate,
        spotUvPlate: !!pr.spotUvPlate,
        customerApproval: !!(spec.customerApprovalPharma),
        qaTextApproval: !!(spec.shadeCardQaTextApproval),
      }
    }
    return s
  })

  const totalQty = rows.reduce((s, r) => s + r.quantity, 0)
  const inferredArtworkCode = useMemo(() => {
    const nonEmpty = rows.map((r) => (r.artworkCode || '').trim()).filter(Boolean)
    if (!nonEmpty.length) return ''
    const counts = new Map<string, number>()
    for (const aw of nonEmpty) counts.set(aw, (counts.get(aw) || 0) + 1)
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  }, [rows])
  const inferredSetNumber = useMemo(() => {
    const nonEmpty = rows.map((r) => (r.setNumber || '').trim()).filter(Boolean)
    if (!nonEmpty.length) return ''
    const counts = new Map<string, number>()
    for (const n of nonEmpty) counts.set(n, (counts.get(n) || 0) + 1)
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  }, [rows])
  const [groupSetNumber, setGroupSetNumber] = useState('')
  const [groupArtworkCode, setGroupArtworkCode] = useState('')
  const [groupCustomerApproval, setGroupCustomerApproval] = useState(false)
  const [groupQaTextApproval, setGroupQaTextApproval] = useState(false)
  const [unifiedMode, setUnifiedMode] = useState(true)
  const [pushPlates, setPushPlates] = useState(false)
  const [pushDie, setPushDie] = useState(false)
  const [pushEmboss, setPushEmboss] = useState(false)

  useEffect(() => {
    setGroupArtworkCode(inferredArtworkCode)
    setGroupSetNumber(inferredSetNumber)
    const allCust = rows.length > 0 && rows.every((r) => !!r.specOverrides?.customerApprovalPharma)
    const allQa = rows.length > 0 && rows.every((r) => !!r.specOverrides?.shadeCardQaTextApproval)
    setGroupCustomerApproval(allCust)
    setGroupQaTextApproval(allQa)
    setUnifiedMode(true)
    setPushPlates(false)
    setPushDie(false)
    setPushEmboss(false)
    setDirty(false)
    setLastSavedAt(null)
  }, [rows, inferredArtworkCode, inferredSetNumber, isOpen])

  useEffect(() => {
    if (!isOpen) return
    if (groupSetNumber.trim()) return
    const aw = groupArtworkCode.trim()
    const customerId = rows[0]?.po?.customer?.id
    const excludeLineId = rows[0]?.id
    if (!aw || !customerId || !excludeLineId) return
    let cancelled = false
    void (async () => {
      const res = await fetch(
        `/api/designing/customer-aw-set-history?customerId=${encodeURIComponent(customerId)}&awCode=${encodeURIComponent(aw)}&excludeLineId=${encodeURIComponent(excludeLineId)}`,
      )
      const json = (await res.json().catch(() => ({}))) as { setNumber?: string | null }
      const setNo = (json.setNumber || '').trim()
      if (cancelled || !setNo) return
      setGroupSetNumber((prev) => (prev.trim() ? prev : setNo))
      toast.message(`Set # autofetched from latest ${rows[0]?.po?.customer?.name} + AW (${aw}): ${setNo}`)
    })()
    return () => {
      cancelled = true
    }
  }, [groupArtworkCode, groupSetNumber, isOpen, rows])

  function updateItem(id: string, patch: Partial<ItemState>) {
    setDirty(true)
    setItemStates((prev) => ({ ...prev, [id]: { ...prev[id]!, ...patch } }))
  }

  function applyFieldsToAllFromFirst() {
    const first = rows[0]
    if (!first) return
    const src = itemStates[first.id]
    if (!src) return
    setItemStates((prev) => {
      const next = { ...prev }
      for (const r of rows) {
        const base = next[r.id]
        if (!base) continue
        next[r.id] = {
          ...base,
          ups: src.ups,
          specialRemarks: src.specialRemarks,
          standardC: src.standardC,
          standardM: src.standardM,
          standardY: src.standardY,
          standardK: src.standardK,
          pantoneEnabled: src.pantoneEnabled,
          numberOfPantones: src.numberOfPantones,
          pantone1: src.pantone1,
          pantone2: src.pantone2,
          pantone3: src.pantone3,
          dripOffPlate: src.dripOffPlate,
          spotUvPlate: src.spotUvPlate,
        }
      }
      return next
    })
    setDirty(true)
    toast.success('Copied UPS/colours/remarks from item 1 to all')
  }

  async function saveItem(r: Row) {
    const st = itemStates[r.id]
    if (!st) return
    setSaving((prev) => { const n = new Set(prev); n.add(r.id); return n })
    try {
      const spec = (r.specOverrides || {}) as Record<string, unknown>
      const prevDc = parseDesignerCommand(spec.designerCommand)
      const upsNum = st.ups.trim() ? parseInt(st.ups.trim(), 10) : null
      const pantoneNum = st.numberOfPantones.trim() ? parseInt(st.numberOfPantones.trim(), 10) : 0
      const specOverrides = {
        ...spec,
        ups: Number.isFinite(upsNum) && (upsNum as number) >= 1 ? upsNum : null,
        numberOfUps: Number.isFinite(upsNum) && (upsNum as number) >= 1 ? upsNum : null,
        specialRemarks: st.specialRemarks.trim() || null,
        prePressRemarks: st.specialRemarks.trim() || null,
        customerApprovalPharma: st.customerApproval,
        shadeCardQaTextApproval: st.qaTextApproval,
        designerCommand: {
          ...prevDc,
          plateRequirement: {
            ...prevDc.plateRequirement,
            standardC: st.standardC,
            standardM: st.standardM,
            standardY: st.standardY,
            standardK: st.standardK,
            pantoneEnabled: st.pantoneEnabled,
            numberOfPantones: Number.isFinite(pantoneNum) && pantoneNum > 0 ? pantoneNum : 0,
            pantone1: st.pantone1,
            pantone2: st.pantone2,
            pantone3: st.pantone3,
            dripOffPlate: st.dripOffPlate,
            spotUvPlate: st.spotUvPlate,
          },
        },
      }
      const res = await fetch(`/api/planning/po-lines/${r.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artworkCode: st.artworkCode || null,
          setNumber: st.setNumber || null,
          specOverrides,
        }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error || 'Save failed')
      }
      toast.success(`Saved ${r.cartonName}`)
      setDirty(false)
      setLastSavedAt(new Date())
      onRefresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving((prev) => {
        const next = new Set(prev)
        next.delete(r.id)
        return next
      })
    }
  }

  async function saveUnifiedGroup() {
    if (!rows.length) return
    setSavingGroup(true)
    const nowIso = new Date().toISOString()
    let okCount = 0
    let failCount = 0
    for (const r of rows) {
      try {
        const specBase = (r.specOverrides || {}) as Record<string, unknown>
        const dc = parseDesignerCommand(specBase.designerCommand)
        const nextDesignerCommand: Record<string, unknown> = { ...dc }
        if (pushPlates) nextDesignerCommand.plateHubDispatchAt = nowIso
        if (pushDie) {
          nextDesignerCommand.dieLastIntent = 'die_hub'
          nextDesignerCommand.dieLastIntentAt = nowIso
        }
        if (pushEmboss) {
          nextDesignerCommand.embossLastIntent = 'emboss_hub'
          nextDesignerCommand.embossLastIntentAt = nowIso
        }
        const specOverrides = {
          ...specBase,
          customerApprovalPharma: groupCustomerApproval,
          shadeCardQaTextApproval: groupQaTextApproval,
          designerCommand: nextDesignerCommand,
        }
        const res = await fetch(`/api/planning/po-lines/${r.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            artworkCode: groupArtworkCode.trim() || null,
            setNumber: groupSetNumber.trim() || null,
            specOverrides,
          }),
        })
        if (!res.ok) throw new Error('Save failed')
        okCount += 1
      } catch {
        failCount += 1
      }
    }
    setSavingGroup(false)
    if (failCount > 0) {
      toast.error(`Unified save: ${okCount}/${rows.length} succeeded`)
    } else {
      const decisions = [pushPlates ? 'plates' : '', pushDie ? 'die' : '', pushEmboss ? 'emboss' : '']
        .filter(Boolean)
        .join(', ')
      toast.success(
        `Unified group saved for ${okCount} item${okCount === 1 ? '' : 's'}${decisions ? ` · push decisions: ${decisions}` : ''}`,
      )
    }
    setDirty(false)
    setLastSavedAt(new Date())
    onRefresh()
  }

  const userById = Object.fromEntries(users.map((u) => [u.id, u]))

  return (
    <SlideOverPanel
      isOpen={isOpen}
      onClose={onClose}
      widthClass="w-[min(100%,clamp(560px,55vw,860px))]"
      title={
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-bold text-sky-700 dark:text-sky-300">
            <Layers className="h-3 w-3 shrink-0" aria-hidden />
            GANG
          </span>
          <span className="text-base font-semibold text-ds-ink">Gang Print Group</span>
        </div>
      }
      headerMeta={
        <div className="flex flex-wrap items-center gap-3 text-[12px]">
          <span className="text-ds-ink-faint">
            Group: <span className={`${mono} text-ds-ink-muted`}>{groupId.slice(0, 8)}</span>
          </span>
          <span className="text-ds-ink-faint">
            {rows.length} items ·{' '}
            <span className={`font-semibold text-ds-brand ${mono}`}>{totalQty.toLocaleString('en-IN')}</span>{' '}
            pcs combined
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Unified group body controls */}
        <div className="rounded-ds-md border border-sky-500/35 bg-sky-500/8 p-3">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-sky-700 dark:text-sky-300">
            Unified group body
          </p>
          <div className="mb-2 flex items-center justify-between rounded border border-ds-line/40 bg-ds-elevated/20 px-2 py-1.5">
            <span className="text-[12px] text-ds-ink-muted">Use unified editing (recommended)</span>
            <label className="flex cursor-pointer items-center gap-2">
              <span className="text-[11px] text-ds-ink-faint">{unifiedMode ? 'On' : 'Off'}</span>
              <input
                type="checkbox"
                checked={unifiedMode}
                onChange={(e) => setUnifiedMode(e.target.checked)}
                className="h-4 w-4 rounded border-ds-line accent-ds-brand"
              />
            </label>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-ds-ink-faint">Set # (common)</label>
              <input
                type="text"
                value={groupSetNumber}
                onChange={(e) => setGroupSetNumber(e.target.value)}
                placeholder="e.g. 1"
                className={`w-full rounded-ds-sm border border-ds-line/50 bg-ds-elevated/30 px-2.5 py-1.5 text-[13px] text-ds-ink outline-none transition focus:border-ds-brand/60 focus:ring-1 focus:ring-ds-brand/30 ${mono}`}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-ds-ink-faint">Artwork code (auto-filled)</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={groupArtworkCode}
                  onChange={(e) => setGroupArtworkCode(e.target.value)}
                  placeholder="e.g. AW-2024-001"
                  className={`w-full rounded-ds-sm border border-ds-line/50 bg-ds-elevated/30 px-2.5 py-1.5 text-[13px] text-ds-ink outline-none transition focus:border-ds-brand/60 focus:ring-1 focus:ring-ds-brand/30 ${mono}`}
                />
                <button
                  type="button"
                  onClick={() => setGroupArtworkCode(inferredArtworkCode)}
                  className="shrink-0 rounded-ds-sm border border-ds-line/60 bg-ds-elevated/20 px-2 py-1 text-[11px] text-ds-ink-muted hover:border-ds-brand/40 hover:text-ds-brand"
                  title="Auto-fill from existing group values"
                >
                  Autofetch
                </button>
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 select-none">
              <input
                type="checkbox"
                checked={groupCustomerApproval}
                onChange={(e) => setGroupCustomerApproval(e.target.checked)}
                className="h-4 w-4 rounded border-ds-line accent-ds-brand"
              />
              <span className="text-[12px] text-ds-ink-muted">Customer approval (all)</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 select-none">
              <input
                type="checkbox"
                checked={groupQaTextApproval}
                onChange={(e) => setGroupQaTextApproval(e.target.checked)}
                className="h-4 w-4 rounded border-ds-line accent-ds-brand"
              />
              <span className="text-[12px] text-ds-ink-muted">QA text approval (all)</span>
            </label>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="flex cursor-pointer items-center gap-2 rounded border border-ds-line/40 bg-ds-elevated/20 px-2 py-1.5 text-[12px]">
              <input type="checkbox" checked={pushPlates} onChange={(e) => setPushPlates(e.target.checked)} className="h-4 w-4 accent-ds-brand" />
              <span className="text-ds-ink-muted">Decision: push plates</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded border border-ds-line/40 bg-ds-elevated/20 px-2 py-1.5 text-[12px]">
              <input type="checkbox" checked={pushDie} onChange={(e) => setPushDie(e.target.checked)} className="h-4 w-4 accent-ds-brand" />
              <span className="text-ds-ink-muted">Decision: push die</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded border border-ds-line/40 bg-ds-elevated/20 px-2 py-1.5 text-[12px]">
              <input type="checkbox" checked={pushEmboss} onChange={(e) => setPushEmboss(e.target.checked)} className="h-4 w-4 accent-ds-brand" />
              <span className="text-ds-ink-muted">Decision: push emboss</span>
            </label>
          </div>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              disabled={savingGroup}
              onClick={() => void saveUnifiedGroup()}
              className="inline-flex items-center gap-1 rounded-ds-sm border border-sky-500/45 bg-sky-500/15 px-3 py-1.5 text-[12px] font-semibold text-sky-700 transition hover:bg-sky-500/25 disabled:opacity-40 dark:text-sky-200"
            >
              <Pencil className="h-3 w-3" aria-hidden />
              {savingGroup ? 'Saving group…' : 'Save unified group'}
            </button>
          </div>
        </div>

        {/* Qty summary bar */}
        <div className="rounded-ds-md border border-ds-line/50 bg-ds-elevated/20 p-3">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-ds-ink-faint">Quantity breakdown</p>
          <div className="flex flex-wrap gap-2">
            {rows.map((r) => (
              <div key={r.id} className="flex flex-col rounded-ds-sm border border-ds-line/40 bg-ds-elevated/30 px-3 py-2 text-center min-w-[110px]">
                <span className="truncate text-[11px] font-medium text-ds-ink-muted" title={r.cartonName}>
                  {r.cartonName.length > 16 ? r.cartonName.slice(0, 15) + '…' : r.cartonName}
                </span>
                <span className="text-[10px] text-ds-ink-faint">{r.po.poNumber}</span>
                <span className={`mt-1 text-[18px] font-bold leading-none text-ds-brand ${mono}`}>
                  {r.quantity.toLocaleString('en-IN')}
                </span>
                <span className="text-[9px] text-ds-ink-faint">pcs</span>
              </div>
            ))}
          </div>
        </div>

        {/* Per-item edit panels */}
        <div className="flex flex-col gap-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-ds-ink-faint">Individual job details</p>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-ds-line/35 bg-ds-elevated/15 px-2 py-1.5">
            <p className="text-[11px] text-ds-ink-muted">
              Batch tools: apply one item's UPS/colours/remarks to all.
            </p>
            <button
              type="button"
              onClick={applyFieldsToAllFromFirst}
              className="rounded border border-ds-brand/35 bg-ds-brand/10 px-2 py-1 text-[11px] font-medium text-ds-brand hover:bg-ds-brand/20"
            >
              Copy from item 1 → all
            </button>
          </div>
          {unifiedMode ? (
            <p className="rounded border border-sky-500/30 bg-sky-500/8 px-2 py-1 text-[11px] text-sky-700 dark:text-sky-300">
              Unified mode is on: Set # and Artwork code are managed from the top unified section.
            </p>
          ) : null}

          {rows.map((r, idx) => {
            const st = itemStates[r.id] ?? {
              artworkCode: r.artworkCode ?? '',
              setNumber: r.setNumber ?? '',
              ups: '',
              specialRemarks: '',
              standardC: true,
              standardM: true,
              standardY: true,
              standardK: true,
              pantoneEnabled: false,
              numberOfPantones: '',
              pantone1: '',
              pantone2: '',
              pantone3: '',
              dripOffPlate: false,
              spotUvPlate: false,
              customerApproval: !!(r.specOverrides?.customerApprovalPharma),
              qaTextApproval: !!(r.specOverrides?.shadeCardQaTextApproval),
            }
            const isSaving = saving.has(r.id)
            const phase = r.readiness?.pipelinePhase ?? 'drafting'
            const finalized = !!r.readiness?.prePressFinalized
            const spec = r.specOverrides || {}
            const designerId = spec.assignedDesignerId as string | undefined
            const designerName = designerId ? (userById[designerId]?.name ?? '—') : 'Unassigned'

            return (
              <div
                key={r.id}
                className="rounded-ds-md border border-ds-line/50 bg-ds-elevated/10 overflow-hidden"
              >
                {/* Item header */}
                <div className="flex items-center justify-between gap-3 border-b border-ds-line/30 bg-ds-elevated/30 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-500/20 text-[10px] font-bold text-sky-700 dark:text-sky-300 ${mono}`}>
                      {idx + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-ds-ink" title={r.cartonName}>
                        {r.cartonName}
                      </p>
                      <p className={`text-[11px] text-ds-warning ${mono}`}>{r.po.poNumber} · {r.po.customer.name}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="flex items-center gap-1">
                      <span className={`h-2 w-2 rounded-full ${pipelineDot(phase)}`} />
                      <span className="text-[11px] text-ds-ink-faint">{pipelineLabel(phase)}</span>
                    </div>
                    {finalized && (
                      <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                        Finalized
                      </span>
                    )}
                    <Link
                      href={`/orders/designing/${r.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded border border-ds-line/50 bg-ds-elevated/20 px-2 py-0.5 text-[11px] text-ds-ink-muted hover:border-ds-warning/40 hover:text-ds-warning transition-colors"
                      title="Open full edit page"
                    >
                      <ExternalLink className="h-3 w-3" aria-hidden />
                      Full edit
                    </Link>
                  </div>
                </div>

                {/* Editable fields */}
                <div className="px-3 py-3">
                  <div className="mb-2 rounded border border-ds-line/30 bg-ds-elevated/20 px-2 py-1.5 text-[11px] text-ds-ink-muted">
                    Spec: {(r.paperType || '—').trim?.() || r.paperType || '—'} · {(r.coatingType || '—').trim?.() || r.coatingType || '—'} · GSM {r.gsm ?? '—'} · Size {r.cartonSize ?? '—'} · {(r.embossingLeafing || 'No emboss').trim?.() || r.embossingLeafing || 'No emboss'}
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {/* Qty — read-only */}
                    <div>
                      <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-ds-ink-faint">
                        Qty
                      </label>
                      <div className={`rounded-ds-sm border border-ds-line/30 bg-ds-elevated/40 px-2.5 py-1.5 text-[13px] font-bold text-ds-brand ${mono}`}>
                        {r.quantity.toLocaleString('en-IN')}
                      </div>
                    </div>

                    {/* Set # */}
                    <div>
                      <label htmlFor={`set-${r.id}`} className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-ds-ink-faint">
                        Set #
                      </label>
                      <input
                        id={`set-${r.id}`}
                        type="text"
                        value={st.setNumber}
                        onChange={(e) => updateItem(r.id, { setNumber: e.target.value })}
                        placeholder="e.g. 1"
                        disabled={unifiedMode}
                        className={`w-full rounded-ds-sm border border-ds-line/50 px-2.5 py-1.5 text-[13px] outline-none transition ${
                          unifiedMode
                            ? 'cursor-not-allowed bg-ds-elevated/10 text-ds-ink-faint opacity-70'
                            : 'bg-ds-elevated/30 text-ds-ink focus:border-ds-brand/60 focus:ring-1 focus:ring-ds-brand/30'
                        } ${mono}`}
                      />
                    </div>

                    {/* Artwork code */}
                    <div className="col-span-2">
                      <label htmlFor={`aw-${r.id}`} className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-ds-ink-faint">
                        Artwork code
                      </label>
                      <input
                        id={`aw-${r.id}`}
                        type="text"
                        value={st.artworkCode}
                        onChange={(e) => updateItem(r.id, { artworkCode: e.target.value })}
                        placeholder="e.g. AW-2024-001"
                        disabled={unifiedMode}
                        className={`w-full rounded-ds-sm border border-ds-line/50 px-2.5 py-1.5 text-[13px] outline-none transition ${
                          unifiedMode
                            ? 'cursor-not-allowed bg-ds-elevated/10 text-ds-ink-faint opacity-70'
                            : 'bg-ds-elevated/30 text-ds-ink focus:border-ds-brand/60 focus:ring-1 focus:ring-ds-brand/30'
                        } ${mono}`}
                      />
                    </div>

                    {/* UPS from planning */}
                    <div>
                      <label htmlFor={`ups-${r.id}`} className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-ds-ink-faint">
                        UPS (planning)
                      </label>
                      <input
                        id={`ups-${r.id}`}
                        type="number"
                        min={1}
                        step={1}
                        value={st.ups}
                        onChange={(e) => updateItem(r.id, { ups: e.target.value })}
                        placeholder="e.g. 2"
                        className={`w-full rounded-ds-sm border border-ds-line/50 bg-ds-elevated/30 px-2.5 py-1.5 text-[13px] text-ds-ink outline-none transition focus:border-ds-brand/60 focus:ring-1 focus:ring-ds-brand/30 ${mono}`}
                      />
                    </div>
                  </div>

                  {/* Colour controls aligned with Full edit */}
                  <div className="mt-3 rounded border border-ds-line/35 bg-ds-elevated/20 p-2.5">
                    <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-ds-ink-faint">Colours (as full edit)</p>
                    <div className="mb-2 flex flex-wrap gap-3">
                      {[
                        ['standardC', 'C'],
                        ['standardM', 'M'],
                        ['standardY', 'Y'],
                        ['standardK', 'K'],
                      ].map(([key, label]) => (
                        <label key={key} className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ds-ink-muted">
                          <input
                            type="checkbox"
                            checked={st[key as keyof ItemState] as boolean}
                            onChange={(e) => updateItem(r.id, { [key]: e.target.checked } as Partial<ItemState>)}
                            className="h-4 w-4 rounded border-ds-line accent-ds-brand"
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                    <div className="mb-2 flex items-center gap-3">
                      <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ds-ink-muted">
                        <input
                          type="checkbox"
                          checked={st.pantoneEnabled}
                          onChange={(e) => updateItem(r.id, { pantoneEnabled: e.target.checked })}
                          className="h-4 w-4 rounded border-ds-line accent-ds-brand"
                        />
                        Pantone
                      </label>
                      {st.pantoneEnabled ? (
                        <input
                          type="number"
                          min={1}
                          max={3}
                          value={st.numberOfPantones}
                          onChange={(e) => updateItem(r.id, { numberOfPantones: e.target.value })}
                          placeholder="No."
                          className={`h-8 w-20 rounded border border-ds-line/50 bg-ds-elevated/30 px-2 text-[12px] text-ds-ink ${mono}`}
                        />
                      ) : null}
                    </div>
                    {st.pantoneEnabled ? (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        {(['pantone1', 'pantone2', 'pantone3'] as const).map((k, i) => (
                          <input
                            key={k}
                            type="text"
                            value={st[k]}
                            onChange={(e) => updateItem(r.id, { [k]: e.target.value } as Partial<ItemState>)}
                            placeholder={`P${i + 1}`}
                            className={`h-8 w-full rounded border border-ds-line/50 bg-ds-elevated/30 px-2 text-[12px] text-ds-ink ${mono}`}
                          />
                        ))}
                      </div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-3">
                      <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ds-ink-muted">
                        <input
                          type="checkbox"
                          checked={st.dripOffPlate}
                          onChange={(e) => updateItem(r.id, { dripOffPlate: e.target.checked })}
                          className="h-4 w-4 rounded border-ds-line accent-ds-brand"
                        />
                        Drip-off plate
                      </label>
                      <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ds-ink-muted">
                        <input
                          type="checkbox"
                          checked={st.spotUvPlate}
                          onChange={(e) => updateItem(r.id, { spotUvPlate: e.target.checked })}
                          className="h-4 w-4 rounded border-ds-line accent-ds-brand"
                        />
                        Spot UV plate
                      </label>
                    </div>
                  </div>

                  <div className="mt-3">
                    <label htmlFor={`remarks-${r.id}`} className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-ds-ink-faint">
                      Special remarks
                    </label>
                    <textarea
                      id={`remarks-${r.id}`}
                      value={st.specialRemarks}
                      onChange={(e) => updateItem(r.id, { specialRemarks: e.target.value })}
                      rows={2}
                      placeholder="Enter special remarks to carry forward"
                      className="w-full resize-y rounded-ds-sm border border-ds-line/50 bg-ds-elevated/30 px-2.5 py-1.5 text-[12px] text-ds-ink outline-none transition focus:border-ds-brand/60 focus:ring-1 focus:ring-ds-brand/30"
                    />
                  </div>

                  {/* Approvals row */}
                  <div className="mt-3 flex flex-wrap items-center gap-4">
                    <label className="flex cursor-pointer items-center gap-2 select-none">
                      <input
                        type="checkbox"
                        checked={st.customerApproval}
                        onChange={(e) => updateItem(r.id, { customerApproval: e.target.checked })}
                        className="h-4 w-4 rounded border-ds-line accent-ds-brand"
                      />
                      <span className="text-[12px] text-ds-ink-muted">Customer approval (pharma)</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 select-none">
                      <input
                        type="checkbox"
                        checked={st.qaTextApproval}
                        onChange={(e) => updateItem(r.id, { qaTextApproval: e.target.checked })}
                        className="h-4 w-4 rounded border-ds-line accent-ds-brand"
                      />
                      <span className="text-[12px] text-ds-ink-muted">QA text / shade card approval</span>
                    </label>
                    <div className="ml-auto flex items-center gap-2">
                      <span className="text-[11px] text-ds-ink-faint">Designer: {designerName}</span>
                      <button
                        type="button"
                        disabled={isSaving}
                        onClick={() => void saveItem(r)}
                        className="inline-flex items-center gap-1 rounded-ds-sm border border-ds-brand/40 bg-ds-brand/10 px-3 py-1 text-[12px] font-semibold text-ds-brand transition hover:bg-ds-brand/20 disabled:opacity-40"
                      >
                        <Pencil className="h-3 w-3" aria-hidden />
                        {isSaving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Footer note */}
        <div className="space-y-1">
          <p className="text-center text-[11px] text-ds-ink-faint">
            All items above belong to the same gang print group. Use "Full edit" to access advanced options per item.
          </p>
          <p className="text-center text-[11px] text-ds-ink-muted">
            {savingGroup || saving.size > 0
              ? 'Saving…'
              : dirty
                ? 'Unsaved changes'
                : lastSavedAt
                  ? `Saved at ${lastSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                  : 'No pending changes'}
          </p>
        </div>
      </div>
    </SlideOverPanel>
  )
}
