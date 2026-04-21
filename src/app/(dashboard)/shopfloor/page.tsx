'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { toast } from 'sonner'
import { PRODUCTION_STAGES } from '@/lib/constants'
import {
  PRODUCTION_DOWNTIME_CATEGORIES,
  PRODUCTION_DOWNTIME_LOCK_SECONDS,
} from '@/lib/production-oee-constants'

type Stage = {
  id: string
  stageName: string
  status: string
  operator: string | null
  counter: number | null
  sheetSize: string | null
  excessSheets: number | null
  completedAt: string | null
  lastProductionTickAt?: string | null
  inProgressSince?: string | null
}

type JobCard = {
  id: string
  jobCardNumber: number
  setNumber: string | null
  productName: string | null
  customer: { id: string; name: string }
  requiredSheets: number
  totalSheets: number
  sheetsIssued: number
  status: string
  createdAt: string
  machineId?: string | null
  stages: Stage[]
}

function idleSecondsInProgress(stage: Stage, jobCreatedAt: string): number {
  if (stage.status !== 'in_progress') return 0
  const ref = stage.lastProductionTickAt ?? stage.inProgressSince ?? jobCreatedAt
  return Math.max(0, Math.floor((Date.now() - new Date(ref).getTime()) / 1000))
}

type StageQueueItem = {
  stageRecord: { id: string; stageName: string; status: string; operator: string | null; counter: number | null }
  jobCard: {
    id: string
    jobCardNumber: number
    setNumber: string | null
    customer: { name: string }
    status: string
    productName?: string | null
  } | null
}

const TABS = [
  { id: 'jobs', label: 'Jobs', icon: '📋' },
  { id: 'stages', label: 'Stages', icon: '⚙️' },
  { id: 'more', label: 'More', icon: '⋯' },
] as const

