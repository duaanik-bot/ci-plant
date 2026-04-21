'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  EnterpriseTableShell,
  enterpriseTheadClass,
  enterpriseTbodyClass,
  enterpriseTrClass,
  enterpriseThClass,
  enterpriseTdClass,
  enterpriseTdMonoClass,
  enterpriseTdMutedClass,
} from '@/components/ui/EnterpriseTableShell'

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

  if (loading) {
    return <div className="text-sm text-slate-600 dark:text-slate-400">Loading…</div>
  }

  return (
    <div>
      <h2 className="mb-4 text-base font-semibold text-slate-900 dark:text-slate-50">QC Instrument Master</h2>
      <EnterpriseTableShell>
        <table className="w-full border-collapse text-left text-sm text-slate-900 dark:text-slate-50">
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>Name</th>
              <th className={enterpriseThClass}>Specification</th>
              <th className={enterpriseThClass}>Last calibration</th>
              <th className={enterpriseThClass}>Due date</th>
              <th className={enterpriseThClass}>Certificate</th>
              <th className={enterpriseThClass}>Actions</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {list.map((i) => (
              <tr key={i.id} className={enterpriseTrClass}>
                <td className={enterpriseTdClass}>{i?.instrumentName ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{i?.specification ?? '—'}</td>
                <td className={enterpriseTdMonoClass}>{i?.lastCalibration ?? '—'}</td>
                <td className={enterpriseTdMonoClass}>
                  <span
                    className={
                      i?.calibrationDue && new Date(i.calibrationDue) < new Date()
                        ? 'font-medium text-rose-600 dark:text-rose-400'
                        : ''
                    }
                  >
                    {i?.calibrationDue ?? '—'}
                  </span>
                </td>
                <td className={enterpriseTdClass}>
                  {i?.certificateUrl ? (
                    <a
                      href={i.certificateUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      View
                    </a>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </td>
                <td className={enterpriseTdClass}>
                  <Link href={`/masters/instruments/${i?.id ?? ''}`} className="text-blue-600 hover:underline dark:text-blue-400">
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </EnterpriseTableShell>
      {list.length === 0 && <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">No instruments. Run seed.</p>}
    </div>
  )
}
