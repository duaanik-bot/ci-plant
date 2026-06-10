'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { toast } from '@/store/toastStore'
import { IndustrialModuleShell } from '@/components/industrial/IndustrialModuleShell'
import { PRODUCTION_STAGES } from '@/lib/constants'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'

type Row = {
  stageRecord: {
    id: string
    status: string
    operator: string | null
    completedAt: string | null
    stageName: string
  }
  jobCard: {
    id: string
    jobCardNumber: number
    setNumber: string | null
    customer: { name: string }
    productName: string | null
    requiredSheets: number
    status: string
    industrialPriority?: boolean
    postPressRouting: Record<string, unknown> | null
    poMeta?: {
      poNumber: string
      poDate: string | null
      quantity: number
      coatingType: string | null
      paperType: string | null
      embossingLeafing: string | null
      gsm: number | null
      cartonName: string
      specOverrides: Record<string, unknown> | null
    } | null
    stageMap?: Record<string, { status: string; completedAt: string | null }>
  }
}

type Payload = {
  stageKey: string
  stageLabel: string
  jobCards: Row[]
}

type TriageStatus = 'pending' | 'make_ready_alert' | 'make_ready_started' | 'ready_to_receive' | 'in_progress' | 'hold' | 'completed'

const STATUS_COLS: Array<{ key: TriageStatus; label: string }> = [
  { key: 'pending', label: 'Pending' },
  { key: 'make_ready_alert', label: 'Make-Ready' },
  { key: 'ready_to_receive', label: 'Ready to Receive' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'hold', label: 'Hold' },
  { key: 'completed', label: 'Completed' },
]

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function triageMeta(row: Row, stageKey: string) {
  const ppr = asObj(row.jobCard.postPressRouting)
  const exec = asObj(ppr.executionOrchestration)
  const triageByStage = asObj(exec.triageByStage)
  const stageTriage = asObj(triageByStage[stageKey])
  const item = asObj(stageTriage[row.stageRecord.id])
  return {
    status: String(item.status ?? row.stageRecord.status ?? 'pending').toLowerCase() as TriageStatus,
    sequenceNo: Number(item.sequenceNo ?? 9999) || 9999,
    priorityRank: Number(item.priorityRank ?? (row.jobCard.industrialPriority ? 1 : 100)) || 100,
    machineId: (item.machineId as string | null) ?? null,
    operator: (item.operator as string | null) ?? row.stageRecord.operator ?? null,
    plannedStartTime: (item.plannedStartTime as string | null) ?? null,
    expectedArrivalTime: (() => {
      const progress = asObj(asObj(exec.stageProgress)[stageKey])
      return (progress.expectedArrivalTime as string | null) ?? null
    })(),
  }
}

