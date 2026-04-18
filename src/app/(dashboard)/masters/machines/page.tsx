'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { MachineHealthMeter } from '@/components/industrial/MachineHealthMeter'
import { PmSpotlightDrawer } from '@/components/industrial/PmSpotlightDrawer'

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

  if (loading) return <div className="text-slate-400">Loading…</div>

  return (
    <div>
      <h2 className="text-lg font-semibold text-white mb-4">Machine Master (CI-01 to CI-12)</h2>
      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-black ring-1 ring-white/5">
        <table className={`w-full text-sm text-left ${mono}`}>
          <thead className="bg-zinc-950 text-zinc-400 text-[10px] uppercase tracking-wider">
            <tr>
              <th className="px-4 py-2">Code</th>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Health</th>
              <th className="px-4 py-2">PM usage</th>
              <th className="px-4 py-2">Make</th>
              <th className="px-4 py-2">Capacity/Shift</th>
              <th className="px-4 py-2">Std Waste %</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Last PM</th>
              <th className="px-4 py-2">Next PM Due</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="text-zinc-200">
            {list.map((m) => {
              const pm = pmById[m.id]
              return (
                <tr
                  key={m.id}
                  className={`border-t border-zinc-800 ${pm?.overdue ? 'bg-rose-950/20 border-l-4 border-rose-600' : ''}`}
                >
                  <td className="px-4 py-2 font-mono text-amber-300">{m.machineCode}</td>
                  <td className="px-4 py-2">{m.name}</td>
                  <td className="px-4 py-2">
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
                  <td className="px-4 py-2 text-xs text-zinc-500">
                    {pm?.hasSchedule ? `${pm.usageRunHours}h · ${pm.usageImpressions}` : '—'}
                  </td>
                  <td className="px-4 py-2 text-slate-400">{m.make ?? '—'}</td>
                  <td className="px-4 py-2">{m.capacityPerShift.toLocaleString()}</td>
                  <td className="px-4 py-2">{m.stdWastePct}%</td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        m.status === 'active'
                          ? 'text-green-400'
                          : m.status === 'under_maintenance'
                            ? 'text-amber-400'
                            : 'text-red-400'
                      }
                    >
                      {m.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-slate-400">{m.lastPmDate ?? '—'}</td>
                  <td className="px-4 py-2">
                    <span className={m.nextPmDue && new Date(m.nextPmDue) < new Date() ? 'text-red-400' : ''}>
                      {m.nextPmDue ?? '—'}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <Link href={`/masters/machines/${m.id}`} className="text-amber-400 hover:underline">
                      Edit
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {list.length === 0 && <p className="text-slate-400 mt-4">No machines. Run seed.</p>}
      <PmSpotlightDrawer machineId={pmMachineId} onClose={() => setPmMachineId(null)} />
    </div>
  )
}
