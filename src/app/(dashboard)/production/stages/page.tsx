'use client'

import Link from 'next/link'
import { PRODUCTION_STAGES } from '@/lib/constants'

const mono = 'font-designing-queue tabular-nums tracking-tight'

export default function ProductionStagesHubPage() {
  return (
    <div className="min-h-screen bg-background text-ds-ink">
      <div className="mx-auto max-w-6xl space-y-6 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold text-ds-ink">Live Production</h1>
            <p className="text-xs text-ds-ink-faint">Open a stage to view and act on job cards.</p>
          </div>
          <Link
            href="/production/job-cards"
            className="rounded-lg border border-ds-line/60 px-3 py-1.5 text-sm text-ds-ink transition hover:border-ds-brand/40 hover:text-ds-brand"
          >
            Go to Job Cards
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {PRODUCTION_STAGES.map((stage, index) => (
            <Link
              key={stage.key}
              href={stage.key === 'cutting' ? '/production/cutting-queue' : `/production/stages/${stage.key}`}
              className="flex items-center gap-3 rounded-xl border border-ds-line/40 bg-ds-main p-4 transition hover:border-ds-brand/50"
            >
              <span className={`flex h-10 w-10 items-center justify-center rounded-lg bg-ds-card text-ds-brand ${mono} text-sm`}>
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="truncate font-semibold text-ds-ink">{stage.label}</p>
                <p className="text-xs text-ds-ink-faint">View job cards →</p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
