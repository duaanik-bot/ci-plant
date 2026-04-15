'use client'

import { Suspense } from 'react'
import HubPlateDashboard from '@/components/hub/HubPlateDashboard'

/**
 * Plate Hub entry: wireframe dashboard (triage strip + 3-column CTP / inventory / custody).
 * Implementation lives in {@link HubPlateDashboard}.
 */
export default function HubPlatesShell() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-black text-zinc-400 p-8 text-sm flex items-center justify-center">
          Loading Plate Hub…
        </div>
      }
    >
      <HubPlateDashboard />
    </Suspense>
  )
}
