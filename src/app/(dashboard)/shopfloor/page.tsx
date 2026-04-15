'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { PRODUCTION_STAGES } from '@/lib/constants'

type Stage = {
  id: string
  stageName: string
  status: string
  operator: string | null
  counter: number | null
  sheetSize: string | null
  excessSheets: number | null
  completedAt: string | null
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
  stages: Stage[]
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
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('jobs')
  const [jobCards, setJobCards] = useState<JobCard[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [stageKey, setStageKey] = useState<string | null>(null)
  const [stageQueue, setStageQueue] = useState<StageQueueItem[]>([])
  const [saving, setSaving] = useState(false)
  const [counterVal, setCounterVal] = useState<Record<string, string>>({})
  const [excessSheetsVal, setExcessSheetsVal] = useState<Record<string, string>>({})

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
      toast.success(patch.status === 'completed' ? 'Stage completed — moved to next queue' : 'Stage started')
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

  return (
    <div className="min-h-screen bg-slate-900 text-white flex flex-col pb-20">
      <header className="p-4 border-b border-slate-700 sticky top-0 bg-slate-900 z-10">
        <h1 className="text-xl font-bold text-amber-400">Shopfloor</h1>
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
                    className="rounded-xl border border-slate-700 bg-slate-800/80 overflow-hidden"
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
                              stage.status === 'in_progress' ? 'bg-amber-600 text-white' : 'bg-slate-600 text-slate-200'
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
                      <div className="border-t border-slate-700 p-4 space-y-3 bg-slate-900/50">
                        {jc.stages.map((s) => (
                          <div
                            key={s.id}
                            className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-700 p-3"
                          >
                            <span className="font-medium text-slate-200 w-32">{s.stageName}</span>
                            <span
                              className={`px-2 py-0.5 rounded text-xs ${
                                s.status === 'completed'
                                  ? 'bg-green-800 text-green-200'
                                  : s.status === 'in_progress'
                                    ? 'bg-amber-600 text-white'
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
                                  className="w-24 px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white text-sm"
                                />
                                <input
                                  type="number"
                                  min={0}
                                  placeholder="Excess sheets"
                                  value={excessSheetsVal[s.id] ?? ''}
                                  onChange={(e) =>
                                    setExcessSheetsVal((prev) => ({ ...prev, [s.id]: e.target.value }))
                                  }
                                  className="w-28 px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white text-sm"
                                />
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
                                  className="px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-medium"
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
                                className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium"
                              >
                                Start
                              </button>
                            )}
                          </div>
                        ))}
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
                  className="text-sm text-slate-400 hover:text-white mb-2"
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

      <nav className="fixed bottom-0 left-0 right-0 border-t border-slate-700 bg-slate-900 flex justify-around py-2 safe-area-pb">
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
