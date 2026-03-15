'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

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

export default function MastersMachinesPage() {
  const [list, setList] = useState<Machine[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/masters/machines')
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="text-slate-400">Loading…</div>

  return (
    <div>
      <h2 className="text-lg font-semibold text-white mb-4">Machine Master (CI-01 to CI-12)</h2>
      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-4 py-2">Code</th>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Make</th>
              <th className="px-4 py-2">Capacity/Shift</th>
              <th className="px-4 py-2">Std Waste %</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Last PM</th>
              <th className="px-4 py-2">Next PM Due</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="text-white">
            {list.map((m) => (
              <tr key={m.id} className="border-t border-slate-700">
                <td className="px-4 py-2 font-mono">{m.machineCode}</td>
                <td className="px-4 py-2">{m.name}</td>
                <td className="px-4 py-2 text-slate-400">{m.make ?? '—'}</td>
                <td className="px-4 py-2">{m.capacityPerShift.toLocaleString()}</td>
                <td className="px-4 py-2">{m.stdWastePct}%</td>
                <td className="px-4 py-2">
                  <span className={
                    m.status === 'active' ? 'text-green-400' :
                    m.status === 'under_maintenance' ? 'text-amber-400' : 'text-red-400'
                  }>
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
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && <p className="text-slate-400 mt-4">No machines. Run seed.</p>}
    </div>
  )
}