export default function ShopfloorPage() {
  const { data: session } = useSession()
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('jobs')
  const [jobCards, setJobCards] = useState<JobCard[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [stageKey, setStageKey] = useState<string | null>(null)
  const [stageQueue, setStageQueue] = useState<StageQueueItem[]>([])
  const [saving, setSaving] = useState(false)
  const [counterVal, setCounterVal] = useState<Record<string, string>>({})
  const [excessSheetsVal, setExcessSheetsVal] = useState<Record<string, string>>({})
  const [downtimeOpen, setDowntimeOpen] = useState<{
    jobCardId: string
    stageId: string
    machineId: string | null
    gapStartedAt: string
  } | null>(null)
  const [downtimeCategory, setDowntimeCategory] = useState('WAITING_MATERIAL')
  const [downtimeNotes, setDowntimeNotes] = useState('')
  const [downtimeSubmitting, setDowntimeSubmitting] = useState(false)

  const fetchJobCards = useCallback(() => {
    fetch('/api/shopfloor/job-cards')
      .then((r) => r.json())
      .then((data) => setJobCards(Array.isArray(data) ? data : []))
      .catch(() => setJobCards([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchJobCards()
  }, [fetchJobCards])

  useEffect(() => {
    const t = setInterval(() => void fetchJobCards(), 20_000)
    return () => clearInterval(t)
  }, [fetchJobCards])

  useEffect(() => {
    if (!jobCards.length || downtimeOpen) return
    for (const jc of jobCards) {
      for (const s of jc.stages) {
        if (s.status !== 'in_progress') continue
        const idle = idleSecondsInProgress(s, jc.createdAt)
        if (idle > PRODUCTION_DOWNTIME_LOCK_SECONDS) {
          const ref = s.lastProductionTickAt ?? s.inProgressSince ?? jc.createdAt
          setDowntimeOpen({
            jobCardId: jc.id,
            stageId: s.id,
            machineId: jc.machineId ?? null,
            gapStartedAt: new Date(ref).toISOString(),
          })
          return
        }
      }
    }
  }, [jobCards, downtimeOpen])

  const fetchStageQueue = useCallback((key: string) => {
    fetch(`/api/production/stages/${key}`)
      .then((r) => r.json())
      .then((data) => setStageQueue(data?.jobCards ?? []))
      .catch(() => setStageQueue([]))
  }, [])

  useEffect(() => {
    if (stageKey) fetchStageQueue(stageKey)
  }, [stageKey, fetchStageQueue])

  async function updateStage(
    jobCardId: string,
    stageId: string,
    patch: { status?: string; counter?: number | null; excessSheets?: number | null },
  ) {
    setSaving(true)
    try {
      const jc = jobCards.find((j) => j.id === jobCardId) || (await fetch(`/api/job-cards/${jobCardId}`).then((r) => r.json()))
      const stages = (jc.stages || []).map((s: Stage) =>
        s.id === stageId ? { ...s, ...patch } : s,
      )
      const res = await fetch(`/api/job-cards/${jobCardId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stages: stages.map((s: Stage) => ({
            id: s.id,
            status: s.status,
            operator: s.operator,
            counter: s.counter,
            sheetSize: s.sheetSize,
            excessSheets: s.excessSheets,
          })),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      toast.success(
        patch.status === 'completed'
          ? 'Stage completed — moved to next queue'
          : patch.counter != null
            ? 'Production pulse logged'
            : 'Stage started',
      )
      setCounterVal((prev) => ({ ...prev, [stageId]: '' }))
      setExcessSheetsVal((prev) => ({ ...prev, [stageId]: '' }))
      fetchJobCards()
      if (stageKey) fetchStageQueue(stageKey)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  const currentStage = (jc: JobCard) => jc.stages.find((s) => s.status === 'in_progress') || jc.stages.find((s) => s.status === 'ready')

  async function submitDowntimeReason() {
    if (!downtimeOpen || !session?.user) {
      toast.error('Sign in required to log downtime')
      return
    }
    setDowntimeSubmitting(true)
    try {
      const res = await fetch('/api/production/downtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productionJobCardId: downtimeOpen.jobCardId,
          productionStageRecordId: downtimeOpen.stageId,
          machineId: downtimeOpen.machineId,
          reasonCategory: downtimeCategory,
          gapStartedAt: downtimeOpen.gapStartedAt,
          notes: downtimeNotes.trim() || null,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((j as { error?: string }).error || 'Log failed')
      toast.success('Downtime logged — timestamped to your operator ID')
      setDowntimeOpen(null)
      setDowntimeNotes('')
      fetchJobCards()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setDowntimeSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col pb-20">
      <header className="p-4 border-b border-zinc-800 sticky top-0 bg-background z-10">
        <h1 className="text-xl font-bold text-orange-400">Shopfloor</h1>
        <p className="text-xs text-slate-500 mt-0.5">Production job cards</p>
      </header>

      <main className="flex-1 p-4 overflow-y-auto">
        {tab === 'jobs' && (
          <div className="space-y-3">
            {loading ? (
              <p className="text-slate-400">Loading…</p>
            ) : (
              jobCards.map((jc) => {
                const stage = currentStage(jc)
                const isExpanded = expandedId === jc.id
                return (
                  <div
                    key={jc.id}
                    className="rounded-xl border border-zinc-800 bg-zinc-950/80 overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : jc.id)}
                      className="w-full p-4 text-left flex items-center justify-between"
                    >
                      <div>
                        <p className="font-mono font-semibold text-amber-400">
                          JC#{jc.jobCardNumber}
                          {jc.productName ? ` · ${jc.productName}` : ''}
                        </p>
                        <p className="text-sm text-slate-300">{jc.customer.name}</p>
                        <p className="text-xs text-slate-500">
                          {jc.setNumber ? `Set ${jc.setNumber}` : ''} · Sheets: {jc.sheetsIssued}/{jc.totalSheets}
                        </p>
                      </div>
                      <div className="text-right">
                        {stage && (
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-xs ${
                              stage.status === 'in_progress' ? 'bg-amber-600 text-primary-foreground' : 'bg-slate-600 text-slate-200'
                            }`}
                          >
                            {stage.stageName}
                          </span>
                        )}
                        <span className="block text-xs text-slate-500 mt-1">{jc.status}</span>
                        <span className="text-slate-400">{isExpanded ? '▼' : '▶'}</span>
                      </div>
                    </button>
                    {isExpanded && (
                      <div className="border-t border-zinc-800 p-4 space-y-3 bg-background/40">
                        {jc.stages.map((s) => {
                          const idleSec = idleSecondsInProgress(s, jc.createdAt)
                          const lock = s.status === 'in_progress' && idleSec > PRODUCTION_DOWNTIME_LOCK_SECONDS
                          return (
                          <div
                            key={s.id}
                            className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 p-3"
                          >
                            <span className="font-medium text-slate-200 w-32">{s.stageName}</span>
                            <span
                              className={`px-2 py-0.5 rounded text-xs ${
                                s.status === 'completed'
                                  ? 'bg-green-800 text-green-200'
                                  : s.status === 'in_progress'
                                    ? 'bg-amber-600 text-primary-foreground'
                                    : 'bg-slate-700 text-slate-400'
                              }`}
                            >
                              {s.status}
                            </span>
                            {s.status === 'in_progress' && (
                              <>
                                <input
                                  type="number"
                                  min={0}
                                  placeholder="Counter"
                                  value={counterVal[s.id] ?? ''}
                                  onChange={(e) => setCounterVal((prev) => ({ ...prev, [s.id]: e.target.value }))}
                                  className={`w-24 px-2 py-1 rounded bg-zinc-900 border text-foreground text-sm font-designing-queue ${
                                    lock
                                      ? 'border-rose-500 ring-2 ring-rose-500/70 animate-pulse'
                                      : 'border-zinc-600'
                                  }`}
                                />
                                <input
                                  type="number"
                                  min={0}
                                  placeholder="Excess sheets"
                                  value={excessSheetsVal[s.id] ?? ''}
                                  onChange={(e) =>
                                    setExcessSheetsVal((prev) => ({ ...prev, [s.id]: e.target.value }))
                                  }
                                  className="w-28 px-2 py-1 rounded bg-zinc-900 border border-zinc-600 text-foreground text-sm"
                                />
                                <button
                                  type="button"
                                  disabled={saving || counterVal[s.id] === '' || counterVal[s.id] == null}
                                  onClick={() =>
                                    updateStage(jc.id, s.id, {
                                      counter: parseInt(counterVal[s.id], 10),
                                    })
                                  }
                                  className="px-2 py-1.5 rounded-lg bg-orange-600/90 hover:bg-orange-500 disabled:opacity-40 text-foreground text-xs font-medium"
                                >
                                  Log pulse
                                </button>
                                <button
                                  type="button"
                                  disabled={saving}
                                  onClick={() =>
                                    updateStage(jc.id, s.id, {
                                      status: 'completed',
                                      counter: counterVal[s.id] ? parseInt(counterVal[s.id], 10) : null,
                                      excessSheets: excessSheetsVal[s.id]
                                        ? parseInt(excessSheetsVal[s.id], 10) : null,
                                    })
                                  }
                                  className="px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 text-primary-foreground text-sm font-medium"
                                >
                                  Complete
                                </button>
                              </>
                            )}
                            {s.status === 'ready' && (
                              <button
                                type="button"
                                disabled={saving}
                                onClick={() => updateStage(jc.id, s.id, { status: 'in_progress' })}
                                className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-primary-foreground text-sm font-medium"
                              >
                                Start
                              </button>
                            )}
                          </div>
                          )
                        })}
                        <Link
                          href={`/production/job-cards/${jc.id}`}
                          className="inline-block text-sm text-amber-400 hover:underline"
                        >
                          Open job card →
                        </Link>
                      </div>
                    )}
                  </div>
                )
              })
            )}
            {!loading && jobCards.length === 0 && (
              <p className="text-slate-500 text-center py-8">No active job cards.</p>
            )}
          </div>
        )}

        {tab === 'stages' && (
          <div className="space-y-2">
            {!stageKey ? (
              PRODUCTION_STAGES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setStageKey(s.key)}
                  className="w-full p-4 rounded-xl border border-slate-700 bg-slate-800/80 text-left flex items-center justify-between"
                >
                  <span className="font-medium text-slate-200">{s.label}</span>
                  <span className="text-slate-400">→</span>
                </button>
              ))
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setStageKey(null)}
                  className="text-sm text-slate-400 hover:text-foreground mb-2"
                >
                  ← Back to stages
                </button>
                <div className="space-y-2">
                  {stageQueue.map((item, i) => (
                    <div
                      key={item.stageRecord.id + i}
                      className="p-4 rounded-xl border border-slate-700 bg-slate-800/80"
                    >
                      {item.jobCard && (
                        <>
                          <p className="font-mono text-amber-400">
                            JC#{item.jobCard.jobCardNumber}
                            {item.jobCard.productName ? ` · ${item.jobCard.productName}` : ''}
                          </p>
                          <p className="text-sm text-slate-300">{item.jobCard.customer.name}</p>
                          <p className="text-xs text-slate-500">{item.stageRecord.status}</p>
                          <Link
                            href={`/production/job-cards/${item.jobCard.id}`}
                            className="inline-block mt-2 text-sm text-amber-400 hover:underline"
                          >
                            Open
                          </Link>
                        </>
                      )}
                    </div>
                  ))}
                  {stageQueue.length === 0 && <p className="text-slate-500 py-4">No jobs at this stage.</p>}
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'more' && (
          <div className="space-y-3">
            <Link
              href="/stores/issue"
              className="block p-4 rounded-xl border border-slate-700 bg-slate-800/80 text-amber-400 font-medium"
            >
              Sheet issue (Stores)
            </Link>
            <Link
              href="/production/job-cards"
              className="block p-4 rounded-xl border border-slate-700 bg-slate-800/80 text-slate-200"
            >
              All job cards
            </Link>
            <Link
              href="/production/stages"
              className="block p-4 rounded-xl border border-slate-700 bg-slate-800/80 text-slate-200"
            >
              Production planning
            </Link>
            <Link href="/" className="block p-4 rounded-xl border border-slate-700 bg-slate-800/80 text-slate-200">
              Dashboard
            </Link>
          </div>
        )}
      </main>

      {downtimeOpen ? (
        <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-background/95 p-4">
          <div
            className="w-full max-w-md rounded-2xl border border-orange-500/40 bg-background p-5 shadow-[0_0_40px_rgba(251,146,60,0.15)] space-y-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="downtime-title"
          >
            <h2 id="downtime-title" className="text-lg font-semibold text-orange-400">
              Reason required — downtime lock
            </h2>
            <p className="text-xs text-zinc-500">
              No production logged for {Math.floor(PRODUCTION_DOWNTIME_LOCK_SECONDS / 60)}+ minutes. Select a
              category; log is timestamped and tied to your operator ID.
            </p>
            <label className="block text-xs text-zinc-400 uppercase tracking-wider">Category</label>
            <select
              value={downtimeCategory}
              onChange={(e) => setDowntimeCategory(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-700 text-foreground text-sm"
            >
              {PRODUCTION_DOWNTIME_CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            <label className="block text-xs text-zinc-400 uppercase tracking-wider">Notes (optional)</label>
            <textarea
              value={downtimeNotes}
              onChange={(e) => setDowntimeNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-700 text-foreground text-sm"
            />
            <button
              type="button"
              disabled={downtimeSubmitting || !session?.user}
              onClick={() => void submitDowntimeReason()}
              className="w-full py-3 rounded-xl bg-gradient-to-b from-amber-500 to-orange-600 text-foreground font-semibold disabled:opacity-50"
            >
              {downtimeSubmitting ? 'Saving…' : 'Submit downtime log'}
            </button>
            {!session?.user ? (
              <p className="text-rose-400 text-xs text-center">You must be signed in to submit.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      <nav className="fixed bottom-0 left-0 right-0 border-t border-zinc-800 bg-background flex justify-around py-2 safe-area-pb">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex flex-col items-center gap-0.5 px-6 py-2 rounded-lg text-sm ${
              tab === t.id ? 'text-amber-400 bg-slate-800' : 'text-slate-400'
            }`}
          >
            <span className="text-lg">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
