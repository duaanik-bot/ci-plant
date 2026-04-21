'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { MachineHealthMeter } from '@/components/industrial/MachineHealthMeter'
import { PmSpotlightDrawer } from '@/components/industrial/PmSpotlightDrawer'
import {
  EnterpriseTableShell,
  enterpriseTableClass,
  enterpriseTheadClass,
  enterpriseTbodyClass,
  enterpriseTrClass,
  enterpriseThClass,
  enterpriseTdClass,
  enterpriseTdBase,
  enterpriseTdMonoClass,
  enterpriseTdMutedClass,
} from '@/components/ui/EnterpriseTableShell'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type Machine = {
  id: string
  machineCode: string
  name: string
  make: string | null
  specification: string | null
  capacityPerShift: number
  stdWastePct: number
  status: string
  lastPmDate: string | null
  nextPmDue: string | null
}

type PmRow = {
  machineId: string
  healthPct: number
  hasSchedule: boolean
  overdue: boolean
  usageRunHours: number
  usageImpressions: string
}

export default function MastersMachinesPage() {
  const [list, setList] = useState<Machine[]>([])
  const [loading, setLoading] = useState(true)
  const [pmById, setPmById] = useState<Record<string, PmRow>>({})
  const [pmMachineId, setPmMachineId] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([fetch('/api/masters/machines'), fetch('/api/production/machine-health')])
      .then(async ([machRes, pmRes]) => {
        const data = await machRes.json()
        const pmJson = await pmRes.json()
        setList(Array.isArray(data) ? data : [])
        const map: Record<string, PmRow> = {}
        if (pmJson.machines && Array.isArray(pmJson.machines)) {
          for (const row of pmJson.machines as PmRow[]) {
            map[row.machineId] = row
          }
        }
        setPmById(map)
      })
      .catch(() => toast.error('Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="text-sm text-slate-600 dark:text-slate-400">Loading…</div>
  }

  return (
    <div>
      <h2 className="mb-4 text-base font-semibold text-slate-900 dark:text-slate-50">Machine Master (CI-01 to CI-12)</h2>
      <EnterpriseTableShell>
        <table className={`w-full min-w-[900px] border-collapse text-left text-sm text-slate-900 dark:text-slate-50 ${mono}`}>
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>Code</th>
              <th className={enterpriseThClass}>Name</th>
              <th className={enterpriseThClass}>Health</th>
              <th className={enterpriseThClass}>PM usage</th>
              <th className={enterpriseThClass}>Make</th>
              <th className={enterpriseThClass}>Capacity/Shift</th>
              <th className={enterpriseThClass}>Std Waste %</th>
              <th className={enterpriseThClass}>Status</th>
              <th className={enterpriseThClass}>Last PM</th>
              <th className={enterpriseThClass}>Next PM Due</th>
              <th className={enterpriseThClass}>Actions</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {list.map((m) => {
              const pm = pmById[m.id]
              return (
                <tr
                  key={m.id}
                  className={`${enterpriseTrClass} ${pm?.overdue ? 'bg-rose-50 dark:bg-rose-950/20' : ''}`}
                >
                  <td className={`${enterpriseTdClass} text-amber-700 dark:text-amber-300`}>{m?.machineCode ?? '—'}</td>
                  <td className={enterpriseTdClass}>{m?.name ?? '—'}</td>
                  <td className={enterpriseTdBase}>
                    {pm?.hasSchedule ? (
                      <MachineHealthMeter
                        healthPct={pm.healthPct}
                        hasSchedule
                        onClick={() => setPmMachineId(m.id)}
                      />
                    ) : (
                      <MachineHealthMeter healthPct={0} hasSchedule={false} />
                    )}
                  </td>
                  <td className={enterpriseTdMutedClass}>
                    {pm?.hasSchedule ? `${pm.usageRunHours}h · ${pm.usageImpressions}` : '—'}
                  </td>
                  <td className={enterpriseTdMutedClass}>{m?.make ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{(m?.capacityPerShift ?? 0).toLocaleString()}</td>
                  <td className={enterpriseTdMonoClass}>{m?.stdWastePct ?? '—'}%</td>
                  <td className={enterpriseTdClass}>
                    <span
                      className={
                        m?.status === 'active'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : m?.status === 'under_maintenance'
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-rose-600 dark:text-rose-400'
                      }
                    >
                      {(m?.status ?? '—').replace('_', ' ')}
                    </span>
                  </td>
                  <td className={enterpriseTdMonoClass}>{m?.lastPmDate ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>
                    <span className={m?.nextPmDue && new Date(m.nextPmDue) < new Date() ? 'text-rose-600 dark:text-rose-400' : ''}>
                      {m?.nextPmDue ?? '—'}
                    </span>
                  </td>
                  <td className={enterpriseTdClass}>
                    <Link href={`/masters/machines/${m?.id ?? ''}`} className="text-blue-600 hover:underline dark:text-blue-400">
                      Edit
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </EnterpriseTableShell>
      {list.length === 0 && <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">No machines. Run seed.</p>}
      <PmSpotlightDrawer machineId={pmMachineId} onClose={() => setPmMachineId(null)} />
    </div>
  )
}
