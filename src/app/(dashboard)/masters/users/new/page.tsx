'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

type Role = { id: string; roleName: string }
type Machine = { id: string; machineCode: string }

export default function NewUserPage() {
  const router = useRouter()
  const [roles, setRoles] = useState<Role[]>([])
  const [machines, setMachines] = useState<Machine[]>([])
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [pin, setPin] = useState('')
  const [roleId, setRoleId] = useState('')
  const [machineAccess, setMachineAccess] = useState<string[]>([])
  const [whatsappNumber, setWhatsappNumber] = useState('')
  const [active, setActive] = useState(true)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    Promise.all([
      fetch('/api/masters/roles').then((r) => r.json()),
      fetch('/api/machines').then((r) => r.json()),
    ]).then(([roleData, machs]) => {
      setRoles(Array.isArray(roleData) ? roleData : [])
      if (Array.isArray(roleData) && roleData[0]) setRoleId(roleData[0].id)
      setMachines(Array.isArray(machs) ? machs : [])
    }).catch(() => {})
  }, [])

  function toggleMachine(id: string) {
    setMachineAccess((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFieldErrors({})
    if (pin.length !== 6 || !/^\d+$/.test(pin)) {
      setFieldErrors({ pin: 'PIN must be 6 digits' })
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/masters/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          pin,
          roleId,
          machineAccess,
          whatsappNumber: whatsappNumber.trim() || undefined,
          active,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFieldErrors(data.fields || {})
        toast.error(data.error || 'Failed')
        return
      }
      toast.success('User created')
      router.push('/masters/users')
    } catch {
      toast.error('Failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-lg">
      <h2 className="text-lg font-semibold text-foreground mb-4">New user</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-slate-400 mb-1">Full name *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-foreground ${
              fieldErrors.name ? 'border-red-500' : 'border-slate-600'
            }`}
          />
          {fieldErrors.name && <p className="mt-1 text-sm text-red-400">{fieldErrors.name}</p>}
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Email *</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-foreground ${
              fieldErrors.email ? 'border-red-500' : 'border-slate-600'
            }`}
          />
          {fieldErrors.email && <p className="mt-1 text-sm text-red-400">{fieldErrors.email}</p>}
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">PIN (6 digits) *</label>
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            maxLength={6}
            placeholder="••••••"
            className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-foreground ${
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
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
          >
            <option value="">Select role</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.roleName}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Machine access (CI-01 to CI-12)</label>
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
            placeholder="+91..."
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
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
            className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:bg-slate-600 text-primary-foreground"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <Link href="/masters/users" className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-foreground">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
