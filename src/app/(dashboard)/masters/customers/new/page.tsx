'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

function toCaps(value: string) {
  return value.toUpperCase()
}

function firstFieldError(fields: Record<string, string> | undefined) {
  if (!fields) return ''
  const v = Object.values(fields)[0]
  return typeof v === 'string' ? v : ''
}

function NewCustomerForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
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
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const pre = searchParams.get('name')?.trim()
    if (pre) setName(toCaps(pre))
  }, [searchParams])

  async function parseApiResponse(res: Response) {
    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      return res.json()
    }

    const text = await res.text()
    return { error: text || `Request failed with status ${res.status}` }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFieldErrors({})
    setSubmitting(true)
    try {
      const res = await fetch('/api/masters/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: toCaps(name.trim()),
          gstNumber: gstNumber.trim() ? toCaps(gstNumber.trim()) : undefined,
          contactName: contactName.trim() ? toCaps(contactName.trim()) : undefined,
          contactPhone: contactPhone.trim() || undefined,
          email: email.trim() ? email.trim().toLowerCase() : undefined,
          address: address.trim() ? toCaps(address.trim()) : undefined,
          creditLimit: Number(creditLimit) || 0,
          requiresArtworkApproval,
          active,
        }),
      })
      const data = await parseApiResponse(res)
      if (!res.ok) {
        setFieldErrors((data.fields as Record<string, string>) || {})
        const detail = firstFieldError(data.fields) || data.error || `Request failed (${res.status})`
        toast.error(detail)
        return
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('ci-customers-updated'))
      }
      toast.success('Customer created')
      router.push('/masters/customers')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create customer')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-lg">
      <h2 className="text-lg font-semibold text-foreground mb-4">New customer</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Company name *</label>
          <input
            value={name}
            onChange={(e) => setName(toCaps(e.target.value))}
            className={`w-full px-3 py-2 rounded-lg bg-ds-elevated border text-foreground ${
              fieldErrors.name ? 'border-red-500' : 'border-ds-line/60'
            }`}
          />
          {fieldErrors.name && <p className="mt-1 text-sm text-red-400">{fieldErrors.name}</p>}
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">GST number</label>
          <input
            value={gstNumber}
            onChange={(e) => setGstNumber(toCaps(e.target.value))}
            className={`w-full px-3 py-2 rounded-lg bg-ds-elevated border text-foreground ${
              fieldErrors.gstNumber ? 'border-red-500' : 'border-ds-line/60'
            }`}
          />
          {fieldErrors.gstNumber && <p className="mt-1 text-sm text-red-400">{fieldErrors.gstNumber}</p>}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-ds-ink-muted mb-1">Contact person</label>
            <input
              value={contactName}
              onChange={(e) => setContactName(toCaps(e.target.value))}
              className="w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground"
            />
          </div>
          <div>
            <label className="block text-sm text-ds-ink-muted mb-1">Phone</label>
            <input
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              className={`w-full px-3 py-2 rounded-lg bg-ds-elevated border text-foreground ${
                fieldErrors.contactPhone ? 'border-red-500' : 'border-ds-line/60'
              }`}
            />
            {fieldErrors.contactPhone && <p className="mt-1 text-sm text-red-400">{fieldErrors.contactPhone}</p>}
          </div>
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value.trim().toLowerCase())}
            className={`w-full px-3 py-2 rounded-lg bg-ds-elevated border text-foreground ${
              fieldErrors.email ? 'border-red-500' : 'border-ds-line/60'
            }`}
          />
          {fieldErrors.email && <p className="mt-1 text-sm text-red-400">{fieldErrors.email}</p>}
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Billing address</label>
          <textarea
            value={address}
            onChange={(e) => setAddress(toCaps(e.target.value))}
            rows={2}
            className="w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground"
          />
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Credit limit</label>
          <input
            type="number"
            min={0}
            value={creditLimit}
            onChange={(e) => setCreditLimit(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground"
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
            Requires artwork approval (pharma)
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
            className="px-4 py-2 rounded-lg bg-ds-warning hover:bg-ds-warning disabled:bg-ds-line/30 text-primary-foreground"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <Link
            href="/masters/customers"
            className="px-4 py-2 rounded-lg bg-ds-elevated hover:bg-ds-line/30 text-foreground"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}

export default function NewCustomerPage() {
  return (
    <Suspense fallback={<div className="text-ds-ink-muted">Loading…</div>}>
      <NewCustomerForm />
    </Suspense>
  )
}
