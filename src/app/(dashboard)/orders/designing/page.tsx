'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  CircleHelp,
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
import {
  ACTION_PILL_NEUTRAL,
  ICON_BUTTON_BASE,
  ICON_BUTTON_TIGHT,
  PUSHED_CHIP_CLASS,
  STATUS_CHIP_BASE,
} from '@/components/design-system/tokens'
import { EnterpriseTableShell } from '@/components/ui/EnterpriseTableShell'
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
        className: `${base} bg-emerald-500/20 text-emerald-200 ring-emerald-500/35`,
        pulse: false,
      }
    case 'revision':
      return {
        label: 'Revision required',
        className: `${base} bg-rose-500/20 text-rose-200 ring-rose-500/35`,
        pulse: false,
      }
    case 'awaiting_client':
      return {
        label: 'Awaiting client',
        className: `${base} bg-blue-500/20 text-blue-200 ring-blue-500/35`,
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

function NeonCommandFilterTrigger({
  searchQuery,
  onQueryChange,
  onClearQuery,
}: {
  searchQuery: string
  onQueryChange: (v: string) => void
  onClearQuery: () => void
}) {
  return (
    <div className="flex w-full max-w-2xl mx-auto items-stretch gap-2">
      <label className="group min-w-0 flex-1 flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-left text-sm text-card-foreground shadow-sm ring-1 ring-ring/30 transition hover:border-neutral-300 dark:border-ds-warning/40 dark:shadow-[0_0_20px_rgba(245,158,11,0.08)] dark:hover:border-ds-warning/60/70">
        <Search className="h-4 w-4 shrink-0 text-blue-600 dark:text-ds-warning" aria-hidden />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search carton or PO #"
          className="min-w-0 flex-1 bg-transparent text-center text-ds-ink-faint placeholder:text-ds-ink-faint/80 focus:outline-none sm:text-left dark:text-ds-ink-muted dark:placeholder:text-ds-ink-muted/80"
          aria-label="Search carton or PO number in AW queue"
        />
      </label>
      {searchQuery.trim().length >= 2 ? (
        <button
          type="button"
          onClick={() => onClearQuery()}
          className="shrink-0 self-center rounded-xl border border-border bg-card px-2.5 py-2 text-ds-ink-faint hover:border-neutral-300 hover:text-neutral-800 dark:border-border/15 dark:hover:border-ds-warning/40 dark:hover:text-ds-warning"
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

function canRecallPlanningRow(r: Row, spec: Record<string, unknown>): boolean {
  const machineAllocated = !!String(spec.machineId || '').trim()
  return !!r.readiness?.planningForwarded && !machineAllocated && !['in_production', 'closed'].includes(r.planningStatus)
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
    <th className={`px-4 py-3 ${className}`}>
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
    return list
  }, [rows, awSearchQuery, designerFilter, userById])

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
      const aPushed = isAwPushedRow(a) ? 1 : 0
      const bPushed = isAwPushedRow(b) ? 1 : 0
      if (aPushed !== bPushed) return aPushed - bPushed
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

  const finalizeFromList = async (r: Row) => {
    const setN = (r.setNumber || '').trim()
    const aw = (r.artworkCode || '').trim()
    if (!setN || !/^\d+$/.test(setN)) {
      toast.error('Set # must be filled (numeric) on the edit screen')
      return
    }
    if (!aw) {
      toast.error('Artwork code is required — open Edit to enter it')
      return
    }
    const spec = r.specOverrides || {}
    if (!spec.customerApprovalPharma || !spec.shadeCardQaTextApproval) {
      toast.error('Both approvals must be checked')
      return
    }
    const designerId = (spec.assignedDesignerId as string | undefined) || null
    const designerCommand = parseDesignerCommand(spec.designerCommand)
    setFinalizingId(r.id)
    try {
      const res = await fetch('/api/plate-hub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poLineId: r.id,
          setNumber: setN,
          awCode: aw,
          customerApproval: true,
          qaTextCheckApproval: true,
          assignedDesignerId: designerId,
          designerCommand,
          status: 'PUSH_TO_PRODUCTION_QUEUE',
        }),
      })
      const json = (await res.json()) as { error?: string; requirementCode?: string }
      if (res.status === 409) {
        toast.info(json.error || 'Already finalized')
        router.refresh()
        return
      }
      if (!res.ok) throw new Error(json.error || 'Finalize failed')
      toast.success('Data successfully routed to Tooling Hubs')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Finalize failed')
    } finally {
      setFinalizingId(null)
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
        <div className="rounded-lg border border-border bg-card px-2 py-1.5 sm:px-3">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-ds-ink-faint dark:text-ds-ink-muted">
            <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300/90">
              Customer PO ✓
            </span>
            <span>→</span>
            <span className="rounded border border-ds-warning/40 bg-ds-warning/8 px-1.5 py-0.5 text-ds-warning">
              Planning decision
            </span>
            <span>→</span>
            <span className="rounded border border-sky-500/35 bg-sky-500/10 px-1.5 py-0.5 text-sky-200/95">
              AW queue
            </span>
            <span>→</span>
            <span className="rounded border border-border px-1.5 py-0.5 text-ds-ink-muted">Plate Hub</span>
            <span>→</span>
            <span className="rounded border border-border px-1.5 py-0.5 text-ds-ink-muted">Downstream</span>
          </div>
        </div>

        <div className="py-1 flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-2">
          <div className="min-w-0 flex-1">
            <NeonCommandFilterTrigger
              searchQuery={awSearchQuery}
              onQueryChange={setAwSearchQuery}
              onClearQuery={() => setAwSearchQuery('')}
            />
          </div>
          <div className="relative flex shrink-0 items-center self-stretch sm:self-auto">
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
              className={`h-full min-h-[42px] w-full min-w-[12rem] appearance-none rounded-xl border border-border bg-card py-2 pl-8 pr-9 text-sm font-medium text-card-foreground shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 sm:min-w-[13.5rem] sm:min-h-0 ${
                designerFilter !== 'all' ? 'bg-blue-50/70 hover:bg-muted/70' : 'hover:bg-muted/70'
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
                  }}
                  className="rounded border border-ds-line/60 px-2 py-0.5 text-[11px] text-ds-ink-faint hover:text-ds-ink"
                >
                  Clear all
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-ds-ink-muted">
              <span className="font-semibold text-ds-ink-faint">Row states:</span>
              <span
                className="inline-flex items-center text-ds-ink-faint"
                title="Priority rows are pinned. Pushed rows are finalized to Plate Hub and moved to end."
                aria-label="Row state help"
              >
                <CircleHelp className="h-3.5 w-3.5" />
              </span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-ds-warning" /> Priority</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-400" /> Pushed</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-ds-elevated ring-1 ring-ds-line/50" /> Normal</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-base font-semibold text-neutral-900 dark:text-ds-ink">Visual audit station</h1>
            <p className="text-sm text-ds-ink-faint dark:text-ds-ink-muted">
              Pre-press audit · <span className="text-ds-ink-faint dark:text-ds-ink-faint">{PREPRESS_AUDIT_LEAD}</span> · Ready:{' '}
              <span className="font-semibold text-neutral-900 dark:text-ds-warning">{readyCount}</span> / {rows.length}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/orders/purchase-orders"
              className="rounded-lg border border-border bg-card px-2.5 py-1 text-sm text-card-foreground shadow-sm hover:bg-muted/70 dark:hover:border-ds-warning/40"
            >
              POs
            </Link>
            <Link
              href="/hub/plates"
              className="rounded-lg border border-border bg-card px-2.5 py-1 text-sm text-card-foreground shadow-sm hover:bg-muted/70 dark:hover:border-ds-warning/40"
            >
              Plate Hub
            </Link>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className={`min-w-[160px] rounded border border-border bg-card px-2 py-1.5 text-card-foreground ${mono}`}
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
            className={`rounded border px-2.5 py-1.5 text-sm font-medium transition-colors ${mono} ${
              myJobsOnly
                ? 'border-emerald-500/50 bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200'
                : 'border-border bg-card text-ds-ink-faint hover:border-neutral-300 dark:text-ds-ink-muted dark:hover:border-ds-line/60'
            }`}
            title="Show only lines allocated to you in Planning"
          >
            My jobs
          </button>
        </div>

        <EnterpriseTableShell>
          <table className="w-full min-w-[1100px] table-fixed border-collapse text-left text-sm">
            <thead className="border-b border-border bg-card text-xs font-semibold uppercase tracking-wider text-ds-ink-faint dark:text-ds-ink-muted">
              <tr>
                <th className="w-[52px] px-4 py-3">Preview</th>
                <SortHeader
                  label="PO #"
                  column="po"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={cycleSort}
                  className="w-[6.25rem]"
                />
                <SortHeader
                  label="Customer"
                  column="customer"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={cycleSort}
                  className="w-[6.5rem]"
                />
                <th className="min-w-[9rem] px-4 py-3">Carton</th>
                <SortHeader
                  label="Qty"
                  column="qty"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={cycleSort}
                  className="w-10 text-right [&_button]:justify-end [&_button]:w-full"
                />
                <th className="w-9 px-4 py-3">Set</th>
                <th className="w-[5rem] px-4 py-3">Designer</th>
                <th className="w-[8.5rem] px-4 py-3">Pipeline</th>
                <SortHeader
                  label="Days"
                  column="days"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={cycleSort}
                  className="w-14 text-right [&_button]:justify-end [&_button]:w-full"
                />
                <th className="min-w-[11rem] px-4 py-3">Actions</th>
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
                  const groupPushed = groupRows.every((r) => isAwPushedRow(r))
                  const groupPushAge = groupPushed
                    ? formatShortTimeAgo(
                        ((spec0.prePressSentToPlateHubAt as string | undefined) || (spec0.prePressFinalizedAt as string | undefined) || firstRow.createdAt),
                      )
                    : null
                  const groupRecallEligibleCount = groupRows.filter((r) =>
                    canRecallPlanningRow(r, ((r.specOverrides || {}) as Record<string, unknown>)),
                  ).length

                  return (
                    <Fragment key={`aw-group:${groupId}`}>
                      <tr
                        className={`border-l-[3px] transition-colors ${
                          groupPushed
                            ? 'border-emerald-500/70 bg-emerald-500/20 hover:bg-emerald-500/24'
                            : 'border-sky-500/70 bg-sky-500/5 hover:bg-sky-500/8'
                        } ${priRow0 ? INDUSTRIAL_PRIORITY_ROW_CLASS : ''}`}
                      >
                        {/* Preview — first item's preview */}
                        <td className="px-4 py-2 align-middle">
                          <ArtworkPreviewCell
                            url={firstRow.artworkPreviewUrl ?? null}
                            alt={firstRow.cartonName}
                            onOpenLightbox={(src) => setLightbox({ src, alt: `${firstRow.po.poNumber} · ${firstRow.cartonName}` })}
                          />
                        </td>
                        {/* PO / priority */}
                        <td className={`px-4 py-2 align-middle text-sm font-medium ${mono} text-neutral-900 dark:text-ds-warning`}>
                          <div className="flex flex-col gap-0.5 leading-tight">
                            <span className="inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-bold text-sky-600 dark:text-sky-300">
                              <Layers className="h-3 w-3 shrink-0" aria-hidden /> GANG · {groupRows.length} items
                            </span>
                            {groupRows.map((r) => (
                              <span key={r.id} className={`truncate text-[11px] ${mono} text-ds-warning`}>{r.po.poNumber}</span>
                            ))}
                          </div>
                        </td>
                        {/* Customer */}
                        <td className="px-4 py-2 align-middle text-sm font-medium leading-tight text-neutral-700 dark:text-ds-ink-muted">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <CustomerAvatar name={firstRow.po.customer.name} logoUrl={firstRow.po.customer.logoUrl} />
                            <span className="min-w-0 overflow-hidden text-ellipsis">{firstRow.po.customer.name}</span>
                          </div>
                        </td>
                        {/* Carton — all items */}
                        <td className="px-4 py-2 align-middle text-sm leading-snug text-neutral-900 dark:text-ds-ink">
                          <div className="flex min-w-0 flex-col gap-0.5">
                            {groupRows.map((r) => (
                              <span
                                key={r.id}
                                className={`min-w-0 truncate text-[12px] ${groupPushed ? 'text-emerald-300' : ''}`}
                                title={r.cartonName}
                              >
                                {r.cartonName}
                              </span>
                            ))}
                            <span className="w-fit rounded border border-sky-500/45 bg-sky-500/10 px-1 py-0.5 text-[10px] font-semibold uppercase text-sky-700 dark:text-sky-300">
                              Gang print
                            </span>
                          </div>
                        </td>
                        {/* Qty — combined */}
                        <td className={`px-4 py-2 align-middle text-right text-sm font-bold ${mono} text-ds-brand`}>
                          <div className="flex flex-col items-end">
                            <span>{totalQty.toLocaleString('en-IN')}</span>
                            <span className="text-[9px] font-normal text-ds-ink-faint">combined</span>
                          </div>
                        </td>
                        {/* Set */}
                        <td className={`px-4 py-2 align-middle text-sm ${mono} text-ds-ink-muted`}>
                          {firstRow.setNumber ?? '—'}
                        </td>
                        {/* Designer */}
                        <td className="px-4 py-2 align-middle text-xs text-ds-ink-faint">
                          {designerName0}
                        </td>
                        {/* Pipeline */}
                        <td className="px-4 py-2 align-middle">
                          <span className={`${badge0.className} ${badge0.pulse ? 'animate-pulse' : ''}`}>
                            <Layers className="h-3 w-3 shrink-0" aria-hidden />
                            {badge0.label}
                          </span>
                          {groupPushAge ? (
                            <div className="mt-0.5">
                              <span className={PUSHED_CHIP_CLASS}>
                                Pushed {groupPushAge}
                              </span>
                            </div>
                          ) : null}
                        </td>
                        {/* Days */}
                        <td className={`px-4 py-2 align-middle text-right text-sm ${mono} ${ageClass(dQ0)}`}>
                          {dQ0}d
                        </td>
                        {/* Actions */}
                        <td className="px-4 py-2 align-middle">
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
                        const badge = pipelineBadge(phase)
                        const dQ = daysInQueue(r.createdAt)
                        const approvalsDone = !!r.readiness?.approvalsComplete
                        const finalized = !!r.readiness?.prePressFinalized
                        const pushedAge = finalized
                          ? formatShortTimeAgo(
                              ((spec.prePressSentToPlateHubAt as string | undefined) || (spec.prePressFinalizedAt as string | undefined) || r.createdAt),
                            )
                          : null
                        const awPo = readAwPoStatus(spec)
                        const rowClosed = awPo === AW_PO_STATUS.CLOSED
                        const canFinalizeRow = approvalsDone && !finalized && !!(r.setNumber || '').trim() && !!(r.artworkCode || '').trim() && !rowClosed

                        return (
                          <tr
                            key={`aw-sub:${r.id}`}
                            className={`border-l-[3px] transition-colors ${
                              finalized
                                ? 'border-emerald-500/50 bg-emerald-500/20 hover:bg-emerald-500/24'
                                : 'border-sky-500/30 bg-sky-500/3 hover:bg-sky-500/6'
                            }`}
                          >
                            <td className="px-3 py-1.5 align-middle">
                              <span className="text-[10px] text-sky-500/60">↳{si + 1}</span>
                            </td>
                            <td className={`px-3 py-1.5 align-middle text-xs font-medium ${mono} text-ds-warning`}>
                              {r.po.poNumber}
                            </td>
                            <td className="px-3 py-1.5 align-middle text-xs text-ds-ink-muted">{r.po.customer.name}</td>
                            <td className="px-3 py-1.5 align-middle text-xs font-medium text-ds-ink">
                              <span className={`line-clamp-1 ${finalized ? 'text-emerald-300' : ''}`}>{r.cartonName}</span>
                            </td>
                            <td className={`px-3 py-1.5 align-middle text-right text-xs ${mono} text-ds-ink`}>{r.quantity.toLocaleString('en-IN')}</td>
                            <td className={`px-3 py-1.5 align-middle text-xs ${mono} text-ds-ink-muted`}>{r.setNumber ?? '—'}</td>
                            <td className="px-3 py-1.5 align-middle text-xs text-ds-ink-faint">{designerName}</td>
                            <td className="px-3 py-1.5 align-middle">
                              <span className={`${badge.className} text-[10px] py-0 ${badge.pulse ? 'animate-pulse' : ''}`}>
                                {badge.label}
                              </span>
                              {pushedAge ? (
                                <div className="mt-0.5">
                                  <span className={PUSHED_CHIP_CLASS}>
                                    Pushed {pushedAge}
                                  </span>
                                </div>
                              ) : null}
                            </td>
                            <td className={`px-3 py-1.5 align-middle text-right text-xs ${mono} ${ageClass(dQ)}`}>{dQ}d</td>
                            <td className="px-3 py-1.5 align-middle">
                              <div className="flex flex-wrap items-center gap-1">
                                <Link
                                  href={`/orders/designing/${r.id}`}
                                  className={`${ACTION_PILL_NEUTRAL} min-w-0 px-1.5 hover:border-ds-warning/50`}
                                >
                                  <Pencil className="h-3 w-3 opacity-70" aria-hidden />
                                  Edit
                                </Link>
                                {canFinalizeRow && (
                                  <button type="button" disabled={finalizingId === r.id} onClick={() => void finalizeFromList(r)}
                                    className="rounded border border-emerald-500/40 px-1.5 py-0.5 text-xs text-emerald-800 hover:bg-emerald-500/10 disabled:opacity-40 dark:text-emerald-200"
                                  >
                                    {finalizingId === r.id ? '…' : 'Plate Hub'}
                                  </button>
                                )}
                              </div>
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
                const approvalsDone = !!r.readiness?.approvalsComplete
                const finalized = !!r.readiness?.prePressFinalized
                const planningForwarded = !!r.readiness?.planningForwarded
                const spec = (r.specOverrides || {}) as Record<string, unknown>
                const awPo = readAwPoStatus(spec)
                const rowClosed = awPo === AW_PO_STATUS.CLOSED
                const batchSeg = batchProgressSegments(spec)
                const canFinalizeRow =
                  approvalsDone &&
                  !finalized &&
                  !!(r.setNumber || '').trim() &&
                  !!(r.artworkCode || '').trim() &&
                  !rowClosed
                const canRecallPlanning =
                  canRecallPlanningRow(r, spec)
                const showRecall = !!r.id
                const phase = r.readiness?.pipelinePhase ?? 'drafting'
                const dQ = daysInQueue(r.createdAt)
                const badge = pipelineBadge(phase)
                const pushedAge = finalized
                  ? formatShortTimeAgo(
                      ((spec.prePressSentToPlateHubAt as string | undefined) || (spec.prePressFinalizedAt as string | undefined) || r.createdAt),
                    )
                  : null
                const previewUrl = r.artworkPreviewUrl ?? null

                const priRow = rowIndustrialPriority(r)
                return (
                  <tr
                    key={r.id}
                    className={`transition-colors ${
                      priRow
                        ? `${INDUSTRIAL_PRIORITY_ROW_CLASS} hover:bg-ds-warning/5 dark:hover:bg-ds-warning/12`
                        : finalized
                          ? 'border-l-2 border-emerald-500/70 bg-emerald-500/20 hover:bg-emerald-500/24'
                        : 'border-l-2 border-transparent hover:border-ds-warning hover:bg-neutral-50 dark:hover:bg-ds-elevated/50'
                    } ${r.directorHold ? 'opacity-45' : ''} ${rowClosed ? 'opacity-40 saturate-0' : ''}`}
                  >
                    <td className="px-4 py-3 align-middle">
                      <ArtworkPreviewCell
                        url={previewUrl}
                        alt={r.cartonName}
                        onOpenLightbox={(src) =>
                          setLightbox({ src, alt: `${r.po.poNumber} · ${r.cartonName}` })
                        }
                      />
                    </td>
                    <td
                      className={`px-4 py-3 align-middle text-sm font-medium ${mono} whitespace-nowrap text-neutral-900 dark:text-ds-warning`}
                    >
                      <div className="flex flex-col gap-0.5 leading-tight">
                        <div className="flex min-w-0 items-start gap-0.5">
                          <button
                            type="button"
                            title={
                              r.po.isPriority === true ? 'Clear PO priority (pin)' : 'Mark PO priority (pin to top)'
                            }
                            aria-pressed={r.po.isPriority === true}
                            aria-label={
                              r.po.isPriority === true ? 'Clear PO priority' : 'Mark PO priority'
                            }
                            disabled={priorityBusyPoId === r.po.id}
                            onClick={(e) => void togglePoPriority(r, e)}
                            className={`mt-0.5 shrink-0 ${ICON_BUTTON_TIGHT} text-ds-ink-faint hover:bg-neutral-100 hover:text-ds-warning dark:hover:bg-card/5 dark:hover:text-ds-warning`}
                          >
                            <Star
                              className={`h-3.5 w-3.5 ${
                                r.po.isPriority === true
                                  ? INDUSTRIAL_PRIORITY_STAR_ICON_CLASS
                                  : 'text-ds-ink-faint'
                              }`}
                              strokeWidth={2}
                            />
                          </button>
                          <span className="min-w-0 overflow-hidden text-ellipsis break-all">{r.po?.poNumber ?? '—'}</span>
                        </div>
                        {totalContractBatches(spec) > 0 ? (
                          <div
                            className="mt-0.5 flex h-1 w-full max-w-[6rem] overflow-hidden rounded-full bg-ds-elevated ring-1 ring-ds-line/50"
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
                          <span className="w-fit rounded bg-ds-warning/15 px-1 text-xs font-bold uppercase text-ds-warning ring-1 ring-ds-warning/35 dark:text-ds-warning">
                            Priority
                          </span>
                        ) : null}
                        {r.directorHold ? (
                          <span className="w-fit rounded bg-ds-elevated/30 px-1 text-xs text-ds-ink-faint dark:text-ds-ink-muted">
                            Hold
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-middle text-sm font-medium leading-tight text-neutral-700 break-words dark:text-ds-ink-muted">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <CustomerAvatar
                          name={r.po?.customer?.name ?? '—'}
                          logoUrl={r.po?.customer?.logoUrl}
                        />
                        <span className="min-w-0 overflow-hidden text-ellipsis">{r.po?.customer?.name ?? '—'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 align-middle text-sm font-medium leading-snug text-neutral-900 break-words dark:text-ds-ink">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className={`min-w-0 ${finalized ? 'text-emerald-300' : ''}`}>{r.cartonName ?? '—'}</span>
                        {readPlanningCore(spec).layoutType === 'gang' ? (
                          <span className="w-fit rounded border border-sky-500/45 bg-sky-500/10 px-1 py-0.5 text-xs font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
                            Gang print
                          </span>
                        ) : readPlanningCore(spec).savedAt ? (
                          <span className="w-fit rounded border border-neutral-300 px-1 py-0.5 text-xs text-ds-ink-faint dark:border-ds-line/60 dark:text-ds-ink-faint">
                            Single product
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td
                      className={`px-4 py-3 align-middle text-right text-sm font-medium ${mono} whitespace-nowrap text-neutral-900 dark:text-ds-ink`}
                    >
                      {r.quantity}
                    </td>
                    <td
                      className={`px-4 py-3 align-middle text-sm font-medium ${mono} whitespace-nowrap overflow-hidden text-ellipsis text-neutral-900 dark:text-ds-ink-muted`}
                    >
                      {r.setNumber ?? '—'}
                    </td>
                    <td className="px-4 py-3 align-middle text-xs leading-tight text-ds-ink-faint dark:text-ds-ink-muted">
                      {designerName}
                    </td>
                    <td className="px-4 py-3 align-middle">
                      <span
                        className={`${badge.className} ${badge.pulse ? 'animate-pulse motion-reduce:animate-none' : ''}`}
                        title={
                          (r.readiness?.artworkStatusLabel ?? '') +
                          (planningForwarded ? ' · Plate Hub: forwarded to planning' : ' · Plate Hub: pending')
                        }
                      >
                        <Layers
                          className={`h-3 w-3 shrink-0 ${
                            planningForwarded ? 'text-emerald-400' : 'text-ds-ink-faint'
                          }`}
                          aria-hidden
                        />
                        {badge.label}
                      </span>
                      {pushedAge ? (
                        <div className="mt-0.5">
                          <span className={PUSHED_CHIP_CLASS}>
                            Pushed {pushedAge}
                          </span>
                        </div>
                      ) : null}
                    </td>
                    <td
                      className={`px-4 py-3 align-middle text-right text-sm font-medium ${mono} whitespace-nowrap ${ageClass(dQ)}`}
                    >
                      {dQ}d
                    </td>
                    <td className="px-4 py-3 align-middle">
                      <div className="flex flex-wrap items-center gap-1">
                        <Link
                          href={`/orders/designing/${r.id}`}
                          className={`${ACTION_PILL_NEUTRAL} hover:border-ds-warning/50 hover:bg-ds-warning/8`}
                        >
                          <Pencil className="h-3 w-3 opacity-70" aria-hidden />
                          Edit
                        </Link>
                        {approvalsDone && !planningForwarded && (
                          <button
                            type="button"
                            disabled={forwardingId === r.id || rowClosed}
                            onClick={() => void forwardPlanning(r)}
                            className={`${ACTION_PILL_NEUTRAL} hover:border-violet-400/50 hover:bg-violet-500/10`}
                          >
                            {forwardingId === r.id ? '…' : 'Forward'}
                          </button>
                        )}
                        {canFinalizeRow && (
                          <button
                            type="button"
                            disabled={finalizingId === r.id || rowClosed}
                            onClick={() => void finalizeFromList(r)}
                            className={`${ACTION_PILL_NEUTRAL} border-emerald-500/40 text-emerald-800 hover:bg-emerald-500/10 dark:text-emerald-200`}
                          >
                            {finalizingId === r.id ? '…' : 'Plate Hub'}
                          </button>
                        )}
                        {finalized && (
                          <Link
                            href="/hub/plates"
                            className={`${ACTION_PILL_NEUTRAL} border-emerald-500/30 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300`}
                          >
                            Plates
                          </Link>
                        )}
                        {planningForwarded && (
                          <Link
                            href="/orders/planning"
                            className={`${ACTION_PILL_NEUTRAL} border-emerald-500/30 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300`}
                          >
                            Planning
                          </Link>
                        )}
                        {showRecall && (
                          <button
                            type="button"
                            disabled={recallingPlanningId === r.id}
                            onClick={() => void recallPlanning(r)}
                            title={
                              canRecallPlanning
                                ? 'Recall to Planning'
                                : 'Recall is allowed only before machine allocation / production'
                            }
                            className={`${ACTION_PILL_NEUTRAL} ${
                              canRecallPlanning
                                ? 'border-rose-500/35 text-rose-700 hover:bg-rose-500/10 dark:text-rose-300'
                                : 'border-ds-line text-ds-warning hover:bg-ds-warning/10'
                            }`}
                          >
                            {recallingPlanningId === r.id ? '…' : 'Recall'}
                          </button>
                        )}
                        <a
                          href={`/api/designing/po-lines/${r.id}/job-spec-pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`${ICON_BUTTON_BASE} border hover:bg-orange-500/15`}
                          style={{
                            borderColor: `${BRAND_ORANGE}99`,
                            color: BRAND_ORANGE,
                          }}
                          title="Spec PDF"
                          aria-label="Download spec PDF"
                        >
                          <FileDown className="h-3.5 w-3.5" strokeWidth={2.25} />
                        </a>
                        <Link
                          href={r.po?.id ? `/orders/purchase-orders/${r.po.id}` : '#'}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded border border-neutral-200 px-1.5 py-0.5 text-xs text-ds-ink-faint hover:text-neutral-900 dark:border-border/10 dark:text-ds-ink-faint dark:hover:text-ds-ink-muted"
                        >
                          PO
                        </Link>
                      </div>
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
