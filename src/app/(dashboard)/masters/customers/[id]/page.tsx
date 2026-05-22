'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from '@/store/toastStore'

type Customer = {
  id: string
  name: string
  gstNumber: string | null
  pan: string | null
  stateCode: string | null
  billingAddress: string | null
  shippingAddress: string | null
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
  const [pan, setPan] = useState('')
  const [stateCode, setStateCode] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [email, setEmail] = useState('')
  const [address, setAddress] = useState('')
  const [billingAddress, setBillingAddress] = useState('')
  const [shippingAddress, setShippingAddress] = useState('')
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
          setPan(c.pan ?? '')
          setStateCode(c.stateCode ?? '')
          setContactName(c.contactName ?? '')
          setContactPhone(c.contactPhone ?? '')
          setEmail(c.email ?? '')
          setAddress(c.address ?? '')
          setBillingAddress(c.billingAddress ?? '')
          setShippingAddress(c.shippingAddress ?? '')
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
          pan: pan.trim() || null,
          stateCode: stateCode.trim() || null,
          billingAddress: billingAddress.trim() || null,
          shippingAddress: shippingAddress.trim() || null,
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

  if (loading) return <div className="text-ds-ink-muted">Loading…</div>
  if (!customer) return <div className="text-[var(--error)]">Customer not found</div>

  return (
    <div className="max-w-lg">
      <h2 className="text-lg font-semibold text-foreground mb-4">Edit customer</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Company name *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`w-full px-3 py-2 rounded-ds-md bg-ds-elevated border text-foreground ${
              fieldErrors.name ? 'border-[var(--error)]' : 'border-ds-line/60'
            }`}
          />
          {fieldErrors.name && <p className="mt-1 text-sm text-[var(--error)]">{fieldErrors.name}</p>}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-ds-ink-muted mb-1">GST number</label>
            <input
              value={gstNumber}
              onChange={(e) => setGstNumber(e.target.value.toUpperCase())}
              placeholder="22AAAAA0000A1Z5"
              className={`w-full px-3 py-2 rounded-ds-md bg-ds-elevated border text-foreground font-mono text-sm ${
                fieldErrors.gstNumber ? 'border-[var(--error)]' : 'border-ds-line/60'
              }`}
            />
            {fieldErrors.gstNumber && <p className="mt-1 text-sm text-[var(--error)]">{fieldErrors.gstNumber}</p>}
          </div>
          <div>
            <label className="block text-sm text-ds-ink-muted mb-1">
              State code <span className="text-xs text-ds-ink-faint">(2-digit)</span>
            </label>
            <input
              value={stateCode}
              onChange={(e) => setStateCode(e.target.value.replace(/\D/g, '').slice(0, 2))}
              placeholder="27"
              className={`w-full px-3 py-2 rounded-ds-md bg-ds-elevated border text-foreground font-mono text-sm ${
                fieldErrors.stateCode ? 'border-[var(--error)]' : 'border-ds-line/60'
              }`}
            />
            {fieldErrors.stateCode && <p className="mt-1 text-sm text-[var(--error)]">{fieldErrors.stateCode}</p>}
          </div>
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">PAN</label>
          <input
            value={pan}
            onChange={(e) => setPan(e.target.value.toUpperCase().slice(0, 10))}
            placeholder="ABCDE1234F"
            className={`w-full px-3 py-2 rounded-ds-md bg-ds-elevated border text-foreground font-mono text-sm ${
              fieldErrors.pan ? 'border-[var(--error)]' : 'border-ds-line/60'
            }`}
          />
          {fieldErrors.pan && <p className="mt-1 text-sm text-[var(--error)]">{fieldErrors.pan}</p>}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-ds-ink-muted mb-1">Contact person</label>
            <input
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated border border-ds-line/60 text-foreground"
            />
          </div>
          <div>
            <label className="block text-sm text-ds-ink-muted mb-1">Phone</label>
            <input
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              className={`w-full px-3 py-2 rounded-ds-md bg-ds-elevated border text-foreground ${
                fieldErrors.contactPhone ? 'border-[var(--error)]' : 'border-ds-line/60'
              }`}
            />
            {fieldErrors.contactPhone && <p className="mt-1 text-sm text-[var(--error)]">{fieldErrors.contactPhone}</p>}
          </div>
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={`w-full px-3 py-2 rounded-ds-md bg-ds-elevated border text-foreground ${
              fieldErrors.email ? 'border-[var(--error)]' : 'border-ds-line/60'
            }`}
          />
          {fieldErrors.email && <p className="mt-1 text-sm text-[var(--error)]">{fieldErrors.email}</p>}
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">
            Address (general / legacy)
          </label>
          <textarea
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated border border-ds-line/60 text-foreground"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-ds-ink-muted mb-1">Billing address (tax invoice)</label>
            <textarea
              value={billingAddress}
              onChange={(e) => setBillingAddress(e.target.value)}
              rows={3}
              placeholder="Full address with city + pincode"
              className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated border border-ds-line/60 text-foreground"
            />
          </div>
          <div>
            <label className="block text-sm text-ds-ink-muted mb-1">Shipping address</label>
            <textarea
              value={shippingAddress}
              onChange={(e) => setShippingAddress(e.target.value)}
              rows={3}
              placeholder="Leave blank if same as billing"
              className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated border border-ds-line/60 text-foreground"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Credit limit</label>
          <input
            type="number"
            min={0}
            value={creditLimit}
            onChange={(e) => setCreditLimit(e.target.value)}
            className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated border border-ds-line/60 text-foreground"
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="artwork"
            checked={requiresArtworkApproval}
            onChange={(e) => setRequiresArtworkApproval(e.target.checked)}
            className="rounded border-ds-line/60"
          />
          <label htmlFor="artwork" className="text-sm text-ds-ink-muted">
            Requires artwork approval
          </label>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="active"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="rounded border-ds-line/60"
          />
          <label htmlFor="active" className="text-sm text-ds-ink-muted">
            Active
          </label>
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 rounded-ds-md bg-ds-warning hover:bg-ds-warning disabled:bg-ds-line/30 text-primary-foreground"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <Link
            href="/masters/customers"
            className="px-4 py-2 rounded-ds-md bg-ds-elevated hover:bg-ds-line/30 text-foreground"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
