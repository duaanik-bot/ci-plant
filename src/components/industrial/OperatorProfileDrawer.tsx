'use client'

import { useEffect, useState } from 'react'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { PRODUCTION_DOWNTIME_CATEGORIES } from '@/lib/production-oee-constants'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type Profile = {
  user: { id: string; name: string }
  jobCount: number
  avgOee: number
  avgYield: number
  avgWastagePct: number
  factoryAvgWastagePct: number
  machineHistory: Array<{ machineCode: string; machineName: string; jobCount: number; avgOee: number }>
  downtimeSignature: Array<{ reasonKey: string; count: number; totalMinutes: number }>
}

function reasonLabel(key: string) {
  return PRODUCTION_DOWNTIME_CATEGORIES.find((c) => c.key === key)?.label ?? key.replace(/_/g, ' ')
}

export function OperatorProfileDrawer({
  operatorId,
  onClose,
}: {
  operatorId: string | null
  onClose: () => void
}) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!operatorId) {
      setProfile(null)
      return
    }
    let cancelled = false
    setLoading(true)
    fetch(`/api/production/operators/${operatorId}/profile`)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && !j.error) setProfile(j as Profile)
        else if (!cancelled) setProfile(null)
      })
      .catch(() => {
        if (!cancelled) setProfile(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [operatorId])

  return (
    <SlideOverPanel
      title={profile?.user.name ?? 'Operator profile'}
      isOpen={operatorId != null}
      onClose={onClose}
      widthClass="max-w-lg"
    >
      {loading ? (
        <p className="text-neutral-500 text-sm">Loading…</p>
      ) : profile ? (
        <div className={`space-y-6 text-sm text-neutral-400 ${mono}`}>
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div>
              <div className="text-neutral-500 uppercase tracking-wider">Jobs</div>
              <div className="text-ds-ink text-base">{profile.jobCount}</div>
            </div>
            <div>
              <div className="text-neutral-500 uppercase tracking-wider">Avg OEE</div>
              <div className="text-orange-300 text-base">{profile.avgOee}%</div>
            </div>
            <div>
              <div className="text-neutral-500 uppercase tracking-wider">Avg yield</div>
              <div className="text-orange-300 text-base">{profile.avgYield}%</div>
            </div>
          </div>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">
              Waste profile
            </h3>
            <p>
              Operator avg wastage:{' '}
              <span className="text-ds-ink">{profile.avgWastagePct}%</span> vs factory{' '}
              <span className="text-neutral-500">{profile.factoryAvgWastagePct}%</span>
            </p>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">
              Machine history (run best)
            </h3>
            {profile.machineHistory.length === 0 ? (
              <p className="text-neutral-600 text-xs">No attributed ledger runs in window.</p>
            ) : (
              <ul className="space-y-2">
                {profile.machineHistory.map((m) => (
                  <li
                    key={m.machineCode}
                    className="flex justify-between border-b border-ds-line/30 pb-1 text-xs"
                  >
                    <span>
                      {m.machineCode} · {m.machineName}
                    </span>
                    <span className="text-emerald-400">
                      {m.avgOee}% <span className="text-neutral-600">({m.jobCount} jobs)</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">
              Downtime signature
            </h3>
            {profile.downtimeSignature.length === 0 ? (
              <p className="text-neutral-600 text-xs">No downtime logs in window.</p>
            ) : (
              <ul className="space-y-1.5 text-xs">
                {profile.downtimeSignature.map((d) => (
                  <li key={d.reasonKey} className="flex justify-between gap-2">
                    <span className="text-neutral-500">{reasonLabel(d.reasonKey)}</span>
                    <span>
                      {d.totalMinutes}m <span className="text-neutral-600">· {d.count}×</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : (
        <p className="text-neutral-500 text-sm">Could not load profile.</p>
      )}
    </SlideOverPanel>
  )
}
