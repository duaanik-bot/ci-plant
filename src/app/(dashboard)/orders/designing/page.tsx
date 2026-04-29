'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronUp,
  FileDown,
  ImageOff,
  Layers,
  Pencil,
  Search,
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
import { formatShortTimeAgo } from '@/lib/time-ago'
import { isEmbossingRequired } from '@/lib/emboss-conditions'
import {
  ACTION_PILL_NEUTRAL,
  ICON_BUTTON_BASE,
  ICON_BUTTON_TIGHT,
  PUSHED_CHIP_CLASS,
  STATUS_CHIP_BASE,
} from '@/components/design-system/tokens'
import { BulkActionBar, LaneCounterChips } from '@/components/design-system'
import { EnterpriseTableShell } from '@/components/ui/EnterpriseTableShell'
import { RowStateLegend } from '@/components/ui/RowStateLegend'
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
  artworkCode?: string | null
  quantity: number
  paperType: string | null
  coatingType: string | null
  embossingLeafing: string | null
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
  materialQueue?: { totalSheets: number } | null
}

type Customer = { id: string; name: string; logoUrl?: string | null }
type User = { id: string; name: string }

/** AW queue designer column filter. */
type DesignerFilterValue = 'all' | 'unassigned' | string

const mono = 'font-designing-queue tabular-nums tracking-tight'
const PREPRESS_AUDIT_LEAD = DEFAULT_PREPRESS_AUDIT_LEAD
const BRAND_ORANGE = '#f97316'

function daysInQueue(createdAtIso: string): number {
  const d = new Date(createdAtIso)
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const t = new Date()
  const end = new Date(t.getFullYear(), t.getMonth(), t.getDate())
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000))
}

function ageClass(days: number): string {
  if (days <= 3) return 'text-emerald-400'
  if (days <= 7) return 'text-ds-warning'
  return 'text-rose-400 animate-po-age-alert'
}

function pipelineBadge(phase: Row['readiness']['pipelinePhase']) {
  const base = `${STATUS_CHIP_BASE} gap-1 ring-1`
  switch (phase) {
    case 'finalized':
      return {
        label: 'Finalized',
        className: `${base} bg-emerald-500/15 text-emerald-700 ring-emerald-500/35 dark:bg-emerald-500/20 dark:text-emerald-200`,
        pulse: false,
      }
    case 'revision':
      return {
        label: 'Revision required',
        className: `${base} bg-rose-500/12 text-rose-700 ring-rose-500/30 dark:bg-rose-500/20 dark:text-rose-200`,
        pulse: false,
      }
    case 'awaiting_client':
      return {
        label: 'Awaiting client',
        className: `${base} bg-blue-500/12 text-blue-700 ring-blue-500/30 dark:bg-blue-500/20 dark:text-blue-200`,
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
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold tabular-nums ring-1 ring-ring/15"
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
  disablePushJobCard?: boolean
  disablePushPlate?: boolean
  disableRecall?: boolean
  pushJobCardLabel?: string
  pushPlateLabel?: string
  recallLabel?: string
}) {
  return (
    <div className="flex items-center gap-2 justify-end">
      <button
        onClick={onPushJobCard}
        disabled={disablePushJobCard}
        className="px-3 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition disabled:opacity-40"
      >
        {pushJobCardLabel ?? 'Push Job Card'}
      </button>

      <div className="relative group">
        <button
          type="button"
          className="px-3 py-1.5 text-sm rounded-md border border-[var(--border)] text-[var(--text-primary)]"
        >
          Push to Hubs ▾
        </button>

        <div className="absolute right-0 mt-2 w-56 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border)] shadow-lg hidden group-hover:block z-50">
          <div className="p-2 flex flex-col gap-1">
            <button
              onClick={onPushPlate}
              disabled={disablePushPlate}
              className="text-left px-3 py-2 rounded hover:bg-[var(--accent)]/10 disabled:opacity-40"
            >
              {pushPlateLabel ?? 'Plates'}
            </button>

            <button
              onClick={onPushEmboss}
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
              onClick={onPushShadeCard}
              className="text-left px-3 py-2 rounded hover:bg-[var(--accent)]/10"
            >
              Shade Card
            </button>

            <div className="border-t border-[var(--border)] my-2" />

            <button
              onClick={onRecallPlanning}
              disabled={disableRecall}
              className="text-left px-3 py-2 rounded text-[var(--warning)] hover:bg-[var(--warning)]/10 disabled:opacity-40"
            >
              Recall to Planning
            </button>
          </div>
        </div>
      </div>

      <button
        onClick={onRecallPlanning}
        disabled={disableRecall}
        className="px-3 py-1.5 text-sm rounded-md border border-[var(--border)] text-[var(--warning)] hover:bg-[var(--warning)]/10 disabled:opacity-40"
      >
        {recallLabel ?? 'Recall'}
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
  const inputCls = `h-9 w-full min-w-[14rem] rounded border border-ds-brand/35 bg-ds-main/95 px-9 pr-3 text-[13px] font-medium text-ds-ink shadow-sm transition focus:border-ds-brand focus:outline-none focus:ring-2 focus:ring-ds-brand/30 ${mono}`
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
          className={`shrink-0 rounded border border-ds-line/60 bg-ds-main px-2.5 text-[12px] text-ds-ink-faint hover:border-ds-brand/40 hover:text-ds-brand transition-colors ${mono}`}
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
    'h-12 w-12 shrink-0 overflow-hidden rounded-[4px] border border-ds-line/50 bg-background'

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
              <div className="h-[144px] w-[144px] overflow-hidden rounded-[4px] border border-ds-line/50 shadow-2xl ring-1 ring-ring/50">
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

function canRecallPlanningRow(r: Row, spec: Record<string, unknown>): boolean {
  const machineAllocated = !!String(spec.machineId || '').trim()
  return !!r.readiness?.planningForwarded && !machineAllocated && !['in_production', 'closed'].includes(r.planningStatus)
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

async function pushJobCardOnlyRow(r: Row): Promise<JobCardOnlyResult> {
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
    }),
  })
  const json = (await res.json().catch(() => ({}))) as { error?: string; idempotent?: boolean }
  if (!res.ok) return { ok: false, error: json.error || `Job card (${res.status})` }
  return { ok: true, idempotent: json.idempotent === true || res.status === 200 }
}

