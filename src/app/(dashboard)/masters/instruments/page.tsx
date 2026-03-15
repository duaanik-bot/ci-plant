'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

type Instrument = {
  id: string
  instrumentName: string
  specification: string | null
  range: string | null
  lastCalibration: string | null
  calibrationDue: string | null
  certificateUrl: string | null
  active: boolean
}

export default function MastersInstrumentsPage() {
  const [list, setList] = useState<Instrument[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/masters/instruments')
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="text-slate-400">Loading…</div>

  return (
    <div>
      <h2 className="text-lg font-semibold text-white mb-4">QC Instrument Master</h2>
      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Specification</th>
              <th className="px-4 py-2">Last calibration</th>
              <th className="px-4 py-2">Due date</th>
              <th className="px-4 py-2">Certificate</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="text-white">
            {list.map((i) => (
              <tr key={i.id} className="border-t border-slate-700">
                <td className="px-4 py-2">{i.instrumentName}</td>
                <td className="px-4 py-2 text-slate-400">{i.specification ?? '—'}</td>
                <td className="px-4 py-2 text-slate-400">{i.lastCalibration ?? '—'}</td>
                <td className="px-4 py-2">
                  <span className={
                    i.calibrationDue && new Date(i.calibrationDue) < new Date()
                      ? 'text-red-400 font-medium'
                      : ''
                  }>
                    {i.calibrationDue ?? '—'}
                  </span>
                </td>
                <td className="px-4 py-2">
                  {i.certificateUrl ? (
                    <a href={i.certificateUrl} target="_blank" rel="noopener noreferrer" className="text-amber-400 hover:underline">
                      View
                    </a>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <Link href={`/masters/instruments/${i.id}`} className="text-amber-400 hover:underline">
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && <p className="text-slate-400 mt-4">No instruments. Run seed.</p>}
    </div>
  )
}
