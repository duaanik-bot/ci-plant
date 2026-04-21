'use client'

import { Suspense } from 'react'
import HubToolingKanbanDashboard from '@/components/hub/HubToolingKanbanDashboard'

export default function HubToolingShell({ mode }: { mode: 'dies' | 'blocks' }) {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background p-8 text-sm text-muted-foreground flex items-center justify-center">
          Loading…
        </div>
      }
    >
      <HubToolingKanbanDashboard mode={mode} />
    </Suspense>
  )
}
