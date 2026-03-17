'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'

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
}

const PREPRESS = ['Board Store', 'CI-10', 'CI-12', 'Plate QC & Store']
const PRESS = ['CI-01', 'CI-02', 'CI-03']
const POSTPRESS = ['CI-04', 'CI-05']
const FINISHING = ['CI-06', 'CI-07', 'CI-08', 'CI-09']
const QC_DISPATCH = ['Final QC Bench', 'Auto Counter', 'Packing Line', 'FG Warehouse', 'Dispatch Bay']

function MachineCard({ m }: { m: MachineFlowItem }) {
  const isPress = PRESS.includes(m.machineCode)
  const statusCls = m.status === 'active' ? 'text-green-400' : m.status === 'under_maintenance' ? 'text-red-400' : 'text-slate-400'
  return (
    <div className="rounded-lg border border-slate-600 bg-slate-800/50 p-3 min-w-[140px]">
      <p className="font-mono text-amber-400 text-sm">{m.machineCode}</p>
      <p className="text-slate-300 text-xs truncate">{m.name}</p>
      <p className="text-sm mt-1">{m.currentJob ? m.currentJob.jobNumber : 'Idle'}</p>
      {isPress && m.oee != null && (
        <div className="flex items-center gap-1 mt-1">
          <div className="w-8 h-8 rounded-full border-2 border-slate-500 flex items-center justify-center text-xs">
            {m.oee}%
          </div>
          <span className="text-slate-500 text-xs">
            {m.sheetsToday ?? 0} / {m.capacityPerShift?.toLocaleString() ?? '—'}
          </span>
        </div>
      )}
      <p className={`text-xs mt-1 ${statusCls}`}>
        {m.status === 'active' ? 'Running' : m.status === 'under_maintenance' ? 'Maintenance' : 'Idle'}
      </p>
      <p className="text-slate-500 text-xs">First article: ○</p>
    </div>
  )
}

export default function MachineFlowPage() {
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

  if (isLoading) return <div className="p-4 text-slate-400">Loading…</div>

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-amber-400">Machine Flow</h1>
        <Link href="/jobs" className="text-slate-400 hover:text-white text-sm">Active Jobs</Link>
      </div>

      <div className="space-y-6">
        <section>
          <h2 className="text-sm font-semibold text-slate-400 mb-2">Pre-press</h2>
          <div className="flex flex-wrap gap-2">
            <div className="rounded-lg border border-slate-600 bg-slate-800/30 p-3 min-w-[100px] text-center">
              <p className="text-slate-400 text-xs">Board Store</p>
            </div>
            {prepressItems.map((m) => (
              <MachineCard key={m.id} m={m} />
            ))}
            <div className="rounded-lg border border-slate-600 bg-slate-800/30 p-3 min-w-[100px] text-center">
              <p className="text-slate-400 text-xs">Plate QC & Store</p>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-slate-400 mb-2">Press</h2>
          <div className="flex flex-wrap gap-2">
            {pressItems.map((m) => (
              <MachineCard key={m.id} m={m} />
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-slate-400 mb-2">Post-press</h2>
          <div className="flex flex-wrap gap-2">
            {postpressItems.map((m) => (
              <MachineCard key={m.id} m={m} />
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-slate-400 mb-2">Finishing</h2>
          <div className="flex flex-wrap gap-2">
            {finishingItems.map((m) => (
              <MachineCard key={m.id} m={m} />
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-slate-400 mb-2">QC & Dispatch</h2>
          <div className="flex flex-wrap gap-2">
            {['Final QC Bench', 'Auto Counter', 'Packing Line', 'FG Warehouse', 'Dispatch Bay'].map((label) => (
              <div key={label} className="rounded-lg border border-slate-600 bg-slate-800/30 p-3 min-w-[100px] text-center">
                <p className="text-slate-400 text-xs">{label}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="mt-8 overflow-x-auto">
        <h2 className="text-sm font-semibold text-slate-400 mb-2">Changeover timer</h2>
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-left">
            <tr>
              <th className="px-4 py-2">Machine</th>
              <th className="px-4 py-2">Std Changeover</th>
              <th className="px-4 py-2">Current Status</th>
              <th className="px-4 py-2">Last Changeover</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pressItems.concat(postpressItems).concat(finishingItems).map((m) => (
              <tr key={m.id}>
                <td className="px-4 py-2 font-mono">{m.machineCode}</td>
                <td className="px-4 py-2 text-slate-400">45–90 min</td>
                <td className="px-4 py-2">—</td>
                <td className="px-4 py-2 text-slate-500">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
