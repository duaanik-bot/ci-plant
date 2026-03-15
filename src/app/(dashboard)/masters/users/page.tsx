'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

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

  if (loading) return <div className="text-slate-400">Loading…</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">User Master</h2>
        <Link
          href="/masters/users/new"
          className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm"
        >
          Add user
        </Link>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Email</th>
              <th className="px-4 py-2">Role</th>
              <th className="px-4 py-2">WhatsApp</th>
              <th className="px-4 py-2">Last login</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="text-white">
            {list.map((u) => (
              <tr key={u.id} className="border-t border-slate-700">
                <td className="px-4 py-2">{u.name}</td>
                <td className="px-4 py-2">{u.email}</td>
                <td className="px-4 py-2">{u.role?.roleName ?? '—'}</td>
                <td className="px-4 py-2 text-slate-400">{u.whatsappNumber ?? '—'}</td>
                <td className="px-4 py-2 text-slate-400">
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}
                </td>
                <td className="px-4 py-2">
                  <span className={u.active ? 'text-green-400' : 'text-red-400'}>
                    {u.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <Link href={`/masters/users/${u.id}`} className="text-amber-400 hover:underline">
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && <p className="text-slate-400 mt-4">No users.</p>}
    </div>
  )
}
