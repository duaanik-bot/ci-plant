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
  enterpriseTdMonoClass,
  enterpriseTdMutedClass,
} from '@/components/ui/EnterpriseTableShell'

type Customer = {
  id: string
  name: string
  gstNumber: string | null
  contactName: string | null
  contactPhone: string | null
  email: string | null
  address: string | null
  creditLimit: number
  requiresArtworkApproval: boolean
  active: boolean
}

export default function MastersCustomersPage() {
  const [list, setList] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)

  function load() {
    fetch('/api/masters/customers')
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load customers'))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    load()
  }, [])

  async function deactivate(c: Customer) {
    if (!confirm(`Deactivate ${c.name}?`)) return
    const res = await fetch(`/api/masters/customers/${c.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
    })
    if (res.ok) {
      toast.success('Customer deactivated')
      load()
    } else toast.error('Failed')
  }

  if (loading) {
    return <div className="text-sm text-slate-600 dark:text-slate-400">Loading…</div>
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">Customer Master</h2>
        <Link
          href="/masters/customers/new"
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-primary-foreground hover:bg-blue-700"
        >
          Add customer
        </Link>
      </div>
      <EnterpriseTableShell>
        <table className={enterpriseTableClass}>
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>Name</th>
              <th className={enterpriseThClass}>GST</th>
              <th className={enterpriseThClass}>Contact</th>
              <th className={enterpriseThClass}>Phone</th>
              <th className={enterpriseThClass}>Credit Limit</th>
              <th className={enterpriseThClass}>Status</th>
              <th className={enterpriseThClass}>Actions</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {list.map((c) => (
              <tr key={c.id} className={enterpriseTrClass}>
                <td className={enterpriseTdClass}>{c?.name ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{c?.gstNumber ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{c?.contactName ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{c?.contactPhone ?? '—'}</td>
                <td className={enterpriseTdMonoClass}>{c?.creditLimit ?? '—'}</td>
                <td className={enterpriseTdClass}>
                  <span className={c?.active ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                    {c?.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className={enterpriseTdClass}>
                  <Link href={`/masters/customers/${c?.id ?? ''}`} className="mr-2 text-blue-600 hover:underline dark:text-blue-400">
                    Edit
                  </Link>
                  {c?.active && (
                    <button type="button" onClick={() => deactivate(c)} className="text-slate-600 hover:underline dark:text-slate-400">
                      Deactivate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </EnterpriseTableShell>
      {list.length === 0 && (
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">No customers. Add one to get started.</p>
      )}
    </div>
  )
}
