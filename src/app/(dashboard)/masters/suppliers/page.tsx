'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  EnterpriseTableShell,
  enterpriseTableClass,
  enterpriseTheadClass,
  enterpriseTbodyClass,
  enterpriseTrClass,
  enterpriseThClass,
  enterpriseTdClass,
  enterpriseTdMutedClass,
} from '@/components/ui/EnterpriseTableShell'

type Supplier = {
  id: string
  name: string
  gstNumber: string | null
  contactName: string | null
  contactPhone: string | null
  materialTypes: string[]
  leadTimeDays: number
  active: boolean
}

export default function MastersSuppliersPage() {
  const [list, setList] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/masters/suppliers')
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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">Supplier Master</h2>
        <Link
          href="/masters/suppliers/new"
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-primary-foreground hover:bg-blue-700"
        >
          Add supplier
        </Link>
      </div>
      <EnterpriseTableShell>
        <table className={enterpriseTableClass}>
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>Name</th>
              <th className={enterpriseThClass}>GST</th>
              <th className={enterpriseThClass}>Contact</th>
              <th className={enterpriseThClass}>Material types</th>
              <th className={enterpriseThClass}>Lead time</th>
              <th className={enterpriseThClass}>Status</th>
              <th className={enterpriseThClass}>Actions</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {list.map((s) => (
              <tr key={s.id} className={enterpriseTrClass}>
                <td className={enterpriseTdClass}>{s?.name ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{s?.gstNumber ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{s?.contactName ?? '—'}</td>
                <td className={`${enterpriseTdClass} max-w-[14rem]`}>
                  {s?.materialTypes?.length
                    ? s.materialTypes.map((t) => (
                        <span key={t} className="mr-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-200">
                          {t}
                        </span>
                      ))
                    : '—'}
                </td>
                <td className={enterpriseTdClass}>{s?.leadTimeDays ?? '—'} days</td>
                <td className={enterpriseTdClass}>
                  <span className={s?.active ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                    {s?.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className={enterpriseTdClass}>
                  <Link href={`/masters/suppliers/${s?.id ?? ''}`} className="text-blue-600 hover:underline dark:text-blue-400">
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </EnterpriseTableShell>
      {list.length === 0 && <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">No suppliers.</p>}
    </div>
  )
}
