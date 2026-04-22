'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { MachineHealthMeter } from '@/components/industrial/MachineHealthMeter'
import { PmSpotlightDrawer } from '@/components/industrial/PmSpotlightDrawer'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type MachineFlowItem = {
  id: string
  machineCode: string
  name: string
  status: string
  capacityPerShift: number
  currentJob: { jobNumber: string; productName: string } | null
  oee: number | null
  sheetsToday: number | null
  firstArticle: string | null
  pmHealth: {
    healthPct: number
    hasSchedule: boolean
    overdue: boolean
    usageRunHours: number
    usageImpressions: string
  }
}

const PREPRESS = ['Board Store', 'CI-10', 'CI-12', 'Plate QC & Store']
const PRESS = ['CI-01', 'CI-02', 'CI-03']
const POSTPRESS = ['CI-04', 'CI-05']
const FINISHING = ['CI-06', 'CI-07', 'CI-08', 'CI-09']
const QC_DISPATCH = ['Final QC Bench', 'Auto Counter', 'Packing Line', 'FG Warehouse', 'Dispatch Bay']

function MachineCard({
  m,
  onPmClick,
  highlight,
}: {
  m: MachineFlowItem
  onPmClick: (id: string) => void
  /** Deep-link from tooling hub — scroll + transient ring */
  highlight?: boolean
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!highlight || !cardRef.current) return
    const el = cardRef.current
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('ring-2', 'ring-emerald-400/85', 'ring-offset-2', 'ring-offset-black')
    const t = window.setTimeout(() => {
      el.classList.remove('ring-2', 'ring-emerald-400/85', 'ring-offset-2', 'ring-offset-black')
    }, 2600)
    return () => window.clearTimeout(t)
  }, [highlight])

  const isPress = PRESS.includes(m.machineCode)
  const statusCls = m.status === 'active' ? 'text-green-400' : m.status === 'under_maintenance' ? 'text-red-400' : 'text-ds-ink-muted'
  return (
    <div
      ref={cardRef}
      data-machine-flow-id={m.id}
      className="rounded-lg border border-ds-line/60 bg-ds-elevated/50 p-3 min-w-[140px]"
    >
      <p className="font-mono text-ds-warning text-sm">{m.machineCode}</p>
      <p className="text-ds-ink-muted text-xs truncate">{m.name}</p>
      <p className="text-sm mt-1">{m.currentJob ? m.currentJob.jobNumber : 'Idle'}</p>
      {m.pmHealth.hasSchedule ? (
        <div className={`flex items-center gap-2 mt-2 ${mono} text-[10px] text-neutral-500`}>
          <MachineHealthMeter
            healthPct={m.pmHealth.healthPct}
            hasSchedule
            onClick={() => onPmClick(m.id)}
          />
          <span>
            {m.pmHealth.usageRunHours}h · {m.pmHealth.usageImpressions} imp.
          </span>
        </div>
      ) : null}
      {isPress && m.oee != null && (
        <div className="flex items-center gap-1 mt-1">
          <div className="w-8 h-8 rounded-full border-2 border-ds-line/50 flex items-center justify-center text-xs">
            {m.oee}%
          </div>
          <span className="text-ds-ink-faint text-xs">
            {m.sheetsToday ?? 0} / {m.capacityPerShift?.toLocaleString() ?? '—'}
          </span>
        </div>
      )}
      <p className={`text-xs mt-1 ${statusCls}`}>
        {m.status === 'active' ? 'Running' : m.status === 'under_maintenance' ? 'Maintenance' : 'Idle'}
      </p>
      <p className="text-ds-ink-faint text-xs">First article: ○</p>
    </div>
  )
}

