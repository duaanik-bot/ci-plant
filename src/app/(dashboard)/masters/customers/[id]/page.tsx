'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

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

export default function EditCustomerPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [name, setName] = useState('')
  const [gstNumber, setGstNumber] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [email, setEmail] = useState('')
  const [address, setAddress] = useState('')
  const [creditLimit, setCreditLimit] = useState('0')
  const [requiresArtworkApproval, setRequiresArtworkApproval] = useState(true)
  const [active, setActive] = useState(true)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    fetch('/api/masters/customers')
      .then((r) => r.json())
      .then((data: Customer[]) => {
        const c = Array.isArray(data) ? data.find((x) => x.id === id) : null
        if (c) {
          setCustomer(c)
          setName(c.name)
          setGstNumber(c.gstNumber ?? '')
          setContactName(c.contactName ?? '')
          setContactPhone(c.contactPhone ?? '')
          setEmail(c.email ?? '')
          setAddress(c.address ?? '')
          setCreditLimit(String(c.creditLimit))
          setRequiresArtworkApproval(c.requiresArtworkApproval)
          setActive(c.active)
        }
      })
      .catch(() => toast.error('Failed to load'))
      .finally(() => setLoading(false))
  }, [id])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFieldErrors({})
    setSubmitting(true)
    try {
      const res = await fetch(`/api/masters/customers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          gstNumber: gstNumber.trim() || null,
          contactName: contactName.trim() || null,
          contactPhone: contactPhone.trim() || null,
          email: email.trim() || null,
          address: address.trim() || null,
          creditLimit: Number(creditLimit) || 0,
          requiresArtworkApproval,
          active,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFieldErrors(data.fields || {})
        toast.error(data.error || 'Failed to update')
        return
      }
      toast.success('Customer updated')
      router.push('/masters/customers')
    } catch {
      toast.error('Failed to update')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="text-slate-400">Loading…</div>
  if (!customer) return <div className="text-red-400">Customer not found</div>

  return (
    <div className="max-w-lg">
      <h2 className="text-lg font-semibold text-white mb-4">Edit customer</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-slate-400 mb-1">Company name *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-white ${
              fieldErrors.name ? 'border-red-500' : 'border-slate-600'
            }`}
          />
          {fieldErrors.name && <p className="mt-1 text-sm text-red-400">{fieldErrors.name}</p>}
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">GST number</label>
          <input
            value={gstNumber}
            onChange={(e) => setGstNumber(e.target.value)}
            className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-white ${
              fieldErrors.gstNumber ? 'border-red-500' : 'border-slate-600'
            }`}
          />
          {fieldErrors.gstNumber && <p className="mt-1 text-sm text-red-400">{fieldErrors.gstNumber}</p>}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-slate-400 mb-1">Contact person</label>
            <input
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Phone</label>
            <input
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-white ${
                fieldErrors.contactPhone ? 'border-red-500' : 'border-slate-600'
              }`}
            />
            {fieldErrors.contactPhone && <p className="mt-1 text-sm text-red-400">{fieldErrors.contactPhone}</p>}
          </div>
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={`w-full px-3 py-2 rounded-lg bg-slate-800 border text-white ${
              fieldErrors.email ? 'border-red-500' : 'border-slate-600'
            }`}
          />
          {fieldErrors.email && <p className="mt-1 text-sm text-red-400">{fieldErrors.email}</p>}
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Billing address</label>
          <textarea
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Credit limit</label>
          <input
            type="number"
            min={0}
            value={creditLimit}
            onChange={(e) => setCreditLimit(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="artwork"
            checked={requiresArtworkApproval}
            onChange={(e) => setRequiresArtworkApproval(e.target.checked)}
            className="rounded border-slate-600"
          />
          <label htmlFor="artwork" className="text-sm text-slate-300">
            Requires artwork approval
          </label>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="active"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="rounded border-slate-600"
          />
          <label htmlFor="active" className="text-sm text-slate-300">
            Active
          </label>
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:bg-slate-600 text-white"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <Link
            href="/masters/customers"
            className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