function canPushToolingHubRow(r: Row): boolean {
  const setN = (r.setNumber || '').trim()
  const aw = (r.artworkCode || '').trim()
  if (!setN || !aw) return false
  const spec = (r.specOverrides || {}) as Record<string, unknown>
  if (readAwPoStatus(spec) === AW_PO_STATUS.CLOSED) return false
  const planningCore = readPlanningCore(spec)
  const len = Number(spec.sheetLengthMm)
  const wid = Number(spec.sheetWidthMm)
  const hasSheet =
    (Number.isFinite(len) && Number.isFinite(wid) && len > 0 && wid > 0) ||
    (typeof planningCore.actualSheetSizeLabel === 'string' && planningCore.actualSheetSizeLabel.trim().length > 0)
  return hasSheet
}

function hasToolingSheetSize(spec: Record<string, unknown>): boolean {
  const planningCore = readPlanningCore(spec)
  const len = Number(spec.sheetLengthMm)
  const wid = Number(spec.sheetWidthMm)
  return (
    (Number.isFinite(len) && Number.isFinite(wid) && len > 0 && wid > 0) ||
    (typeof planningCore.actualSheetSizeLabel === 'string' && planningCore.actualSheetSizeLabel.trim().length > 0)
  )
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
  const core = readPlanningCore(spec)
  const meta = readPlanningMeta(spec)
  const raw = spec.ups ?? spec.numberOfUps ?? core.ups ?? meta.ups
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) return String(Math.floor(raw))
  return '—'
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
            className={`h-3 w-3 shrink-0 ${active && dir === 'asc' ? 'text-blue-600 dark:text-ds-warning' : 'text-ds-ink-faint dark:text-ds-ink-faint'}`}
            strokeWidth={2}
          />
          <ChevronDown
            className={`h-3 w-3 shrink-0 ${active && dir === 'desc' ? 'text-blue-600 dark:text-ds-warning' : 'text-ds-ink-faint dark:text-ds-ink-faint'}`}
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
        className="absolute right-3 top-3 rounded-lg border border-border bg-card p-2 text-ds-ink-muted hover:text-foreground"
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
  const [designerFilter, setDesignerFilter] = useState<DesignerFilterValue>('all')
  const [expandedAwGroups, setExpandedAwGroups] = useState<Set<string>>(new Set())
  const [activeGroupEdit, setActiveGroupEdit] = useState<{ groupId: string; rows: Row[] } | null>(null)
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set())
  const [bulkPushing, setBulkPushing] = useState(false)
  const [bulkToolingPushing, setBulkToolingPushing] = useState<null | 'DIE' | 'BLOCK'>(null)
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null)
  const [jobCardFilter, setJobCardFilter] = useState<'all' | 'pending'>('all')

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams()
      if (customerId) qs.set('customerId', customerId)
      if (myJobsOnly) qs.set('myJobs', '1')
      const [custRes, usersRes, linesRes] = await Promise.all([
        fetch('/api/masters/customers'),
        fetch('/api/users'),
        fetch(`/api/designing/po-lines?${qs.toString()}`),
      ])
      const custJson = await custRes.json()
      const usersJson = await usersRes.json()
      const json = await linesRes.json()
      setCustomers(Array.isArray(custJson) ? custJson : [])
      setUsers(Array.isArray(usersJson) ? usersJson : [])
      setRows(Array.isArray(json) ? json : [])
    } catch {
      toast.error('Failed to load designing queue')
    } finally {
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
    if (jobCardFilter === 'pending') {
      list = list.filter((r) => awJobCardState(r) === 'pending')
    }
    return list
  }, [rows, awSearchQuery, designerFilter, userById, jobCardFilter])

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
    if (jobCardFilter === 'pending') {
      chips.push({ key: 'job-card', label: 'Job card: Pending', onClear: () => setJobCardFilter('all') })
    }
    if (customerId) {
      const c = customers.find((x) => x.id === customerId)
      chips.push({ key: 'customer', label: `Customer: ${c?.name || customerId}`, onClear: () => setCustomerId('') })
    }
    if (myJobsOnly) chips.push({ key: 'my-jobs', label: 'My jobs only', onClear: () => setMyJobsOnly(false) })
    return chips
  }, [awSearchQuery, designerFilter, customerId, myJobsOnly, customers, jobCardFilter])

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
      toast.success('Returned to Planning', {
        action: {
          label: 'View Planning',
          onClick: () => router.push('/orders/planning?view=pending'),
        },
      })
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
        toast.success(`Returned to Planning • ${success} item${success > 1 ? 's' : ''}`, {
          action: {
            label: 'View Planning',
            onClick: () => router.push('/orders/planning?view=pending'),
          },
        })
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
        toast.error(jobCardError || 'Job card step failed', {
          description: 'Plate Hub / CTP side completed or was already sent — fix job card issue and retry',
        })
      } else if (!plateOk && jcOk) {
        toast.warning(plateError || 'Plate Hub step failed', {
          description: 'Job card was created — review Plate Hub push and retry if needed',
        })
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
      const out = await pushJobCardOnlyRow(r)
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
    const len = Number(spec.sheetLengthMm)
    const wid = Number(spec.sheetWidthMm)
    const actualSheetSize =
      Number.isFinite(len) && Number.isFinite(wid) && len > 0 && wid > 0
        ? `${Math.floor(len)}×${Math.floor(wid)} mm`
        : typeof planningCore.actualSheetSizeLabel === 'string' && planningCore.actualSheetSizeLabel.trim()
          ? planningCore.actualSheetSizeLabel.trim()
          : ''
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
          const len = Number(spec.sheetLengthMm)
          const wid = Number(spec.sheetWidthMm)
          const actualSheetSize =
            Number.isFinite(len) && Number.isFinite(wid) && len > 0 && wid > 0
              ? `${Math.floor(len)}×${Math.floor(wid)} mm`
              : typeof planningCore.actualSheetSizeLabel === 'string' && planningCore.actualSheetSizeLabel.trim()
                ? planningCore.actualSheetSizeLabel.trim()
                : ''
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
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-2 text-card-foreground md:hidden">
        <span className="truncate text-sm font-semibold text-neutral-900 dark:text-ds-ink">Artwork queue</span>
      </div>

      <div className="mx-auto max-w-[1600px] space-y-3 px-2 py-3 pb-10 sm:px-3">
        <div className="rounded-lg border border-ds-line/70 bg-ds-elevated/70 p-2 shadow-md ring-1 ring-ds-line/30">
        <div className="flex flex-col gap-1.5 md:flex-row md:flex-wrap md:items-center md:gap-2">
          <div className="min-w-0 flex-1 md:min-w-[14rem] md:max-w-xl">
            <NeonCommandFilterTrigger
              searchQuery={awSearchQuery}
              onQueryChange={setAwSearchQuery}
              onClearQuery={() => setAwSearchQuery('')}
            />
          </div>
          <div className="relative flex min-h-[36px] shrink-0 items-center md:min-w-[11rem]">
            <User
              className="pointer-events-none absolute left-2.5 top-1/2 z-[1] h-3.5 w-3.5 -translate-y-1/2 text-ds-ink-faint"
              aria-hidden
            />
            <ChevronDown
              className="pointer-events-none absolute right-2.5 top-1/2 z-[1] h-4 w-4 -translate-y-1/2 text-ds-ink-faint"
              aria-hidden
            />
            <select
              value={designerFilter}
              onChange={(e) => setDesignerFilter(e.target.value as DesignerFilterValue)}
              aria-label="Filter by designer"
              title="Filter by planning designer — All, Unassigned, or planning names"
              className={`h-9 w-full min-w-[12rem] appearance-none rounded border border-ds-brand/35 bg-ds-main/95 py-1.5 pl-8 pr-9 text-[13px] font-medium text-ds-ink shadow-sm outline-none transition focus:border-ds-brand focus:ring-2 focus:ring-ds-brand/30 md:min-w-[11rem] ${mono} ${
                designerFilter !== 'all' ? 'bg-ds-brand/8' : ''
              }`}
            >
              <option value="all">Filter by Designer…</option>
              <option value="unassigned">Unassigned</option>
              {planningDesignerOptions.map((name) => (
                <option key={name} value={`planning:${name}`}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>
        </div>

        <div className="rounded-lg border border-ds-line/40 bg-ds-elevated/20 px-2.5 py-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint ${mono}`}>Applied filters</span>
              {awFilterChips.length === 0 ? (
                <span className="text-[11px] text-ds-ink-faint">None</span>
              ) : (
                awFilterChips.map((chip) => (
                  <span
                    key={chip.key}
                    className="inline-flex items-center gap-1 rounded border border-ds-line/60 bg-ds-main/50 px-2 py-0.5 text-[11px] text-ds-ink"
                  >
                    {chip.label}
                    {chip.onClear ? (
                      <button
                        type="button"
                        onClick={chip.onClear}
                        className="text-ds-ink-faint hover:text-ds-ink"
                        title={`Clear ${chip.key} filter`}
                      >
                        ×
                      </button>
                    ) : null}
                  </span>
                ))
              )}
              {awFilterChips.length > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setAwSearchQuery('')
                    setDesignerFilter('all')
                    setCustomerId('')
                    setMyJobsOnly(false)
                    setJobCardFilter('all')
                  }}
                  className="rounded border border-ds-line/60 px-2 py-0.5 text-[11px] text-ds-ink-faint hover:text-ds-ink"
                >
                  Clear all
                </button>
              ) : null}
            </div>
            <RowStateLegend helperText="Priority rows are pinned. Plate-only rows stay in place (grey). Rows move to end only after job card is ensured (green)." />
          </div>
        </div>

        <LaneCounterChips
          chips={[
            {
              key: 'all',
              label: 'All',
              count: rows.length,
              active: jobCardFilter === 'all' && sortKey == null,
              onClick: () => {
                setJobCardFilter('all')
                setSortKey(null)
              },
              tone: 'brand',
            },
            {
              key: 'jc-pending',
              label: 'Job card pending',
              count: rows.filter((r) => awJobCardState(r) === 'pending').length,
              active: jobCardFilter === 'pending',
              onClick: () => setJobCardFilter((prev) => (prev === 'pending' ? 'all' : 'pending')),
              tone: 'warning',
            },
            {
              key: 'floor',
              label: 'On-Floor',
              count: rows.filter((r) => r.readiness?.pipelinePhase === 'awaiting_client').length,
              active: false,
              tone: 'info',
            },
            {
              key: 'revision',
              label: 'Revision',
              count: rows.filter((r) => r.readiness?.pipelinePhase === 'revision').length,
              active: false,
              tone: 'warning',
            },
            {
              key: 'finalized',
              label: 'Finalized',
              count: rows.filter((r) => isAwCompletedRow(r)).length,
              active: false,
              tone: 'success',
            },
          ]}
        />

        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-ds-line/40 bg-ds-elevated/10 px-2 py-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-ds-ink-muted">
            <span className="font-semibold text-ds-ink">AW queue</span>
            <span className="text-ds-ink-faint">·</span>
            <span>
              Ready <span className="font-semibold text-ds-warning">{readyCount}</span>/{rows.length}
            </span>
            <span className="hidden sm:inline text-ds-ink-faint">· {PREPRESS_AUDIT_LEAD}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className={`h-9 min-w-[8rem] max-w-[14rem] rounded-lg border border-border bg-card px-2 py-1 text-xs text-card-foreground ${mono}`}
          >
            <option value="">All customers</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setMyJobsOnly((o) => !o)}
            className={`h-9 rounded-lg border px-2.5 text-xs font-medium transition-colors ${mono} ${
              myJobsOnly
                ? 'border-emerald-500/50 bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200'
                : 'border-border bg-card text-ds-ink-faint hover:border-neutral-300 dark:text-ds-ink-muted dark:hover:border-ds-line/60'
            }`}
            title="Show only lines allocated to you in Planning"
          >
            My jobs
          </button>
        </div>

        <BulkActionBar
          selectedCount={selectedRowIds.size}
          left={
            <>
              <button
                type="button"
                onClick={() => setSelectedRowIds(new Set())}
                disabled={bulkPushing || bulkToolingPushing != null || selectedRowIds.size === 0}
                className="h-8 rounded-md border border-ds-line/60 px-2.5 text-xs font-medium text-ds-ink transition-colors hover:bg-ds-elevated/40 disabled:opacity-40"
              >
                Clear selection
              </button>
            </>
          }
          right={
            <>
              <button
                type="button"
                onClick={() => void bulkPushSelectedToPlateHub()}
                disabled={bulkPushing || bulkToolingPushing != null || selectedRowIds.size === 0}
                className="h-8 rounded-md border border-emerald-500/40 px-2.5 text-xs font-semibold text-emerald-800 transition-colors hover:bg-emerald-500/10 disabled:opacity-40 dark:text-emerald-200"
              >
                {bulkPushing ? 'Pushing…' : `Bulk Plate Hub${selectedRowIds.size > 0 ? ` (${selectedRowIds.size})` : ''}`}
              </button>
              <button
                type="button"
                onClick={() => void bulkPushSelectedToToolingHub('DIE')}
                disabled={bulkPushing || bulkToolingPushing != null || selectedRowIds.size === 0}
                className="h-8 rounded-md border border-violet-500/40 px-2.5 text-xs font-semibold text-violet-700 transition-colors hover:bg-violet-500/10 disabled:opacity-40 dark:text-violet-300"
              >
                {bulkToolingPushing === 'DIE'
                  ? 'Pushing…'
                  : `Bulk Die Hub${selectedRowIds.size > 0 ? ` (${selectedRowIds.size})` : ''}`}
              </button>
              <button
                type="button"
                onClick={() => void bulkPushSelectedToToolingHub('BLOCK')}
                disabled={bulkPushing || bulkToolingPushing != null || selectedRowIds.size === 0}
                className="h-8 rounded-md border border-orange-500/40 px-2.5 text-xs font-semibold text-orange-700 transition-colors hover:bg-orange-500/10 disabled:opacity-40 dark:text-orange-300"
              >
                {bulkToolingPushing === 'BLOCK'
                  ? 'Pushing…'
                  : `Bulk Emboss Hub${selectedRowIds.size > 0 ? ` (${selectedRowIds.size})` : ''}`}
              </button>
            </>
          }
        />
        <EnterpriseTableShell>
          <table className="w-full min-w-[1020px] table-fixed border-collapse text-left text-xs">
            <thead className="border-b border-border bg-card text-[10px] font-semibold uppercase tracking-wider text-ds-ink-faint dark:text-ds-ink-muted">
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
                <th className="w-[48px] px-2 py-2">Prv</th>
                <th className="min-w-[10rem] px-2 py-2">Carton / PO / Customer</th>
                <SortHeader
                  label="Qty"
                  column="qty"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={cycleSort}
                  className="w-11 text-right [&_button]:justify-end [&_button]:w-full"
                />
                <th className="w-[4.5rem] px-2 py-2">Designer</th>
                <th className="w-10 px-2 py-2 text-right">UPS</th>
                <th className="w-[5.5rem] px-2 py-2">Batch</th>
                <th className="w-[7rem] px-2 py-2">Status</th>
                <th className="w-[7.5rem] px-2 py-2">Job card</th>
                <th className="min-w-[10rem] px-2 py-2">Actions</th>
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
                    return !hasToolingSheetSize(rs)
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
                        className={`border-l-[3px] transition-colors ${
                          groupCompleted
                            ? 'border-emerald-500/70 bg-emerald-500/10 hover:bg-emerald-500/15 dark:bg-emerald-500/20 dark:hover:bg-emerald-500/24'
                            : groupPlatePushedPending
                              ? 'border-rose-300/70 bg-rose-500/5 hover:bg-rose-500/10 dark:bg-rose-500/10 dark:hover:bg-rose-500/16'
                              : groupJobCardOnly
                                  ? 'border-violet-300/70 bg-violet-500/5 hover:bg-violet-500/10 dark:bg-violet-500/10 dark:hover:bg-violet-500/16'
                              : 'border-sky-500/70 bg-sky-500/5 hover:bg-sky-500/8'
                        } ${priRow0 ? INDUSTRIAL_PRIORITY_ROW_CLASS : ''}`}
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
                          <div className="mb-0.5 inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/10 px-1 py-0.5 text-[9px] font-bold uppercase text-sky-600 dark:text-sky-300">
                            <Layers className="h-3 w-3 shrink-0" aria-hidden /> Gang · {groupRows.length}
                          </div>
                          <div className="flex min-w-0 items-center gap-1 text-[10px] text-ds-ink-muted">
                            <CustomerAvatar name={firstRow.po.customer.name} logoUrl={firstRow.po.customer.logoUrl} />
                            <span className="min-w-0 truncate">{firstRow.po.customer.name}</span>
                            <span className={`shrink-0 ${mono} text-ds-warning`}>{firstRow.po.poNumber}</span>
                          </div>
                          <div className="mt-0.5 flex min-w-0 flex-col gap-0.5">
                            {groupRows.map((r) => (
                              <span
                                key={r.id}
                                className={`min-w-0 truncate ${groupCompleted ? 'text-emerald-700 dark:text-emerald-300' : ''}`}
                                title={r.cartonName}
                              >
                                {r.cartonName}
                              </span>
                            ))}
                          </div>
                          <div className={`mt-0.5 text-[10px] ${mono} text-ds-ink-faint`}>
                            Set {firstRow.setNumber ?? '—'} · {dQ0}d
                          </div>
                        </td>
                        <td className={`px-2 py-1.5 align-middle text-right text-xs font-bold ${mono} text-ds-brand`}>
                          {totalQty.toLocaleString('en-IN')}
                        </td>
                        <td className="px-2 py-1.5 align-middle text-[10px] text-ds-ink-faint">{designerName0}</td>
                        <td className={`px-2 py-1.5 align-middle text-right text-xs ${mono} text-ds-ink`}>{groupUpsLabel}</td>
                        <td className="px-2 py-1.5 align-middle text-[10px] text-ds-ink-muted">Gang</td>
                        <td className="px-2 py-1.5 align-middle">
                          <span className={`${badge0.className} text-[10px] ${badge0.pulse ? 'animate-pulse' : ''}`}>
                            <Layers className="h-3 w-3 shrink-0" aria-hidden />
                            {badge0.label}
                          </span>
                          {groupPushAge ? (
                            <div className="mt-0.5">
                              <span className={groupCompleted ? PUSHED_CHIP_CLASS : 'rounded border border-ds-line/60 bg-ds-elevated px-1.5 py-0.5 text-[10px] text-ds-ink-faint'}>
                                {groupCompleted ? `Pushed ${groupPushAge}` : `Plate pushed ${groupPushAge}`}
                              </span>
                            </div>
                          ) : null}
                        </td>
                        <td className="px-2 py-1.5 align-middle">
                          {groupJobCardReady === groupRows.length ? (
                            <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
                              Ready ({groupJobCardReady}/{groupRows.length})
                            </span>
                          ) : (
                            <span className="rounded border border-ds-line/60 bg-ds-elevated px-1.5 py-0.5 text-[10px] text-ds-ink-faint">
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
                              className="inline-flex items-center gap-0.5 rounded border border-sky-500/40 bg-sky-500/8 px-2 py-0.5 text-xs font-medium text-sky-700 hover:bg-sky-500/15 dark:text-sky-300"
                            >
                              {isExpanded ? '▲ Collapse' : `▼ ${groupRows.length} items`}
                            </button>
                            <button
                              type="button"
                              onClick={() => setActiveGroupEdit({ groupId, rows: groupRows })}
                              className="inline-flex items-center justify-center gap-1 rounded border border-ds-warning/40 bg-ds-warning/8 px-2 py-0.5 text-xs font-medium text-ds-warning hover:bg-ds-warning/15 dark:border-ds-warning/40 dark:text-ds-warning"
                            >
                              <Pencil className="h-3 w-3 opacity-80" aria-hidden />
                              Edit group
                            </button>
                            {groupMissingSheetCount > 0 ? (
                              <span className="rounded border border-orange-500/35 bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-700 dark:text-orange-300">
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
                              className={`rounded border px-2 py-0.5 text-xs disabled:opacity-40 ${
                                groupFinalizeEligibleCount > 0
                                  ? 'border-emerald-500/40 text-emerald-800 hover:bg-emerald-500/10 dark:text-emerald-200'
                                  : 'border-ds-line text-ds-warning hover:bg-ds-warning/10'
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
                              className={`rounded border px-2 py-0.5 text-xs disabled:opacity-40 ${
                                groupRecallEligibleCount > 0
                                  ? 'border-rose-500/35 text-rose-700 hover:bg-rose-500/10 dark:text-rose-300'
                                  : 'border-ds-line text-ds-warning hover:bg-ds-warning/10'
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
                        const missingSheetSize = !hasToolingSheetSize(spec)
                        const canFinalizeRow = canFinalizePlateHubRow(r)
                        const canRecallPlanning = canRecallPlanningRow(r, spec)
                        const jcState = awJobCardState(r)
                        const embossEnabled = isEmbossingRequired(r.embossingLeafing)

                        return (
                          <tr
                            key={`aw-sub:${r.id}`}
                            className={`border-l-[3px] transition-colors ${
                              completed
                                ? 'border-emerald-500/50 bg-emerald-500/10 hover:bg-emerald-500/15 dark:bg-emerald-500/20 dark:hover:bg-emerald-500/24'
                                : platePushedOnly
                                  ? 'border-rose-300/70 bg-rose-500/5 hover:bg-rose-500/10 dark:bg-rose-500/10 dark:hover:bg-rose-500/16'
                                  : jobCardOnly
                                    ? 'border-violet-300/70 bg-violet-500/5 hover:bg-violet-500/10 dark:bg-violet-500/10 dark:hover:bg-violet-500/16'
                                  : 'border-sky-500/30 bg-sky-500/3 hover:bg-sky-500/6'
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
                            <td className="px-2 py-1 align-middle text-[10px] leading-snug text-ds-ink">
                              <span className="text-sky-500/70">↳{si + 1}</span>{' '}
                              <span className={`${mono} text-ds-warning`}>{r.po.poNumber}</span>
                              <div className="flex min-w-0 items-center gap-1 text-ds-ink-muted">
                                <CustomerAvatar name={r.po.customer.name} logoUrl={r.po.customer.logoUrl} />
                                <span className="min-w-0 truncate">{r.po.customer.name}</span>
                              </div>
                              <div className={`min-w-0 truncate font-medium ${completed ? 'text-emerald-700 dark:text-emerald-300' : ''}`}>
                                {r.cartonName}
                              </div>
                              <div className={`${mono} text-ds-ink-faint`}>Set {r.setNumber ?? '—'} · {dQ}d</div>
                            </td>
                            <td className={`px-2 py-1 align-middle text-right text-xs ${mono} text-ds-ink`}>
                              {r.quantity.toLocaleString('en-IN')}
                            </td>
                            <td className="px-2 py-1 align-middle text-[10px] text-ds-ink-faint">{designerName}</td>
                            <td className={`px-2 py-1 align-middle text-right text-xs ${mono}`}>{rowUpsDisplay(spec)}</td>
                            <td className="px-2 py-1 align-middle text-[10px] text-ds-ink-muted">
                              {rowBatchTypeDisplay(spec)}
                            </td>
                            <td className="px-2 py-1 align-middle">
                              <div className="flex flex-wrap items-center gap-1">
                                {phase === 'awaiting_client' ? (
                                  <span className="rounded border border-sky-500/45 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                                    Awaiting client
                                  </span>
                                ) : null}
                                {missingSheetSize ? (
                                  <span className="rounded border border-orange-500/35 bg-orange-500/10 px-1.5 py-0.5 text-[10px] text-orange-700 dark:text-orange-300">
                                    Sheet size missing
                                  </span>
                                ) : null}
                              </div>
                            </td>
                            <td className="px-2 py-1 align-middle">
                              {jcState === 'ready' ? (
                                <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
                                  Ready
                                </span>
                              ) : (
                                <span className="text-[10px] text-ds-ink-faint">—</span>
                              )}
                            </td>
                            <td className="px-2 py-1 align-middle">
                              <ActionsCell
                                embossEnabled={embossEnabled}
                                onPushJobCard={() => void pushJobCardFromList(r)}
                                onPushPlate={() => void finalizeFromList(r)}
                                onPushEmboss={() => void pushToolingFromList(r, 'BLOCK')}
                                onPushShadeCard={() => window.open('/hub/shade-card-hub', '_blank', 'noopener,noreferrer')}
                                onRecallPlanning={() => void recallPlanning(r)}
                                disablePushJobCard={jobCardPushingId === r.id || rowClosed || hasLinkedJobCard(r)}
                                disablePushPlate={finalizingId === r.id || rowClosed || !canFinalizeRow}
                                disableRecall={recallingPlanningId === r.id || !canRecallPlanning || rowClosed}
                                pushJobCardLabel={jobCardPushingId === r.id ? '…' : hasLinkedJobCard(r) ? 'Job card ✓' : 'Push Job Card'}
                                pushPlateLabel={finalizingId === r.id ? '…' : 'Plates'}
                                recallLabel={recallingPlanningId === r.id ? '…' : 'Recall'}
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
                const missingSheetSize = !hasToolingSheetSize(spec)
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
                    className={`transition-colors ${
                      priRow
                        ? `${INDUSTRIAL_PRIORITY_ROW_CLASS} hover:bg-ds-warning/5 dark:hover:bg-ds-warning/12`
                        : completed
                          ? 'border-l-2 border-emerald-500/70 bg-emerald-500/10 hover:bg-emerald-500/15 dark:bg-emerald-500/20 dark:hover:bg-emerald-500/24'
                        : platePushedOnly
                          ? 'border-l-2 border-rose-300/70 bg-rose-500/5 hover:bg-rose-500/10 dark:bg-rose-500/10 dark:hover:bg-rose-500/16'
                          : jobCardOnly
                            ? 'border-l-2 border-violet-300/70 bg-violet-500/5 hover:bg-violet-500/10 dark:bg-violet-500/10 dark:hover:bg-violet-500/16'
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
                          <div className="flex min-w-0 items-center gap-1 text-[10px] text-ds-ink-muted">
                            <CustomerAvatar name={r.po?.customer?.name ?? '—'} logoUrl={r.po?.customer?.logoUrl} />
                            <span className="min-w-0 truncate">{r.po?.customer?.name ?? '—'}</span>
                          </div>
                          <div className={`mt-0.5 min-w-0 font-medium ${completed ? 'text-emerald-700 dark:text-emerald-300' : ''}`}>
                            {r.cartonName ?? '—'}
                          </div>
                          {readPlanningCore(spec).layoutType === 'gang' ? (
                            <span className="mt-0.5 inline-block w-fit rounded border border-sky-500/45 bg-sky-500/10 px-1 py-0.5 text-[9px] font-semibold uppercase text-sky-700 dark:text-sky-300">
                              Gang print
                            </span>
                          ) : readPlanningCore(spec).savedAt ? (
                            <span className="mt-0.5 inline-block w-fit rounded border border-neutral-300 px-1 py-0.5 text-[9px] text-ds-ink-faint dark:border-ds-line/60">
                              Single
                            </span>
                          ) : null}
                          {totalContractBatches(spec) > 0 ? (
                            <div
                              className="mt-1 flex h-1 w-full max-w-[7rem] overflow-hidden rounded-full bg-ds-elevated ring-1 ring-ds-line/50"
                              title="Batch progress"
                            >
                              <div
                                className="h-full bg-emerald-600/90"
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
                            <span className="mt-0.5 inline-block w-fit rounded bg-ds-warning/15 px-1 text-[9px] font-bold uppercase text-ds-warning ring-1 ring-ds-warning/35">
                              Priority
                            </span>
                          ) : null}
                          {r.directorHold ? (
                            <span className="mt-0.5 inline-block w-fit rounded bg-ds-elevated/30 px-1 text-[9px] text-ds-ink-faint">
                              Hold
                            </span>
                          ) : null}
                          <div className={`mt-0.5 text-[10px] ${mono} text-ds-ink-faint`}>
                            Set {r.setNumber ?? '—'} · {dQ}d queue
                          </div>
                        </div>
                      </div>
                    </td>
                    <td
                      className={`px-2 py-2 align-middle text-right text-xs font-semibold ${mono} text-neutral-900 dark:text-ds-ink`}
                    >
                      {r.quantity}
                    </td>
                    <td className="px-2 py-2 align-middle text-[10px] leading-tight text-ds-ink-faint dark:text-ds-ink-muted">
                      {designerName}
                    </td>
                    <td className={`px-2 py-2 align-middle text-right text-xs ${mono} text-ds-ink`}>{rowUpsDisplay(spec)}</td>
                    <td className="px-2 py-2 align-middle text-[10px] text-ds-ink-muted">{rowBatchTypeDisplay(spec)}</td>
                    <td className="px-2 py-2 align-middle">
                      <div className="flex flex-wrap items-center gap-1">
                        {phase === 'awaiting_client' ? (
                          <span className="rounded border border-sky-500/45 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                            Awaiting client
                          </span>
                        ) : null}
                        {missingSheetSize ? (
                          <span className="rounded border border-orange-500/35 bg-orange-500/10 px-1.5 py-0.5 text-[10px] text-orange-700 dark:text-orange-300">
                            Sheet size missing
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-2 py-2 align-middle">
                      {jcState === 'ready' ? (
                        <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
                          Ready
                        </span>
                      ) : (
                        <span className="text-[10px] text-ds-ink-faint">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2 align-middle">
                      <ActionsCell
                        embossEnabled={embossEnabled}
                        onPushJobCard={() => void pushJobCardFromList(r)}
                        onPushPlate={() => void finalizeFromList(r)}
                        onPushEmboss={() => void pushToolingFromList(r, 'BLOCK')}
                        onPushShadeCard={() => window.open('/hub/shade-card-hub', '_blank', 'noopener,noreferrer')}
                        onRecallPlanning={() => void recallPlanning(r)}
                        disablePushJobCard={jobCardPushingId === r.id || rowClosed || hasLinkedJobCard(r)}
                        disablePushPlate={finalizingId === r.id || rowClosed || !canFinalizeRow}
                        disableRecall={!showRecall || recallingPlanningId === r.id || !canRecallPlanning || rowClosed}
                        pushJobCardLabel={jobCardPushingId === r.id ? '…' : hasLinkedJobCard(r) ? 'Job card ✓' : 'Push Job Card'}
                        pushPlateLabel={finalizingId === r.id ? '…' : 'Plates'}
                        recallLabel={recallingPlanningId === r.id ? '…' : 'Recall'}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </EnterpriseTableShell>

        {sortedRows.length === 0 && (
          <p className="py-8 text-center text-sm text-ds-ink-faint">
            {awSearchQuery.trim().length >= 2
              ? 'No rows match current view or filters. Clear filters to see all rows.'
              : 'No rows in this queue yet.'}
          </p>
        )}
      </div>

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
