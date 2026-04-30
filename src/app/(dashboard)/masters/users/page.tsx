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

type User = {
  id: string
  name: string
  email: string
  role: { id: string; roleName: string }
  whatsappNumber: string | null
  lastLoginAt: string | null
  active: boolean
}

export default function MastersUsersPage() {
  const [list, setList] = useState<User[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/masters/users')
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="text-sm text-ds-ink-faint dark:text-ds-ink-muted">Loading…</div>
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">User Master</h2>
        <Link
          href="/masters/users/new"
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-primary-foreground hover:bg-blue-700"
        >
          Add user
        </Link>
      </div>
      <EnterpriseTableShell>
        <table className={enterpriseTableClass}>
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>Name</th>
              <th className={enterpriseThClass}>Email</th>
              <th className={enterpriseThClass}>Role</th>
              <th className={enterpriseThClass}>WhatsApp</th>
              <th className={enterpriseThClass}>Last login</th>
              <th className={enterpriseThClass}>Status</th>
              <th className={enterpriseThClass}>Actions</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {list.map((u) => (
              <tr key={u.id} className={enterpriseTrClass}>
                <td className={enterpriseTdClass}>{u?.name ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{u?.email ?? '—'}</td>
                <td className={enterpriseTdClass}>{u?.role?.roleName ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{u?.whatsappNumber ?? '—'}</td>
                <td className={enterpriseTdMonoClass}>
                  {u?.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}
                </td>
                <td className={enterpriseTdClass}>
                  <span className={u?.active ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                    {u?.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className={enterpriseTdClass}>
                  <Link href={`/masters/users/${u?.id ?? ''}`} className="text-blue-600 hover:underline dark:text-blue-400">
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </EnterpriseTableShell>
      {list.length === 0 && <p className="mt-4 text-sm text-ds-ink-faint dark:text-ds-ink-muted">No users.</p>}
    </div>
  )
}
