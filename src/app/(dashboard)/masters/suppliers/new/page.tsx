'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

const MATERIAL_OPTIONS = ['Paperboard', 'Inks', 'Foil', 'UV Varnish', 'Laminate Film', 'Consumables', 'Plates']

export default function NewSupplierPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [gstNumber, setGstNumber] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [email, setEmail] = useState('')
  const [address, setAddress] = useState('')
  const [materialTypes, setMaterialTypes] = useState<string[]>([])
  const [leadTimeDays, setLeadTimeDays] = useState('7')
  const [paymentTermsDays, setPaymentTermsDays] = useState('30')
  const [paymentTerms, setPaymentTerms] = useState('')
  const [active, setActive] = useState(true)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  function toggleType(t: string) {
    setMaterialTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFieldErrors({})
    setSubmitting(true)
    try {
      const res = await fetch('/api/masters/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          gstNumber: gstNumber.trim() || undefined,
          contactName: contactName.trim() || undefined,
          contactPhone: contactPhone.trim() || undefined,
          email: email.trim() || undefined,
          address: address.trim() || undefined,
          materialTypes,
          leadTimeDays: Number(leadTimeDays) || 7,
          paymentTermsDays: (() => {
            const n = Number(paymentTermsDays)
            return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 30
          })(),
          paymentTerms: paymentTerms.trim() || undefined,
          active,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFieldErrors(data.fields || {})
        toast.error(data.error || 'Failed')
        return
      }
      toast.success('Supplier created')
      router.push('/masters/suppliers')
    } catch {
      toast.error('Failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-lg">
      <h2 className="text-lg font-semibold text-foreground mb-4">New supplier</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-slate-400 mb-1">Supplier name *</label>
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
          <label className="block text-sm text-slate-400 mb-1">GST number</label>
          <input
            value={gstNumber}
            onChange={(e) => setGstNumber(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-slate-400 mb-1">Contact person</label>
            <input
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Phone</label>
            <input
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Address</label>
          <textarea
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Material types supplied</label>
          <div className="flex flex-wrap gap-2">
            {MATERIAL_OPTIONS.map((t) => (
              <label key={t} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={materialTypes.includes(t)}
                  onChange={() => toggleType(t)}
                  className="rounded border-slate-600"
                />
                {t}
              </label>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Lead time (days)</label>
          <input
            type="number"
            min={0}
            value={leadTimeDays}
            onChange={(e) => setLeadTimeDays(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Payment terms (days credit)</label>
          <input
            type="number"
            min={0}
            value={paymentTermsDays}
            onChange={(e) => setPaymentTermsDays(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground font-mono tabular-nums"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Payment terms (notes)</label>
          <input
            value={paymentTerms}
            onChange={(e) => setPaymentTerms(e.target.value)}
            placeholder="e.g. 30 days credit"
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
          <Link href="/masters/suppliers" className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-foreground">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
