'use client'

import { Fragment, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from '@/store/toastStore'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  FileDown,
  FileText,
  ImageOff,
  Layers,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Star,
  User,
  X,
} from 'lucide-react'
import { parseDesignerCommand } from '@/lib/designer-command'
import {
  AW_PO_STATUS,
  batchProgressSegments,
  readAwPoStatus,
  totalContractBatches,
} from '@/lib/aw-queue-spec'
import { DEFAULT_PREPRESS_AUDIT_LEAD } from '@/lib/pre-press-defaults'
import {
  INDUSTRIAL_PRIORITY_ROW_CLASS,
  INDUSTRIAL_PRIORITY_STAR_ICON_CLASS,
} from '@/lib/industrial-priority-ui'
import {
  broadcastIndustrialPriorityChange,
  INDUSTRIAL_PRIORITY_EVENT,
} from '@/lib/industrial-priority-sync'
import { PLANNING_DESIGNERS, readPlanningCore, readPlanningMeta } from '@/lib/planning-decision-spec'
import { resolveSheetSize, resolveUps } from '@/lib/production-os-resolvers'
import { formatShortTimeAgo } from '@/lib/time-ago'
import { isEmbossingRequired } from '@/lib/emboss-conditions'
import {
  ACTION_PILL_NEUTRAL,
  ICON_BUTTON_BASE,
  ICON_BUTTON_TIGHT,
  PUSHED_CHIP_CLASS,
  STATUS_CHIP_BASE,
} from '@/components/design-system/tokens'
import { EnterpriseTableShell } from '@/components/ui/EnterpriseTableShell'
import { Button } from '@/components/design-system/Button'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'
import { AwGroupEditDrawer } from '@/components/designing/AwGroupEditDrawer'

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
  createdAt: string
  cartonName: string
  remarks?: string | null
  artworkCode?: string | null
  quantity: number
  paperType: string | null
  coatingType: string | null
  otherCoating?: string | null
  embossingLeafing: string | null
  gsm?: number | null
  cartonSize?: string | null
  setNumber: string | null
  planningStatus: string
  jobCardNumber: number | null
  specOverrides: SpecOverrides
  artworkPreviewUrl?: string | null
  po: {
    id: string
    poNumber: string
    status: string
    poDate: string
    isPriority?: boolean
    customer: { id: string; name: string; logoUrl?: string | null }
  }
  jobCard: {
    id: string
    jobCardNumber: number
    artworkApproved: boolean
    firstArticlePass: boolean
    finalQcPass: boolean
    qaReleased: boolean
    status: string
    fileUrl?: string | null
  } | null
  readiness: {
    hasSet: boolean
    hasJobCard: boolean
    artworkApproved: boolean
    artworkLocksCompleted?: number
    approvalsComplete?: boolean
    prePressFinalized?: boolean
    artworkStatusLabel?: string
    firstArticlePass: boolean
    readyForProduction: boolean
    planningForwarded?: boolean
    plateFlowStatus?: string | null
    pipelinePhase?: 'finalized' | 'revision' | 'awaiting_client' | 'drafting'
    revisionRequired?: boolean
  }
  directorPriority?: boolean
  directorHold?: boolean
  carton?: { gsm?: number | null } | null
  materialQueue?: {
    totalSheets: number
    boardType?: string | null
    gsm?: number | null
    ups?: number | null
    sheetLengthMm?: number | null
    sheetWidthMm?: number | null
  } | null
}

type Customer = { id: string; name: string; logoUrl?: string | null }
type User = { id: string; name: string }

/** AW queue designer column filter. */
type DesignerFilterValue = 'all' | 'unassigned' | string
type DrawerPushStep = 'plate' | 'die' | 'emboss' | 'shade' | 'jobCard'
type DrawerPushState = 'idle' | 'ok' | 'failed' | 'skipped'
type DrawerForm = {
  cartonName: string
  cartonSize: string
  quantity: string
  sheetSize: string
  ups: string
  gsm: string
  boardType: string
  coating: string
  embossing: string
  colorSpec: string
  setNumber: string
  artworkCode: string
  dieNumber: string
  embossBlockNumber: string
}

const mono = 'font-designing-queue tabular-nums tracking-tight'
const PREPRESS_AUDIT_LEAD = DEFAULT_PREPRESS_AUDIT_LEAD
const BRAND_ORANGE = '#2563eb'

function daysInQueue(createdAtIso: string): number {
  const d = new Date(createdAtIso)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const t = new Date()
  const end = new Date(t.getFullYear(), t.getMonth(), t.getDate())
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000))
}

function ageClass(days: number): string {
  if (days <= 3) return 'text-[var(--success)]'
  if (days <= 7) return 'text-ds-warning'
  return 'text-[var(--error)] animate-po-age-alert'
}

function formatAwModalDate(value?: string | null): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function fileNameFromUrl(value?: string | null): string {
  if (!value) return ''
  try {
    const url = new URL(value, 'http://local')
    const tail = url.pathname.split('/').filter(Boolean).pop()
    return tail ? decodeURIComponent(tail) : 'Artwork file'
  } catch {
    const tail = value.split('/').filter(Boolean).pop()
    return tail ? decodeURIComponent(tail) : 'Artwork file'
  }
}

function pipelineBadge(phase: Row['readiness']['pipelinePhase']) {
  const base = `${STATUS_CHIP_BASE} gap-1 ring-1`
  switch (phase) {
    case 'finalized':
      return {
        label: 'Finalized',
        className: `${base} bg-[var(--success-bg)] text-[var(--success)] ring-[var(--success)]/35 dark:bg-[var(--success-bg)] dark:text-[var(--success)]`,
        pulse: false,
      }
    case 'revision':
      return {
        label: 'Revision required',
        className: `${base} bg-[var(--error-bg)] text-[var(--error)] ring-[var(--error)]/30 dark:bg-[var(--error-bg)] dark:text-[var(--error)]`,
        pulse: false,
      }
    case 'awaiting_client':
      return {
        label: 'Awaiting client',
        className: `${base} bg-[var(--info-bg)] text-[var(--info)] ring-[var(--info)]/30 dark:bg-[var(--info-bg)] dark:text-[var(--info)]`,
        pulse: true,
      }
    default:
      return {
        label: 'Drafting',
        className: `${base} bg-ds-elevated/30 text-ds-ink ring-ds-line/40`,
        pulse: false,
      }
  }
}

function hashHue(name: string): number {
  const s = name.trim().toLowerCase()
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}

function customerInitial(name: string): string {
  const m = name.match(/[A-Za-z0-9]/)
  return m ? m[0].toUpperCase() : '?'
}

function CustomerAvatar({
  name,
  logoUrl,
}: {
  name: string
  logoUrl?: string | null
}) {
  const [broken, setBroken] = useState(false)
  const showLogo = logoUrl?.trim() && !broken
  const hue = hashHue(name)
  if (showLogo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl!.trim()}
        alt=""
        width={24}
        height={24}
        className="h-6 w-6 shrink-0 rounded-full object-cover ring-1 ring-ds-line/50"
        loading="lazy"
        onError={() => setBroken(true)}
      />
    )
  }
  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums ring-1 ring-ring/15"
      style={{
        backgroundColor: `hsl(${hue} 42% 28%)`,
        color: `hsl(${hue} 25% 94%)`,
      }}
      aria-hidden
    >
      {customerInitial(name)}
    </span>
  )
}

function ActionsCell({
  embossEnabled,
  onPushJobCard,
  onPushPlate,
  onPushEmboss,
  onPushShadeCard,
  onRecallPlanning,
  onDeleteRow,
  disablePushJobCard,
  disablePushPlate,
  disableRecall,
  pushJobCardLabel,
  pushPlateLabel,
  recallLabel,
}: {
  embossEnabled: boolean
  onPushJobCard: () => void
  onPushPlate: () => void
  onPushEmboss: () => void
  onPushShadeCard: () => void
  onRecallPlanning: () => void
  onDeleteRow: () => void
  disablePushJobCard?: boolean
  disablePushPlate?: boolean
  disableRecall?: boolean
  pushJobCardLabel?: string
  pushPlateLabel?: string
  recallLabel?: string
}) {
  const [hubsOpen, setHubsOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const recomputeMenuPosition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const menuWidth = 240
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight
    const margin = 8

    let left = rect.right - menuWidth
    if (left < margin) left = margin
    if (left + menuWidth > viewportW - margin) left = viewportW - menuWidth - margin

    let top = rect.bottom + 8
    const menuHeight = menuRef.current?.offsetHeight ?? 220
    if (top + menuHeight > viewportH - margin) {
      top = Math.max(margin, rect.top - menuHeight - 8)
    }

    setMenuPos({ top, left })
  }, [])

  useEffect(() => {
    if (!hubsOpen) return
    recomputeMenuPosition()

    const onDocPointer = (ev: PointerEvent) => {
      const t = ev.target as Node | null
      if (!t) return
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setHubsOpen(false)
    }

    const onEsc = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setHubsOpen(false)
    }

    const onViewportChange = () => recomputeMenuPosition()

    document.addEventListener('pointerdown', onDocPointer)
    document.addEventListener('keydown', onEsc)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      document.removeEventListener('pointerdown', onDocPointer)
      document.removeEventListener('keydown', onEsc)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [hubsOpen, recomputeMenuPosition])

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <button
        onClick={onPushJobCard}
        disabled={disablePushJobCard}
        className="h-7 whitespace-nowrap rounded-ds-sm bg-[var(--accent)] px-2.5 text-xs font-semibold text-white transition hover:bg-[var(--accent-hover)] disabled:opacity-40"
      >
        {pushJobCardLabel ?? 'Push Job Card'}
      </button>
      <button
        onClick={onDeleteRow}
        className="h-7 whitespace-nowrap rounded-ds-sm bg-[var(--error-bg)] px-2 text-xs font-semibold text-[var(--error)] hover:bg-[var(--error-bg)]/80 dark:text-[var(--error)]"
        title="Delete row"
      >
        Delete
      </button>

      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setHubsOpen((v) => !v)}
          className="h-7 whitespace-nowrap rounded-ds-sm px-2.5 text-xs font-semibold text-[var(--text-primary)] hover:bg-ds-elevated/60"
        >
          Push to Hubs ▾
        </button>
      </div>

      {hubsOpen && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              className="fixed w-[240px] rounded-ds-md bg-[var(--bg-elevated)] shadow-lg"
              style={{ top: menuPos.top, left: menuPos.left, zIndex: 9999 }}
            >
              <div className="p-2 flex flex-col gap-1">
                <button
                  onClick={() => {
                    onPushPlate()
                    setHubsOpen(false)
                  }}
                  disabled={disablePushPlate}
                  className="text-left px-3 py-2 rounded hover:bg-[var(--accent)]/10 disabled:opacity-40"
                >
                  {pushPlateLabel ?? 'Plates'}
                </button>

                <button
                  onClick={() => {
                    onPushEmboss()
                    setHubsOpen(false)
                  }}
                  disabled={!embossEnabled}
                  className={`text-left px-3 py-2 rounded ${
                    embossEnabled
                      ? 'text-[var(--accent)] hover:bg-[var(--accent)]/10'
                      : 'opacity-40 cursor-not-allowed'
                  }`}
                >
                  Emboss
                </button>

                <button
                  onClick={() => {
                    onPushShadeCard()
                    setHubsOpen(false)
                  }}
                  className="text-left px-3 py-2 rounded hover:bg-[var(--accent)]/10"
                >
                  Shade Card
                </button>

                <div className="my-2" />

                <button
                  onClick={() => {
                    onRecallPlanning()
                    setHubsOpen(false)
                  }}
                  disabled={disableRecall}
                  className="text-left px-3 py-2 rounded text-[var(--warning)] hover:bg-[var(--warning-bg)] disabled:opacity-40"
                >
                  Send Back to Planning
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}

      <button
        onClick={onRecallPlanning}
        disabled={disableRecall}
        className="h-7 whitespace-nowrap rounded-ds-sm bg-[var(--warning-bg)] px-2.5 text-xs font-semibold text-[var(--warning)] hover:bg-[var(--warning-bg)]/80 disabled:opacity-40"
      >
        {recallLabel ?? 'Send Back'}
      </button>
    </div>
  )
}

function NeonCommandFilterTrigger({
  searchQuery,
  onQueryChange,
  onClearQuery,
}: {
  searchQuery: string
  onQueryChange: (v: string) => void
  onClearQuery: () => void
}) {
  const inputCls = `h-9 w-full min-w-[14rem] rounded border border-ds-brand/35 bg-ds-main/95 px-9 pr-3 text-sm font-medium text-ds-ink shadow-sm transition focus:border-ds-brand focus:outline-none focus:ring-2 focus:ring-ds-brand/30 ${mono}`
  return (
    <div className="flex w-full items-stretch gap-2">
      <label className="group relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ds-ink-faint" aria-hidden />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search carton or PO #"
          className={inputCls}
          aria-label="Search carton or PO number in AW queue"
        />
      </label>
      {searchQuery.trim().length >= 2 ? (
        <button
          type="button"
          onClick={() => onClearQuery()}
          className={`shrink-0 rounded border border-ds-line/60 bg-ds-main px-2.5 text-xs text-ds-ink-faint hover:border-ds-brand/40 hover:text-ds-brand transition-colors ${mono}`}
          title="Clear filter"
          aria-label="Clear filter"
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  )
}

function ArtworkPreviewCell({
  url,
  alt,
  onOpenLightbox,
}: {
  url: string | null
  alt: string
  onOpenLightbox: (src: string) => void
}) {
  const [broken, setBroken] = useState(false)
  const [peek, setPeek] = useState(false)

  const thumbClass =
    'h-12 w-12 shrink-0 overflow-hidden rounded-[4px] bg-background'

  if (!url || broken) {
    return (
      <div
        className={`flex ${thumbClass} items-center justify-center text-ds-ink-faint`}
        title="No preview"
      >
        <ImageOff className="h-4 w-4" aria-hidden />
      </div>
    )
  }
  return (
    <>
      <button
        type="button"
        className={`group relative ${thumbClass} focus:outline-none focus:ring-2 focus:ring-ds-warning/35`}
        title="Hover for magnified preview · click for full screen"
        onMouseEnter={() => setPeek(true)}
        onMouseLeave={() => setPeek(false)}
        onFocus={() => setPeek(true)}
        onBlur={() => setPeek(false)}
        onClick={() => onOpenLightbox(url)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpenLightbox(url)
          }
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={alt}
          className="h-full w-full object-cover transition duration-150 group-hover:brightness-110"
          loading="lazy"
          onError={() => setBroken(true)}
        />
      </button>
      {peek && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="pointer-events-none fixed inset-0 z-[85] flex items-center justify-center bg-background/35 backdrop-blur-[2px]"
              aria-hidden
            >
              <div className="h-[144px] w-[144px] overflow-hidden rounded-[4px] shadow-2xl ring-1 ring-ring/50">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" className="h-full w-full object-cover" />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

type AuditSortKey = 'days' | 'qty' | 'customer' | 'po'

function rowIndustrialPriority(r: Row): boolean {
  return r.po.isPriority === true || r.directorPriority === true
}

function isAwPushedRow(r: Row): boolean {
  return !!r.readiness?.prePressFinalized
}

function hasLinkedJobCard(r: Row): boolean {
  return !!r.jobCard?.id
}

function isAwCompletedRow(r: Row): boolean {
  return isAwPushedRow(r) && hasLinkedJobCard(r)
}

function isAwJobCardOnlyRow(r: Row): boolean {
  return !isAwPushedRow(r) && hasLinkedJobCard(r)
}

function awJobCardState(r: Row): 'ready' | 'pending' {
  return isAwCompletedRow(r) ? 'ready' : 'pending'
}

function canPushJobCardRow(r: Row): boolean {
  const spec = (r.specOverrides || {}) as Record<string, unknown>
  const rowClosed = readAwPoStatus(spec) === AW_PO_STATUS.CLOSED
  return !rowClosed && !hasLinkedJobCard(r)
}

function pushJobCardBlockReason(r: Row): string | null {
  const spec = (r.specOverrides || {}) as Record<string, unknown>
  const rowClosed = readAwPoStatus(spec) === AW_PO_STATUS.CLOSED
  if (rowClosed) return 'row is closed'
  if (hasLinkedJobCard(r)) return 'job card already created'
  return null
}

function canRecallPlanningRow(r: Row, spec: Record<string, unknown>): boolean {
  const machineAllocated = !!String(spec.machineId || '').trim()
  if (machineAllocated) return false
  if (['in_production', 'closed', 'pending'].includes(r.planningStatus)) return false
  return true
}

function canFinalizePlateHubRow(r: Row): boolean {
  void r
  return true
}

function plateHubDisabledReason(r: Row): string {
  void r
  return 'Push to Plate Hub'
}

function normalizePlateSetNumber(setRaw: string): string | null {
  const raw = String(setRaw || '').trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) return raw
  const digits = raw.match(/\d+/g)?.join('') || ''
  return digits || null
}

function ensurePlateDesignerCommand(
  row: Pick<Row, 'embossingLeafing'>,
  raw: unknown,
): ReturnType<typeof parseDesignerCommand> {
  const dc = parseDesignerCommand(raw)
  return {
    ...dc,
    dieSource: dc.dieSource ?? 'new',
    setType: dc.setType || 'new_set',
    embossSource: isEmbossingRequired(row.embossingLeafing) ? (dc.embossSource ?? 'new') : dc.embossSource,
  }
}

type PlateJobOrchestrationResult = {
  plate: 'ok' | 'duplicate' | 'fail'
  jobCard: 'ok' | 'fail'
  plateError?: string
  jobCardError?: string
}

type JobCardOnlyResult = {
  ok: boolean
  error?: string
  idempotent?: boolean
  errorCode?: string
  overrideAllowed?: boolean
}

/** Plate Hub triage + job card creation in parallel (no dependency between legs). */
async function pushPlateHubAndCreateJobCardRow(r: Row): Promise<PlateJobOrchestrationResult> {
  const setN = (r.setNumber || '').trim()
  const normalizedSetN = normalizePlateSetNumber(setN)
  const aw = (r.artworkCode || '').trim()
  // AW queue no longer blocks push actions; keep safe fallbacks for missing inputs.
  const pushSetNumber = normalizedSetN ?? '1'
  const pushAwCode = aw || `AW-${r.id.slice(0, 8).toUpperCase()}`
  const spec = r.specOverrides || {}
  const designerId = (spec.assignedDesignerId as string | undefined) || null
  const designerCommand = ensurePlateDesignerCommand(r, spec.designerCommand)
  const mqSheets = r.materialQueue?.totalSheets
  const requiredSheets = Math.max(
    1,
    Math.ceil(
      mqSheets != null && mqSheets > 0
        ? mqSheets
        : Math.max(1, Number(r.quantity) || 0) / 4,
    ),
  )

  const [plateRes, jcRes] = await Promise.all([
    fetch('/api/plate-hub', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        poLineId: r.id,
        setNumber: pushSetNumber,
        awCode: pushAwCode,
        customerApproval: true,
        qaTextCheckApproval: true,
        assignedDesignerId: designerId,
        designerCommand,
        status: 'PUSH_TO_PRODUCTION_QUEUE',
      }),
    }),
    fetch('/api/job-cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        poLineItemId: r.id,
        requiredSheets,
        wastageSheets: 0,
        idempotentIfExists: true,
        orchestrationSource: 'aw_orchestration',
      }),
    }),
  ])

  const plateJson = (await plateRes.json().catch(() => ({}))) as { error?: string }
  let plate: PlateJobOrchestrationResult['plate'] = 'fail'
  if (plateRes.ok) plate = 'ok'
  else if (plateRes.status === 409) plate = 'duplicate'
  else plate = 'fail'
  const plateError = plate === 'fail' ? plateJson.error || `Plate Hub (${plateRes.status})` : undefined

  const jcJson = (await jcRes.json().catch(() => ({}))) as { error?: string; idempotent?: boolean }
  let jobCard: PlateJobOrchestrationResult['jobCard'] = 'fail'
  if (jcRes.ok && (jcRes.status === 201 || jcRes.status === 200)) jobCard = 'ok'
  else jobCard = 'fail'
  const jobCardError = jobCard === 'fail' ? jcJson.error || `Job card (${jcRes.status})` : undefined

  return { plate, jobCard, plateError, jobCardError }
}

