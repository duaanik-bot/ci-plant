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
            className="rounded-ds-md bg-ds-elevated px-3 py-1.5 text-sm text-ds-ink transition hover:text-ds-brand"
          >
            Go to Job Cards
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {PRODUCTION_STAGES.map((stage, index) => (
            <div key={stage.key} className="rounded-ds-lg bg-ds-main p-4 shadow-ds-depth-sm">
              <div className="flex items-center gap-3">
                <span className={`flex h-10 w-10 items-center justify-center rounded-ds-md bg-ds-card text-ds-brand ${mono} text-sm`}>
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="truncate font-semibold text-ds-ink">{stage.label}</p>
                  <p className="text-xs text-ds-ink-faint">Execution + triage</p>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Link
                  href={stage.key === 'cutting' ? '/production/cutting-queue' : `/production/stages/${stage.key}`}
                  className="rounded-ds-md bg-ds-elevated px-2.5 py-1.5 text-xs text-ds-ink transition hover:text-ds-brand"
                >
                  Execution
                </Link>
                <Link
                  href={`/production/stages/${stage.key}/triage`}
                  className="rounded-ds-md bg-ds-elevated px-2.5 py-1.5 text-xs text-ds-ink transition hover:text-ds-brand"
                >
                  Triage
                </Link>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
