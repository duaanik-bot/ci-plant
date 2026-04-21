'use client'

import { useEffect, useState } from 'react'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { toast } from 'sonner'
import { MachineHealthMeter } from '@/components/industrial/MachineHealthMeter'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type SpotlightPayload = {
  machine: { id: string; machineCode: string; name: string }
  health: {
    healthPct: number
    hourHealth: number | null
    impressionHealth: number | null
    overdue: boolean
    hasSchedule: boolean
  }
  usageRunHours: number
  usageImpressions: string
  intervalRunHours: number | null
  intervalImpressions: string | null
  serviceHistory: Array<{
    verifiedAt: string
    signedOffNote: string
    runHoursBeforeReset: number
    impressionsBeforeReset: string
  }>
  checklist: string[]
  sparePartsPlaceholder: string | null
}

export function PmSpotlightDrawer({
  machineId,
  onClose,
  onSignedOff,
}: {
  machineId: string | null
  onClose: () => void
  onSignedOff?: () => void
}) {
  const [data, setData] = useState<SpotlightPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!machineId) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    fetch(`/api/production/machines/${machineId}/pm-spotlight`)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && !j.error) setData(j as SpotlightPayload)
        else if (!cancelled) {
          setData(null)
          toast.error((j as { error?: string }).error ?? 'Failed to load PM')
        }
      })
      .catch(() => {
        if (!cancelled) setData(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [machineId])

  async function signOff() {
    if (!machineId) return
    setBusy(true)
    try {
      const res = await fetch('/api/production/pm-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((j as { error?: string }).error ?? 'Sign-off failed')
      toast.success((j as { message?: string }).message ?? 'PM verified')
      onSignedOff?.()
      if (machineId) {
        setLoading(true)
        fetch(`/api/production/machines/${machineId}/pm-spotlight`)
          .then((r) => r.json())
          .then((j) => {
            if (!j.error) setData(j as SpotlightPayload)
          })
          .finally(() => setLoading(false))
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SlideOverPanel
      title={data ? `${data.machine.machineCode} · PM` : 'Maintenance'}
      isOpen={machineId != null}
      onClose={onClose}
      widthClass="max-w-lg"
    >
      <div className={`space-y-5 text-sm text-zinc-300 bg-background min-h-[120px] ${mono}`}>
        {loading ? (
          <p className="text-zinc-500 text-sm">Loading…</p>
        ) : data ? (
          <>
            <div className="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-3">
              <MachineHealthMeter
                healthPct={data.health.healthPct}
                hasSchedule={data.health.hasSchedule}
                size="md"
              />
              <div className="space-y-1 text-xs">
                <p className="text-zinc-100 font-medium">{data.machine.name}</p>
                <p className="text-zinc-500">
                  Health {data.health.hasSchedule ? `${data.health.healthPct}%` : 'no schedule'}
                </p>
                {data.health.hasSchedule ? (
                  <p className="text-zinc-500">
                    Usage {data.usageRunHours}h · {data.usageImpressions} imp.
                    {data.intervalRunHours != null ? ` / ${data.intervalRunHours}h` : ''}
                    {data.intervalImpressions != null ? ` · ${data.intervalImpressions} imp. interval` : ''}
                  </p>
                ) : null}
              </div>
            </div>

            <section>
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">
                Service history (last 3)
              </h3>
              {data.serviceHistory.length === 0 ? (
                <p className="text-zinc-600 text-xs">No PM sign-offs recorded yet.</p>
              ) : (
                <ul className="space-y-2">
                  {data.serviceHistory.map((h) => (
                    <li
                      key={h.verifiedAt}
                      className="rounded-lg border border-zinc-800 bg-background px-2 py-2 text-xs text-zinc-400"
                    >
                      <span className="text-zinc-200">{new Date(h.verifiedAt).toLocaleString()}</span>
                      <p className="mt-0.5 text-zinc-500">{h.signedOffNote}</p>
                      <p className="mt-1 text-[10px] text-zinc-600">
                        Before reset: {h.runHoursBeforeReset}h · {h.impressionsBeforeReset} impressions
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">
                Task checklist
              </h3>
              {data.checklist.length === 0 ? (
                <p className="text-zinc-600 text-xs">Configure checklist on the machine PM schedule.</p>
              ) : (
                <ol className="list-decimal list-inside space-y-1.5 text-xs text-zinc-400">
                  {data.checklist.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              )}
            </section>

            <section>
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">
                Spare parts
              </h3>
              <p className="text-xs text-zinc-500 rounded-lg border border-dashed border-zinc-700 bg-zinc-950/50 px-2 py-2">
                {data.sparePartsPlaceholder ?? 'Placeholder — inventory pick list integration pending.'}
              </p>
            </section>

            {data.health.hasSchedule ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void signOff()}
                className="w-full rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-primary-foreground text-sm font-medium py-2.5"
              >
                {busy ? '…' : 'Sign off PM completion'}
              </button>
            ) : null}
          </>
        ) : (
          <p className="text-zinc-600 text-sm">Could not load machine.</p>
        )}
      </div>
    </SlideOverPanel>
  )
}