async function pushJobCardOnlyRow(
  r: Row,
  opts?: { toolingOverrideTrial?: boolean; toolingOverrideReason?: string },
): Promise<JobCardOnlyResult> {
  const mqSheets = r.materialQueue?.totalSheets
  const requiredSheets = Math.max(
    1,
    Math.ceil(
      mqSheets != null && mqSheets > 0
        ? mqSheets
        : Math.max(1, Number(r.quantity) || 0) / 4,
    ),
  )
  const res = await fetch('/api/job-cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      poLineItemId: r.id,
      requiredSheets,
      wastageSheets: 0,
      idempotentIfExists: true,
      orchestrationSource: 'aw_orchestration',
      toolingOverrideTrial: opts?.toolingOverrideTrial ?? true,
      toolingOverrideReason:
        opts?.toolingOverrideReason || 'Trial mode override from AW queue',
    }),
  })
  const json = (await res.json().catch(() => ({}))) as {
    error?: string
    idempotent?: boolean
    errorCode?: string
    overrideAllowed?: boolean
  }
  if (!res.ok) {
    return {
      ok: false,
      error: json.error || `Job card (${res.status})`,
      errorCode: json.errorCode,
      overrideAllowed: json.overrideAllowed === true,
    }
  }
  return { ok: true, idempotent: json.idempotent === true || res.status === 200 }
}

function canPushToolingHubRow(r: Row): boolean {
  const setN = (r.setNumber || '').trim()
  const aw = (r.artworkCode || '').trim()
  if (!setN || !aw) return false
  const spec = (r.specOverrides || {}) as Record<string, unknown>
  if (readAwPoStatus(spec) === AW_PO_STATUS.CLOSED) return false
  return !!resolveAwSheetSize(spec)
}

function resolveAwSheetSize(spec: Record<string, unknown>): string {
  const resolved = resolveSheetSize({ specOverrides: spec, spec })
  return resolved === '-' ? '' : resolved
}

function resolveAwSheetSizeFromRow(r: Row): string {
  const spec = (r.specOverrides || {}) as Record<string, unknown>
  const planningResolved = resolveSheetSize({
    ...(r as unknown as Record<string, unknown>),
    specOverrides: spec,
    spec,
  } as Record<string, unknown>)
  if (planningResolved && planningResolved !== '-') return planningResolved
  return resolveAwSheetSize(spec) || '-'
}

function hasToolingSheetSize(r: Row, spec: Record<string, unknown>): boolean {
  const resolved = resolveAwSheetSizeFromRow(r)
  if (resolved && resolved !== '-') return true
  return !!resolveAwSheetSize(spec)
}

function resolvePlanningDesignerName(
  spec: Record<string, unknown>,
  userById: Record<string, User>,
): string {
  const direct = typeof spec.planningDesignerDisplayName === 'string' ? spec.planningDesignerDisplayName.trim() : ''
  if (direct) return direct
  const core = readPlanningCore(spec)
  if (core.designerKey) return PLANNING_DESIGNERS[core.designerKey] || core.designerKey
  const meta = readPlanningMeta(spec)
  const metaDesigner = typeof meta.designer === 'string' ? meta.designer.trim() : ''
  if (metaDesigner) return metaDesigner
  const assignedDesignerId = typeof spec.assignedDesignerId === 'string' ? spec.assignedDesignerId : ''
  if (assignedDesignerId) return userById[assignedDesignerId]?.name ?? ''
  return ''
}

function rowUpsDisplay(spec: Record<string, unknown>): string {
  const fromResolver = resolveUps({ specOverrides: spec, spec })
  if (fromResolver != null) return String(fromResolver)
  const core = readPlanningCore(spec)
  const meta = readPlanningMeta(spec)
  const raw = spec.ups ?? spec.numberOfUps ?? core.ups ?? meta.ups
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) return String(Math.floor(raw))
  return '—'
}

