'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

type Supplier = {
  id: string
  name: string
  gstNumber: string | null
  contactName: string | null
  contactPhone: string | null
  email: string | null
  address: string | null
  materialTypes: string[]
  leadTimeDays: number
  paymentTerms: string | null
  paymentTermsDays: number
  active: boolean
}

const MATERIAL_OPTIONS = ['Paperboard', 'Inks', 'Foil', 'UV Varnish', 'Laminate Film', 'Consumables', 'Plates']

export default function EditSupplierPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const [supplier, setSupplier] = useState<Supplier | null>(null)
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
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  function toggleType(t: string) {
    setMaterialTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    )
  }

  useEffect(() => {
    fetch('/api/masters/suppliers')
      .then((r) => r.json())
      .then((data: Supplier[]) => {
        const s = Array.isArray(data) ? data.find((x) => x.id === id) : null
        if (s) {
          setSupplier(s)
          setName(s.name)
          setGstNumber(s.gstNumber ?? '')
          setContactName(s.contactName ?? '')
          setContactPhone(s.contactPhone ?? '')
          setEmail(s.email ?? '')
          setAddress(s.address ?? '')
          setMaterialTypes(s.materialTypes ?? [])
          setLeadTimeDays(String(s.leadTimeDays))
          setPaymentTermsDays(String(s.paymentTermsDays ?? 30))
          setPaymentTerms(s.paymentTerms ?? '')
          setActive(s.active)
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
      const res = await fetch(`/api/masters/suppliers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          gstNumber: gstNumber.trim() || null,
          contactName: contactName.trim() || null,
          contactPhone: contactPhone.trim() || null,
          email: email.trim() || null,
          address: address.trim() || null,
          materialTypes,
          leadTimeDays: Number(leadTimeDays) || 7,
          paymentTermsDays: (() => {
            const n = Number(paymentTermsDays)
            return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 30
          })(),
          paymentTerms: paymentTerms.trim() || null,
          active,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFieldErrors(data.fields || {})
        toast.error(data.error || 'Failed')
        return
      }
      toast.success('Supplier updated')
      router.push('/masters/suppliers')
    } catch {
      toast.error('Failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="text-slate-400">Loading…</div>
  if (!supplier) return <div className="text-red-400">Supplier not found</div>

  return (
    <div className="max-w-lg">
      <h2 className="text-lg font-semibold text-foreground mb-4">Edit supplier</h2>
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
          <label className="block text-sm text-slate-400 mb-1">Material types</label>
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
            placeholder="0 = advance, 30 = Net 30"
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground font-mono tabular-nums"
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Drives projected payment date from GRN receipt (calendar days).
          </p>
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Payment terms (notes)</label>
          <input
            value={paymentTerms}
            onChange={(e) => setPaymentTerms(e.target.value)}
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
