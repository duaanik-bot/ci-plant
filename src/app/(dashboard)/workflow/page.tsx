'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { WORKFLOW_STAGE_COUNT } from '@/lib/workflow'

type WorkflowJob = {
  id: string
  jobNumber: string
  productName: string
  customer: { name: string }
  workflowStages: { stageNumber: number; stageName: string; status: string; actualStart: string | null }[]
  createdAt: string
}

export default function WorkflowOverviewPage() {
  const [jobs, setJobs] = useState<WorkflowJob[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/jobs?status=in_production')
      .then((r) => r.json())
      .then((data) => setJobs(Array.isArray(data) ? data : []))
      .catch(() => setJobs([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="p-4 text-slate-400">Loading workflow…</div>

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <h1 className="text-xl font-bold text-amber-400 mb-4">Workflow — Active Jobs</h1>
      <div className="grid md:grid-cols-3 gap-4">
        {jobs.map((job) => {
          const stages = job.workflowStages || []
          const completed = stages.filter((s) => s.status === 'completed').length
          const pct = stages.length ? Math.round((completed / stages.length) * 100) : 0
          const current =
            stages.find((s) => s.status === 'in_progress') ||
            stages.find((s) => s.status === 'pending')
          const started = job.createdAt ? new Date(job.createdAt) : null
          const daysRunning = started
            ? Math.max(0, Math.floor((Date.now() - started.getTime()) / (1000 * 60 * 60 * 24)))
            : 0
          return (
            <Link
              key={job.id}
              href={`/workflow/${job.id}`}
              className="rounded-xl border border-slate-700 bg-slate-800/60 p-4 hover:border-amber-500/60"
            >
              <p className="font-mono text-amber-300 text-sm">{job.jobNumber}</p>
              <p className="text-slate-200 text-sm truncate">{job.productName}</p>
              <p className="text-slate-500 text-xs">{job.customer?.name}</p>
              <div className="mt-3">
                <div className="h-1.5 rounded-full bg-slate-700 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-amber-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Stage {current?.stageNumber ?? '-'} / {WORKFLOW_STAGE_COUNT} — {current?.stageName ?? 'Not started'}
                </p>
              </div>
              <p className="text-xs text-slate-500 mt-1">Days running: {daysRunning}</p>
            </Link>
          )
        })}
        {jobs.length === 0 && (
          <p className="text-slate-500 col-span-3">No active jobs with workflow.</p>
        )}
      </div>
    </div>
  )
}