function resolveAwGsmFromRow(r: Row): number | null {
  const spec = (r.specOverrides || {}) as Record<string, unknown>
  const candidates: unknown[] = [
    spec.gsm,
    r.gsm,
    r.materialQueue?.gsm,
    r.carton?.gsm,
  ]
  for (const value of candidates) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

function rowBatchTypeDisplay(spec: Record<string, unknown>): string {
  const coreRaw = readPlanningCore(spec) as Record<string, unknown>
  const meta = readPlanningMeta(spec)
  const b =
    (typeof coreRaw.batchType === 'string' && coreRaw.batchType.trim()) ||
    (typeof spec.batchType === 'string' && spec.batchType.trim()) ||
    (typeof meta.batchMode === 'string' && meta.batchMode.trim())
  return b || '—'
}

function SortHeader({
  label,
  column,
  activeKey,
  dir,
  onSort,
  className = '',
}: {
  label: string
  column: AuditSortKey
  activeKey: AuditSortKey | null
  dir: 'asc' | 'desc'
  onSort: (c: AuditSortKey) => void
  className?: string
}) {
  const active = activeKey === column
  return (
    <th className={`px-3 py-2 ${className}`}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-0.5 ${mono} text-xs font-medium uppercase tracking-wider text-ds-ink-faint hover:text-neutral-700 dark:text-ds-ink-muted dark:hover:text-ds-ink`}
      >
        {label}
        <span className="inline-flex flex-col -space-y-1.5" aria-hidden>
          <ChevronUp
            className={`h-3 w-3 shrink-0 ${active && dir === 'asc' ? 'text-[var(--info)] dark:text-ds-warning' : 'text-ds-ink-faint dark:text-ds-ink-faint'}`}
            strokeWidth={2}
          />
          <ChevronDown
            className={`h-3 w-3 shrink-0 ${active && dir === 'desc' ? 'text-[var(--info)] dark:text-ds-warning' : 'text-ds-ink-faint dark:text-ds-ink-faint'}`}
            strokeWidth={2}
          />
        </span>
      </button>
    </th>
  )
}

function LightboxModal({ src, alt, onClose }: { src: string | null; alt: string; onClose: () => void }) {
  if (!src) return null
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-background/90 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="Artwork preview"
      onClick={onClose}
    >
      <button
        type="button"
        className="absolute right-3 top-3 rounded-ds-md bg-card p-2 text-ds-ink-muted hover:text-foreground"
        onClick={onClose}
        aria-label="Close preview"
      >
        <X className="h-5 w-5" />
      </button>
      <div
        className="max-h-[90vh] max-w-5xl overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="max-h-[85vh] w-auto max-w-full object-contain shadow-2xl ring-1 ring-ring/20" />
      </div>
    </div>
  )
}

export default function DesigningQueuePage() {
  const router = useRouter()
  const [awSearchQuery, setAwSearchQuery] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [customerId, setCustomerId] = useState('')
  const [finalizingId, setFinalizingId] = useState<string | null>(null)
  const [jobCardPushingId, setJobCardPushingId] = useState<string | null>(null)
  const [finalizingGroupId, setFinalizingGroupId] = useState<string | null>(null)
  const [forwardingId, setForwardingId] = useState<string | null>(null)
  const [recallingPlanningId, setRecallingPlanningId] = useState<string | null>(null)
  const [recallingGroupId, setRecallingGroupId] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const [sortKey, setSortKey] = useState<AuditSortKey | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [priorityBusyPoId, setPriorityBusyPoId] = useState<string | null>(null)
  const [myJobsOnly, setMyJobsOnly] = useState(false)
  const [awTab, setAwTab] = useState<'all' | 'my' | 'ready' | 'pending'>('all')
  const [designerFilter, setDesignerFilter] = useState<DesignerFilterValue>('all')
  const [expandedAwGroups, setExpandedAwGroups] = useState<Set<string>>(new Set())
  const [activeGroupEdit, setActiveGroupEdit] = useState<{ groupId: string; rows: Row[] } | null>(null)
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set())
  const [bulkPushing, setBulkPushing] = useState(false)
  const [bulkToolingPushing, setBulkToolingPushing] = useState<null | 'DIE' | 'BLOCK'>(null)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [hubsMenuOpen, setHubsMenuOpen] = useState(false)
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null)
  const [activeRowDrawer, setActiveRowDrawer] = useState<Row | null>(null)
  const [drawerSaving, setDrawerSaving] = useState(false)
  const [drawerPushAllBusy, setDrawerPushAllBusy] = useState(false)
  const [drawerPushStates, setDrawerPushStates] = useState<Record<DrawerPushStep, DrawerPushState>>({
    plate: 'idle',
    die: 'idle',
    emboss: 'idle',
    shade: 'idle',
    jobCard: 'idle',
  })
  const [drawerPushErrors, setDrawerPushErrors] = useState<Partial<Record<DrawerPushStep, string>>>({})
  const [drawerForm, setDrawerForm] = useState<DrawerForm | null>(null)
  const [showDiscardModal, setShowDiscardModal] = useState(false)
  const [showPushAllConfirm, setShowPushAllConfirm] = useState(false)
  const [highlightMissingFields, setHighlightMissingFields] = useState(false)
  const drawerFieldRefs = useRef<Partial<Record<keyof DrawerForm, HTMLInputElement | null>>>({})
  const loadInFlightKey = useRef<string | null>(null)
  const customersLoadedRef = useRef(false)
  const usersLoadedRef = useRef(false)

  const focusDrawerField = useCallback((field: keyof DrawerForm) => {
    const input = drawerFieldRefs.current[field]
    input?.focus()
    input?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [])

  const openRowDrawerFromClick = useCallback(
    (e: MouseEvent<HTMLElement>, row: Row) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('button,input,select,textarea,a,label,[data-no-row-open="1"]')) return
      setFocusedRowId(row.id)
      setActiveRowDrawer(row)
    },
    [],
  )

  const openRowModal = useCallback((row: Row) => {
    setFocusedRowId(row.id)
    setActiveRowDrawer(row)
  }, [])

  const autoSetNumber = useCallback((rowId: string) => {
    const seed = Math.abs(
      rowId
        .split('')
        .slice(0, 8)
        .reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, Date.now() % 1000),
    )
    return String((seed % 9000) + 1000)
  }, [])

  const buildInitialDrawerForm = useCallback(
    (row: Row): DrawerForm => {
      const spec = (row.specOverrides || {}) as Record<string, unknown>
      const resolvedSheet = resolveAwSheetSizeFromRow(row)
      const resolvedUps = rowUpsDisplay(spec)
      const resolvedGsm = resolveAwGsmFromRow(row)
      const colorSpecCandidate =
        (typeof spec.colorSpec === 'string' && spec.colorSpec.trim()) ||
        (typeof spec.colourSpec === 'string' && spec.colourSpec.trim()) ||
        (typeof spec.colour === 'string' && spec.colour.trim()) ||
        (typeof spec.color === 'string' && spec.color.trim()) ||
        ''

      return {
        cartonName: row.cartonName || '',
        cartonSize: row.cartonSize || '',
        quantity: String(row.quantity || ''),
        sheetSize: resolvedSheet === '-' ? '' : resolvedSheet,
        ups: resolvedUps === '—' ? '' : resolvedUps,
        gsm: resolvedGsm != null ? String(resolvedGsm) : '',
        boardType: row.paperType || '',
        coating: row.coatingType || row.otherCoating || '',
        embossing: row.embossingLeafing || '',
        colorSpec: colorSpecCandidate,
        setNumber: row.setNumber || autoSetNumber(row.id),
        artworkCode: row.artworkCode || '',
        dieNumber: String(spec.dieNumber || ''),
        embossBlockNumber: String(spec.embossBlockNumber || ''),
      }
    },
    [autoSetNumber],
  )

  useEffect(() => {
    if (!activeRowDrawer) {
      setDrawerForm(null)
      setDrawerPushStates({ plate: 'idle', die: 'idle', emboss: 'idle', shade: 'idle', jobCard: 'idle' })
      setDrawerPushErrors({})
      setShowPushAllConfirm(false)
      setHighlightMissingFields(false)
      return
    }
    setFocusedRowId(activeRowDrawer.id)
    setDrawerForm(buildInitialDrawerForm(activeRowDrawer))
  }, [activeRowDrawer, buildInitialDrawerForm])

  const drawerHasUnsavedChanges = useMemo(() => {
    if (!activeRowDrawer || !drawerForm) return false
    return JSON.stringify(drawerForm) !== JSON.stringify(buildInitialDrawerForm(activeRowDrawer))
  }, [activeRowDrawer, buildInitialDrawerForm, drawerForm])

  const closeActiveRowModal = useCallback(() => {
    if (drawerHasUnsavedChanges) {
      setShowDiscardModal(true)
      return
    }
    setActiveRowDrawer(null)
  }, [drawerHasUnsavedChanges])

  const discardActiveRowChanges = useCallback(() => {
    setShowDiscardModal(false)
    setActiveRowDrawer(null)
  }, [])

  useEffect(() => {
    if (!activeRowDrawer) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (!drawerSaving) void saveDrawerDetails()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // saveDrawerDetails intentionally preserves the existing handler shape in this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRowDrawer, drawerForm, drawerSaving])

  async function saveDrawerDetails() {
    if (!activeRowDrawer || !drawerForm) return
    setDrawerSaving(true)
    try {
      const currentSpec = ((activeRowDrawer.specOverrides || {}) as Record<string, unknown>) || {}
      const payload = {
        cartonName: drawerForm.cartonName.trim() || activeRowDrawer.cartonName,
        cartonSize: drawerForm.cartonSize.trim() || null,
        quantity: Number(drawerForm.quantity) > 0 ? Number(drawerForm.quantity) : activeRowDrawer.quantity,
        paperType: drawerForm.boardType.trim() || null,
        coatingType: drawerForm.coating.trim() || null,
        embossingLeafing: drawerForm.embossing.trim() || null,
        setNumber: drawerForm.setNumber.trim() || null,
        artworkCode: drawerForm.artworkCode.trim() || null,
        gsm: Number.isFinite(Number(drawerForm.gsm)) ? Number(drawerForm.gsm) : null,
        specOverrides: {
          ...currentSpec,
          sheetSize: drawerForm.sheetSize.trim() || null,
          actualSheetSize: drawerForm.sheetSize.trim() || null,
          ups: Number.isFinite(Number(drawerForm.ups)) && Number(drawerForm.ups) > 0 ? Number(drawerForm.ups) : null,
          colorSpec: drawerForm.colorSpec.trim() || null,
          dieNumber: drawerForm.dieNumber.trim() || null,
          embossBlockNumber: drawerForm.embossBlockNumber.trim() || null,
        },
      }
      const res = await fetch(`/api/planning/po-lines/${activeRowDrawer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Failed to save')
      setActiveRowDrawer((prev) =>
        prev
          ? {
              ...prev,
              cartonName: payload.cartonName,
              cartonSize: payload.cartonSize,
              quantity: payload.quantity,
              paperType: payload.paperType,
              coatingType: payload.coatingType,
              embossingLeafing: payload.embossingLeafing,
              setNumber: payload.setNumber,
              artworkCode: payload.artworkCode,
              gsm: payload.gsm,
              specOverrides: payload.specOverrides as SpecOverrides,
            }
          : prev,
      )
      toast.success('AW details updated')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save details')
    } finally {
      setDrawerSaving(false)
    }
  }

  function buildMergedRowFromDrawerForm(): Row | null {
    if (!activeRowDrawer || !drawerForm) return null
    const mergedSpec = {
      ...(((activeRowDrawer.specOverrides || {}) as Record<string, unknown>) || {}),
      sheetSize: drawerForm.sheetSize.trim() || null,
      actualSheetSize: drawerForm.sheetSize.trim() || null,
      ups: Number.isFinite(Number(drawerForm.ups)) && Number(drawerForm.ups) > 0 ? Number(drawerForm.ups) : null,
      dieNumber: drawerForm.dieNumber.trim() || null,
      embossBlockNumber: drawerForm.embossBlockNumber.trim() || null,
      colorSpec: drawerForm.colorSpec.trim() || null,
    }
    return {
      ...activeRowDrawer,
      cartonSize: drawerForm.cartonSize.trim() || activeRowDrawer.cartonSize,
      setNumber: drawerForm.setNumber.trim() || activeRowDrawer.setNumber,
      artworkCode: drawerForm.artworkCode.trim() || activeRowDrawer.artworkCode,
      paperType: drawerForm.boardType.trim() || activeRowDrawer.paperType,
      coatingType: drawerForm.coating.trim() || activeRowDrawer.coatingType,
      embossingLeafing: drawerForm.embossing.trim() || activeRowDrawer.embossingLeafing,
      specOverrides: mergedSpec,
    }
  }

  async function dispatchHubStep(row: Row, step: DrawerPushStep): Promise<{ ok: boolean; error?: string }> {
    try {
      if (step === 'shade') {
        window.open('/hub/shade-card-hub', '_blank', 'noopener,noreferrer')
        return { ok: true }
      }

      if (step === 'jobCard') {
        const jc = await pushJobCardOnlyRow(row)
        return jc.ok ? { ok: true } : { ok: false, error: jc.error || 'Job card push failed' }
      }

      const spec = (row.specOverrides || {}) as Record<string, unknown>
      const actualSheetSize = resolveAwSheetSizeFromRow(row)
      const upsRaw = spec.ups ?? spec.numberOfUps
      const ups = typeof upsRaw === 'number' && Number.isFinite(upsRaw) && upsRaw >= 1 ? Math.floor(upsRaw) : 1
      const setN = (row.setNumber || '').trim()
      const aw = (row.artworkCode || '').trim()

      if (!setN) return { ok: false, error: 'Set number missing' }
      if (!aw) return { ok: false, error: 'Artwork code missing' }
      if (!actualSheetSize || actualSheetSize === '-') return { ok: false, error: 'Sheet size missing' }

      if (step === 'plate') {
        const designerCommand = ensurePlateDesignerCommand(row, spec.designerCommand)
        const body = {
          poLineId: row.id,
          setNumber: setN,
          awCode: aw,
          customerApproval: true,
          qaTextCheckApproval: true,
          assignedDesignerId:
            typeof spec.assignedDesignerId === 'string' && spec.assignedDesignerId.trim()
              ? spec.assignedDesignerId.trim()
              : null,
          designerCommand,
          status: 'PUSH_TO_PRODUCTION_QUEUE',
        }
        const res = await fetch('/api/plate-hub', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = (await res.json().catch(() => ({}))) as { error?: string; fields?: Record<string, string> }
        const fieldErrors = json.fields ? Object.values(json.fields).filter(Boolean).join(' • ') : ''
        return res.ok || res.status === 409
          ? { ok: true }
          : { ok: false, error: fieldErrors || json.error || 'Plate push failed' }
      }

      if (step === 'die') {
        const body = {
          toolType: 'DIE',
          awCode: aw,
          actualSheetSize,
          ups,
          jobId: row.id,
          setNumber: setN,
          source: 'NEW',
        }
        const res = await fetch('/api/tooling-hub/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        return res.ok ? { ok: true } : { ok: false, error: json.error || 'Die push failed' }
      }

      const body = {
        toolType: 'BLOCK',
        awCode: aw,
        actualSheetSize,
        blockType: String(row.embossingLeafing || 'Emboss').trim() || 'Emboss',
        cartonSize: row.cartonSize || undefined,
        jobId: row.id,
        setNumber: setN,
        source: 'NEW',
      }
      const res = await fetch('/api/tooling-hub/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      return res.ok ? { ok: true } : { ok: false, error: json.error || 'Emboss push failed' }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Step failed' }
    }
  }

  async function retryDrawerStep(step: DrawerPushStep) {
    const row = buildMergedRowFromDrawerForm()
    if (!row) return
    setDrawerPushStates((prev) => ({ ...prev, [step]: 'idle' }))
    const result = await dispatchHubStep(row, step)
    setDrawerPushStates((prev) => ({ ...prev, [step]: result.ok ? 'ok' : 'failed' }))
    setDrawerPushErrors((prev) => ({ ...prev, [step]: result.error }))
    if (result.ok) {
      toast.success(`${step} push completed`)
      await load()
    } else {
      toast.error(result.error || `${step} push failed`)
    }
  }

  async function pushAllFromDrawer() {
    if (!activeRowDrawer || !drawerForm) return
    setDrawerPushAllBusy(true)
    try {
      await saveDrawerDetails()
      const mergedRow = buildMergedRowFromDrawerForm()
      if (!mergedRow) return
      const embossNeeded = isEmbossingRequired(mergedRow.embossingLeafing)
      const nextStates: Record<DrawerPushStep, DrawerPushState> = {
        plate: 'idle',
        die: 'idle',
        emboss: embossNeeded ? 'idle' : 'skipped',
        shade: 'idle',
        jobCard: 'idle',
      }
      const nextErrors: Partial<Record<DrawerPushStep, string>> = {}
      for (const step of (['plate', 'die', 'emboss', 'shade', 'jobCard'] as DrawerPushStep[])) {
        if (step === 'emboss' && !embossNeeded) continue
        const result = await dispatchHubStep(mergedRow, step)
        nextStates[step] = result.ok ? 'ok' : 'failed'
        if (!result.ok) nextErrors[step] = result.error || `${step} push failed`
      }
      setDrawerPushStates(nextStates)
      setDrawerPushErrors(nextErrors)
      const failed = Object.entries(nextStates).filter(([, s]) => s === 'failed').map(([k]) => k)
      if (failed.length === 0) toast.success('Push All completed successfully')
      else toast.error(`Push All partial failure: ${failed.join(', ')}`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Push all failed')
    } finally {
      setDrawerPushAllBusy(false)
    }
  }

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ mode: 'compact' })
    if (customerId) qs.set('customerId', customerId)
    if (myJobsOnly) qs.set('myJobs', '1')
    const requestKey = qs.toString()
    if (loadInFlightKey.current === requestKey) return
    loadInFlightKey.current = requestKey
    try {
      const [custRes, usersRes, linesRes] = await Promise.all([
        customersLoadedRef.current ? Promise.resolve(null) : fetch('/api/masters/customers'),
        usersLoadedRef.current ? Promise.resolve(null) : fetch('/api/users'),
        fetch(`/api/designing/po-lines?${qs.toString()}`),
      ])
      const custJson = custRes ? await custRes.json() : null
      const usersJson = usersRes ? await usersRes.json() : null
      const json = await linesRes.json()
      if (custRes) {
        setCustomers(Array.isArray(custJson) ? custJson : [])
        customersLoadedRef.current = true
      }
      if (usersRes) {
        setUsers(Array.isArray(usersJson) ? usersJson : [])
        usersLoadedRef.current = true
      }
      setRows(Array.isArray(json) ? json : [])
    } catch {
      toast.error('Failed to load designing queue')
    } finally {
      if (loadInFlightKey.current === requestKey) loadInFlightKey.current = null
      setLoading(false)
    }
  }, [customerId, myJobsOnly])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const onPri = () => {
      void load()
    }
    window.addEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
    return () => window.removeEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
  }, [load])

  useEffect(() => {
    setMyJobsOnly(awTab === 'my')
  }, [awTab])

  const userById = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u])), [users])

  const planningDesignerOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) {
      const spec = (r.specOverrides || {}) as Record<string, unknown>
      const name = resolvePlanningDesignerName(spec, userById).trim()
      if (!name) continue
      const key = name.toLowerCase()
      if (!seen.has(key)) seen.set(key, name)
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b))
  }, [rows, userById])

  const filteredRows = useMemo(() => {
    let list = rows
    const q = awSearchQuery.trim().toLowerCase()
    if (q.length >= 2) {
      list = list.filter(
        (r) =>
          r.cartonName.toLowerCase().includes(q) ||
          r.po.poNumber.toLowerCase().includes(q),
      )
    }
    if (designerFilter === 'unassigned') {
      list = list.filter((r) => {
        const spec = (r.specOverrides || {}) as Record<string, unknown>
        return !resolvePlanningDesignerName(spec, userById)
      })
    } else if (designerFilter !== 'all') {
      const wanted = designerFilter.replace(/^planning:/, '').trim().toLowerCase()
      list = list.filter((r) => {
        const spec = (r.specOverrides || {}) as Record<string, unknown>
        return resolvePlanningDesignerName(spec, userById).trim().toLowerCase() === wanted
      })
    }
    if (awTab === 'ready') {
      list = list.filter((r) => awJobCardState(r) === 'ready')
    } else if (awTab === 'pending') {
      list = list.filter((r) => awJobCardState(r) === 'pending')
    }
    return list
  }, [rows, awSearchQuery, designerFilter, userById, awTab])

  const awFilterChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; onClear?: () => void }> = []
    if (awSearchQuery.trim()) {
      chips.push({ key: 'search', label: `Search: ${awSearchQuery.trim()}`, onClear: () => setAwSearchQuery('') })
    }
    if (designerFilter !== 'all') {
      chips.push({
        key: 'designer',
        label: `Designer: ${designerFilter === 'unassigned' ? 'Unassigned' : designerFilter.replace(/^planning:/, '')}`,
        onClear: () => setDesignerFilter('all'),
      })
    }
    if (customerId) {
      const c = customers.find((x) => x.id === customerId)
      chips.push({ key: 'customer', label: `Customer: ${c?.name || customerId}`, onClear: () => setCustomerId('') })
    }
    if (myJobsOnly) chips.push({ key: 'my-jobs', label: 'My jobs only', onClear: () => setMyJobsOnly(false) })
    return chips
  }, [awSearchQuery, designerFilter, customerId, myJobsOnly, customers])

  const cycleSort = useCallback((column: AuditSortKey) => {
    setSortKey((prev) => {
      if (prev === column) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
        return prev
      }
      setSortDir('asc')
      return column
    })
  }, [])

  const sortedRows = useMemo(() => {
    const out = [...filteredRows]
    const cmpSecondary = (a: Row, b: Row): number => {
      if (sortKey === null) {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      }
      let c = 0
      switch (sortKey) {
        case 'days': {
          const da = daysInQueue(a.createdAt)
          const db = daysInQueue(b.createdAt)
          c = da - db
          break
        }
        case 'qty':
          c = a.quantity - b.quantity
          break
        case 'customer':
          c = (a.po.customer.name || '').localeCompare(b.po.customer.name || '', undefined, {
            sensitivity: 'base',
          })
          break
        case 'po':
          c = (a.po.poNumber || '').localeCompare(b.po.poNumber || '', undefined, {
            numeric: true,
            sensitivity: 'base',
          })
          break
      }
      return sortDir === 'asc' ? c : -c
    }
    out.sort((a, b) => {
      const pa = rowIndustrialPriority(a) ? 1 : 0
      const pb = rowIndustrialPriority(b) ? 1 : 0
      if (pa !== pb) return pb - pa
      const aCompleted = isAwCompletedRow(a) ? 1 : 0
      const bCompleted = isAwCompletedRow(b) ? 1 : 0
      if (aCompleted !== bCompleted) return aCompleted - bCompleted
      return cmpSecondary(a, b)
    })
    return out
  }, [filteredRows, sortKey, sortDir])

  type AwVisualEntry =
    | { kind: 'single'; row: Row }
    | { kind: 'group'; rows: Row[]; groupId: string }
    | { kind: 'sub'; row: Row; groupId: string; subIdx: number }

  const sortedVisualRows = useMemo((): AwVisualEntry[] => {
    const result: AwVisualEntry[] = []
    const seenGroups = new Set<string>()

    for (const r of sortedRows) {
      const spec = (r.specOverrides || {}) as Record<string, unknown>
      const core = readPlanningCore(spec)
      const mid = core.masterSetId
      const members = core.mixSetMemberIds ?? []
      const isGang = !!(mid && members.length > 1 && core.layoutType === 'gang')

      if (!isGang || !mid) {
        result.push({ kind: 'single', row: r })
        continue
      }

      if (seenGroups.has(mid)) {
        if (expandedAwGroups.has(mid)) {
          const subIdx = result.filter((e) => e.kind === 'sub' && e.groupId === mid).length
          result.push({ kind: 'sub', row: r, groupId: mid, subIdx })
        }
        continue
      }

      seenGroups.add(mid)

      const groupRows = sortedRows.filter((sr) => {
        const ss = (sr.specOverrides || {}) as Record<string, unknown>
        return readPlanningCore(ss).masterSetId === mid
      })

      result.push({ kind: 'group', rows: groupRows, groupId: mid })
    }

    return result
  }, [sortedRows, expandedAwGroups])

  const rowsById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])

  const selectableRowIds = useMemo(() => {
    const ids: string[] = []
    for (const entry of sortedVisualRows) {
      if (entry.kind === 'single') ids.push(entry.row.id)
      if (entry.kind === 'group') ids.push(...entry.rows.map((r) => r.id))
    }
    return Array.from(new Set(ids))
  }, [sortedVisualRows])

  const allSelectableChecked =
    selectableRowIds.length > 0 && selectableRowIds.every((id) => selectedRowIds.has(id))
  const someSelectableChecked = selectableRowIds.some((id) => selectedRowIds.has(id))
  const keyboardRows = useMemo(() => sortedRows, [sortedRows])

  const togglePoPriority = async (r: Row, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const poId = r.po.id
    const next = r.po.isPriority !== true
    setPriorityBusyPoId(poId)
    try {
      const res = await fetch(`/api/purchase-orders/${poId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPriority: next }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Could not update priority')
      setRows((prev) =>
        prev.map((row) =>
          row.po.id === poId ? { ...row, po: { ...row.po, isPriority: next } } : row,
        ),
      )
      broadcastIndustrialPriorityChange({
        source: 'po_is_priority',
        at: new Date().toISOString(),
      })
      toast.success(next ? 'PO marked priority — synced to hubs' : 'PO priority cleared')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Priority update failed')
    } finally {
      setPriorityBusyPoId(null)
    }
  }

  const readyCount = useMemo(
    () => rows.filter((r) => r.readiness?.readyForProduction).length,
    [rows],
  )

  const forwardPlanning = async (r: Row) => {
    setForwardingId(r.id)
    try {
      const res = await fetch(`/api/designing/po-lines/${r.id}/forward-planning`, { method: 'POST' })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Forward failed')
      toast.success('Forwarded to planning')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Forward failed')
    } finally {
      setForwardingId(null)
    }
  }

  const recallPlanning = async (r: Row) => {
    setRecallingPlanningId(r.id)
    try {
      const res = await fetch(`/api/planning/po-lines/${r.id}/recall-from-aw`, {
        method: 'POST',
        cache: 'no-store',
      })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Recall failed')
      setRows((prev) => prev.filter((row) => row.id !== r.id))
      window.dispatchEvent(new CustomEvent('planning:refresh'))
      toast.success('Returned to Planning')
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Recall failed')
    } finally {
      setRecallingPlanningId(null)
    }
  }

  const recallPlanningGroup = async (groupId: string, groupRows: Row[]) => {
    const eligible = groupRows.filter((row) =>
      canRecallPlanningRow(row, ((row.specOverrides || {}) as Record<string, unknown>)),
    )
    if (eligible.length === 0) {
      toast.info('Recall is allowed only before machine allocation / production')
      return
    }
    setRecallingGroupId(groupId)
    try {
      let success = 0
      let failed = 0
      for (const row of eligible) {
        try {
          const res = await fetch(`/api/planning/po-lines/${row.id}/recall-from-aw`, {
            method: 'POST',
            cache: 'no-store',
          })
          const json = (await res.json()) as { error?: string }
          if (!res.ok) throw new Error(json.error || 'Recall failed')
          success += 1
        } catch {
          failed += 1
        }
      }
      window.dispatchEvent(new CustomEvent('planning:refresh'))
      if (success > 0) {
        toast.success(`Returned to Planning • ${success} item${success > 1 ? 's' : ''}`)
      }
      if (failed > 0) toast.error(`Recall failed for ${failed} item${failed > 1 ? 's' : ''}`)
      void load()
    } finally {
      setRecallingGroupId(null)
    }
  }

  useEffect(() => {
    if (keyboardRows.length === 0) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = (target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault()
        const currentIdx = keyboardRows.findIndex((r) => r.id === focusedRowId)
        const nextIdx =
          e.key === 'j'
            ? Math.min(currentIdx < 0 ? 0 : currentIdx + 1, keyboardRows.length - 1)
            : Math.max(currentIdx < 0 ? 0 : currentIdx - 1, 0)
        setFocusedRowId(keyboardRows[nextIdx]?.id ?? null)
      }
      const active = focusedRowId ? rowsById.get(focusedRowId) : null
      if (!active) return
      if (e.key === 'Enter') {
        e.preventDefault()
        router.push(`/orders/designing/${active.id}`)
      } else if (e.key.toLowerCase() === 'p' && canFinalizePlateHubRow(active)) {
        e.preventDefault()
        void finalizeFromList(active)
      } else if (e.key.toLowerCase() === 'd') {
        e.preventDefault()
        void pushToolingFromList(active, 'DIE')
      } else if (e.key.toLowerCase() === 'e') {
        e.preventDefault()
        void pushToolingFromList(active, 'BLOCK')
      } else if (e.key.toLowerCase() === 'r') {
        e.preventDefault()
        void recallPlanning(active)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keyboardRows, focusedRowId, rowsById, router])

  const finalizeFromList = async (r: Row) => {
    setFinalizingId(r.id)
    try {
      const { plate, jobCard, plateError, jobCardError } = await pushPlateHubAndCreateJobCardRow(r)
      const plateOk = plate === 'ok' || plate === 'duplicate'
      const jcOk = jobCard === 'ok'
      if (plateOk && jcOk) {
        toast.success(
          plate === 'duplicate'
            ? 'Plate Hub already had this line — job card ensured (created or already exists)'
            : 'Plate Hub + job card: routed to CTP triage and production',
        )
      } else if (plateOk && !jcOk) {
        toast.error(`${jobCardError || 'Job card step failed'} — Plate Hub / CTP side completed or was already sent — fix job card issue and retry`)
      } else if (!plateOk && jcOk) {
        toast.warning(`${plateError || 'Plate Hub step failed'} — Job card was created — review Plate Hub push and retry if needed`)
      } else {
        toast.error(plateError || jobCardError || 'Plate Hub and job card both failed')
      }
      await load()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Finalize failed')
    } finally {
      setFinalizingId(null)
    }
  }

  const pushJobCardFromList = async (r: Row) => {
    setJobCardPushingId(r.id)
    try {
      let out = await pushJobCardOnlyRow(r)
      if (!out.ok && out.errorCode === 'TOOLING_BLOCKED' && out.overrideAllowed) {
        const proceed = window.confirm(
          'Tooling not fully ready. Continue with trial/admin override?',
        )
        if (proceed) {
          out = await pushJobCardOnlyRow(r, {
            toolingOverrideTrial: true,
            toolingOverrideReason: 'Confirmed in AW queue override prompt',
          })
        }
      }
      if (out.ok) {
        toast.success(out.idempotent ? 'Job card already existed' : 'Job card created')
      } else {
        toast.error(out.error || 'Job card push failed')
      }
      await load()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Job card push failed')
    } finally {
      setJobCardPushingId(null)
    }
  }

  const pushToolingFromList = async (r: Row, tool: 'DIE' | 'BLOCK') => {
    const setN = (r.setNumber || '').trim()
    const aw = (r.artworkCode || '').trim()
    if (!setN || !aw) {
      toast.error('Set # and Artwork code are required')
      return
    }
    const spec = (r.specOverrides || {}) as Record<string, unknown>
    const planningCore = readPlanningCore(spec)
    const planningMeta = readPlanningMeta(spec)
    const actualSheetSize = resolveAwSheetSize(spec)
    const upsRaw = spec.ups ?? spec.numberOfUps ?? planningCore.ups ?? planningMeta.ups
    const ups = typeof upsRaw === 'number' && Number.isFinite(upsRaw) && upsRaw >= 1 ? Math.floor(upsRaw) : 1
    if (!actualSheetSize) {
      toast.error('Sheet size is required before tooling push')
      return
    }
    setFinalizingId(r.id)
    try {
      const body =
        tool === 'DIE'
          ? {
              toolType: 'DIE',
              awCode: aw,
              actualSheetSize,
              ups,
              jobId: r.id,
              setNumber: setN,
              source: 'NEW',
            }
          : {
              toolType: 'BLOCK',
              awCode: aw,
              actualSheetSize,
              blockType: String(r.embossingLeafing || 'Emboss').trim() || 'Emboss',
              jobId: r.id,
              setNumber: setN,
              source: 'NEW',
            }
      const res = await fetch('/api/tooling-hub/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Tooling dispatch failed')
      toast.success(tool === 'DIE' ? 'Pushed to Die Hub triage' : 'Pushed to Embossing Hub triage')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Tooling dispatch failed')
    } finally {
      setFinalizingId(null)
    }
  }

  const bulkPushSelectedToPlateHub = async () => {
    const picked = Array.from(selectedRowIds)
      .map((id) => rowsById.get(id))
      .filter((r): r is Row => !!r)
    if (picked.length === 0) {
      toast.info('Select at least one row')
      return
    }
    const eligible = picked.filter((r) => canFinalizePlateHubRow(r))
    if (eligible.length === 0) {
      toast.info('No eligible selected rows for Plate Hub push')
      return
    }
    setBulkPushing(true)
    try {
      let success = 0
      let failed = 0
      for (const row of eligible) {
        try {
          const { plate, jobCard } = await pushPlateHubAndCreateJobCardRow(row)
          const plateOk = plate === 'ok' || plate === 'duplicate'
          const jcOk = jobCard === 'ok'
          if (plateOk && jcOk) success += 1
          else failed += 1
        } catch {
          failed += 1
        }
      }
      if (success > 0) {
        toast.success(
          `Bulk Plate Hub + job cards • ${success} line${success > 1 ? 's' : ''} (CTP + job card OK)`,
        )
      }
      if (failed > 0) {
        toast.error(
          `Bulk orchestration incomplete for ${failed} line${failed > 1 ? 's' : ''} — open a row for details`,
        )
      }
      setSelectedRowIds(new Set())
      await load()
    } finally {
      setBulkPushing(false)
    }
  }

  const bulkPushSelectedToToolingHub = async (tool: 'DIE' | 'BLOCK') => {
    const picked = Array.from(selectedRowIds)
      .map((id) => rowsById.get(id))
      .filter((r): r is Row => !!r)
    if (picked.length === 0) {
      toast.info('Select at least one row')
      return
    }
    const eligible = picked.filter((r) => canPushToolingHubRow(r))
    if (eligible.length === 0) {
      toast.info(tool === 'DIE' ? 'No eligible selected rows for Die Hub push' : 'No eligible selected rows for Emboss Hub push')
      return
    }
    setBulkToolingPushing(tool)
    try {
      let success = 0
      let failed = 0
      for (const row of eligible) {
        try {
          const setN = (row.setNumber || '').trim()
          const normalizedSetN = normalizePlateSetNumber(setN)
          if (!normalizedSetN) throw new Error('Set # must contain digits')
          const aw = (row.artworkCode || '').trim()
          const spec = (row.specOverrides || {}) as Record<string, unknown>
          const planningCore = readPlanningCore(spec)
          const planningMeta = readPlanningMeta(spec)
          const actualSheetSize = resolveAwSheetSize(spec)
          if (!actualSheetSize) throw new Error('Sheet size is required')
          const upsRaw = spec.ups ?? spec.numberOfUps ?? planningCore.ups ?? planningMeta.ups
          const ups = typeof upsRaw === 'number' && Number.isFinite(upsRaw) && upsRaw >= 1 ? Math.floor(upsRaw) : 1
          const body =
            tool === 'DIE'
              ? {
                  toolType: 'DIE',
                  awCode: aw,
                  actualSheetSize,
                  ups,
                  jobId: row.id,
                  setNumber: setN,
                  source: 'NEW',
                }
              : {
                  toolType: 'BLOCK',
                  awCode: aw,
                  actualSheetSize,
                  blockType: String(row.embossingLeafing || 'Emboss').trim() || 'Emboss',
                  jobId: row.id,
                  setNumber: setN,
                  source: 'NEW',
                }
          const res = await fetch('/api/tooling-hub/dispatch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          const json = (await res.json().catch(() => ({}))) as { error?: string }
          if (!res.ok) throw new Error(json.error || 'Dispatch failed')
          success += 1
        } catch {
          failed += 1
        }
      }
      if (success > 0) {
        toast.success(
          tool === 'DIE'
            ? `Bulk pushed to Die Hub • ${success} item${success > 1 ? 's' : ''}`
            : `Bulk pushed to Emboss Hub • ${success} item${success > 1 ? 's' : ''}`,
        )
      }
      if (failed > 0) {
        toast.error(
          tool === 'DIE'
            ? `Bulk Die push failed for ${failed} item${failed > 1 ? 's' : ''}`
            : `Bulk Emboss push failed for ${failed} item${failed > 1 ? 's' : ''}`,
        )
      }
      setSelectedRowIds(new Set())
      await load()
    } finally {
      setBulkToolingPushing(null)
    }
  }

  const bulkDeleteSelectedRows = async () => {
    const picked = Array.from(selectedRowIds)
    if (picked.length === 0) return
    if (!confirm(`Delete ${picked.length} artwork queue item(s)?`)) return
    const reason = prompt('Enter delete reason (required):')
    if (!reason || reason.trim().length < 3) {
      toast.error('Delete reason is required (minimum 3 characters)')
      return
    }
    const token = prompt('Second confirmation: type DELETE to continue bulk delete.')
    if (token !== 'DELETE') return

    setBulkDeleting(true)
    let ok = 0
    let fail = 0
    for (const id of picked) {
      try {
        const res = await fetch(`/api/planning/po-lines/${id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason.trim() }),
        })
        if (!res.ok) throw new Error('Failed')
        ok += 1
      } catch {
        fail += 1
      }
    }
    if (ok) toast.success(`Deleted ${ok} artwork queue item(s)`)
    if (fail) toast.error(`Failed to delete ${fail} item(s)`)
    setSelectedRowIds(new Set())
    setBulkDeleting(false)
    await load()
  }

  const deleteAwRow = async (row: Row) => {
    const ok = window.confirm(`Delete ${row.cartonName || row.po.poNumber}?`)
    if (!ok) return
    const reason = prompt('Enter delete reason (required):')?.trim() ?? ''
    if (reason.length < 3) {
      toast.error('Delete reason is required (minimum 3 characters)')
      return
    }
    const token = prompt('Type DELETE to confirm row delete.')?.trim() ?? ''
    if (token !== 'DELETE') return
    const res = await fetch(`/api/planning/po-lines/${row.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    })
    if (!res.ok) {
      toast.error('Failed to delete row')
      return
    }
    toast.success('Row deleted')
    await load()
  }

  const bulkPushSelectedToJobCards = async () => {
    const picked = Array.from(selectedRowIds)
    if (picked.length === 0) return
    const ineligible = picked
      .map((id) => rows.find((r) => r.id === id))
      .filter((r): r is Row => !!r)
      .filter((r) => !canPushJobCardRow(r))
    if (ineligible.length > 0) {
      toast.error('Some rows are blocked: row is closed or already linked to a job card.')
    }
    let ok = 0
    let fail = 0
    const failReasons: string[] = []
    for (const id of picked) {
      const row = rows.find((r) => r.id === id)
      if (!row) continue
      if (!canPushJobCardRow(row)) {
        fail += 1
        failReasons.push(`${row.cartonName || row.po.poNumber}: ${pushJobCardBlockReason(row) || 'blocked'}`)
        continue
      }
      try {
        let out = await pushJobCardOnlyRow(row)
        if (!out.ok && out.errorCode === 'TOOLING_BLOCKED' && out.overrideAllowed) {
          const proceed = window.confirm(
            `Tooling not fully ready for ${row.cartonName || row.po.poNumber}. Continue with trial/admin override?`,
          )
          if (proceed) {
            out = await pushJobCardOnlyRow(row, {
              toolingOverrideTrial: true,
              toolingOverrideReason: 'Confirmed in AW bulk override prompt',
            })
          }
        }
        if (out.ok) {
          ok += 1
        } else {
          fail += 1
          failReasons.push(`${row.po.poNumber}: ${out.error || 'server error'}`)
        }
      } catch (e) {
        fail += 1
        failReasons.push(`${row.po.poNumber}: ${e instanceof Error ? e.message : 'server error'}`)
      }
    }
    await load()
    router.refresh()
    if (ok) toast.success(`Pushed ${ok} row(s) to Job Card`)
    if (fail) {
      const sample = failReasons.slice(0, 3).join(' | ')
      toast.error(`Failed for ${fail} row(s): ${sample}${failReasons.length > 3 ? ' ...' : ''}`)
    }
  }

  const finalizeGroupFromList = async (groupId: string, groupRows: Row[]) => {
    const eligible = groupRows.filter((row) => canFinalizePlateHubRow(row))
    if (eligible.length === 0) {
      toast.info('No eligible items in this gang for Plate Hub push')
      return
    }
    setFinalizingGroupId(groupId)
    try {
      let success = 0
      let failed = 0
      for (const row of eligible) {
        try {
          const { plate, jobCard } = await pushPlateHubAndCreateJobCardRow(row)
          const plateOk = plate === 'ok' || plate === 'duplicate'
          const jcOk = jobCard === 'ok'
          if (plateOk && jcOk) success += 1
          else failed += 1
        } catch {
          failed += 1
        }
      }
      if (success > 0) {
        toast.success(
          `Plate Hub + job cards • ${success} line${success > 1 ? 's' : ''} (gang / selection)`,
        )
      }
      if (failed > 0) {
        toast.error(`Plate Hub push failed for ${failed} item${failed > 1 ? 's' : ''}`)
      }
      await load()
    } finally {
      setFinalizingGroupId(null)
    }
  }

  if (loading) {
    return (
      <div className={`min-h-[40vh] p-4 text-sm text-ds-ink-faint dark:text-ds-ink-muted ${mono}`}>Loading…</div>
    )
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-ds-main dark:text-ds-ink">
      <div className="w-full space-y-3 p-3 pb-8">
        <section className="rounded-ds-md border border-ds-line/25 bg-card px-3.5 py-2.5 shadow-ds-depth-sm">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h1 className="text-[17px] font-semibold leading-tight text-ds-ink">AW Queue</h1>
              <p className="mt-0.5 text-[12px] text-ds-ink-faint">
                {rows.length} Jobs • {readyCount} Ready • {Math.max(0, rows.length - readyCount)} Pending
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-ds-md border border-ds-line/25 bg-[var(--bg-card)] px-3.5 py-2.5 shadow-ds-depth-sm">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <div className="relative min-w-[240px] flex-1 max-w-[420px]">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ds-ink-faint" />
                <input
                  type="search"
                  value={awSearchQuery}
                  onChange={(e) => setAwSearchQuery(e.target.value)}
                  placeholder="Search carton or PO #"
                  className={`h-8 w-full rounded-ds-sm border border-ds-line/35 bg-ds-main pl-8 pr-3 text-[12px] text-ds-ink outline-none transition focus:border-ds-brand/50 focus:ring-1 focus:ring-ds-brand/25 ${mono}`}
                />
              </div>
              <select
                value={designerFilter}
                onChange={(e) => setDesignerFilter(e.target.value as DesignerFilterValue)}
                className={`h-8 w-[170px] rounded-ds-sm border border-ds-line/35 bg-ds-main px-2 text-[12px] text-ds-ink ${mono}`}
              >
                <option value="all">All designers</option>
                <option value="unassigned">Unassigned</option>
                {planningDesignerOptions.map((name) => (
                  <option key={name} value={`planning:${name}`}>
                    {name}
                  </option>
                ))}
              </select>
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className={`h-8 w-[170px] rounded-ds-sm border border-ds-line/35 bg-ds-main px-2 text-[12px] text-ds-ink ${mono}`}
              >
                <option value="">All customers</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <span className="text-xs text-ds-ink-faint">{selectedRowIds.size} Selected</span>
              <Button
                variant="utility"
                type="button"
                onClick={() => void bulkDeleteSelectedRows()}
                disabled={selectedRowIds.size === 0 || bulkDeleting || bulkPushing || bulkToolingPushing != null}
                className="h-8 px-2.5 text-xs text-[var(--error)] hover:bg-[var(--error-bg)] dark:text-[var(--error)]"
              >
                {bulkDeleting ? 'Deleting…' : 'Bulk Delete'}
              </Button>
              <div className="relative">
                <Button
                  variant="utility"
                  type="button"
                  onClick={() => setHubsMenuOpen((v) => !v)}
                  disabled={selectedRowIds.size === 0 || bulkPushing || bulkToolingPushing != null}
                  className="h-8 px-2.5 text-xs"
                >
                  Push to Hubs
                </Button>
                {hubsMenuOpen ? (
                  <div className="absolute right-0 top-10 z-20 min-w-[10rem] rounded-ds-md bg-card p-1 shadow-lg">
                    <button type="button" className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-ds-elevated/40" onClick={() => { setHubsMenuOpen(false); void bulkPushSelectedToPlateHub() }}>Plate</button>
                    <button type="button" className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-ds-elevated/40" onClick={() => { setHubsMenuOpen(false); void bulkPushSelectedToToolingHub('DIE') }}>Die</button>
                    <button type="button" className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-ds-elevated/40" onClick={() => { setHubsMenuOpen(false); void bulkPushSelectedToToolingHub('BLOCK') }}>Emboss</button>
                    <button type="button" className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-ds-elevated/40" onClick={() => { setHubsMenuOpen(false); window.open('/hub/shade-card-hub', '_blank', 'noopener,noreferrer') }}>Shade Card</button>
                  </div>
                ) : null}
              </div>
              <Button
                variant="success"
                type="button"
                onClick={() => void bulkPushSelectedToJobCards()}
                disabled={selectedRowIds.size === 0 || bulkPushing || bulkToolingPushing != null}
                className="h-8 px-2.5 text-xs font-semibold"
              >
                Push to Job Card
              </Button>
            </div>
          </div>
        </section>

        <section className="rounded-ds-md border border-ds-line/25 bg-card px-3.5 py-2 shadow-ds-depth-sm">
          <div className="flex flex-wrap items-center gap-2">
            {[
              { key: 'all' as const, label: 'All' },
              { key: 'my' as const, label: 'My Jobs' },
              { key: 'ready' as const, label: 'Ready' },
              { key: 'pending' as const, label: 'Pending' },
            ].map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setAwTab(tab.key)}
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${awTab === tab.key ? 'bg-ds-brand/12 text-ds-brand' : 'bg-ds-elevated text-ds-ink-faint hover:text-ds-ink'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </section>
        {sortedRows.length === 0 ? (
          <section className="flex min-h-[420px] items-center justify-center rounded-ds-md bg-card p-4 shadow-ds-depth-sm">
            <div className="text-center">
              <ImageOff className="mx-auto h-10 w-10 text-ds-ink-faint" />
              <h3 className="mt-3 text-base font-semibold text-ds-ink">No artwork jobs yet</h3>
              <p className="mt-1 text-sm text-ds-ink-faint">
                Jobs from Planning will appear here once artwork is created.
              </p>
              <button
                type="button"
                onClick={() => router.push('/orders/planning')}
                className="mt-4 h-9 rounded bg-ds-brand px-3 text-sm font-semibold text-white"
              >
                Go to Planning
              </button>
            </div>
          </section>
        ) : (
        <section className="rounded-ds-md border border-ds-line/25 bg-card p-2.5 shadow-ds-depth-sm">
        <EnterpriseTableShell>
          <table className="w-full min-w-[1180px] table-fixed border-collapse text-left text-xs">
            <colgroup>
              <col className="w-10" />
              <col className="w-12" />
              <col className="w-[370px]" />
              <col className="w-[92px]" />
              <col className="w-[112px]" />
              <col className="w-[52px]" />
              <col className="w-[76px]" />
              <col className="w-[116px]" />
              <col className="w-[100px]" />
              <col className="w-[190px]" />
            </colgroup>
            <thead className="bg-card text-xs font-semibold uppercase tracking-wider text-ds-ink-faint dark:text-ds-ink-muted">
              <tr>
                <th className="w-10 px-2 py-2 text-center">
                  <input
                    type="checkbox"
                    aria-label="Select all visible rows"
                    checked={allSelectableChecked}
                    ref={(el) => {
                      if (el) el.indeterminate = !allSelectableChecked && someSelectableChecked
                    }}
                    onChange={() => {
                      setSelectedRowIds((prev) => {
                        const next = new Set(prev)
                        if (allSelectableChecked) selectableRowIds.forEach((id) => next.delete(id))
                        else selectableRowIds.forEach((id) => next.add(id))
                        return next
                      })
                    }}
                    className="h-3.5 w-3.5 accent-ds-brand"
                  />
                </th>
                <th className="w-[48px] px-2 py-2">•</th>
                <th className="px-2 py-2">Product</th>
                <SortHeader
                  label="Qty"
                  column="qty"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={cycleSort}
                  className="text-right [&_button]:w-full [&_button]:justify-end"
                />
                <th className="px-2 py-2">Designer</th>
                <th className="w-10 px-2 py-2 text-right">UPS</th>
                <th className="w-[5.5rem] px-2 py-2">Batch</th>
                <th className="w-[7rem] px-2 py-2">Status</th>
                <th className="w-[7.5rem] px-2 py-2">Job card</th>
                <th className="px-2 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 bg-card dark:divide-ds-line/30">
              {sortedVisualRows.map((entry) => {
                // ── GROUP HEADER ROW ──────────────────────────────────────
                if (entry.kind === 'group') {
                  const { rows: groupRows, groupId } = entry
                  const firstRow = groupRows[0]!
                  const totalQty = groupRows.reduce((s, r) => s + r.quantity, 0)
                  const isExpanded = expandedAwGroups.has(groupId)
                  const spec0 = (firstRow.specOverrides || {}) as Record<string, unknown>
                  const designerName0 = resolvePlanningDesignerName(spec0, userById) || '—'
                  const priRow0 = rowIndustrialPriority(firstRow)
                  const dQ0 = daysInQueue(firstRow.createdAt)
                  const phase0 = firstRow.readiness?.pipelinePhase ?? 'drafting'
                  const badge0 = pipelineBadge(phase0)
                  const groupCompleted = groupRows.every((r) => isAwCompletedRow(r))
                  const groupPlatePushedPending = !groupCompleted && groupRows.every((r) => isAwPushedRow(r))
                  const groupJobCardOnly = !groupCompleted && groupRows.every((r) => isAwJobCardOnlyRow(r))
                  const groupPushAge = (groupCompleted || groupPlatePushedPending)
                    ? formatShortTimeAgo(
                        ((spec0.prePressSentToPlateHubAt as string | undefined) || (spec0.prePressFinalizedAt as string | undefined) || firstRow.createdAt),
                      )
                    : null
                  const groupFinalizeEligibleCount = groupRows.filter((r) => canFinalizePlateHubRow(r)).length
                  const groupMissingSheetCount = groupRows.filter((r) => {
                    const rs = (r.specOverrides || {}) as Record<string, unknown>
                    return !hasToolingSheetSize(r, rs)
                  }).length
                  const groupRecallEligibleCount = groupRows.filter((r) =>
                    canRecallPlanningRow(r, ((r.specOverrides || {}) as Record<string, unknown>)),
                  ).length
                  const groupJobCardReady = groupRows.filter((r) => awJobCardState(r) === 'ready').length
                  const upsSet = new Set(
                    groupRows.map((r) =>
                      rowUpsDisplay(((r.specOverrides || {}) as Record<string, unknown>)),
                    ),
                  )
                  const groupUpsLabel = upsSet.size <= 1 ? Array.from(upsSet)[0] ?? '—' : 'Mix'

                  return (
                    <Fragment key={`aw-group:${groupId}`}>
                      <tr
                        onClick={(e) => openRowDrawerFromClick(e, firstRow)}
                        className={`border-l-[3px] transition-colors ${
                          groupCompleted
                            ? 'border-[var(--success)]/70 bg-[var(--success-bg)] hover:bg-[var(--success-bg)] dark:bg-[var(--success-bg)] dark:hover:bg-[var(--success-bg)]'
                            : groupPlatePushedPending
                              ? 'border-[var(--error)]/70 bg-[var(--error-bg)] hover:bg-[var(--error-bg)] dark:bg-[var(--error-bg)] dark:hover:bg-[var(--error-bg)]'
                              : groupJobCardOnly
                                  ? 'border-[var(--tooling,#7c3aed)]/70 bg-[var(--tooling-bg,rgba(124,58,237,0.12))] hover:bg-[var(--tooling-bg,rgba(124,58,237,0.12))] dark:bg-[var(--tooling-bg,rgba(124,58,237,0.12))] dark:hover:bg-[var(--tooling-bg,rgba(124,58,237,0.12))]'
                              : 'border-[var(--info)]/70 bg-[var(--info-bg)] hover:bg-[var(--info-bg)]'
                        } ${priRow0 ? INDUSTRIAL_PRIORITY_ROW_CLASS : ''} ${groupRows.some((r) => r.id === focusedRowId) ? 'ring-1 ring-ds-warning/45' : ''}`}
                      >
                        <td className="px-2 py-1.5 align-middle text-center">
                          <input
                            type="checkbox"
                            aria-label="Select gang rows"
                            checked={groupRows.every((r) => selectedRowIds.has(r.id))}
                            ref={(el) => {
                              if (!el) return
                              const all = groupRows.every((r) => selectedRowIds.has(r.id))
                              const some = groupRows.some((r) => selectedRowIds.has(r.id))
                              el.indeterminate = !all && some
                            }}
                            onChange={() => {
                              const all = groupRows.every((r) => selectedRowIds.has(r.id))
                              setSelectedRowIds((prev) => {
                                const next = new Set(prev)
                                if (all) groupRows.forEach((r) => next.delete(r.id))
                                else groupRows.forEach((r) => next.add(r.id))
                                return next
                              })
                            }}
                            className="h-3.5 w-3.5 accent-ds-brand"
                          />
                        </td>
                        <td className="px-2 py-1.5 align-middle">
                          <ArtworkPreviewCell
                            url={firstRow.artworkPreviewUrl ?? null}
                            alt={firstRow.cartonName}
                            onOpenLightbox={(src) => setLightbox({ src, alt: `${firstRow.po.poNumber} · ${firstRow.cartonName}` })}
                          />
                        </td>
                        <td className="px-2 py-1.5 align-middle text-xs leading-snug text-neutral-900 dark:text-ds-ink">
                          <div className="mb-0.5 inline-flex items-center gap-1 rounded bg-[var(--info-bg)] px-1 py-0.5 text-xs font-bold uppercase text-[var(--info)] dark:text-[var(--info)]">
                            <Layers className="h-3 w-3 shrink-0" aria-hidden /> Gang · {groupRows.length}
                          </div>
                          <div className="flex min-w-0 items-center gap-1 text-xs text-ds-ink-muted">
                            <CustomerAvatar name={firstRow.po.customer.name} logoUrl={firstRow.po.customer.logoUrl} />
                            <span className="min-w-0 truncate">{firstRow.po.customer.name}</span>
                            <span className={`shrink-0 ${mono} text-ds-warning`}>{firstRow.po.poNumber}</span>
                          </div>
                          <div className="mt-0.5 flex min-w-0 flex-col gap-0.5">
                            {groupRows.map((r) => (
                              <span
                                key={r.id}
                                className={`min-w-0 truncate ${groupCompleted ? 'text-[var(--success)] dark:text-[var(--success)]' : ''}`}
                                title={r.cartonName}
                              >
                                {r.cartonName}
                              </span>
                            ))}
                          </div>
                          <div className={`mt-0.5 text-xs ${mono} text-ds-ink-faint`}>
                            Set {firstRow.setNumber ?? '—'} · {dQ0}d
                          </div>
                        </td>
                        <td className={`whitespace-nowrap px-2 py-1.5 align-middle text-right text-xs font-bold tabular-nums ${mono} text-ds-brand`}>
                          {totalQty.toLocaleString('en-IN')}
                        </td>
                        <td className="px-2 py-1.5 align-middle text-xs leading-tight text-ds-ink-faint">
                          <div className="max-w-full whitespace-normal break-words">{designerName0}</div>
                        </td>
                        <td className={`px-2 py-1.5 align-middle text-right text-xs ${mono} text-ds-ink`}>{groupUpsLabel}</td>
                        <td className="px-2 py-1.5 align-middle text-xs text-ds-ink-muted">Gang</td>
                        <td className="px-2 py-1.5 align-middle">
                          <span className={`${badge0.className} text-xs ${badge0.pulse ? 'animate-pulse' : ''}`}>
                            <Layers className="h-3 w-3 shrink-0" aria-hidden />
                            {badge0.label}
                          </span>
                          {groupPushAge ? (
                            <div className="mt-0.5">
                              <span className={groupCompleted ? PUSHED_CHIP_CLASS : 'rounded bg-ds-elevated px-1.5 py-0.5 text-xs text-ds-ink-faint'}>
                                {groupCompleted ? `Pushed ${groupPushAge}` : `Plate pushed ${groupPushAge}`}
                              </span>
                            </div>
                          ) : null}
                        </td>
                        <td className="px-2 py-1.5 align-middle">
                          {groupJobCardReady === groupRows.length ? (
                            <span className="rounded bg-[var(--success-bg)] px-1.5 py-0.5 text-xs text-[var(--success)]">
                              Ready ({groupJobCardReady}/{groupRows.length})
                            </span>
                          ) : (
                            <span className="rounded bg-ds-elevated px-1.5 py-0.5 text-xs text-ds-ink-faint">
                              Pending ({groupRows.length - groupJobCardReady}/{groupRows.length})
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 align-middle">
                          <div className="flex flex-wrap items-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                setExpandedAwGroups((prev) => {
                                  const next = new Set(prev)
                                  if (next.has(groupId)) next.delete(groupId)
                                  else next.add(groupId)
                                  return next
                                })
                              }}
                              className="inline-flex items-center gap-0.5 rounded bg-[var(--info-bg)] px-2 py-0.5 text-xs font-medium text-[var(--info)] hover:bg-[var(--info-bg)] dark:text-[var(--info)]"
                            >
                              {isExpanded ? '▲ Collapse' : `▼ ${groupRows.length} items`}
                            </button>
                            <button
                              type="button"
                              onClick={() => setActiveGroupEdit({ groupId, rows: groupRows })}
                              className="inline-flex items-center justify-center gap-1 rounded bg-ds-warning/8 px-2 py-0.5 text-xs font-medium text-ds-warning hover:bg-ds-warning/15 dark:text-ds-warning"
                            >
                              <Pencil className="h-3 w-3 opacity-80" aria-hidden />
                              Edit group
                            </button>
                            {groupMissingSheetCount > 0 ? (
                              <span className="rounded bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-700 dark:text-orange-300">
                                Missing sheet size ({groupMissingSheetCount})
                              </span>
                            ) : null}
                            <button
                              type="button"
                              disabled={finalizingGroupId === groupId || groupFinalizeEligibleCount === 0}
                              onClick={() => void finalizeGroupFromList(groupId, groupRows)}
                              title={
                                groupFinalizeEligibleCount > 0
                                  ? `Push ${groupFinalizeEligibleCount} eligible item${groupFinalizeEligibleCount > 1 ? 's' : ''} to Plate Hub`
                                  : 'No eligible items in this gang for Plate Hub push'
                              }
                              className={`rounded px-2 py-0.5 text-xs disabled:opacity-40 ${
                                groupFinalizeEligibleCount > 0
                                  ? 'text-[var(--success)] hover:bg-[var(--success-bg)] dark:text-[var(--success)]'
                                  : 'text-ds-warning hover:bg-ds-warning/10'
                              }`}
                            >
                              {finalizingGroupId === groupId
                                ? '…'
                                : `Plate Hub group${groupFinalizeEligibleCount > 0 ? ` (${groupFinalizeEligibleCount})` : ''}`}
                            </button>
                            <button
                              type="button"
                              disabled={recallingGroupId === groupId || groupRecallEligibleCount === 0}
                              onClick={() => void recallPlanningGroup(groupId, groupRows)}
                              title={
                                groupRecallEligibleCount > 0
                                  ? `Recall ${groupRecallEligibleCount} eligible item${groupRecallEligibleCount > 1 ? 's' : ''} to Planning`
                                  : 'Recall is allowed only before machine allocation / production'
                              }
                              className={`rounded px-2 py-0.5 text-xs disabled:opacity-40 ${
                                groupRecallEligibleCount > 0
                                  ? 'text-[var(--error)] hover:bg-[var(--error-bg)] dark:text-[var(--error)]'
                                  : 'text-ds-warning hover:bg-ds-warning/10'
                              }`}
                            >
                              {recallingGroupId === groupId ? '…' : `Recall group${groupRecallEligibleCount > 0 ? ` (${groupRecallEligibleCount})` : ''}`}
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Expanded sub-rows */}
                      {isExpanded && groupRows.map((r, si) => {
                        const spec = (r.specOverrides || {}) as Record<string, unknown>
                        const designerName = resolvePlanningDesignerName(spec, userById) || '—'
                        const phase = r.readiness?.pipelinePhase ?? 'drafting'
                        const embossEnabled = isEmbossingRequired(r.embossingLeafing)
                        const dQ = daysInQueue(r.createdAt)
                        const completed = isAwCompletedRow(r)
                        const platePushedOnly = !completed && isAwPushedRow(r)
                        const jobCardOnly = !completed && isAwJobCardOnlyRow(r)
                        const pushedAge = completed || platePushedOnly
                          ? formatShortTimeAgo(
                              ((spec.prePressSentToPlateHubAt as string | undefined) || (spec.prePressFinalizedAt as string | undefined) || r.createdAt),
                            )
                          : null
                        const awPo = readAwPoStatus(spec)
                        const rowClosed = awPo === AW_PO_STATUS.CLOSED
                        const missingSheetSize = !hasToolingSheetSize(r, spec)
                        const canFinalizeRow = canFinalizePlateHubRow(r)
                        const canRecallPlanning = canRecallPlanningRow(r, spec)
                        const jcState = awJobCardState(r)

                        return (
                          <tr
                            key={`aw-sub:${r.id}`}
                            onClick={(e) => openRowDrawerFromClick(e, r)}
                            className={`border-l-[3px] transition-colors ${
                              completed
                                ? 'border-[var(--success)]/50 bg-[var(--success-bg)] hover:bg-[var(--success-bg)] dark:bg-[var(--success-bg)] dark:hover:bg-[var(--success-bg)]'
                                : platePushedOnly
                                  ? 'border-[var(--error)]/70 bg-[var(--error-bg)] hover:bg-[var(--error-bg)] dark:bg-[var(--error-bg)] dark:hover:bg-[var(--error-bg)]'
                                  : jobCardOnly
                                    ? 'border-[var(--tooling,#7c3aed)]/70 bg-[var(--tooling-bg,rgba(124,58,237,0.12))] hover:bg-[var(--tooling-bg,rgba(124,58,237,0.12))] dark:bg-[var(--tooling-bg,rgba(124,58,237,0.12))] dark:hover:bg-[var(--tooling-bg,rgba(124,58,237,0.12))]'
                                  : 'border-[var(--info)]/30 bg-[var(--info-bg)] hover:bg-[var(--info-bg)]'
                            } ${focusedRowId === r.id ? 'ring-1 ring-ds-warning/45' : ''}`}
                          >
                            <td className="px-2 py-1 align-middle text-center">
                              <input
                                type="checkbox"
                                aria-label="Select row"
                                checked={selectedRowIds.has(r.id)}
                                onChange={() => {
                                  setSelectedRowIds((prev) => {
                                    const next = new Set(prev)
                                    if (next.has(r.id)) next.delete(r.id)
                                    else next.add(r.id)
                                    return next
                                  })
                                }}
                                className="h-3.5 w-3.5 accent-ds-brand"
                              />
                            </td>
                            <td className="px-2 py-1 align-middle">
                              <ArtworkPreviewCell
                                url={r.artworkPreviewUrl ?? null}
                                alt={r.cartonName}
                                onOpenLightbox={(src) =>
                                  setLightbox({ src, alt: `${r.po.poNumber} · ${r.cartonName}` })
                                }
                              />
                            </td>
                            <td className="px-2 py-1 align-middle text-xs leading-snug text-ds-ink">
                              <span className="text-[var(--info)]/70">↳{si + 1}</span>{' '}
                              <span className={`${mono} text-ds-warning`}>{r.po.poNumber}</span>
                              <div className="flex min-w-0 items-center gap-1 text-ds-ink-muted">
                                <CustomerAvatar name={r.po.customer.name} logoUrl={r.po.customer.logoUrl} />
                                <span className="min-w-0 truncate">{r.po.customer.name}</span>
                              </div>
                              <button
                                type="button"
                                className={`min-w-0 truncate text-left font-medium underline-offset-2 hover:underline ${completed ? 'text-[var(--success)] dark:text-[var(--success)]' : ''}`}
                                onClick={() => setActiveRowDrawer(r)}
                              >
                                {r.cartonName}
                              </button>
                              <div className={`${mono} text-ds-ink-faint`}>Set {r.setNumber ?? '—'} · {dQ}d</div>
                            </td>
                            <td className={`whitespace-nowrap px-2 py-1 align-middle text-right text-xs tabular-nums ${mono} text-ds-ink`}>
                              {r.quantity.toLocaleString('en-IN')}
                            </td>
                            <td className="px-2 py-1 align-middle text-xs leading-tight text-ds-ink-faint">
                              <div className="max-w-full whitespace-normal break-words">{designerName}</div>
                            </td>
                            <td className={`px-2 py-1 align-middle text-right text-xs ${mono}`}>{rowUpsDisplay(spec)}</td>
                            <td className="px-2 py-1 align-middle text-xs text-ds-ink-muted">
                              {rowBatchTypeDisplay(spec)}
                            </td>
                            <td className="px-2 py-1 align-middle">
                              <div className="flex flex-wrap items-center gap-1">
                                {phase === 'awaiting_client' ? (
                                  <span className="rounded bg-[var(--info-bg)] px-1.5 py-0.5 text-xs text-[var(--info)] dark:text-[var(--info)]">
                                    Awaiting client
                                  </span>
                                ) : null}
                                {missingSheetSize ? (
                                  <span className="rounded bg-orange-500/10 px-1.5 py-0.5 text-xs text-orange-700 dark:text-orange-300">
                                    Sheet size missing
                                  </span>
                                ) : null}
                              </div>
                            </td>
                            <td className="px-2 py-1 align-middle">
                              <div className="flex items-center justify-between gap-2">
                                {jcState === 'ready' ? (
                                  <span className="rounded bg-[var(--success-bg)] px-1.5 py-0.5 text-xs text-[var(--success)]">
                                    Ready
                                  </span>
                                ) : (
                                  <span className="text-xs text-ds-ink-faint">—</span>
                                )}
                                <button
                                  type="button"
                                  className="rounded px-1 text-xs text-ds-ink-faint hover:bg-ds-main/40 hover:text-ds-ink"
                                  onClick={() => setActiveRowDrawer(r)}
                                  aria-label="Open AW details"
                                  title="Open details"
                                >
                                  →
                                </button>
                              </div>
                            </td>
                            <td className="px-2 py-1 align-middle">
                              <ActionsCell
                                embossEnabled={embossEnabled}
                                onPushJobCard={() => void pushJobCardFromList(r)}
                                onPushPlate={() => void finalizeFromList(r)}
                                onPushEmboss={() => void pushToolingFromList(r, 'BLOCK')}
                                onPushShadeCard={() => window.open('/hub/shade-card-hub', '_blank', 'noopener,noreferrer')}
                                onRecallPlanning={() => void recallPlanning(r)}
                                onDeleteRow={() => void deleteAwRow(r)}
                                disablePushJobCard={jobCardPushingId === r.id || !canPushJobCardRow(r)}
                                disablePushPlate={finalizingId === r.id || rowClosed || !canFinalizeRow}
                                disableRecall={recallingPlanningId === r.id || !canRecallPlanning || rowClosed}
                                pushJobCardLabel={jobCardPushingId === r.id ? '…' : hasLinkedJobCard(r) ? 'Job card ✓' : 'Push Job Card'}
                                pushPlateLabel={finalizingId === r.id ? '…' : 'Plates'}
                                recallLabel={recallingPlanningId === r.id ? '…' : 'Send Back'}
                              />
                            </td>
                          </tr>
                        )
                      })}
                    </Fragment>
                  )
                }

                // ── SINGLE ROW ──────────────────────────────────────────────
                // entry.kind === 'single' (sub rows are rendered inline in group above)
                const r = entry.kind === 'single' ? entry.row : entry.row
                const rowSpec = (r.specOverrides || {}) as Record<string, unknown>
                const designerName = resolvePlanningDesignerName(rowSpec, userById) || '—'
                const completed = isAwCompletedRow(r)
                const platePushedOnly = !completed && isAwPushedRow(r)
                const jobCardOnly = !completed && isAwJobCardOnlyRow(r)
                const spec = (r.specOverrides || {}) as Record<string, unknown>
                const awPo = readAwPoStatus(spec)
                const rowClosed = awPo === AW_PO_STATUS.CLOSED
                const missingSheetSize = !hasToolingSheetSize(r, spec)
                const batchSeg = batchProgressSegments(spec)
                const canFinalizeRow = canFinalizePlateHubRow(r)
                const canRecallPlanning =
                  canRecallPlanningRow(r, spec)
                const showRecall = !!r.id
                const jcState = awJobCardState(r)
                const phase = r.readiness?.pipelinePhase ?? 'drafting'
                const dQ = daysInQueue(r.createdAt)
                const embossEnabled = isEmbossingRequired(r.embossingLeafing)
                const previewUrl = r.artworkPreviewUrl ?? null

                const priRow = rowIndustrialPriority(r)
                return (
                  <tr
                    key={r.id}
                    onClick={(e) => openRowDrawerFromClick(e, r)}
                    className={`transition-colors ${
                      priRow
                        ? `${INDUSTRIAL_PRIORITY_ROW_CLASS} hover:bg-ds-warning/5 dark:hover:bg-ds-warning/12`
                        : completed
                          ? 'border-l-2 border-[var(--success)]/70 bg-[var(--success-bg)] hover:bg-[var(--success-bg)] dark:bg-[var(--success-bg)] dark:hover:bg-[var(--success-bg)]'
                        : platePushedOnly
                          ? 'border-l-2 border-[var(--error)]/70 bg-[var(--error-bg)] hover:bg-[var(--error-bg)] dark:bg-[var(--error-bg)] dark:hover:bg-[var(--error-bg)]'
                          : jobCardOnly
                            ? 'border-l-2 border-[var(--tooling,#7c3aed)]/70 bg-[var(--tooling-bg,rgba(124,58,237,0.12))] hover:bg-[var(--tooling-bg,rgba(124,58,237,0.12))] dark:bg-[var(--tooling-bg,rgba(124,58,237,0.12))] dark:hover:bg-[var(--tooling-bg,rgba(124,58,237,0.12))]'
                          : 'border-l-2 border-transparent hover:border-ds-warning hover:bg-neutral-50 dark:hover:bg-ds-elevated/50'
                    } ${r.directorHold ? 'opacity-45' : ''} ${rowClosed ? 'opacity-40 saturate-0' : ''} ${focusedRowId === r.id ? 'ring-1 ring-ds-warning/45' : ''}`}
                  >
                    <td className="px-2 py-2 align-middle text-center">
                      <input
                        type="checkbox"
                        aria-label="Select row"
                        checked={selectedRowIds.has(r.id)}
                        onChange={() => {
                          setSelectedRowIds((prev) => {
                            const next = new Set(prev)
                            if (next.has(r.id)) next.delete(r.id)
                            else next.add(r.id)
                            return next
                          })
                        }}
                        className="h-3.5 w-3.5 accent-ds-brand"
                      />
                    </td>
                    <td className="px-2 py-2 align-middle">
                      <ArtworkPreviewCell
                        url={previewUrl}
                        alt={r.cartonName}
                        onOpenLightbox={(src) =>
                          setLightbox({ src, alt: `${r.po.poNumber} · ${r.cartonName}` })
                        }
                      />
                    </td>
                    <td className="px-2 py-2 align-middle text-xs leading-snug text-neutral-900 dark:text-ds-ink">
                      <div className="flex min-w-0 items-start gap-1">
                        <button
                          type="button"
                          title={
                            r.po.isPriority === true ? 'Clear PO priority (pin)' : 'Mark PO priority (pin to top)'
                          }
                          aria-pressed={r.po.isPriority === true}
                          aria-label={r.po.isPriority === true ? 'Clear PO priority' : 'Mark PO priority'}
                          disabled={priorityBusyPoId === r.po.id}
                          onClick={(e) => void togglePoPriority(r, e)}
                          className={`mt-0.5 shrink-0 ${ICON_BUTTON_TIGHT} text-ds-ink-faint hover:bg-neutral-100 hover:text-ds-warning dark:hover:bg-card/5 dark:hover:text-ds-warning`}
                        >
                          <Star
                            className={`h-3 w-3 ${
                              r.po.isPriority === true
                                ? INDUSTRIAL_PRIORITY_STAR_ICON_CLASS
                                : 'text-ds-ink-faint'
                            }`}
                            strokeWidth={2}
                          />
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className={`truncate ${mono} text-ds-warning`}>{r.po?.poNumber ?? '—'}</div>
                          <div className="flex min-w-0 items-center gap-1 text-xs text-ds-ink-muted">
                            <CustomerAvatar name={r.po?.customer?.name ?? '—'} logoUrl={r.po?.customer?.logoUrl} />
                            <span className="min-w-0 truncate">{r.po?.customer?.name ?? '—'}</span>
                          </div>
                          <button
                            type="button"
                            className={`mt-0.5 min-w-0 text-left font-medium underline-offset-2 hover:underline ${completed ? 'text-[var(--success)] dark:text-[var(--success)]' : ''}`}
                            onClick={() => setActiveRowDrawer(r)}
                          >
                            {r.cartonName ?? '—'}
                          </button>
                          {readPlanningCore(spec).layoutType === 'gang' ? (
                            <span className="mt-0.5 inline-block w-fit rounded bg-[var(--info-bg)] px-1 py-0.5 text-xs font-semibold uppercase text-[var(--info)] dark:text-[var(--info)]">
                              Gang print
                            </span>
                          ) : readPlanningCore(spec).savedAt ? (
                            <span className="mt-0.5 inline-block w-fit rounded px-1 py-0.5 text-xs text-ds-ink-faint">
                              Single
                            </span>
                          ) : null}
                          {totalContractBatches(spec) > 0 ? (
                            <div
                              className="mt-1 flex h-1 w-full max-w-[7rem] overflow-hidden rounded-full bg-ds-elevated ring-1 ring-ds-line/50"
                              title="Batch progress"
                            >
                              <div
                                className="h-full bg-[var(--success-bg)]"
                                style={{ width: `${Math.round(batchSeg.shippedPct * 100)}%` }}
                              />
                              <div
                                className="h-full bg-ds-warning/90"
                                style={{ width: `${Math.round(batchSeg.inProductionPct * 100)}%` }}
                              />
                              <div
                                className="h-full bg-ds-line/30"
                                style={{ width: `${Math.round(batchSeg.remainingPct * 100)}%` }}
                              />
                            </div>
                          ) : null}
                          {r.directorPriority ? (
                            <span className="mt-0.5 inline-block w-fit rounded bg-ds-warning/15 px-1 text-xs font-bold uppercase text-ds-warning ring-1 ring-ds-warning/35">
                              Priority
                            </span>
                          ) : null}
                          {r.directorHold ? (
                            <span className="mt-0.5 inline-block w-fit rounded bg-ds-elevated/30 px-1 text-xs text-ds-ink-faint">
                              Hold
                            </span>
                          ) : null}
                          <div className={`mt-0.5 text-xs ${mono} text-ds-ink-faint`}>
                            Set {r.setNumber ?? '—'} · {dQ}d queue
                          </div>
                        </div>
                      </div>
                    </td>
                    <td
                      className={`whitespace-nowrap px-2 py-2 align-middle text-right text-xs font-semibold tabular-nums ${mono} text-neutral-900 dark:text-ds-ink`}
                    >
                      {r.quantity.toLocaleString('en-IN')}
                    </td>
                    <td className="px-2 py-2 align-middle text-xs leading-tight text-ds-ink-faint dark:text-ds-ink-muted">
                      <div className="max-w-full whitespace-normal break-words">{designerName}</div>
                    </td>
                    <td className={`px-2 py-2 align-middle text-right text-xs ${mono} text-ds-ink`}>{rowUpsDisplay(spec)}</td>
                    <td className="px-2 py-2 align-middle text-xs text-ds-ink-muted">{rowBatchTypeDisplay(spec)}</td>
                    <td className="px-2 py-2 align-middle">
                      <div className="flex flex-wrap items-center gap-1">
                        {phase === 'awaiting_client' ? (
                          <span className="rounded bg-[var(--info-bg)] px-1.5 py-0.5 text-xs text-[var(--info)] dark:text-[var(--info)]">
                            Awaiting client
                          </span>
                        ) : null}
                        {missingSheetSize ? (
                          <span className="rounded bg-orange-500/10 px-1.5 py-0.5 text-xs text-orange-700 dark:text-orange-300">
                            Sheet size missing
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-2 py-2 align-middle">
                      <div className="flex items-center justify-between gap-2">
                        {jcState === 'ready' ? (
                          <span className="rounded bg-[var(--success-bg)] px-1.5 py-0.5 text-xs text-[var(--success)]">
                            Ready
                          </span>
                        ) : (
                          <span className="text-xs text-ds-ink-faint">—</span>
                        )}
                        <button
                          type="button"
                          className="rounded px-1 text-xs text-ds-ink-faint hover:bg-ds-main/40 hover:text-ds-ink"
                          onClick={() => setActiveRowDrawer(r)}
                          aria-label="Open AW details"
                          title="Open details"
                        >
                          →
                        </button>
                      </div>
                    </td>
                    <td className="px-2 py-2 align-middle">
                      <ActionsCell
                        embossEnabled={embossEnabled}
                        onPushJobCard={() => void pushJobCardFromList(r)}
                        onPushPlate={() => void finalizeFromList(r)}
                        onPushEmboss={() => void pushToolingFromList(r, 'BLOCK')}
                        onPushShadeCard={() => window.open('/hub/shade-card-hub', '_blank', 'noopener,noreferrer')}
                        onRecallPlanning={() => void recallPlanning(r)}
                        onDeleteRow={() => void deleteAwRow(r)}
                        disablePushJobCard={jobCardPushingId === r.id || !canPushJobCardRow(r)}
                        disablePushPlate={finalizingId === r.id || rowClosed || !canFinalizeRow}
                        disableRecall={!showRecall || recallingPlanningId === r.id || !canRecallPlanning || rowClosed}
                        pushJobCardLabel={jobCardPushingId === r.id ? '…' : hasLinkedJobCard(r) ? 'Job card ✓' : 'Push Job Card'}
                        pushPlateLabel={finalizingId === r.id ? '…' : 'Plates'}
                        recallLabel={recallingPlanningId === r.id ? '…' : 'Send Back'}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </EnterpriseTableShell>
        </section>
        )}
      </div>

      {activeRowDrawer
        ? (() => {
            const spec = (activeRowDrawer.specOverrides || {}) as Record<string, unknown>
            const resolvedSheet = resolveAwSheetSizeFromRow(activeRowDrawer)
            const resolvedGsm = resolveAwGsmFromRow(activeRowDrawer)
            const designer = resolvePlanningDesignerName(spec, userById) || '-'
            const tooling = activeRowDrawer.readiness?.readyForProduction ? 'Ready' : 'Pending'
            const pr = activeRowDrawer.readiness?.pipelinePhase ?? '-'
            const badge = pipelineBadge(activeRowDrawer.readiness?.pipelinePhase)
            const checklist = drawerForm
              ? [
                  { label: 'Sheet size', field: 'sheetSize' as const, ok: drawerForm.sheetSize.trim().length > 0 },
                  { label: 'Set no', field: 'setNumber' as const, ok: drawerForm.setNumber.trim().length > 0 },
                  { label: 'Die number', field: 'dieNumber' as const, ok: drawerForm.dieNumber.trim().length > 0 },
                  { label: 'UPS', field: 'ups' as const, ok: Number.isFinite(Number(drawerForm.ups)) && Number(drawerForm.ups) > 0 },
                  { label: 'Artwork code', field: 'artworkCode' as const, ok: drawerForm.artworkCode.trim().length > 0 },
                  { label: 'Emboss block no', field: 'embossBlockNumber' as const, ok: drawerForm.embossBlockNumber.trim().length > 0 || !isEmbossingRequired(drawerForm.embossing) },
                ]
              : []
            const checklistOk = checklist.every((item) => item.ok)
            const readyCount = checklist.filter((item) => item.ok).length
            const totalChecklist = checklist.length
            const readinessPct = totalChecklist > 0 ? Math.round((readyCount / totalChecklist) * 100) : 0
            const firstMissingField = checklist.find((item) => !item.ok)?.field
            const modalStatus = activeRowDrawer.readiness?.prePressFinalized
              ? 'Finalized'
              : checklistOk
                ? 'Awaiting Push'
                : badge.label
            const inputClass = 'h-9 w-full rounded-ds-sm border border-ds-line/40 bg-ds-main px-3 text-xs text-ds-ink outline-none transition focus:border-ds-brand/60 focus:ring-2 focus:ring-ds-brand/15'
            const missingInputClass = 'border-[var(--error)]/70 bg-[var(--error-bg)]/20 focus:border-[var(--error)] focus:ring-[var(--error)]/15'
            const fieldLabelClass = 'space-y-1.5 text-[11px] font-medium text-ds-ink-muted'
            const inputStateClass = (field: keyof DrawerForm) =>
              highlightMissingFields && checklist.some((item) => item.field === field && !item.ok)
                ? `${inputClass} ${missingInputClass}`
                : inputClass
            const summaryItems = [
              ['Sheet Size', resolvedSheet || '-'],
              ['Qty', activeRowDrawer.quantity?.toLocaleString('en-IN') || '-'],
              ['Tooling', tooling],
              ['Board Type', activeRowDrawer.paperType || '-'],
              ['UPS', rowUpsDisplay(spec)],
              ['Pipeline', pr],
              ['Designer', designer],
              ['GSM', resolvedGsm != null ? String(resolvedGsm) : '-'],
              ['Job Card', activeRowDrawer.jobCard?.jobCardNumber ? `JC-${activeRowDrawer.jobCard.jobCardNumber}` : 'Not Created'],
            ]
            const fileUrl = activeRowDrawer.jobCard?.fileUrl || activeRowDrawer.artworkPreviewUrl || null
            const fileName = fileNameFromUrl(fileUrl)
            const saveStateLabel = drawerSaving ? 'Saving…' : drawerHasUnsavedChanges ? 'Unsaved changes' : 'Saved'
            const saveStateClass = drawerSaving
              ? 'bg-[var(--info-bg)] text-[var(--info)] ring-[var(--info)]/25'
              : drawerHasUnsavedChanges
                ? 'bg-[var(--warning-bg)] text-[var(--warning)] ring-[var(--warning)]/25'
                : 'bg-[var(--success-bg)] text-[var(--success)] ring-[var(--success)]/25'
            const smartBadges = [
              { label: 'Summary', value: checklistOk ? 'Ready' : 'Missing Info', ok: checklistOk },
              { label: 'Artwork', value: fileUrl ? 'Uploaded' : 'Pending', ok: !!fileUrl },
              { label: 'Tooling', value: activeRowDrawer.readiness?.readyForProduction ? 'Ready' : 'Pending', ok: !!activeRowDrawer.readiness?.readyForProduction },
              { label: 'Job Card', value: activeRowDrawer.jobCard || activeRowDrawer.jobCardNumber ? 'Linked' : 'Not Linked', ok: !!(activeRowDrawer.jobCard || activeRowDrawer.jobCardNumber) },
            ]
            const notes = [
              typeof activeRowDrawer.remarks === 'string' ? activeRowDrawer.remarks.trim() : '',
              typeof spec.notes === 'string' ? spec.notes.trim() : '',
              typeof spec.note === 'string' ? spec.note.trim() : '',
              typeof spec.awNotes === 'string' ? spec.awNotes.trim() : '',
            ].filter(Boolean)
            const activityEvents = [
              {
                label: 'Created',
                detail: activeRowDrawer.po.customer.name || 'System',
                date: formatAwModalDate(activeRowDrawer.createdAt),
                tone: 'bg-ds-brand/10 text-ds-brand ring-ds-brand/20',
              },
              ...(fileUrl
                ? [{
                    label: 'Artwork Uploaded',
                    detail: fileName,
                    date: '',
                    tone: 'bg-[var(--info-bg)] text-[var(--info)] ring-[var(--info)]/20',
                  }]
                : []),
              {
                label: modalStatus,
                detail: activeRowDrawer.readiness?.plateFlowStatus || activeRowDrawer.planningStatus || 'Current stage',
                date: formatAwModalDate(
                  (spec.prePressSentToPlateHubAt as string | undefined) ||
                  (spec.prePressFinalizedAt as string | undefined) ||
                  null,
                ),
                tone: checklistOk ? 'bg-[var(--success-bg)] text-[var(--success)] ring-[var(--success)]/20' : 'bg-[var(--warning-bg)] text-[var(--warning)] ring-[var(--warning)]/20',
              },
            ]

            return (
              <GlobalPopoutModal
                isOpen={true}
                onClose={closeActiveRowModal}
                title={
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-ds-lg bg-ds-brand/10 text-ds-brand ring-1 ring-ds-brand/15">
                      <ClipboardList className="h-5 w-5" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate text-lg font-semibold text-ds-ink">Artwork Queue Details</span>
                        <span className={`${badge.className} ${badge.pulse ? 'animate-pulse' : ''}`}>{modalStatus}</span>
                        <span className="rounded-full bg-ds-brand/10 px-2.5 py-1 text-xs font-semibold text-ds-brand ring-1 ring-ds-brand/20">
                          {readyCount}/{totalChecklist} Ready · {readinessPct}%
                        </span>
                        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${saveStateClass}`}>
                          {saveStateLabel}
                        </span>
                      </span>
                    </span>
                  </div>
                }
                metadata={
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ds-ink-muted">
                    <span>Job Card: <span className={`${mono} text-ds-ink`}>{activeRowDrawer.jobCard?.jobCardNumber ? `JC-${activeRowDrawer.jobCard.jobCardNumber}` : activeRowDrawer.jobCardNumber ? `JC-${activeRowDrawer.jobCardNumber}` : 'Not Created'}</span></span>
                    <span aria-hidden>•</span>
                    <span>PO: <span className={`${mono} text-ds-ink`}>{activeRowDrawer.po.poNumber || '-'}</span></span>
                    <span aria-hidden>•</span>
                    <span className="max-w-[42rem] truncate">Carton: <span className="text-ds-ink">{activeRowDrawer.cartonName || '-'}</span></span>
                  </div>
                }
                size="xl"
                mode="preview"
                hasUnsavedChanges={drawerHasUnsavedChanges}
                bodyClassName="bg-ds-card px-4 py-4 text-xs md:px-5"
                widthClass="sm:w-[88vw] sm:max-w-[1220px]"
                zIndexClass="z-[1200]"
                footer={
                  <div className="flex w-full flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-ds-sm bg-ds-main px-3 py-2 text-[11px] text-ds-ink-muted">
                      <span>Job Card <span className={`${mono} text-ds-ink`}>{activeRowDrawer.jobCard?.jobCardNumber ? `JC-${activeRowDrawer.jobCard.jobCardNumber}` : activeRowDrawer.jobCardNumber ? `JC-${activeRowDrawer.jobCardNumber}` : 'Not Linked'}</span></span>
                      <span>Qty <span className={`${mono} text-ds-ink`}>{activeRowDrawer.quantity?.toLocaleString('en-IN') || '-'}</span></span>
                      <span>Sheet <span className={`${mono} text-ds-ink`}>{resolvedSheet || '-'}</span></span>
                      <span>Status <span className="font-medium text-ds-ink">{modalStatus}</span></span>
                      <span className={`ml-auto rounded-full px-2 py-0.5 font-semibold ring-1 ${saveStateClass}`}>{saveStateLabel}</span>
                    </div>
                    <div className="flex gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
                      <Button
                        className="h-9 shrink-0 px-4 text-xs font-semibold"
                        onClick={() => {
                          if (!checklistOk) {
                            setHighlightMissingFields(true)
                            if (firstMissingField) focusDrawerField(firstMissingField)
                            return
                          }
                          setShowPushAllConfirm(true)
                        }}
                        disabled={drawerPushAllBusy}
                      >
                        <Send className="h-3.5 w-3.5" aria-hidden />
                        {drawerPushAllBusy ? 'Pushing…' : 'Push All'}
                      </Button>
                      <Button
                        variant="secondary"
                        className="h-9 shrink-0 px-4 text-xs"
                        onClick={() => void pushJobCardFromList(activeRowDrawer)}
                        disabled={jobCardPushingId === activeRowDrawer.id || !canPushJobCardRow(activeRowDrawer)}
                      >
                        <ClipboardList className="h-3.5 w-3.5" aria-hidden />
                        {jobCardPushingId === activeRowDrawer.id ? 'Pushing…' : 'Push to Job Card'}
                      </Button>
                      <Button
                        variant="secondary"
                        className="h-9 shrink-0 px-4 text-xs"
                        onClick={() => void finalizeFromList(activeRowDrawer)}
                      >
                        <FileText className="h-3.5 w-3.5" aria-hidden />
                        Push to Plate Hub
                      </Button>
                      <Button
                        variant="secondary"
                        className="h-9 shrink-0 px-4 text-xs"
                        onClick={() => void pushToolingFromList(activeRowDrawer, 'DIE')}
                      >
                        <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                        Push to Die Hub
                      </Button>
                      <Button
                        variant="secondary"
                        className="h-9 shrink-0 px-4 text-xs"
                        onClick={() => void pushToolingFromList(activeRowDrawer, 'BLOCK')}
                      >
                        <Layers className="h-3.5 w-3.5" aria-hidden />
                        Push to Emboss Hub
                      </Button>
                      <Button
                        variant="secondary"
                        className="h-9 shrink-0 px-4 text-xs"
                        onClick={() => window.open('/hub/shade-card-hub', '_blank', 'noopener,noreferrer')}
                      >
                        <FileDown className="h-3.5 w-3.5" aria-hidden />
                        Push to Shade Card Hub
                      </Button>
                    </div>
                  </div>
                }
              >
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
                  <div className="min-w-0 space-y-4">
                    <section className="rounded-ds-lg border border-ds-line/35 bg-ds-card p-4 shadow-ds-depth-sm">
                      <div className="mb-4 flex flex-wrap items-center gap-2">
                        <div className="mr-2 min-w-[8rem]">
                          <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-ds-ink-muted">
                            <span>Readiness</span>
                            <span className={`${mono} text-ds-ink`}>{readinessPct}%</span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ds-elevated">
                            <div className="h-full rounded-full bg-ds-brand transition-[width]" style={{ width: `${readinessPct}%` }} />
                          </div>
                        </div>
                        {smartBadges.map((item) => (
                          <span
                            key={item.label}
                            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${
                              item.ok
                                ? 'bg-[var(--success-bg)] text-[var(--success)] ring-[var(--success)]/20'
                                : 'bg-[var(--warning-bg)] text-[var(--warning)] ring-[var(--warning)]/20'
                            }`}
                          >
                            {item.label}: {item.value}
                          </span>
                        ))}
                      </div>
                      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
                        {summaryItems.map(([label, value]) => (
                          <div key={label} className="min-w-0">
                            <p className="text-[11px] font-medium text-ds-ink-muted">{label}</p>
                            <p className={`mt-1 truncate text-sm font-medium text-ds-ink ${label === 'Qty' || label === 'GSM' || label === 'UPS' ? mono : ''}`}>{value}</p>
                          </div>
                        ))}
                      </div>
                    </section>

                  {drawerForm ? (
                    <section className="rounded-ds-lg border border-ds-line/35 bg-ds-card shadow-ds-depth-sm">
                      <div className="border-b border-ds-line/30 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ds-ink-muted">AW Push Readiness Checklist</p>
                          <ShieldCheck className="h-4 w-4 text-ds-brand" aria-hidden />
                        </div>
                        <div className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2">
                          {checklist.map((item) => (
                            <button
                              key={item.label}
                              type="button"
                              onClick={() => {
                                if (!item.ok) {
                                  setHighlightMissingFields(true)
                                  focusDrawerField(item.field)
                                }
                              }}
                              className={`flex items-center gap-2 rounded-ds-sm px-1 py-0.5 text-left transition ${
                                item.ok ? 'cursor-default' : 'hover:bg-[var(--error-bg)]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--error)]/20'
                              }`}
                              aria-label={item.ok ? `${item.label} ready` : `Focus missing ${item.label} field`}
                            >
                              {item.ok ? (
                                <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--success)]" aria-hidden />
                              ) : (
                                <AlertCircle className="h-4 w-4 shrink-0 text-[var(--error)]" aria-hidden />
                              )}
                              <span className={item.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}>{item.label}</span>
                            </button>
                          ))}
                        </div>
                        {!checklistOk ? (
                          <p className="mt-4 text-[11px] font-medium text-[var(--error)]">Complete all required fields before Push All.</p>
                        ) : null}
                      </div>

                      <div className="space-y-3 p-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ds-ink-muted">Editable Carton & Specs</p>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className={fieldLabelClass}><span>Carton</span><input ref={(el) => { drawerFieldRefs.current.cartonName = el }} value={drawerForm.cartonName} onChange={(e) => setDrawerForm((prev) => prev ? ({ ...prev, cartonName: e.target.value }) : prev)} className={inputStateClass('cartonName')} /></label>
                          <label className={fieldLabelClass}><span>Carton Size</span><input ref={(el) => { drawerFieldRefs.current.cartonSize = el }} value={drawerForm.cartonSize} onChange={(e) => setDrawerForm((prev) => prev ? ({ ...prev, cartonSize: e.target.value }) : prev)} className={inputStateClass('cartonSize')} /></label>
                          <label className={fieldLabelClass}><span>Qty</span><input ref={(el) => { drawerFieldRefs.current.quantity = el }} value={drawerForm.quantity} onChange={(e) => setDrawerForm((prev) => prev ? ({ ...prev, quantity: e.target.value }) : prev)} className={inputStateClass('quantity')} /></label>
                          <label className={fieldLabelClass}><span>Sheet Size</span><input ref={(el) => { drawerFieldRefs.current.sheetSize = el }} value={drawerForm.sheetSize} onChange={(e) => setDrawerForm((prev) => prev ? ({ ...prev, sheetSize: e.target.value }) : prev)} className={inputStateClass('sheetSize')} /></label>
                          <label className={fieldLabelClass}><span>UPS</span><input ref={(el) => { drawerFieldRefs.current.ups = el }} value={drawerForm.ups} onChange={(e) => setDrawerForm((prev) => prev ? ({ ...prev, ups: e.target.value }) : prev)} className={inputStateClass('ups')} /></label>
                          <label className={fieldLabelClass}><span>Board Type</span><input ref={(el) => { drawerFieldRefs.current.boardType = el }} value={drawerForm.boardType} onChange={(e) => setDrawerForm((prev) => prev ? ({ ...prev, boardType: e.target.value }) : prev)} className={inputStateClass('boardType')} /></label>
                          <label className={fieldLabelClass}><span>GSM</span><input ref={(el) => { drawerFieldRefs.current.gsm = el }} value={drawerForm.gsm} onChange={(e) => setDrawerForm((prev) => prev ? ({ ...prev, gsm: e.target.value }) : prev)} className={inputStateClass('gsm')} /></label>
                          <label className={fieldLabelClass}><span>Coating</span><input ref={(el) => { drawerFieldRefs.current.coating = el }} value={drawerForm.coating} onChange={(e) => setDrawerForm((prev) => prev ? ({ ...prev, coating: e.target.value }) : prev)} className={inputStateClass('coating')} /></label>
                          <label className={fieldLabelClass}><span>Emboss / Foil</span><input ref={(el) => { drawerFieldRefs.current.embossing = el }} value={drawerForm.embossing} onChange={(e) => setDrawerForm((prev) => prev ? ({ ...prev, embossing: e.target.value }) : prev)} className={inputStateClass('embossing')} /></label>
                          <label className={fieldLabelClass}><span>Colour / Spec</span><input ref={(el) => { drawerFieldRefs.current.colorSpec = el }} value={drawerForm.colorSpec} onChange={(e) => setDrawerForm((prev) => prev ? ({ ...prev, colorSpec: e.target.value }) : prev)} className={inputStateClass('colorSpec')} /></label>
                          <label className={fieldLabelClass}><span>Artwork Code</span><input ref={(el) => { drawerFieldRefs.current.artworkCode = el }} value={drawerForm.artworkCode} onChange={(e) => setDrawerForm((prev) => prev ? ({ ...prev, artworkCode: e.target.value }) : prev)} className={inputStateClass('artworkCode')} /></label>
                          <label className={fieldLabelClass}>
                            <span>Set Number</span>
                            <div className="flex gap-2">
                              <input ref={(el) => { drawerFieldRefs.current.setNumber = el }} value={drawerForm.setNumber} onChange={(e) => setDrawerForm((prev) => prev ? ({ ...prev, setNumber: e.target.value }) : prev)} className={inputStateClass('setNumber')} />
                              <button type="button" className="h-9 rounded-ds-sm border border-ds-line/40 px-2 text-[11px] text-ds-brand hover:bg-ds-brand/10" onClick={() => setDrawerForm((prev) => prev ? ({ ...prev, setNumber: autoSetNumber(activeRowDrawer.id) }) : prev)}>Auto</button>
                            </div>
                          </label>
                          <label className={fieldLabelClass}><span>Die Number</span><input ref={(el) => { drawerFieldRefs.current.dieNumber = el }} value={drawerForm.dieNumber} onChange={(e) => setDrawerForm((prev) => prev ? ({ ...prev, dieNumber: e.target.value }) : prev)} className={inputStateClass('dieNumber')} /></label>
                          <label className={fieldLabelClass}><span>Emboss Block Number</span><input ref={(el) => { drawerFieldRefs.current.embossBlockNumber = el }} value={drawerForm.embossBlockNumber} onChange={(e) => setDrawerForm((prev) => prev ? ({ ...prev, embossBlockNumber: e.target.value }) : prev)} className={inputStateClass('embossBlockNumber')} /></label>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          <Button variant="secondary" className="h-9 px-3 text-xs" onClick={() => void saveDrawerDetails()} disabled={drawerSaving}>
                            {drawerSaving ? 'Saving…' : 'Save Details'}
                          </Button>
                          <Button
                            variant="secondary"
                            className="h-9 px-3 text-xs"
                            onClick={() => void recallPlanning(activeRowDrawer)}
                            disabled={recallingPlanningId === activeRowDrawer.id || !canRecallPlanningRow(activeRowDrawer, spec)}
                          >
                            {recallingPlanningId === activeRowDrawer.id ? 'Sending…' : 'Send Back to Planning'}
                          </Button>
                        </div>
                      </div>
                    </section>
                  ) : null}

                  <section className="space-y-2 rounded-ds-lg border border-ds-line/35 bg-ds-card p-4 shadow-ds-depth-sm">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ds-ink-muted">Tooling Push Tracker</p>
                    <div className="grid gap-2 sm:grid-cols-5">
                      {(['plate', 'die', 'emboss', 'shade', 'jobCard'] as DrawerPushStep[]).map((step) => {
                        const state = drawerPushStates[step]
                        const label = step === 'jobCard' ? 'Job Card' : step.charAt(0).toUpperCase() + step.slice(1)
                        const cls =
                          state === 'ok'
                            ? 'bg-[var(--success-bg)] text-[var(--success)]'
                            : state === 'failed'
                              ? 'bg-[var(--error-bg)] text-[var(--error)]'
                              : state === 'skipped'
                                ? 'bg-ds-elevated/20 text-ds-ink-faint'
                                : 'bg-ds-main text-ds-ink-faint'
                        return (
                          <div key={step} className={`rounded-ds-sm px-2 py-1.5 text-center text-[11px] ${cls}`}>
                            {label}: {state}
                          </div>
                        )
                      })}
                    </div>
                    {Object.values(drawerPushStates).some((s) => s === 'failed') ? (
                      <div className="rounded-ds-sm bg-[var(--error-bg)] p-2">
                        <p className="mb-1 text-[11px] font-medium text-[var(--error)]">Failure Recovery</p>
                        <div className="flex flex-wrap gap-1.5">
                          {(Object.entries(drawerPushStates) as [DrawerPushStep, DrawerPushState][])
                            .filter(([, s]) => s === 'failed')
                            .map(([step]) => (
                              <button
                                key={step}
                                type="button"
                                className="rounded px-2 py-1 text-[11px] text-[var(--error)] hover:bg-[var(--error-bg)]"
                                onClick={() => void retryDrawerStep(step)}
                              >
                                Retry {step}
                              </button>
                            ))}
                        </div>
                        <p className="mt-1 text-[11px] text-[var(--error)]">
                          {Object.entries(drawerPushErrors)
                            .map(([k, v]) => `${k}: ${v}`)
                            .join(' • ')}
                        </p>
                      </div>
                    ) : null}
                  </section>
                  </div>
                  <aside className="min-w-0 space-y-3">
                    <section className="rounded-ds-lg border border-ds-line/35 bg-ds-card p-4 shadow-ds-depth-sm">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ds-ink-muted">Activity Timeline</p>
                      <div className="mt-4 space-y-4">
                        {activityEvents.map((event, index) => (
                          <div key={`${event.label}-${index}`} className="relative flex gap-3">
                            {index < activityEvents.length - 1 ? <span className="absolute left-[15px] top-8 h-[calc(100%+0.5rem)] w-px bg-ds-line/40" aria-hidden /> : null}
                            <span className={`relative z-[1] flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ${event.tone}`}>
                              {event.label === 'Created' ? <ClipboardList className="h-3.5 w-3.5" aria-hidden /> : event.label === 'Artwork Uploaded' ? <FileText className="h-3.5 w-3.5" aria-hidden /> : <AlertCircle className="h-3.5 w-3.5" aria-hidden />}
                            </span>
                            <div className="min-w-0 pt-0.5">
                              <p className="truncate text-xs font-semibold text-ds-ink">{event.label}</p>
                              <p className="mt-0.5 text-[11px] text-ds-ink-muted">
                                {event.detail}
                                {event.date ? <span className={`${mono}`}> · {event.date}</span> : null}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>

                    <section className="rounded-ds-lg border border-ds-line/35 bg-ds-card p-4 shadow-ds-depth-sm">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ds-ink-muted">Files{fileUrl ? ' (1)' : ''}</p>
                        {fileUrl ? <a href={fileUrl} target="_blank" rel="noreferrer" className="text-[11px] font-medium text-ds-brand hover:underline">View</a> : null}
                      </div>
                      {fileUrl ? (
                        <div className="mt-4 flex items-center gap-3 rounded-ds-sm border border-ds-line/30 bg-ds-main p-3">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-ds-sm bg-[var(--error-bg)] text-[var(--error)]">
                            <FileText className="h-4 w-4" aria-hidden />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-semibold text-ds-ink">{fileName}</p>
                            <p className="mt-0.5 text-[11px] text-ds-ink-muted">Linked artwork file</p>
                          </div>
                          <a href={fileUrl} target="_blank" rel="noreferrer" className="rounded-ds-sm p-1 text-ds-ink-muted hover:bg-ds-elevated hover:text-ds-ink" aria-label="Open file">
                            <MoreVertical className="h-4 w-4" aria-hidden />
                          </a>
                        </div>
                      ) : (
                        <div className="mt-4 rounded-ds-sm border border-dashed border-ds-line/40 bg-ds-main p-5 text-center text-[11px] text-ds-ink-muted">
                          <FileText className="mx-auto h-6 w-6 text-ds-ink-faint" aria-hidden />
                          <p className="mt-2">No artwork files attached yet.</p>
                        </div>
                      )}
                    </section>

                    <section className="rounded-ds-lg border border-ds-line/35 bg-ds-card p-4 shadow-ds-depth-sm">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ds-ink-muted">Notes</p>
                        <button type="button" disabled className="inline-flex items-center gap-1 text-[11px] font-medium text-ds-ink-faint disabled:cursor-not-allowed" title="Notes are not wired for AW Queue yet">
                          <Plus className="h-3 w-3" aria-hidden />
                          Add Note
                        </button>
                      </div>
                      {notes.length > 0 ? (
                        <div className="mt-4 space-y-2">
                          {notes.map((note, index) => (
                            <div key={`${note}-${index}`} className="rounded-ds-sm bg-ds-main p-3 text-xs leading-relaxed text-ds-ink">{note}</div>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-4 rounded-ds-sm bg-ds-main p-6 text-center text-[11px] text-ds-ink-muted">
                          <FileText className="mx-auto h-7 w-7 text-ds-ink-faint" aria-hidden />
                          <p className="mt-3 font-medium text-ds-ink">No notes added yet.</p>
                          <p className="mt-1">Notes storage is not connected for this AW Queue item.</p>
                        </div>
                      )}
                    </section>
                  </aside>
                </div>
              </GlobalPopoutModal>
            )
          })()
        : null}

      <GlobalPopoutModal
        isOpen={showDiscardModal}
        onClose={() => setShowDiscardModal(false)}
        title="Discard changes?"
        size="sm"
        mode="preview"
        zIndexClass="z-[1300]"
        footer={
          <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" className="h-9" onClick={() => setShowDiscardModal(false)}>
              Continue editing
            </Button>
            <Button variant="danger" className="h-9" onClick={discardActiveRowChanges}>
              Discard changes
            </Button>
          </div>
        }
      >
        <p className="text-sm leading-relaxed text-ds-ink-muted">
          You have unsaved AW Queue detail edits. Discarding will close the modal without saving those changes.
        </p>
      </GlobalPopoutModal>

      <GlobalPopoutModal
        isOpen={showPushAllConfirm}
        onClose={() => setShowPushAllConfirm(false)}
        title="Confirm Push All"
        size="sm"
        mode="preview"
        zIndexClass="z-[1300]"
        footer={
          <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" className="h-9" onClick={() => setShowPushAllConfirm(false)}>
              Review first
            </Button>
            <Button
              className="h-9"
              onClick={() => {
                setShowPushAllConfirm(false)
                void pushAllFromDrawer()
              }}
              disabled={drawerPushAllBusy}
            >
              <Send className="h-3.5 w-3.5" aria-hidden />
              {drawerPushAllBusy ? 'Pushing…' : 'Push All'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm leading-relaxed text-ds-ink-muted">
          <p>
            This will save the current AW details, then push this item to the configured downstream hubs.
          </p>
          <p className="rounded-ds-sm bg-ds-main p-3 text-xs text-ds-ink">
            Job Card, Plate Hub, Die Hub, Shade Card Hub
            {drawerForm && isEmbossingRequired(drawerForm.embossing) ? ', Emboss Hub' : ''}
          </p>
        </div>
      </GlobalPopoutModal>

      <LightboxModal
        src={lightbox?.src ?? null}
        alt={lightbox?.alt ?? ''}
        onClose={() => setLightbox(null)}
      />

      {activeGroupEdit && (
        <AwGroupEditDrawer
          groupId={activeGroupEdit.groupId}
          rows={activeGroupEdit.rows}
          users={users}
          isOpen={true}
          onClose={() => setActiveGroupEdit(null)}
          onRefresh={() => { void load() }}
        />
      )}
    </div>
  )
}
