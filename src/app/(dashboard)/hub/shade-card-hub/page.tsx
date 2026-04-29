'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, Download, RefreshCw, Star } from 'lucide-react'
import { toast } from 'sonner'
import { HubCategoryNav } from '@/components/hub/HubCategoryNav'
import { HubCardDeleteAction } from '@/components/hub/HubCardDeleteAction'
import { ShadeCardKanbanBoard } from '@/components/hub/ShadeCardKanbanBoard'
import {
  ShadeCardSpotlightDrawer,
  type ShadeCardSpotlightRow,
} from '@/components/hub/ShadeCardSpotlightDrawer'
import {
  shadeCardAgeTier,
  shadeCardIsApproachingHardExpiry,
  shadeCardIsFadingStandard,
} from '@/lib/shade-card-age'
import { shadeCardKanbanColumn, type ShadeKanbanColumnId } from '@/lib/shade-card-kanban'
import { ShadeSmartRemark } from '@/components/hub/ShadeSmartRemark'
import {
  INDUSTRIAL_PRIORITY_ROW_CLASS,
  INDUSTRIAL_PRIORITY_STAR_ICON_CLASS,
} from '@/lib/industrial-priority-ui'
import { SHADE_CARD_ACTION } from '@/lib/shade-card-events'
import { safeJsonParse, safeJsonParseArray, safeJsonStringify } from '@/lib/safe-json'
import { BulkActionBar, LaneCounterChips } from '@/components/design-system'

const mono =
  'font-[family-name:var(--font-designing-queue),ui-monospace,monospace] tabular-nums tracking-tight'

const VIEW_STORAGE = 'shade-hub-view-mode'
const MOBILE_COMPACT_STORAGE = 'shade-hub-mobile-compact'
const SHADE_ISSUE_OPERATOR_KEY = 'shade-hub-issue-operator'
const SHADE_RECEIVE_OPERATOR_KEY = 'shade-hub-receive-operator'

type HubLaneFilter = 'all' | ShadeKanbanColumnId
type MachineOpt = { id: string; machineCode: string; name: string }
type UserOpt = { id: string; name: string }
type JobCardHit = { id: string; jobCardNumber: number; status: string; customer: { name: string } }
type UsageEventRow = { id: string; actionType: string; createdAt: string; details: unknown }

function rowMatchesLaneFilter(row: ShadeCardSpotlightRow, lane: HubLaneFilter): boolean {
  if (lane === 'all') return true
  return shadeCardKanbanColumn(row) === lane
}

function shortTimeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export default function ShadeCardHubPage() {
  const [q, setQ] = useState('')
  const [laneFilter, setLaneFilter] = useState<HubLaneFilter>('all')
  const [rows, setRows] = useState<ShadeCardSpotlightRow[]>([])
  const [loading, setLoading] = useState(true)
  const [spotlight, setSpotlight] = useState<ShadeCardSpotlightRow | null>(null)
  const [viewMode, setViewMode] = useState<'table' | 'kanban'>('table')
  const [mobileCompact, setMobileCompact] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [machines, setMachines] = useState<MachineOpt[]>([])
  const [users, setUsers] = useState<UserOpt[]>([])
  const [issueOpen, setIssueOpen] = useState(false)
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [issueRows, setIssueRows] = useState<ShadeCardSpotlightRow[]>([])
  const [receiveRows, setReceiveRows] = useState<ShadeCardSpotlightRow[]>([])
  const [machineId, setMachineId] = useState('')
  const [operatorId, setOperatorId] = useState('')
  const [receiveOperatorId, setReceiveOperatorId] = useState('')
  const [jobCardQuery, setJobCardQuery] = useState('')
  const [jobCardHits, setJobCardHits] = useState<JobCardHit[]>([])
  const [jobCardLoading, setJobCardLoading] = useState(false)
  const [issueJobCardId, setIssueJobCardId] = useState('')
  const [issueInitialCondition, setIssueInitialCondition] = useState<'mint' | 'used' | 'minor_damage'>('mint')
  const [receiveEndCondition, setReceiveEndCondition] = useState<'mint' | 'used' | 'minor_damage'>('mint')
  const [overrideExpired, setOverrideExpired] = useState(false)
  const [overrideReason, setOverrideReason] = useState('')
  const [usagePreview, setUsagePreview] = useState<Record<string, UsageEventRow[]>>({})
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null)

  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_STORAGE)
      if (v === 'kanban' || v === 'table') setViewMode(v)
      setMobileCompact(localStorage.getItem(MOBILE_COMPACT_STORAGE) === '1')
      const savedIssue = localStorage.getItem(SHADE_ISSUE_OPERATOR_KEY)
      const savedReceive = localStorage.getItem(SHADE_RECEIVE_OPERATOR_KEY)
      if (savedIssue) setOperatorId(savedIssue)
      if (savedReceive) setReceiveOperatorId(savedReceive)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_STORAGE, viewMode)
      localStorage.setItem(MOBILE_COMPACT_STORAGE, mobileCompact ? '1' : '0')
      if (operatorId) localStorage.setItem(SHADE_ISSUE_OPERATOR_KEY, operatorId)
      if (receiveOperatorId) localStorage.setItem(SHADE_RECEIVE_OPERATOR_KEY, receiveOperatorId)
    } catch {
      /* ignore */
    }
  }, [viewMode, mobileCompact, operatorId, receiveOperatorId])

  useEffect(() => {
    void (async () => {
      try {
        const [mRes, uRes] = await Promise.all([fetch('/api/machines'), fetch('/api/users')])
        setMachines(safeJsonParseArray<MachineOpt>(await mRes.text(), []))
        setUsers(safeJsonParseArray<UserOpt>(await uRes.text(), []))
      } catch {
        setMachines([])
        setUsers([])
      }
    })()
  }, [])

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    try {
      const params = new URLSearchParams()
      if (q.trim()) params.set('q', q.trim())
      const r = await fetch(`/api/hub/shade-card-hub?${params}`)
      const j = await r.json()
      setRows(Array.isArray(j.rows) ? j.rows : [])
    } catch {
      setRows([])
    } finally {
      if (!opts?.silent) setLoading(false)
    }
  }, [q])

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 200)
    return () => window.clearTimeout(t)
  }, [load])

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load({ silent: true })
    }, 12_000)
    return () => window.clearInterval(id)
  }, [load])

  const fadingStandardsCount = useMemo(
    () => rows.filter((r) => shadeCardIsFadingStandard(r.currentAgeMonths ?? null)).length,
    [rows],
  )

  const filteredRows = useMemo(
    () => rows.filter((r) => rowMatchesLaneFilter(r, laneFilter)),
    [rows, laneFilter],
  )

  const laneCounts = useMemo(() => {
    const counts: Record<ShadeKanbanColumnId, number> = {
      in_stock: 0,
      on_floor: 0,
      reverify: 0,
      expired: 0,
    }
    for (const r of rows) counts[shadeCardKanbanColumn(r)] += 1
    return counts
  }, [rows])

  const allVisibleSelected =
    filteredRows.length > 0 && filteredRows.every((r) => selectedIds.has(r.id))
  const someVisibleSelected = filteredRows.some((r) => selectedIds.has(r.id))

  const selectedRows = useMemo(
    () => filteredRows.filter((r) => selectedIds.has(r.id)),
    [filteredRows, selectedIds],
  )
  const selectedIssueEligible = useMemo(
    () => selectedRows.filter((r) => r.custodyStatus === 'in_stock'),
    [selectedRows],
  )
  const selectedReceiveEligible = useMemo(
    () => selectedRows.filter((r) => r.custodyStatus === 'on_floor'),
    [selectedRows],
  )

  const loadUsagePreview = useCallback(async (rowId: string) => {
    if (!rowId || usagePreview[rowId]) return
    try {
      const r = await fetch(`/api/inventory-hub/shade-cards/${rowId}/events`)
      const j = (await r.json()) as { events?: UsageEventRow[] }
      const events = Array.isArray(j.events) ? j.events : []
      const allow = new Set<string>([SHADE_CARD_ACTION.ISSUED, SHADE_CARD_ACTION.RECEIVED])
      const mini = events
        .filter((e) => allow.has(e.actionType))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 2)
      setUsagePreview((prev) => ({ ...prev, [rowId]: mini }))
    } catch {
      setUsagePreview((prev) => ({ ...prev, [rowId]: [] }))
    }
  }, [usagePreview])

  const openIssueForRows = useCallback((targets: ShadeCardSpotlightRow[]) => {
    if (targets.length === 0) {
      toast.info('No in-stock cards selected for issue')
      return
    }
    setIssueRows(targets)
    setIssueJobCardId('')
    setJobCardQuery('')
    setJobCardHits([])
    setIssueOpen(true)
  }, [])

  const openReceiveForRows = useCallback((targets: ShadeCardSpotlightRow[]) => {
    if (targets.length === 0) {
      toast.info('No on-floor cards selected for receive')
      return
    }
    setReceiveRows(targets)
    setReceiveOpen(true)
  }, [])

  const exportPrimary = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (q.trim()) params.set('q', q.trim())
      if (laneFilter !== 'all') params.set('lane', laneFilter)
      const r = await fetch(`/api/hub/shade-card-hub/export?${params}`)
      if (!r.ok) {
        toast.error('Export failed')
        return
      }
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `shade-card-high-intensity-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('Export downloaded')
    } catch {
      toast.error('Export failed')
    }
  }, [q, laneFilter])

  useEffect(() => {
    if (!issueOpen) return
    const qv = jobCardQuery.trim()
    const t = window.setTimeout(() => {
      void (async () => {
        setJobCardLoading(true)
        try {
          const r = await fetch(`/api/inventory-hub/job-cards-quick?q=${encodeURIComponent(qv)}`)
          const j = (await r.json()) as { rows?: JobCardHit[] }
          setJobCardHits(Array.isArray(j.rows) ? j.rows : [])
        } catch {
          setJobCardHits([])
        } finally {
          setJobCardLoading(false)
        }
      })()
    }, qv ? 220 : 0)
    return () => window.clearTimeout(t)
  }, [issueOpen, jobCardQuery])

  const submitIssue = useCallback(async () => {
    if (issueRows.length === 0) return
    if (!machineId.trim() || !operatorId.trim()) {
      toast.error('Machine and operator are required')
      return
    }
    if (!issueJobCardId.trim()) {
      toast.error('Link an active production job (job card) — required')
      return
    }
    const expiredRows = issueRows.filter((r) => shadeCardAgeTier(r.currentAgeMonths ?? null) === 'expired')
    if (expiredRows.length > 0 && (!overrideExpired || !overrideReason.trim())) {
      toast.error('Expired cards require override + reason')
      return
    }
    let success = 0
    let failed = 0
    for (const row of issueRows) {
      try {
        const payload: Record<string, unknown> = {
          machineId,
          operatorUserId: operatorId,
          jobCardId: issueJobCardId.trim(),
          initialCondition: issueInitialCondition,
        }
        if (overrideExpired && overrideReason.trim()) payload.overrideReason = overrideReason.trim()
        const r = await fetch(`/api/inventory-hub/shade-cards/${row.id}/issue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: safeJsonStringify(payload),
        })
        const text = await r.text()
        const j = safeJsonParse<{ error?: string; code?: string }>(text, {})
        if (!r.ok) throw new Error(j.error ?? 'Issue failed')
        success += 1
      } catch {
        failed += 1
      }
    }
    if (success > 0) toast.success(`Issued to floor • ${success} card${success > 1 ? 's' : ''}`)
    if (failed > 0) toast.error(`Issue failed for ${failed} card${failed > 1 ? 's' : ''}`)
    setIssueOpen(false)
    setOverrideExpired(false)
    setOverrideReason('')
    setSelectedIds(new Set())
    void load({ silent: true })
  }, [issueRows, machineId, operatorId, issueJobCardId, issueInitialCondition, overrideExpired, overrideReason, load])

  const submitReceive = useCallback(async () => {
    if (receiveRows.length === 0) return
    if (!receiveOperatorId.trim()) {
      toast.error('Select returning operator')
      return
    }
    let success = 0
    let failed = 0
    for (const row of receiveRows) {
      try {
        const r = await fetch(`/api/inventory-hub/shade-cards/${row.id}/receive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: safeJsonStringify({
            finalImpressions: 0,
            endCondition: receiveEndCondition,
            returningOperatorUserId: receiveOperatorId,
          }),
        })
        const text = await r.text()
        const j = safeJsonParse<{ error?: string }>(text, {})
        if (!r.ok) throw new Error(j.error ?? 'Receive failed')
        success += 1
      } catch {
        failed += 1
      }
    }
    if (success > 0) toast.success(`Received to rack • ${success} card${success > 1 ? 's' : ''}`)
    if (failed > 0) toast.error(`Receive failed for ${failed} card${failed > 1 ? 's' : ''}`)
    setReceiveOpen(false)
    setSelectedIds(new Set())
    void load({ silent: true })
  }, [receiveRows, receiveOperatorId, receiveEndCondition, load])

  return (
    <div className="min-h-screen bg-background text-ds-ink">
      <div className="max-w-[1600px] mx-auto p-3 md:p-4 space-y-4 pb-20">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-ds-warning tracking-tight font-sans">Shade Card Hub</h1>
            <p className="text-xs text-neutral-500 mt-0.5">
              Live product sync (12s refresh) · 30.44 d/mo age · custody logged in spotlight
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div
              className={`rounded-lg border border-orange-900/40 bg-ds-main px-3 py-2 ${mono}`}
              title="ΔE Limit Enforced < 2.0"
            >
              <p className="text-xs uppercase tracking-wider text-neutral-500">Fading Standards</p>
              <p className="text-xl font-bold text-orange-400 tabular-nums leading-tight">{fadingStandardsCount}</p>
            </div>
            <button
              type="button"
              onClick={() => void exportPrimary()}
              className={`inline-flex items-center gap-1.5 rounded-lg border-2 border-ds-warning/70 bg-ds-warning/10 px-3 py-1.5 text-xs font-semibold text-ds-warning shadow-[0_0_12px_rgba(245,158,11,0.15)] hover:bg-ds-warning/10 ${mono}`}
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              High-Intensity Export
            </button>
            <div
              className={`flex rounded-lg border border-ds-line/50 overflow-hidden p-0.5 bg-ds-main ${mono}`}
              role="group"
              aria-label="View mode"
            >
              <button
                type="button"
                onClick={() => setViewMode('table')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  viewMode === 'table'
                    ? 'bg-ds-elevated text-foreground'
                    : 'text-neutral-500 hover:text-neutral-400'
                }`}
              >
                Table
              </button>
              <button
                type="button"
                onClick={() => setViewMode('kanban')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  viewMode === 'kanban'
                    ? 'bg-ds-elevated text-foreground'
                    : 'text-neutral-500 hover:text-neutral-400'
                }`}
              >
                Kanban
              </button>
            </div>
            <Link
              href="/hub/shade-card-hub/settings"
              className={`text-xs px-3 py-1.5 rounded-lg border border-ds-warning/30 text-ds-warning hover:bg-ds-warning/8 ${mono}`}
            >
              Issue / receive settings
            </Link>
          </div>
        </header>

        <HubCategoryNav active="shade_cards" />

        <LaneCounterChips
          chips={[
            { key: 'all', label: 'All', count: rows.length, active: laneFilter === 'all', onClick: () => setLaneFilter('all'), tone: 'brand' },
            { key: 'in_stock', label: 'In-Stock', count: laneCounts.in_stock, active: laneFilter === 'in_stock', onClick: () => setLaneFilter('in_stock'), tone: 'success' },
            { key: 'on_floor', label: 'On-Floor', count: laneCounts.on_floor, active: laneFilter === 'on_floor', onClick: () => setLaneFilter('on_floor'), tone: 'info' },
            { key: 'reverify', label: 'Re-Verify', count: laneCounts.reverify, active: laneFilter === 'reverify', onClick: () => setLaneFilter('reverify'), tone: 'warning' },
            { key: 'expired', label: 'Expired', count: laneCounts.expired, active: laneFilter === 'expired', onClick: () => setLaneFilter('expired'), tone: 'danger' },
          ]}
          className="pr-2"
        />

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setMobileCompact((v) => !v)}
            className="rounded border border-ds-line/50 px-2 py-0.5 text-xs text-ds-ink-muted"
          >
            Mobile compact: {mobileCompact ? 'On' : 'Off'}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-ds-ink-muted">
          <span className="rounded border border-ds-line/50 bg-ds-main/50 px-2 py-0.5">
            Fresh = Green
          </span>
          <span className="rounded border border-ds-warning/40 bg-ds-warning/8 px-2 py-0.5 text-ds-warning">
            Re-Verify = Amber
          </span>
          <span className="rounded border border-rose-500/40 bg-rose-500/8 px-2 py-0.5 text-rose-700 dark:text-rose-300">
            Expired = Red
          </span>
          <span className="rounded border border-sky-500/40 bg-sky-500/8 px-2 py-0.5 text-sky-700 dark:text-sky-300">
            On-Floor = Blue
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search shade, product, customer…"
            className={`flex-1 min-w-[200px] max-w-md rounded-lg border border-ds-line/50 bg-card px-3 py-2 text-sm text-foreground placeholder:text-neutral-600 ${mono}`}
            aria-label="Search shade cards"
          />
          <label className={`flex items-center gap-2 text-xs text-neutral-500 font-sans shrink-0`}>
            <span className="hidden sm:inline">Filter</span>
            <select
              value={laneFilter}
              onChange={(e) => setLaneFilter(e.target.value as HubLaneFilter)}
              className={`rounded-lg border border-ds-line/50 bg-card px-2 py-2 text-sm text-ds-ink min-w-[11rem] ${mono}`}
              aria-label="Filter by hub lane"
            >
              <option value="all">All lanes</option>
              <option value="in_stock">In-Stock</option>
              <option value="on_floor">On-Floor</option>
              <option value="reverify">Re-Verify (9m+)</option>
              <option value="expired">Expired (12m+)</option>
            </select>
          </label>
        </div>

        <BulkActionBar
          selectedCount={selectedIds.size}
          left={
            <>
              <button
                type="button"
                onClick={() =>
                  setSelectedIds((prev) => {
                    const next = new Set(prev)
                    if (allVisibleSelected) filteredRows.forEach((r) => next.delete(r.id))
                    else filteredRows.forEach((r) => next.add(r.id))
                    return next
                  })
                }
                className="h-8 rounded-md border border-ds-line/50 px-2.5 text-xs font-medium text-ds-ink-muted"
              >
                {allVisibleSelected ? 'Unselect visible' : 'Select visible'}
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set(filteredRows.filter((r) => r.custodyStatus === 'in_stock').map((r) => r.id)))}
                className="h-8 rounded-md border border-ds-line/50 px-2.5 text-xs font-medium text-ds-ink-muted"
              >
                Select issue-eligible
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set(filteredRows.filter((r) => r.custodyStatus === 'on_floor').map((r) => r.id)))}
                className="h-8 rounded-md border border-ds-line/50 px-2.5 text-xs font-medium text-ds-ink-muted"
              >
                Select receive-eligible
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="h-8 rounded-md border border-ds-line/50 px-2.5 text-xs font-medium text-ds-ink-muted"
              >
                Clear
              </button>
            </>
          }
          right={
            <>
              <button
                type="button"
                onClick={() => openIssueForRows(selectedIssueEligible)}
                disabled={selectedIssueEligible.length === 0}
                className="h-8 rounded-md border border-sky-500/40 px-2.5 text-xs font-semibold text-sky-700 hover:bg-sky-500/10 disabled:opacity-40 dark:text-sky-300"
              >
                Bulk issue ({selectedIssueEligible.length})
              </button>
              <button
                type="button"
                onClick={() => openReceiveForRows(selectedReceiveEligible)}
                disabled={selectedReceiveEligible.length === 0}
                className="h-8 rounded-md border border-emerald-500/40 px-2.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-500/10 disabled:opacity-40 dark:text-emerald-300"
              >
                Bulk receive ({selectedReceiveEligible.length})
              </button>
            </>
          }
        />

        <AnimatePresence mode="wait">
          {viewMode === 'table' ? (
            <motion.div
              key="table"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              className={`overflow-x-auto rounded-xl border border-ds-line/40 bg-background ${mono}`}
            >
          <p className="px-3 py-2 text-xs uppercase tracking-wider text-neutral-600 border-b border-ds-line/30">
            Audit ledger
          </p>
          <table className="w-full text-left text-xs bg-background">
            <thead className="bg-background border-b border-ds-line/30 text-xs uppercase tracking-wider text-neutral-500">
              <tr>
                <th className="px-2 h-[40px] align-middle w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all visible shade cards"
                    checked={allVisibleSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allVisibleSelected && someVisibleSelected
                    }}
                    onChange={() => {
                      setSelectedIds((prev) => {
                        const next = new Set(prev)
                        if (allVisibleSelected) filteredRows.forEach((r) => next.delete(r.id))
                        else filteredRows.forEach((r) => next.add(r.id))
                        return next
                      })
                    }}
                    className="h-3.5 w-3.5 accent-ds-brand"
                  />
                </th>
                <th className="px-3 h-[40px] align-middle min-w-[12rem] font-sans">Identity</th>
                <th className="px-3 h-[40px] align-middle whitespace-nowrap min-w-[6rem]">Shade · AW</th>
                <th className="px-3 h-[40px] align-middle whitespace-nowrap">Age (mo)</th>
                <th className="px-3 h-[40px] align-middle font-sans whitespace-nowrap">Status</th>
                <th className="px-3 h-[40px] align-middle font-sans min-w-[7rem]">Current Custody</th>
                <th className="px-3 h-[40px] align-middle font-sans min-w-[6rem]">Last activity</th>
                <th className="px-3 h-[40px] align-middle font-sans min-w-[8rem]">Quick actions</th>
                <th className="px-3 h-[40px] align-middle font-sans min-w-[8rem]">Remarks</th>
                <th className="px-2 h-[40px] align-middle w-12 font-sans text-right"> </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ds-card bg-background">
              {loading ? (
                <tr>
                  <td colSpan={10} className="px-3 py-8 text-neutral-500 text-center font-sans">
                    Loading…
                  </td>
                </tr>
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-3 py-8 text-neutral-600 text-center font-sans">
                    {rows.length === 0 ? 'No shade cards match.' : 'No cards in this lane for the current search.'}
                  </td>
                </tr>
              ) : (
                filteredRows.map((r) => {
                  const months = r.currentAgeMonths ?? null
                  const tier = shadeCardAgeTier(months)
                  const clientName =
                    r.product?.customer?.name?.trim() || r.customer?.name?.trim() || '—'
                  const productName =
                    r.product?.cartonName?.trim() || r.productMaster?.trim() || '—'
                  const productLinkId = r.product?.id ?? r.productId ?? null
                  const aw = r.masterArtworkRef?.trim() || r.product?.artworkCode?.trim() || '—'
                  const ageLabel = months == null ? '—' : months.toFixed(2)
                  const approaching = shadeCardIsApproachingHardExpiry(months)

                  const statusBadge =
                    tier === 'expired'
                      ? { label: 'Expired (12m+)', cls: 'bg-rose-950/80 text-rose-200 border-rose-500/40' }
                      : tier === 'reverify'
                        ? { label: 'Re-verify (9m+)', cls: 'bg-ds-warning/10 text-ds-warning border-ds-warning/45' }
                        : r.custodyStatus === 'on_floor'
                          ? { label: 'On-Floor', cls: 'bg-sky-950/50 text-sky-200 border-sky-700/40' }
                          : { label: 'In-Stock', cls: 'bg-ds-elevated text-neutral-400 border-ds-line/50' }

                  return (
                    <tr
                      key={r.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSpotlight(r)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setSpotlight(r)
                        }
                      }}
                      onMouseEnter={() => {
                        setHoveredRowId(r.id)
                        void loadUsagePreview(r.id)
                      }}
                      onMouseLeave={() => setHoveredRowId((prev) => (prev === r.id ? null : prev))}
                      className={`h-[44px] max-h-[44px] hover:bg-ds-main/50 cursor-pointer ${
                        r.fadeAlert ? 'ring-1 ring-red-900/40' : ''
                      } ${tier === 'expired' ? 'bg-rose-500/20' : ''} ${
                        r.industrialPriority ? INDUSTRIAL_PRIORITY_ROW_CLASS : ''
                      }`}
                    >
                      <td className="px-2 align-middle" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(r.id)}
                          onChange={() =>
                            setSelectedIds((prev) => {
                              const next = new Set(prev)
                              if (next.has(r.id)) next.delete(r.id)
                              else next.add(r.id)
                              return next
                            })
                          }
                          className="h-3.5 w-3.5 accent-ds-brand"
                        />
                      </td>
                      <td className="px-3 align-middle min-w-0 font-sans">
                        <div className="flex items-start gap-1.5 min-w-0">
                          {r.industrialPriority ? (
                            <Star
                              className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${INDUSTRIAL_PRIORITY_STAR_ICON_CLASS}`}
                              aria-label="Industrial priority"
                            />
                          ) : (
                            <span className="w-3.5 shrink-0" aria-hidden />
                          )}
                          <div className="min-w-0 flex-1">
                            {productLinkId ? (
                              <Link
                                href={`/product/${productLinkId}`}
                                className="block min-w-0 rounded hover:bg-ds-card/50 -m-0.5 p-0.5"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <p className="font-bold text-emerald-400 truncate leading-tight text-xs">
                                  {clientName}
                                </p>
                                <p className={`${mobileCompact ? 'line-clamp-1' : 'truncate'} text-sm text-foreground`}>{productName}</p>
                              </Link>
                            ) : (
                              <>
                                <p className="font-bold text-emerald-400 truncate leading-tight text-xs">
                                  {clientName}
                                </p>
                                <p className={`${mobileCompact ? 'line-clamp-1' : 'truncate'} text-sm text-foreground`}>{productName}</p>
                              </>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className={`px-3 align-middle text-neutral-400 ${mono}`}>
                        <div className="leading-tight">
                          <span className="whitespace-nowrap block text-xs text-ds-warning/90">{r.shadeCode}</span>
                          <span className="whitespace-nowrap text-neutral-500">{aw}</span>
                        </div>
                      </td>
                      <td className="px-3 align-middle whitespace-nowrap">
                        {months == null ? (
                          <span className="text-neutral-600">—</span>
                        ) : (
                          <span className={`inline-flex items-center gap-1 ${mono}`}>
                            {approaching ? (
                              <span
                                className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full border border-ds-warning/60 bg-ds-warning/8 px-0.5 text-xs font-black text-ds-warning animate-pulse"
                                title="11–12 months: hard expiry window — open spotlight for audit trail."
                              >
                                !
                              </span>
                            ) : null}
                            {tier === 'fresh' ? (
                              <span className="text-xs font-medium text-emerald-500">{ageLabel}</span>
                            ) : tier === 'reverify' ? (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-ds-warning">
                                <RefreshCw className="h-3 w-3 shrink-0 animate-pulse" aria-hidden />
                                {ageLabel}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-rose-500">
                                <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                                {ageLabel}
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="px-3 align-middle font-sans">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium border ${statusBadge.cls}`}
                        >
                          {statusBadge.label}
                        </span>
                      </td>
                      <td className="px-3 align-middle font-sans min-w-0">
                        {r.custodyStatus === 'on_floor' &&
                        (r.issuedOperator?.trim() || r.currentHolder?.trim()) ? (
                          <span
                            className={`inline-flex max-w-full truncate rounded-md border border-sky-400/80 bg-ds-main px-2 py-0.5 text-xs font-semibold text-sky-100 ${mono}`}
                            title="Current holder on floor"
                          >
                            {r.issuedOperator?.trim() || '—'} @ {r.currentHolder?.trim() || '—'}
                          </span>
                        ) : (
                          <span className={`text-neutral-600 text-xs ${mono}`}>—</span>
                        )}
                      </td>
                      <td className="px-3 align-middle min-w-[6rem]">
                        <span className={`text-xs text-neutral-500 ${mono}`}>
                          {shortTimeAgo(r.updatedAt)}
                        </span>
                        {hoveredRowId === r.id && usagePreview[r.id] && usagePreview[r.id].length > 0 ? (
                          <div className="mt-1 space-y-0.5">
                            {usagePreview[r.id].map((ev) => (
                              <p key={ev.id} className={`text-xs text-ds-ink-faint ${mono}`}>
                                {ev.actionType === SHADE_CARD_ACTION.ISSUED ? 'Issued' : 'Received'} · {shortTimeAgo(ev.createdAt)}
                              </p>
                            ))}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 align-middle min-w-[8rem]" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-wrap items-center gap-1 leading-none">
                          {r.custodyStatus === 'in_stock' ? (
                            <button
                              type="button"
                              onClick={() => openIssueForRows([r])}
                              className="h-6 rounded-md border border-sky-500/40 bg-sky-500/8 px-2 text-xs font-medium text-sky-700 dark:text-sky-300"
                            >
                              Issue
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => openReceiveForRows([r])}
                              className="h-6 rounded-md border border-emerald-500/40 bg-emerald-500/8 px-2 text-xs font-medium text-emerald-700 dark:text-emerald-300"
                            >
                              Receive
                            </button>
                          )}
                          {(tier === 'reverify' || tier === 'expired') ? (
                            <button
                              type="button"
                              onClick={() => setSpotlight(r)}
                              className="h-6 rounded-md border border-ds-warning/40 bg-ds-warning/8 px-2 text-xs font-medium text-ds-warning"
                            >
                              Schedule reverify
                            </button>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 align-middle max-w-[10rem]" onClick={(e) => e.stopPropagation()}>
                        <ShadeSmartRemark
                          text={r.remarks}
                          editedBy={r.remarksEditedByName}
                          editedAtIso={r.remarksEditedAt}
                          updatedAtIso={r.updatedAt}
                          monoClass={mono}
                        />
                      </td>
                      <td
                        className="px-1 align-middle w-12"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <div className="flex justify-end">
                          <HubCardDeleteAction
                            asset="shade_card"
                            recordId={r.id}
                            triggerClassName="relative"
                            onDeleted={() => {
                              setRows((prev) => prev.filter((x) => x.id !== r.id))
                              setSpotlight((sp) => (sp?.id === r.id ? null : sp))
                              void load({ silent: true })
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
            </motion.div>
          ) : (
            <motion.div
              key="kanban"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              className="rounded-xl border border-ds-line/40 bg-background p-3 overflow-x-auto"
            >
              {loading ? (
                <p className={`text-neutral-500 text-sm py-8 text-center font-sans ${mono}`}>Loading…</p>
              ) : filteredRows.length === 0 ? (
                <p className="text-neutral-600 text-sm py-8 text-center font-sans">
                  {rows.length === 0 ? 'No shade cards match.' : 'No cards in this lane for the current search.'}
                </p>
              ) : (
                <>
                  <ShadeCardKanbanBoard
                    rows={filteredRows}
                    monoClass={mono}
                    onCardClick={(r) => setSpotlight(r)}
                    onDataChange={() => void load({ silent: true })}
                  />
                  <p className={`text-xs text-neutral-600 mt-2 ${mono}`}>
                    Click card for spotlight. Drag the grip (left) to <strong className="text-neutral-500">On-Floor</strong> or{' '}
                    <strong className="text-neutral-500">In-Stock</strong> to run issue / receive.
                  </p>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <p
          className="text-center text-xs text-neutral-500 pt-4 border-t border-ds-line/30 tracking-tight"
        >
          Audit Trail Synchronized - Accountability Layer Active.
        </p>
      </div>
      {issueOpen ? (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-background/70 p-4">
          <div className={`w-full max-w-md rounded-lg border border-ds-line/50 bg-ds-card p-4 space-y-3 text-sm ${mono}`}>
            <h2 className="text-lg font-semibold text-foreground">Issue to floor</h2>
            <p className="text-xs text-neutral-500">
              {issueRows.length} card{issueRows.length > 1 ? 's' : ''} selected
            </p>
            <label className="block text-neutral-400">
              Job card link <span className="text-ds-warning">(required)</span>
              <input
                value={jobCardQuery}
                onChange={(e) => {
                  setJobCardQuery(e.target.value)
                  setIssueJobCardId('')
                }}
                className="mt-1 w-full rounded border border-ds-line/50 bg-ds-elevated px-2 py-2 text-foreground"
                placeholder="Search # or customer…"
              />
            </label>
            {jobCardLoading ? <p className="text-xs text-neutral-500">Searching…</p> : null}
            {!issueJobCardId && jobCardHits.length > 0 ? (
              <ul className="max-h-28 overflow-y-auto rounded border border-ds-line/50 divide-y divide-ds-elevated text-xs">
                {jobCardHits.map((jc) => (
                  <li key={jc.id}>
                    <button
                      type="button"
                      className="w-full px-2 py-1.5 text-left hover:bg-ds-elevated text-ds-ink"
                      onClick={() => {
                        setIssueJobCardId(jc.id)
                        setJobCardQuery(`#${jc.jobCardNumber} · ${jc.customer.name}`)
                      }}
                    >
                      JC #{jc.jobCardNumber} · {jc.customer.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <label className="block text-neutral-400">
              Initial condition
              <select
                value={issueInitialCondition}
                onChange={(e) => setIssueInitialCondition(e.target.value as 'mint' | 'used' | 'minor_damage')}
                className="mt-1 w-full rounded border border-ds-line/50 bg-ds-elevated px-2 py-2 text-foreground"
              >
                <option value="mint">Mint</option>
                <option value="used">Used</option>
                <option value="minor_damage">Minor damage</option>
              </select>
            </label>
            <label className="block text-neutral-400">
              Machine
              <select
                value={machineId}
                onChange={(e) => setMachineId(e.target.value)}
                className="mt-1 w-full rounded border border-ds-line/50 bg-ds-elevated px-2 py-2 text-foreground"
              >
                <option value="">Select</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.machineCode} — {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-neutral-400">
              Operator
              <select
                value={operatorId}
                onChange={(e) => setOperatorId(e.target.value)}
                className="mt-1 w-full rounded border border-ds-line/50 bg-ds-elevated px-2 py-2 text-foreground"
              >
                <option value="">Select</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            {issueRows.some((r) => shadeCardAgeTier(r.currentAgeMonths ?? null) === 'expired') ? (
              <div className="rounded border border-rose-500/40 bg-rose-500/8 p-2">
                <label className="flex items-center gap-2 text-xs text-rose-700 dark:text-rose-300">
                  <input
                    type="checkbox"
                    checked={overrideExpired}
                    onChange={(e) => setOverrideExpired(e.target.checked)}
                    className="h-3.5 w-3.5 accent-ds-brand"
                  />
                  Override expired lock
                </label>
                {overrideExpired ? (
                  <input
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    className="mt-2 w-full rounded border border-ds-line/50 bg-background px-2 py-1.5 text-xs text-ds-ink"
                    placeholder="Reason for override (required)"
                  />
                ) : null}
              </div>
            ) : null}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setIssueOpen(false)} className="px-3 py-1.5 rounded border border-ds-line/50 text-ds-ink">
                Cancel
              </button>
              <button type="button" onClick={() => void submitIssue()} className="px-3 py-1.5 rounded bg-sky-600 text-white">
                Confirm issue
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {receiveOpen ? (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-background/70 p-4">
          <div className={`w-full max-w-md rounded-lg border border-ds-line/50 bg-ds-card p-4 space-y-3 text-sm ${mono}`}>
            <h2 className="text-lg font-semibold text-foreground">Receive to rack</h2>
            <p className="text-xs text-neutral-500">
              {receiveRows.length} card{receiveRows.length > 1 ? 's' : ''} selected
            </p>
            <label className="block text-neutral-400">
              Returning operator
              <select
                value={receiveOperatorId}
                onChange={(e) => setReceiveOperatorId(e.target.value)}
                className="mt-1 w-full rounded border border-ds-line/50 bg-ds-elevated px-2 py-2 text-foreground"
              >
                <option value="">Select</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-neutral-400">
              End condition
              <select
                value={receiveEndCondition}
                onChange={(e) => setReceiveEndCondition(e.target.value as 'mint' | 'used' | 'minor_damage')}
                className="mt-1 w-full rounded border border-ds-line/50 bg-ds-elevated px-2 py-2 text-foreground"
              >
                <option value="mint">Mint</option>
                <option value="used">Used</option>
                <option value="minor_damage">Minor damage</option>
              </select>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setReceiveOpen(false)} className="px-3 py-1.5 rounded border border-ds-line/50 text-ds-ink">
                Cancel
              </button>
              <button type="button" onClick={() => void submitReceive()} className="px-3 py-1.5 rounded bg-emerald-600 text-white">
                Confirm receive
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <ShadeCardSpotlightDrawer
        row={spotlight}
        onClose={() => setSpotlight(null)}
        onSaved={() => void load()}
      />
    </div>
  )
}
