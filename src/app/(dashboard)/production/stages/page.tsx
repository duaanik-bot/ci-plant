'use client'

import Link from 'next/link'
import { PRODUCTION_STAGES } from '@/lib/constants'

export default function ProductionStagesHubPage() {
  return (
    <div className="p-4 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-amber-400">Production Planning</h1>
        <div className="flex items-center gap-2">
          <Link
            href="/orders/planning"
            className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm"
          >
            Planning
          </Link>
          <Link
            href="/production/job-cards"
            className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm"
          >
            Job Cards
          </Link>
        </div>
      </div>
      <p className="text-sm text-slate-400 mb-6">
        Open a stage to see job cards at that step and update progress.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
        {PRODUCTION_STAGES.map((s, idx) => (
          <Link
            key={s.key}
            href={`/production/stages/${s.key}`}
            className="rounded-xl bg-slate-900 border border-slate-700 p-4 hover:border-amber-500/60 flex items-center gap-3"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-800 text-amber-400 font-mono text-sm">
              {idx + 1}
            </span>
            <div>
              <p className="font-semibold text-slate-200">{s.label}</p>
              <p className="text-xs text-slate-500">View job cards →</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