export default function StageTriageBoardPage() {
  const params = useParams<{ stageKey: string }>()
  const stageKey = String(params?.stageKey ?? '')
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [spotlight, setSpotlight] = useState<Row | null>(null)
  const [search, setSearch] = useState('')
  const [density, setDensity] = useState<'compact' | 'comfortable' | 'detailed'>('comfortable')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/production/stages/${stageKey}`, { cache: 'no-store' })
      const json = (await res.json()) as Payload | { error?: string }
      if (!res.ok) throw new Error((json as { error?: string }).error || 'Failed')
      setData(json as Payload)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load triage board')
    } finally {
      setLoading(false)
    }
  }, [stageKey])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    try {
      const d = localStorage.getItem('prod-triage-density')
      if (d === 'compact' || d === 'comfortable' || d === 'detailed') setDensity(d)
    } catch {}
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('prod-triage-density', density)
    } catch {}
  }, [density])

  useEffect(() => {
    try {
      const key = `prod-triage-expanded-${stageKey}`
      const raw = localStorage.getItem(key)
      if (raw) setExpanded(JSON.parse(raw) as Record<string, boolean>)
    } catch {}
  }, [stageKey])

  const stageLabel = data?.stageLabel ?? PRODUCTION_STAGES.find((s) => s.key === stageKey)?.label ?? stageKey

  const cards = useMemo(() => {
    const rows = data?.jobCards ?? []
    const q = search.trim().toLowerCase()
    const filtered = q
      ? rows.filter((row) => {
          const hay = [
            row.jobCard.jobCardNumber,
            row.jobCard.productName ?? row.jobCard.poMeta?.cartonName ?? '',
            row.jobCard.customer.name,
            row.jobCard.setNumber ?? '',
            row.jobCard.poMeta?.poNumber ?? '',
            row.jobCard.poMeta?.paperType ?? '',
            row.jobCard.poMeta?.gsm ?? '',
          ]
            .join(' ')
            .toLowerCase()
          return hay.includes(q)
        })
      : rows
    const mapped = filtered.map((row) => ({ row, triage: triageMeta(row, stageKey) }))
    mapped.sort((a, b) => {
      if (a.triage.priorityRank !== b.triage.priorityRank) return a.triage.priorityRank - b.triage.priorityRank
      if (a.triage.sequenceNo !== b.triage.sequenceNo) return a.triage.sequenceNo - b.triage.sequenceNo
      return a.row.jobCard.jobCardNumber - b.row.jobCard.jobCardNumber
    })
    return mapped
  }, [data, stageKey, search])

  const groups = useMemo(() => {
    const m = new Map<TriageStatus, typeof cards>()
    STATUS_COLS.forEach((s) => m.set(s.key, []))
    for (const c of cards) {
      const k = c.triage.status
      const arr = m.get(k) ?? []
      arr.push(c)
      m.set(k, arr)
    }
    return m
  }, [cards])

  const groupingHints = useMemo(() => {
    const hints: string[] = []
    const coatingMap = new Map<string, number>()
    const boardMap = new Map<string, number>()
    const dieMap = new Map<string, number>()
    const pastingMap = new Map<string, number>()
    for (const c of cards) {
      const po = c.row.jobCard.poMeta
      const coating = String(po?.coatingType ?? '').trim()
      const board = `${String(po?.paperType ?? '').trim()}|${String(po?.gsm ?? '').trim()}`
      const die = String((po?.specOverrides?.dyeDetails as string | undefined) ?? '').trim()
      const pasting = String(po?.specOverrides?.pasting ?? '').trim()
      if (coating) coatingMap.set(coating, (coatingMap.get(coating) ?? 0) + 1)
      if (board && board !== '|') boardMap.set(board, (boardMap.get(board) ?? 0) + 1)
      if (die) dieMap.set(die, (dieMap.get(die) ?? 0) + 1)
      if (pasting) pastingMap.set(pasting, (pastingMap.get(pasting) ?? 0) + 1)
    }
    for (const [k, v] of Array.from(coatingMap.entries())) if (v >= 3) hints.push(`${v} jobs share coating "${k}". Consider running together.`)
    for (const [k, v] of Array.from(boardMap.entries())) if (v >= 3) hints.push(`${v} jobs share board/GSM "${k.replace('|', ' / ')}".`)
    for (const [k, v] of Array.from(dieMap.entries())) if (v >= 2) hints.push(`${v} jobs share die reference "${k}".`)
    for (const [k, v] of Array.from(pastingMap.entries())) if (v >= 3) hints.push(`${v} jobs share pasting type "${k}".`)
    return hints.slice(0, 4)
  }, [cards])

  async function patchCard(row: Row, patch: Record<string, unknown>) {
    setBusy(true)
    try {
      const res = await fetch(`/api/production/stages/${stageKey}/triage`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobCardId: row.jobCard.id,
          stageRecordId: row.stageRecord.id,
          ...patch,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof json?.error === 'string' ? json.error : 'Triage update failed')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Triage update failed')
    } finally {
      setBusy(false)
    }
  }

  const kpis = useMemo(() => ({
    pending: groups.get('pending')?.length ?? 0,
    makeReady: (groups.get('make_ready_alert')?.length ?? 0) + (groups.get('make_ready_started')?.length ?? 0) + (groups.get('ready_to_receive')?.length ?? 0),
    running: groups.get('in_progress')?.length ?? 0,
    hold: groups.get('hold')?.length ?? 0,
    completed: groups.get('completed')?.length ?? 0,
    urgent: cards.filter((c) => c.row.jobCard.industrialPriority).length,
  }), [cards, groups])

  const activity = useMemo(() => {
    const feed: Array<{ at: string; text: string; jobCardId: string }> = []
    for (const c of cards) {
      const ppr = asObj(c.row.jobCard.postPressRouting)
      const exec = asObj(ppr.executionOrchestration)
      const trail = Array.isArray(exec.stagePushTrail) ? exec.stagePushTrail : []
      for (const item of trail.slice(-6)) {
        const o = asObj(item)
        const at = String(o.at ?? '').trim()
        if (!at) continue
        const event = String(o.event ?? o.pushType ?? 'update')
        const stage = String(o.stage ?? o.fromStage ?? stageKey)
        feed.push({
          at,
          text: `JC-${c.row.jobCard.jobCardNumber}: ${event.replace(/_/g, ' ')} (${stage})`,
          jobCardId: c.row.jobCard.id,
        })
      }
    }
    feed.sort((a, b) => (a.at > b.at ? -1 : 1))
    return feed.slice(0, 20)
  }, [cards, stageKey])

  function toggleSection(name: string) {
    setExpanded((prev) => {
      const next = { ...prev, [name]: !(prev[name] ?? true) }
      try {
        localStorage.setItem(`prod-triage-expanded-${stageKey}`, JSON.stringify(next))
      } catch {}
      return next
    })
  }

  if (loading) {
    return (
      <IndustrialModuleShell title={`${stageLabel} Triage`} subtitle="Loading…">
        <div className="text-sm text-ds-ink-faint">Loading…</div>
      </IndustrialModuleShell>
    )
  }

  return (
    <>
      <IndustrialModuleShell
        title={`${stageLabel} Triage`}
        subtitle="Planner scheduling board linked to station execution queue."
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href={`/production/stages/${stageKey}`} className="text-sm text-ds-ink-muted hover:text-ds-ink">← Execution Queue</Link>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search Job/Client/Product/PO/Set"
              className="w-56 rounded-ds-md bg-ds-main px-2.5 py-1.5 text-xs text-ds-ink"
            />
            <div className="inline-flex rounded-ds-md bg-ds-main p-0.5 text-xs">
              {(['compact', 'comfortable', 'detailed'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDensity(d)}
                  className={`rounded-ds-sm px-2 py-1 ${density === d ? 'bg-amber-50 text-amber-800 ring-1 ring-amber-200' : 'text-ds-ink-muted'}`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-ds-ink-muted">
            <span>Pending: {kpis.pending}</span>
            <span>Make-ready: {kpis.makeReady}</span>
            <span>In progress: {kpis.running}</span>
            <span>Hold: {kpis.hold}</span>
            <span>Completed: {kpis.completed}</span>
            <span>Urgent: {kpis.urgent}</span>
          </div>
        </div>
        {groupingHints.length > 0 ? (
          <div className="space-y-1 rounded-ds-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
            {groupingHints.map((h) => (
              <div key={h}>{h}</div>
            ))}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-6">
          {STATUS_COLS.map((col) => {
            const list = groups.get(col.key) ?? []
            const wip = list.reduce((s, c) => s + Number(c.row.jobCard.poMeta?.quantity ?? 0), 0)
            return (
              <div
                key={col.key}
                className="rounded-ds-lg bg-ds-main min-h-[260px] shadow-ds-depth-sm"
                onDragOver={(e) => e.preventDefault()}
                onDrop={async () => {
                  if (!dragId) return
                  const moved = cards.find((c) => c.row.stageRecord.id === dragId)
                  if (!moved) return
                  await patchCard(moved.row, { status: col.key, sequenceNo: list.length + 1 })
                  setDragId(null)
                }}
              >
                <div className="px-3 py-2 text-xs font-semibold text-ds-ink-muted flex items-center justify-between">
                  <span>{col.label} ({list.length})</span>
                  <span className="rounded-full bg-ds-card px-2 py-0.5 text-[10px] text-ds-ink">WIP {wip.toLocaleString('en-IN')}</span>
                </div>
                <div className="space-y-2 p-2">
                  {list.map((c, idx) => (
                    <div
                      key={c.row.stageRecord.id}
                      draggable
                      onDragStart={() => setDragId(c.row.stageRecord.id)}
                      onClick={() => setSpotlight(c.row)}
                      className={`rounded-ds-md bg-ds-card text-xs cursor-grab active:cursor-grabbing ${
                        density === 'compact' ? 'p-1.5' : density === 'detailed' ? 'p-3' : 'p-2'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-designing-queue text-[var(--brand-primary)]">JC #{c.row.jobCard.jobCardNumber}</span>
                        <span className="text-ds-ink-faint">#{c.triage.sequenceNo}</span>
                      </div>
                      <div className="mt-1 text-ds-ink font-medium line-clamp-2">{c.row.jobCard.productName ?? c.row.jobCard.poMeta?.cartonName ?? '-'}</div>
                      <div className="mt-1 text-ds-ink-muted">{c.row.jobCard.customer.name}</div>
                      <div className="mt-1 text-ds-ink-faint">Qty {Number(c.row.jobCard.poMeta?.quantity ?? 0).toLocaleString('en-IN')}</div>
                      <div className="mt-1 text-ds-ink-faint">ETA {c.triage.expectedArrivalTime ? new Date(c.triage.expectedArrivalTime).toLocaleTimeString() : '-'}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <span className="rounded-full bg-ds-main px-1.5 py-0.5 text-[10px] text-ds-ink-muted">Queue #{c.triage.sequenceNo}</span>
                        <span className="rounded-full bg-ds-main px-1.5 py-0.5 text-[10px] text-ds-ink-muted">Machine slot {c.triage.plannedStartTime ? new Date(c.triage.plannedStartTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-'}</span>
                        {c.row.jobCard.industrialPriority ? (
                          <span className="rounded-full bg-[var(--error-bg)] px-1.5 py-0.5 text-[10px] text-[var(--error)]">Urgent</span>
                        ) : null}
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-1">
                        <button
                          type="button"
                          disabled={busy}
                          className="rounded bg-ds-elevated px-1.5 py-0.5 text-[11px] hover:bg-ds-main disabled:opacity-50"
                          onClick={(e) => {
                            e.stopPropagation()
                            void patchCard(c.row, { sequenceNo: Math.max(1, c.triage.sequenceNo - 1) })
                          }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          className="rounded bg-ds-elevated px-1.5 py-0.5 text-[11px] hover:bg-ds-main disabled:opacity-50"
                          onClick={(e) => {
                            e.stopPropagation()
                            void patchCard(c.row, { sequenceNo: c.triage.sequenceNo + 1 })
                          }}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          className="rounded bg-[var(--warning-bg)] px-1.5 py-0.5 text-[11px] text-[var(--warning)] hover:bg-[var(--warning-bg)] disabled:opacity-50"
                          onClick={(e) => {
                            e.stopPropagation()
                            void patchCard(c.row, { status: 'make_ready_alert' })
                          }}
                        >
                          Make-ready
                        </button>
                      </div>
                      {idx < list.length - 1 ? <div className="mt-2" /> : null}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </IndustrialModuleShell>

      <SlideOverPanel
        title={spotlight ? `JC#${spotlight.jobCard.jobCardNumber} · ${stageLabel} Triage` : 'Triage'}
        isOpen={spotlight != null}
        onClose={() => setSpotlight(null)}
      >
        {spotlight ? (
          <div className="space-y-3 text-sm">
            <div className="sticky top-0 z-20 rounded-ds-md bg-ds-main px-3 py-2 shadow-ds-depth-sm">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-designing-queue text-[var(--brand-primary)]">JC #{spotlight.jobCard.jobCardNumber}</span>
                <span className="text-ds-ink">{spotlight.jobCard.productName ?? spotlight.jobCard.poMeta?.cartonName ?? '-'}</span>
                <span className="text-ds-ink-muted">| {spotlight.jobCard.customer.name}</span>
                <span className="rounded-full bg-ds-main px-2 py-0.5 text-[10px] text-ds-ink-muted">Stage {stageLabel}</span>
                <span className="rounded-full bg-ds-main px-2 py-0.5 text-[10px] text-ds-ink-muted">ETA {triageMeta(spotlight, stageKey).expectedArrivalTime ? new Date(triageMeta(spotlight, stageKey).expectedArrivalTime!).toLocaleTimeString() : '-'}</span>
              </div>
            </div>
            <div className="rounded-ds-md bg-ds-main p-3">
              <button type="button" className="w-full text-left text-xs text-ds-ink-faint" onClick={() => toggleSection('snapshot')}>Job Snapshot</button>
              {expanded.snapshot !== false ? (
                <div className="mt-2 text-xs text-ds-ink-muted space-y-1">
                  <div>PO: {spotlight.jobCard.poMeta?.poNumber ?? '-'}</div>
                  <div>Set: {spotlight.jobCard.setNumber ?? '-'}</div>
                  <div>Qty: {Number(spotlight.jobCard.poMeta?.quantity ?? 0).toLocaleString('en-IN')}</div>
                  <div>Material: {spotlight.jobCard.poMeta?.paperType ?? '-'} / {spotlight.jobCard.poMeta?.gsm ?? '-'}</div>
                </div>
              ) : null}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded-ds-md bg-ds-main p-3">
                <button type="button" className="w-full text-left text-xs text-ds-ink-faint" onClick={() => toggleSection('flow')}>Stage Flow</button>
                {expanded.flow !== false ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {['cutting', 'printing', 'chemical_coating', 'embossing', 'dye_cutting', 'pasting', 'sorting'].map((k) => {
                      const label = PRODUCTION_STAGES.find((s) => s.key === k)?.label ?? k
                      const st = spotlight.jobCard.stageMap?.[label]?.status ?? 'pending'
                      const cls = st === 'completed' ? 'bg-[var(--success-bg)] text-[var(--success)]' : st === 'in_progress' ? 'bg-[var(--info-bg)] text-[var(--info)]' : st.includes('make_ready') ? 'bg-[var(--warning-bg)] text-[var(--warning)]' : st === 'hold' ? 'bg-zinc-200 text-zinc-700' : 'bg-ds-card text-ds-ink-muted'
                      return <span key={k} className={`rounded-full px-2 py-0.5 text-[10px] ${cls}`}>{label}</span>
                    })}
                  </div>
                ) : null}
              </div>
              <div className="rounded-ds-md bg-ds-main p-3">
                <button type="button" className="w-full text-left text-xs text-ds-ink-faint" onClick={() => toggleSection('warnings')}>Inline Warnings</button>
                {expanded.warnings !== false ? (
                  <div className="mt-2 space-y-1 text-xs">
                    {spotlight.jobCard.industrialPriority ? <div className="text-[var(--error)]">⚠ Upcoming priority job.</div> : null}
                    {triageMeta(spotlight, stageKey).status === 'hold' ? <div className="text-[var(--warning)]">⚠ Job on hold.</div> : null}
                    {triageMeta(spotlight, stageKey).status === 'make_ready_alert' ? <div className="text-[var(--warning)]">⚠ Make-ready required.</div> : null}
                    <div className="text-ds-ink-muted">⚠ Verify tooling and material before start.</div>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="rounded-ds-md bg-ds-main p-3">
              <button type="button" className="w-full text-left text-xs text-ds-ink-faint" onClick={() => toggleSection('activity')}>Live Activity Feed</button>
              {expanded.activity !== false ? (
                <div className="mt-2 max-h-40 overflow-auto space-y-1">
                  {activity.map((a) => (
                    <div key={`${a.at}-${a.text}`} className="text-xs text-ds-ink-muted">
                      <span className="text-ds-ink-faint">{new Date(a.at).toLocaleTimeString()} </span>
                      {a.text}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="sticky bottom-0 z-20 rounded-ds-md bg-ds-main px-2 py-2 shadow-ds-depth-sm">
              <div className="grid grid-cols-2 gap-2">
                <button className="rounded bg-[var(--info-bg)] px-2 py-1 text-xs text-[var(--info)] hover:bg-[var(--info-bg)]" onClick={() => void patchCard(spotlight, { status: 'in_progress' })}>Start</button>
                <button className="rounded bg-[var(--warning-bg)] px-2 py-1 text-xs text-[var(--warning)] hover:bg-[var(--warning-bg)]" onClick={() => void patchCard(spotlight, { status: 'make_ready_alert' })}>Make-Ready</button>
                <button className="rounded bg-cyan-900/20 px-2 py-1 text-xs text-cyan-300 hover:bg-cyan-900/20" onClick={() => void patchCard(spotlight, { status: 'ready_to_receive' })}>Ready Receive</button>
                <button className="rounded bg-zinc-900/20 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-900/20" onClick={() => void patchCard(spotlight, { status: 'hold' })}>Hold</button>
                <button className="rounded bg-[var(--success-bg)] px-2 py-1 text-xs text-[var(--success)] hover:bg-[var(--success-bg)]" onClick={() => void patchCard(spotlight, { status: 'completed' })}>Complete</button>
                <button className="rounded bg-ds-elevated px-2 py-1 text-xs text-ds-ink-muted hover:bg-ds-card" onClick={() => void patchCard(spotlight, { status: 'pending' })}>Reset</button>
              </div>
            </div>
          </div>
        ) : null}
      </SlideOverPanel>
    </>
  )
}
