'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { WORKFLOW_STAGE_COUNT } from '@/lib/workflow'

type Stage = {
  id: string
  stageNumber: number
  stageName: string
  status: string
  responsibleRole: string | null
  assignedTo: string | null
  actualStart: string | null
  actualEnd: string | null
  notes: string | null
}

export default function JobWorkflowPage() {
  const params = useParams()
  const jobId = params.jobId as string
  const [stages, setStages] = useState<Stage[]>([])
  const [loading, setLoading] = useState(true)
  const [jobInfo, setJobInfo] = useState<{ jobNumber: string; productName: string; customerName: string } | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const [jobRes, wfRes] = await Promise.all([
          fetch(`/api/jobs/${jobId}`),
          fetch(`/api/workflow/${jobId}`),
        ])
        const job = await jobRes.json()
        const wf = await wfRes.json()
        if (!job || job.error) throw new Error('Job not found')
        setJobInfo({
          jobNumber: job.jobNumber,
          productName: job.productName,
          customerName: job.customer?.name ?? '',
        })
        setStages(Array.isArray(wf) ? wf : [])
      } catch {
        setStages([])
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [jobId])

  async function completeStage(stageNumber: number) {
    try {
      const res = await fetch(`/api/workflow/${jobId}/${stageNumber}/complete`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      setStages(Array.isArray(data) ? data : stages)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to complete stage')
    }
  }

  if (loading) return <div className="p-4 text-slate-400">Loading workflow…</div>

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4">
      {jobInfo && (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-amber-400">{jobInfo.jobNumber}</h1>
            <p className="text-slate-200">{jobInfo.productName}</p>
            <p className="text-slate-400 text-xs">{jobInfo.customerName}</p>
          </div>
          <Link href="/workflow" className="text-slate-400 hover:text-foreground text-xs">
            ← Back to workflow
          </Link>
        </div>
      )}

      <div className="space-y-3">
        {stages.map((stage) => {
          const isCompleted = stage.status === 'completed'
          const isCurrent = stage.status === 'in_progress'
          const color =
            isCompleted ? 'border-green-600 bg-green-900/20' : isCurrent ? 'border-blue-500 bg-slate-800' : 'border-slate-700 bg-slate-900'
          return (
            <div
              key={stage.id}
              className={`rounded-lg border ${color} p-3 flex gap-3`}
            >
              <div className="flex flex-col items-center">
                <div
                  className={`w-3 h-3 rounded-full ${
                    isCompleted ? 'bg-green-400' : isCurrent ? 'bg-blue-400 animate-pulse' : 'bg-slate-600'
                  }`}
                />
                {stage.stageNumber < WORKFLOW_STAGE_COUNT && (
                  <div className="w-px flex-1 bg-slate-700 mt-1" />
                )}
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-slate-100">
                  Stage {stage.stageNumber} — {stage.stageName}
                </p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Status: {stage.status}{' '}
                  {stage.responsibleRole && `· Role: ${stage.responsibleRole}`}
                </p>
                {stage.actualStart && (
                  <p className="text-xs text-slate-500">
                    Started: {new Date(stage.actualStart).toLocaleString()}
                  </p>
                )}
                {stage.actualEnd && (
                  <p className="text-xs text-slate-500">
                    Completed: {new Date(stage.actualEnd).toLocaleString()}
                  </p>
                )}
                {isCurrent && (
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => completeStage(stage.stageNumber)}
                      className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-xs font-medium text-primary-foreground"
                    >
                      Complete Stage
                    </button>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