export default function MachineFlowPage() {
  const searchParams = useSearchParams()
  const highlightMachineId = searchParams.get('highlightMachineId')?.trim() || null
  const [pmMachineId, setPmMachineId] = useState<string | null>(null)
  const { data: machines = [], isLoading } = useQuery<MachineFlowItem[]>({
    queryKey: ['production-machine-flow'],
    queryFn: () => fetch('/api/production/machine-flow').then((r) => r.json()),
    refetchInterval: 30_000,
  })

  const byCode = (code: string) => machines.find((m) => m.machineCode === code || m.name.includes(code))
  const row = (codes: string[], label: string) => {
    const items = codes.map((c) => byCode(c)).filter(Boolean) as MachineFlowItem[]
    if (items.length === 0 && codes.some((c) => c.startsWith('CI-'))) {
      const fallback = machines.filter((m) => codes.includes(m.machineCode))
      return { label, items: fallback }
    }
    return { label, items: items.length ? items : machines.filter((m) => codes.some((c) => m.machineCode === c || m.name.includes(c))) }
  }

  const prepressItems = machines.filter((m) => m.machineCode === 'CI-10' || m.machineCode === 'CI-12')
  const pressItems = machines.filter((m) => PRESS.includes(m.machineCode))
  const postpressItems = machines.filter((m) => POSTPRESS.includes(m.machineCode))
  const finishingItems = machines.filter((m) => FINISHING.includes(m.machineCode))

  if (isLoading) return <div className="p-4 text-ds-ink-muted">Loading…</div>

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-ds-warning">Machine Flow</h1>
        <Link href="/jobs" className="text-ds-ink-muted hover:text-foreground text-sm">Active Jobs</Link>
      </div>

      <div className="space-y-6">
        <section>
          <h2 className="text-sm font-semibold text-ds-ink-muted mb-2">Pre-press</h2>
          <div className="flex flex-wrap gap-2">
            <div className="rounded-lg border border-ds-line/60 bg-ds-elevated/30 p-3 min-w-[100px] text-center">
              <p className="text-ds-ink-muted text-xs">Board Store</p>
            </div>
            {prepressItems.map((m) => (
              <MachineCard
                key={m.id}
                m={m}
                onPmClick={setPmMachineId}
                highlight={highlightMachineId === m.id}
              />
            ))}
            <div className="rounded-lg border border-ds-line/60 bg-ds-elevated/30 p-3 min-w-[100px] text-center">
              <p className="text-ds-ink-muted text-xs">Plate QC & Store</p>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-ds-ink-muted mb-2">Press</h2>
          <div className="flex flex-wrap gap-2">
            {pressItems.map((m) => (
              <MachineCard
                key={m.id}
                m={m}
                onPmClick={setPmMachineId}
                highlight={highlightMachineId === m.id}
              />
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-ds-ink-muted mb-2">Post-press</h2>
          <div className="flex flex-wrap gap-2">
            {postpressItems.map((m) => (
              <MachineCard
                key={m.id}
                m={m}
                onPmClick={setPmMachineId}
                highlight={highlightMachineId === m.id}
              />
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-ds-ink-muted mb-2">Finishing</h2>
          <div className="flex flex-wrap gap-2">
            {finishingItems.map((m) => (
              <MachineCard
                key={m.id}
                m={m}
                onPmClick={setPmMachineId}
                highlight={highlightMachineId === m.id}
              />
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-ds-ink-muted mb-2">QC & Dispatch</h2>
          <div className="flex flex-wrap gap-2">
            {['Final QC Bench', 'Auto Counter', 'Packing Line', 'FG Warehouse', 'Dispatch Bay'].map((label) => (
              <div key={label} className="rounded-lg border border-ds-line/60 bg-ds-elevated/30 p-3 min-w-[100px] text-center">
                <p className="text-ds-ink-muted text-xs">{label}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="mt-8 overflow-x-auto rounded-xl border border-ds-line/40 bg-background ring-1 ring-ring/5">
        <h2 className="text-sm font-semibold text-ds-ink-muted mb-2 px-4 pt-4">Machine ledger — changeover & PM health</h2>
        <table className={`w-full text-sm ${mono}`}>
          <thead className="bg-ds-main text-left text-neutral-500 text-[10px] uppercase tracking-wider">
            <tr>
              <th className="px-4 py-2">Machine</th>
              <th className="px-4 py-2">Health</th>
              <th className="px-4 py-2">Usage</th>
              <th className="px-4 py-2">Std Changeover</th>
              <th className="px-4 py-2">Current Status</th>
              <th className="px-4 py-2">Last Changeover</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ds-card text-neutral-400">
            {pressItems.concat(postpressItems).concat(finishingItems).map((m) => (
              <tr
                key={m.id}
                className={m.pmHealth.overdue ? 'bg-rose-950/20 border-l-4 border-rose-600' : ''}
              >
                <td className="px-4 py-2 font-mono text-ds-warning">{m.machineCode}</td>
                <td className="px-4 py-2">
                  {m.pmHealth.hasSchedule ? (
                    <MachineHealthMeter
                      healthPct={m.pmHealth.healthPct}
                      hasSchedule
                      onClick={() => setPmMachineId(m.id)}
                    />
                  ) : (
                    <MachineHealthMeter healthPct={0} hasSchedule={false} />
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-neutral-500">
                  {m.pmHealth.hasSchedule
                    ? `${m.pmHealth.usageRunHours}h · ${m.pmHealth.usageImpressions} imp.`
                    : '—'}
                </td>
                <td className="px-4 py-2 text-ds-ink-muted">45–90 min</td>
                <td className="px-4 py-2">—</td>
                <td className="px-4 py-2 text-ds-ink-faint">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PmSpotlightDrawer machineId={pmMachineId} onClose={() => setPmMachineId(null)} />
    </div>
  )
}
