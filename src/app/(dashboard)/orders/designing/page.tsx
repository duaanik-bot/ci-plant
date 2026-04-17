'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  FileDown,
  ImageOff,
  Layers,
  Pencil,
  Search,
  X,
} from 'lucide-react'
import { parseDesignerCommand } from '@/lib/designer-command'
import {
  useCommandPalette,
  CommandPaletteTriggerIcon,
} from '@/components/command-palette/CommandPalette'
import { DEFAULT_PREPRESS_AUDIT_LEAD } from '@/lib/pre-press-defaults'

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
  if (days <= 7) return 'text-amber-400'
  return 'text-rose-400 animate-po-age-alert'
}

function pipelineBadge(phase: Row['readiness']['pipelinePhase']) {
  const base =
    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1'
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
        className: `${base} bg-slate-600/25 text-slate-200 ring-slate-600/40`,
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
        className="h-6 w-6 shrink-0 rounded-full object-cover ring-1 ring-slate-600"
        loading="lazy"
        onError={() => setBroken(true)}
      />
    )
  }
  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold tabular-nums ring-1 ring-white/15"
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
  paletteQuery,
  onClearQuery,
}: {
  paletteQuery: string
  onClearQuery: () => void
}) {
  const { open } = useCommandPalette()
  const [kbd, setKbd] = useState('⌘K')
  useEffect(() => {
    const mac = /Mac|iPod|iPhone|iPad/i.test(navigator.userAgent)
    setKbd(mac ? '⌘K' : 'Ctrl+K')
  }, [])
  return (
    <div className="flex w-full max-w-2xl mx-auto items-stretch gap-2">
      <button
        type="button"
        onClick={() => open()}
        className="group min-w-0 flex-1 flex items-center gap-2 rounded-xl border border-amber-500/40 bg-black px-4 py-2.5 text-left text-sm shadow-[0_0_20px_rgba(245,158,11,0.08)] ring-1 ring-white/10 backdrop-blur-sm transition hover:border-amber-400/70 hover:ring-amber-400/25"
        aria-label="Open command palette"
      >
        <Search className="h-4 w-4 text-amber-400 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-center text-slate-400 group-hover:text-slate-200 sm:text-left">
          {paletteQuery.trim().length >= 2 ? (
            <>
              <span className="text-emerald-400/90">Filtering queue:</span>{' '}
              <span className="text-slate-100">{paletteQuery.trim()}</span>
            </>
          ) : (
            <>
              Search carton or PO # <span className="text-amber-500/90">({kbd})</span>
            </>
          )}
        </span>
      </button>
      {paletteQuery.trim().length >= 2 ? (
        <button
          type="button"
          onClick={() => onClearQuery()}
          className="shrink-0 self-center rounded-xl border border-white/15 bg-black px-2.5 py-2 text-slate-500 hover:border-amber-500/40 hover:text-amber-300"
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
    'h-12 w-12 shrink-0 overflow-hidden rounded-[4px] border border-slate-700 bg-black'

  if (!url || broken) {
    return (
      <div
        className={`flex ${thumbClass} items-center justify-center text-slate-600`}
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
        className={`group relative ${thumbClass} focus:outline-none focus:ring-2 focus:ring-amber-500/50`}
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
              className="pointer-events-none fixed inset-0 z-[85] flex items-center justify-center bg-black/35 backdrop-blur-[2px]"
              aria-hidden
            >
              <div className="h-[144px] w-[144px] overflow-hidden rounded-[4px] border border-slate-700 shadow-2xl ring-1 ring-black/50">
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

function LightboxModal({ src, alt, onClose }: { src: string | null; alt: string; onClose: () => void }) {
  if (!src) return null
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/92 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="Artwork preview"
      onClick={onClose}
    >
      <button
        type="button"
        className="absolute right-3 top-3 rounded-lg border border-white/20 bg-black p-2 text-slate-400 hover:text-white"
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
        <img src={src} alt={alt} className="max-h-[85vh] w-auto max-w-full object-contain shadow-2xl ring-1 ring-white/10" />
      </div>
    </div>
  )
}

export default function DesigningQueuePage() {
  const router = useRouter()
  const { paletteQuery, clearPaletteQuery } = useCommandPalette()
  const [rows, setRows] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [customerId, setCustomerId] = useState('')
  const [finalizingId, setFinalizingId] = useState<string | null>(null)
  const [forwardingId, setForwardingId] = useState<string | null>(null)
  const [recallingPlanningId, setRecallingPlanningId] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const [custRes, usersRes, linesRes] = await Promise.all([
        fetch('/api/masters/customers'),
        fetch('/api/users'),
        fetch(`/api/designing/po-lines?${customerId ? `customerId=${customerId}` : ''}`),
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
  }, [customerId])

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

  const userById = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u])), [users])

  const filteredRows = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase()
    if (q.length < 2) return rows
    return rows.filter(
      (r) =>
        r.cartonName.toLowerCase().includes(q) ||
        r.po.poNumber.toLowerCase().includes(q),
    )
  }, [rows, paletteQuery])

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
      const res = await fetch(`/api/designing/po-lines/${r.id}/recall-planning`, { method: 'POST' })
      const json = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Recall failed')
      toast.success('Recalled from planning')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Recall failed')
    } finally {
      setRecallingPlanningId(null)
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
      <div className={`min-h-[40vh] p-4 text-slate-500 ${mono}`}>Loading…</div>
    )
  }

  return (
    <div className="min-h-screen bg-[#000000] text-slate-200">
      <div className="border-b border-white/10 bg-black px-3 py-2 md:hidden flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-amber-400 truncate">Artwork queue</span>
        <CommandPaletteTriggerIcon />
      </div>

      <div className="mx-auto max-w-[1600px] space-y-3 px-2 py-3 pb-10 sm:px-3">
        <div className="rounded-lg border border-white/10 bg-black px-2 py-1.5 sm:px-3">
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
            <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300/90">
              Customer PO ✓
            </span>
            <span>→</span>
            <span className="rounded border border-amber-500/35 bg-amber-500/10 px-1.5 py-0.5 text-amber-200/95">
              Visual audit
            </span>
            <span>→</span>
            <span className="rounded border border-white/10 px-1.5 py-0.5 text-slate-400">Plate Hub</span>
            <span>→</span>
            <span className="rounded border border-white/10 px-1.5 py-0.5 text-slate-400">Planning</span>
          </div>
        </div>

        <div className="py-1">
          <NeonCommandFilterTrigger
            paletteQuery={paletteQuery}
            onClearQuery={clearPaletteQuery}
          />
        </div>

        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold text-amber-400 sm:text-xl">Visual audit station</h1>
            <p className="text-[10px] text-slate-500 sm:text-xs">
              Pre-press audit · <span className="text-slate-400">{PREPRESS_AUDIT_LEAD}</span> · Ready:{' '}
              <span className="font-semibold text-amber-300">{readyCount}</span> / {rows.length}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/orders/purchase-orders"
              className="rounded-lg border border-white/15 bg-black px-2.5 py-1 text-xs text-slate-200 hover:border-amber-500/40"
            >
              POs
            </Link>
            <Link
              href="/hub/plates"
              className="rounded-lg border border-white/15 bg-black px-2.5 py-1 text-xs text-slate-200 hover:border-amber-500/40"
            >
              Plate Hub
            </Link>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className={`min-w-[160px] rounded border border-white/15 bg-black px-2 py-1 text-slate-200 ${mono}`}
          >
            <option value="">All customers</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="overflow-x-auto rounded-lg border border-white/10 bg-[#000000]">
          <table className="w-full min-w-[1100px] table-fixed border-collapse text-left text-[11px]">
            <thead className="border-b border-white/10 bg-[#000000] text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="w-[52px] px-1 py-1">Preview</th>
                <th className="w-[5.5rem] px-1 py-1">PO #</th>
                <th className="w-[6.5rem] px-1 py-1">Customer</th>
                <th className="min-w-[9rem] px-1 py-1">Carton</th>
                <th className="w-10 px-1 py-1 text-right">Qty</th>
                <th className="w-9 px-1 py-1">Set</th>
                <th className="w-[5rem] px-1 py-1">Designer</th>
                <th className="w-[8.5rem] px-1 py-1">Pipeline</th>
                <th className="w-12 px-1 py-1 text-right">Days</th>
                <th className="min-w-[11rem] px-1 py-1">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 bg-[#000000]">
              {filteredRows.map((r) => {
                const designerId = r.specOverrides?.assignedDesignerId
                const designerName = designerId ? (userById[designerId]?.name ?? '—') : '—'
                const approvalsDone = !!r.readiness.approvalsComplete
                const finalized = !!r.readiness.prePressFinalized
                const planningForwarded = !!r.readiness.planningForwarded
                const spec = (r.specOverrides || {}) as Record<string, unknown>
                const machineAllocated = !!String(spec.machineId || '').trim()
                const canFinalizeRow =
                  approvalsDone && !finalized && !!(r.setNumber || '').trim() && !!(r.artworkCode || '').trim()
                const canRecallPlanning =
                  planningForwarded &&
                  !machineAllocated &&
                  !['in_production', 'closed'].includes(r.planningStatus)
                const phase = r.readiness.pipelinePhase ?? 'drafting'
                const dQ = daysInQueue(r.createdAt)
                const badge = pipelineBadge(phase)
                const previewUrl = r.artworkPreviewUrl ?? null

                return (
                  <tr
                    key={r.id}
                    className={`border-l-2 border-transparent transition-colors hover:border-amber-500 hover:bg-white/[0.03] ${r.directorHold ? 'opacity-45' : ''}`}
                  >
                    <td className="px-1 py-0.5 align-middle">
                      <ArtworkPreviewCell
                        url={previewUrl}
                        alt={r.cartonName}
                        onOpenLightbox={(src) =>
                          setLightbox({ src, alt: `${r.po.poNumber} · ${r.cartonName}` })
                        }
                      />
                    </td>
                    <td className={`px-1 py-0.5 align-middle ${mono} text-amber-200/95`}>
                      <div className="flex flex-col gap-0.5 leading-tight">
                        <span className="break-all">{r.po.poNumber}</span>
                        {r.directorPriority ? (
                          <span className="w-fit rounded bg-amber-500/15 px-1 text-[8px] font-bold uppercase text-amber-300 ring-1 ring-amber-500/30">
                            Priority
                          </span>
                        ) : null}
                        {r.directorHold ? (
                          <span className="w-fit rounded bg-slate-600/30 px-1 text-[8px] text-slate-400">Hold</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-1 py-0.5 align-middle text-slate-300 leading-tight break-words">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <CustomerAvatar
                          name={r.po.customer.name}
                          logoUrl={r.po.customer.logoUrl}
                        />
                        <span className="min-w-0">{r.po.customer.name}</span>
                      </div>
                    </td>
                    <td className="px-1 py-0.5 align-middle text-slate-100 leading-snug break-words">
                      {r.cartonName}
                    </td>
                    <td className={`px-1 py-0.5 align-middle text-right ${mono} text-slate-200`}>
                      {r.quantity}
                    </td>
                    <td className={`px-1 py-0.5 align-middle ${mono} text-slate-300`}>
                      {r.setNumber ?? '—'}
                    </td>
                    <td className="px-1 py-0.5 align-middle text-[10px] text-slate-400 leading-tight">
                      {designerName}
                    </td>
                    <td className="px-1 py-0.5 align-middle">
                      <span
                        className={`${badge.className} ${badge.pulse ? 'animate-pulse motion-reduce:animate-none' : ''}`}
                        title={
                          (r.readiness.artworkStatusLabel ?? '') +
                          (planningForwarded ? ' · Plate Hub: forwarded to planning' : ' · Plate Hub: pending')
                        }
                      >
                        <Layers
                          className={`h-3 w-3 shrink-0 ${
                            planningForwarded ? 'text-emerald-400' : 'text-slate-500'
                          }`}
                          aria-hidden
                        />
                        {badge.label}
                      </span>
                    </td>
                    <td className={`px-1 py-0.5 align-middle text-right ${mono} text-xs ${ageClass(dQ)}`}>
                      {dQ}d
                    </td>
                    <td className="px-1 py-0.5 align-middle">
                      <div className="flex flex-wrap items-center gap-1">
                        <Link
                          href={`/orders/designing/${r.id}`}
                          className="inline-flex items-center gap-1 rounded border border-white/20 bg-transparent px-2 py-0.5 text-[10px] font-medium text-slate-100 hover:border-amber-500/50 hover:bg-amber-500/10"
                        >
                          <Pencil className="h-3 w-3 opacity-70" aria-hidden />
                          Edit
                        </Link>
                        {approvalsDone && !planningForwarded && (
                          <button
                            type="button"
                            disabled={forwardingId === r.id}
                            onClick={() => void forwardPlanning(r)}
                            className="rounded border border-white/20 bg-transparent px-2 py-0.5 text-[10px] font-medium text-slate-100 hover:border-violet-400/50 hover:bg-violet-500/10 disabled:opacity-40"
                          >
                            {forwardingId === r.id ? '…' : 'Forward'}
                          </button>
                        )}
                        {canFinalizeRow && (
                          <button
                            type="button"
                            disabled={finalizingId === r.id}
                            onClick={() => void finalizeFromList(r)}
                            className="rounded border border-emerald-500/40 bg-transparent px-2 py-0.5 text-[10px] font-medium text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-40"
                          >
                            {finalizingId === r.id ? '…' : 'Plate Hub'}
                          </button>
                        )}
                        {finalized && (
                          <Link
                            href="/hub/plates"
                            className="rounded border border-emerald-500/30 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/10"
                          >
                            Plates
                          </Link>
                        )}
                        {planningForwarded && (
                          <Link
                            href="/orders/planning"
                            className="rounded border border-emerald-500/30 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/10"
                          >
                            Planning
                          </Link>
                        )}
                        {canRecallPlanning && (
                          <button
                            type="button"
                            disabled={recallingPlanningId === r.id}
                            onClick={() => void recallPlanning(r)}
                            className="rounded border border-rose-500/35 px-2 py-0.5 text-[10px] text-rose-300 hover:bg-rose-500/10 disabled:opacity-40"
                          >
                            {recallingPlanningId === r.id ? '…' : 'Recall'}
                          </button>
                        )}
                        <a
                          href={`/api/designing/po-lines/${r.id}/job-spec-pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center justify-center rounded border p-1 hover:bg-orange-500/15"
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
                          href={`/orders/purchase-orders/${r.po.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-slate-500 hover:text-slate-300"
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
        </div>

        {filteredRows.length === 0 && (
          <p className="py-8 text-center text-sm text-slate-600">
            {paletteQuery.trim().length >= 2 ? 'No rows match filter.' : 'No items in designing queue.'}
          </p>
        )}
      </div>

      <LightboxModal
        src={lightbox?.src ?? null}
        alt={lightbox?.alt ?? ''}
        onClose={() => setLightbox(null)}
      />
    </div>
  )
}
