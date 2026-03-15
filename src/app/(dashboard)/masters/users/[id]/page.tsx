'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

type Role = { id: string; roleName: string }
type Machine = { id: string; machineCode: string }
type User = {
  id: string
  name: string
  email: string
  role: Role
  machineAccess: string[]
  whatsappNumber: string | null
  active: boolean
}

export default function EditUserPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const [user, setUser] = useState<User | null>(null)
  const [roles, setRoles] = useState<Role[]>([])
  const [machines, setMachines] = useState<Machine[]>([])
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [roleId, setRoleId] = useState('')
  const [machineAccess, setMachineAccess] = useState<string[]>([])
  const [whatsappNumber, setWhatsappNumber] = useState('')
  const [active, setActive] = useState(true)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    Promise.all([
      fetch('/api/masters/users').then((r) => r.json()),
      fetch('/api/masters/roles').then((r) => r.json()),
      fetch('/api/machines').then((r) => r.json()),
    ]).then(([users, roleData, machs]) => {
      const u = Array.isArray(users) ? users.find((x: User) => x.id === id) : null
      if (u) {
        setUser(u)
        setName(u.name)
        setRoleId(u.role?.id ?? '')
        setMachineAccess(u.machineAccess ?? [])
        setWhatsappNumber(u.whatsappNumber ?? '')
        setActive(u.active)
      }
      setRoles(Array.isArray(roleData) ? roleData : [])
      setMachines(Array.isArray(machs) ? machs : [])
    }).catch(() => toast.error('Failed to load')).finally(() => setLoading(false))
  }, [id])

  function toggleMachine(mid: string) {
    setMachineAccess((prev) =>
      prev.includes(mid) ? prev.filter((x) => x !== mid) : [...prev, mid]
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFieldErrors({})
    if (pin && (pin.length !== 6 || !/^\d+$/.test(pin))) {
      setFieldErrors({ pin: 'PIN must be 6 digits' })
      return
    }
    setSubmitting(true)
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        roleId,
        machineAccess,
        whatsappNumber: whatsappNumber.trim() || null,
        active,
      }
      if (pin) body.pin = pin
      const res = await fetch(`/api/masters/users/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setFieldErrors(data.fields || {})
        toast.error(data.error || 'Failed')
        return
      }
      toast.success('User updated')
      router.push('/masters/users')
    } catch {
      toast.error('Failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="text-slate-400">Loading…</div>
  if (!user) return <div className="text-red-400">User not found</div>

  return (
    <div className="max-w-lg">
      <h2 className="text-lg font-semibold text-white mb-4">Edit user</h2>
      <p className="text-slate-400 text-sm mb-2">Email: {user.email} (cannot be changed)</p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-slate-400 mb-1">Full name *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">New PIN (6 digits, leave blank to keep)</label>
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            maxLength={6}
            placeholder="••••••"
            className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-white ${
              fieldErrors.pin ? 'border-red-500' : 'border-slate-600'
            }`}
          />
          {fieldErrors.pin && <p className="mt-1 text-sm text-red-400">{fieldErrors.pin}</p>}
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Role *</label>
          <select
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          >
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.roleName}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Machine access</label>
          <div className="flex flex-wrap gap-2">
            {machines.map((m) => (
              <label key={m.id} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={machineAccess.includes(m.id)}
                  onChange={() => toggleMachine(m.id)}
                  className="rounded border-slate-600"
                />
                {m.machineCode}
              </label>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">WhatsApp number</label>
          <input
            value={whatsappNumber}
            onChange={(e) => setWhatsappNumber(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="active"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="rounded border-slate-600"
          />
          <label htmlFor="active" className="text-sm text-slate-300">Active</label>
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:bg-slate-600 text-white"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <Link href="/masters/users" className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
