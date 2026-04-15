'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { MasterSearchSelect } from '@/components/ui/MasterSearchSelect'
import { DRUG_SCHEDULES, COATING_TYPES, LAMINATE_TYPES, FOIL_TYPES, EMBOSSING_TYPES, CARTON_CONSTRUCTIONS, BARCODE_TYPES } from '@/lib/constants'

type Customer = {
  id: string
  name: string
  gstNumber?: string | null
  contactName?: string | null
  contactPhone?: string | null
  email?: string | null
  address?: string | null
}

type CartonTemplate = {
  id: string
  cartonName: string
  customerId: string
  productType?: string | null
  cartonSize: string
  boardGrade?: string | null
  gsm?: number | null
  paperType?: string | null
  coatingType?: string | null
  foilType?: string | null
  laminateType?: string | null
  embossingLeafing?: string | null
  cartonConstruct?: string | null
  barcodeType?: string | null
  artworkCode?: string | null
  finishedLength?: number | null
  finishedWidth?: number | null
  finishedHeight?: number | null
  numberOfColours?: number | null
  colourBreakdown?: unknown
  drugSchedule?: string | null
  regulatoryText?: string | null
  batchSpaceL?: number | null
  batchSpaceW?: number | null
  mrpSpaceL?: number | null
  mrpSpaceW?: number | null
  specialInstructions?: string | null
  whoGmpRequired?: boolean
  scheduleMRequired?: boolean
  fssaiRequired?: boolean
}

type Supplier = {
  id: string
  name: string
  contactName?: string | null
  contactPhone?: string | null
  email?: string | null
}

type RfqCoreForm = {
  customerId: string
  customerName: string
  contactPerson: string
  contactPhone: string
  contactEmail: string
  productName: string
  packType: string
  drugSchedule: string
  annualVolume: string
  annualVolumeUnit: string
  sampleQty: string
  deliveryTimeline: string
  referenceSampleAvailable: 'yes' | 'no' | ''
  specialRequirements: string
}

type RfqSpecForm = {
  sizeL: string
  sizeW: string
  sizeH: string
  boardGrade: string
  gsm: string
  colours: string
  colourBreakdown: string
  coatingType: string
  lamination: string
  foil: string
  embossing: string
  construction: string
  barcodeType: string
}

type RfqComplianceForm = {
  regulatoryText: 'yes' | 'no' | ''
  batchSpaceW: string
  batchSpaceH: string
  mrpSpaceW: string
  mrpSpaceH: string
  whoGmp: boolean
  scheduleM: boolean
  fssai: boolean
}

type RfqCommercialForm = {
  existingSupplier: 'yes' | 'no' | ''
  existingSupplierId: string
  existingSupplierName: string
  targetPricePerThousand: string
  competitorRef: string
  priority: 'Normal' | 'Urgent' | 'Critical'
}

type FieldErrors = Record<string, string>

export default function NewRfqPage() {
  const router = useRouter()

  const [core, setCore] = useState<RfqCoreForm>({
    customerId: '',
    customerName: '',
    contactPerson: '',
    contactPhone: '',
    contactEmail: '',
    productName: '',
    packType: '',
    drugSchedule: '',
    annualVolume: '',
    annualVolumeUnit: 'cartons',
    sampleQty: '',
    deliveryTimeline: '',
    referenceSampleAvailable: '',
    specialRequirements: '',
  })

  const [spec, setSpec] = useState<RfqSpecForm>({
    sizeL: '',
    sizeW: '',
    sizeH: '',
    boardGrade: '',
    gsm: '',
    colours: '',
    colourBreakdown: '',
    coatingType: '',
    lamination: '',
    foil: '',
    embossing: '',
    construction: '',
    barcodeType: '',
  })

  const [compliance, setCompliance] = useState<RfqComplianceForm>({
    regulatoryText: '',
    batchSpaceW: '',
    batchSpaceH: '',
    mrpSpaceW: '',
    mrpSpaceH: '',
    whoGmp: false,
    scheduleM: false,
    fssai: false,
  })

  const [commercial, setCommercial] = useState<RfqCommercialForm>({
    existingSupplier: '',
    existingSupplierId: '',
    existingSupplierName: '',
    targetPricePerThousand: '',
    competitorRef: '',
    priority: 'Normal',
  })

  const [errors, setErrors] = useState<FieldErrors>({})
  const [submitting, setSubmitting] = useState(false)

  const [quickCreateOpen, setQuickCreateOpen] = useState(false)
  const [qcCustomer, setQcCustomer] = useState({
    name: '',
    gstNumber: '',
    contactName: '',
    contactPhone: '',
    email: '',
    address: '',
    requiresArtworkApproval: true,
  })
  const [qcErrors, setQcErrors] = useState<FieldErrors>({})
  const [qcSubmitting, setQcSubmitting] = useState(false)

  const customerSearch = useAutoPopulate<Customer>({
    storageKey: 'rfq-customer',
    search: async (query: string) => {
      const res = await fetch(`/api/customers?q=${encodeURIComponent(query)}`)
      return (await res.json()) as Customer[]
    },
    getId: (c) => c.id,
    getLabel: (c) => c.name,
  })

  const cartonSearch = useAutoPopulate<CartonTemplate>({
    storageKey: 'rfq-carton-template',
    search: async (query: string) => {
      const params = new URLSearchParams()
      if (core.customerId) params.set('customerId', core.customerId)
      params.set('q', query)
      const res = await fetch(`/api/cartons?${params.toString()}`)
      const data = (await res.json()) as CartonTemplate[]
      return data
    },
    getId: (c) => c.id,
    getLabel: (c) => c.cartonName,
  })

  const supplierSearch = useAutoPopulate<Supplier>({
    storageKey: 'rfq-supplier',
    search: async (query: string) => {
      const res = await fetch('/api/masters/suppliers')
      const data = (await res.json()) as Supplier[]
      const q = query.toLowerCase()
      return data.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.contactName ?? '').toLowerCase().includes(q),
      )
    },
    getId: (s) => s.id,
    getLabel: (s) => s.name,
  })

  const applyCustomer = (c: Customer) => {
    customerSearch.select(c)
    cartonSearch.setQuery('')
    setCore((prev) => ({
      ...prev,
      customerId: c.id,
      customerName: c.name,
      contactPerson: c.contactName ?? '',
      contactPhone: c.contactPhone ?? '',
      contactEmail: c.email ?? '',
    }))
  }

  const colorBreakdownToText = (value: unknown): string => {
    if (Array.isArray(value)) return value.map((item) => String(item)).join(', ')
    if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).map(String).join(', ')
    return typeof value === 'string' ? value : ''
  }

  const colourCountToLabel = (value?: number | null): string => {
    if (!value || value < 1) return ''
    return `${value}C`
  }

  const yesNoFromRegulatoryText = (value?: string | null): 'yes' | 'no' | '' => {
    if (!value) return ''
    return value.toLowerCase() === 'no' ? 'no' : 'yes'
  }

  const applyCartonTemplate = (carton: CartonTemplate) => {
    cartonSearch.select(carton)
    setCore((prev) => ({
      ...prev,
      packType: carton.productType ?? prev.packType,
      drugSchedule: carton.drugSchedule ?? prev.drugSchedule,
      specialRequirements: carton.specialInstructions ?? prev.specialRequirements,
    }))
    setSpec((prev) => ({
      ...prev,
      boardGrade: carton.boardGrade ?? prev.boardGrade,
      gsm: carton.gsm != null ? String(carton.gsm) : prev.gsm,
      colours: colourCountToLabel(carton.numberOfColours) || prev.colours,
      colourBreakdown: colorBreakdownToText(carton.colourBreakdown) || prev.colourBreakdown,
      coatingType: carton.coatingType ?? prev.coatingType,
      lamination: carton.laminateType ?? prev.lamination,
      foil: carton.foilType ?? prev.foil,
      embossing: carton.embossingLeafing ?? prev.embossing,
      construction: carton.cartonConstruct ?? prev.construction,
      barcodeType: carton.barcodeType ?? prev.barcodeType,
      sizeL: carton.finishedLength != null ? String(carton.finishedLength) : prev.sizeL,
      sizeW: carton.finishedWidth != null ? String(carton.finishedWidth) : prev.sizeW,
      sizeH: carton.finishedHeight != null ? String(carton.finishedHeight) : prev.sizeH,
    }))
    setCompliance((prev) => ({
      ...prev,
      regulatoryText: yesNoFromRegulatoryText(carton.regulatoryText),
      batchSpaceW: carton.batchSpaceW != null ? String(carton.batchSpaceW) : prev.batchSpaceW,
      batchSpaceH: carton.batchSpaceL != null ? String(carton.batchSpaceL) : prev.batchSpaceH,
      mrpSpaceW: carton.mrpSpaceW != null ? String(carton.mrpSpaceW) : prev.mrpSpaceW,
      mrpSpaceH: carton.mrpSpaceL != null ? String(carton.mrpSpaceL) : prev.mrpSpaceH,
      whoGmp: carton.whoGmpRequired ?? prev.whoGmp,
      scheduleM: carton.scheduleMRequired ?? prev.scheduleM,
      fssai: carton.fssaiRequired ?? prev.fssai,
    }))
  }

  const applySupplier = (supplier: Supplier) => {
    supplierSearch.select(supplier)
    setCommercial((prev) => ({
      ...prev,
      existingSupplier: 'yes',
      existingSupplierId: supplier.id,
      existingSupplierName: supplier.name,
    }))
  }

  const validate = (): boolean => {
    const next: FieldErrors = {}
    if (!core.customerId) next.customerId = 'Customer is required'
    if (!core.productName.trim()) next.productName = 'Product name is required'
    if (!core.packType) next.packType = 'Pack type is required'
    if (!core.annualVolume) next.annualVolume = 'Annual estimated volume is required'
    if (!spec.gsm) next.gsm = 'GSM is required'
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return
    setSubmitting(true)
    try {
      const coreRes = await fetch('/api/rfq', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: core.customerId,
          productName: core.productName,
          packType: core.packType,
          estimatedVolume: Number(core.annualVolume) || undefined,
        }),
      })
      const created = await coreRes.json()
      if (!coreRes.ok) {
        throw new Error(created?.error ?? 'Failed to create RFQ')
      }

      const feasibilityPayload = {
        client: {
          customerId: core.customerId,
          customerName: core.customerName,
          contactPerson: core.contactPerson,
          contactPhone: core.contactPhone,
          contactEmail: core.contactEmail,
        },
        product: {
          productName: core.productName,
          packType: core.packType,
          drugSchedule: core.drugSchedule,
          annualVolume: Number(core.annualVolume) || null,
          annualVolumeUnit: core.annualVolumeUnit,
          sampleQty: Number(core.sampleQty) || null,
          deliveryTimeline: core.deliveryTimeline || null,
          referenceSampleAvailable: core.referenceSampleAvailable,
          specialRequirements: core.specialRequirements || null,
        },
        specs: {
          sizeL: Number(spec.sizeL) || null,
          sizeW: Number(spec.sizeW) || null,
          sizeH: Number(spec.sizeH) || null,
          boardGrade: spec.boardGrade || null,
          gsm: Number(spec.gsm) || null,
          colours: spec.colours || null,
          colourBreakdown: spec.colourBreakdown || null,
          coatingType: spec.coatingType || null,
          lamination: spec.lamination || null,
          foil: spec.foil || null,
          embossing: spec.embossing || null,
          construction: spec.construction || null,
          barcodeType: spec.barcodeType || null,
        },
        compliance: {
          regulatoryText: compliance.regulatoryText,
          batchSpace: {
            w: Number(compliance.batchSpaceW) || null,
            h: Number(compliance.batchSpaceH) || null,
          },
          mrpSpace: {
            w: Number(compliance.mrpSpaceW) || null,
            h: Number(compliance.mrpSpaceH) || null,
          },
          whoGmp: compliance.whoGmp,
          scheduleM: compliance.scheduleM,
          fssai: compliance.fssai,
        },
        commercial: {
          existingSupplier: compliance.regulatoryText,
          existingSupplierName: commercial.existingSupplierName || null,
          targetPricePerThousand: Number(commercial.targetPricePerThousand) || null,
          competitorRef: commercial.competitorRef || null,
          priority: commercial.priority,
        },
      }

      await fetch(`/api/rfq/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feasibilityData: feasibilityPayload,
          status: 'received',
        }),
      })

      router.push(`/rfq/${created.id}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create RFQ'
      alert(msg)
    } finally {
      setSubmitting(false)
    }
  }

  const submitQuickCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault()
    const next: FieldErrors = {}
    if (!qcCustomer.name.trim()) next.name = 'Name is required'
    setQcErrors(next)
    if (Object.keys(next).length) return
    setQcSubmitting(true)
    try {
      const res = await fetch('/api/masters/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: qcCustomer.name,
          gstNumber: qcCustomer.gstNumber || undefined,
          contactName: qcCustomer.contactName || undefined,
          contactPhone: qcCustomer.contactPhone || undefined,
          email: qcCustomer.email || undefined,
          address: qcCustomer.address || undefined,
          requiresArtworkApproval: qcCustomer.requiresArtworkApproval,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        alert(data?.error ?? 'Failed to create customer')
        return
      }
      setQuickCreateOpen(false)
      applyCustomer(data as Customer)
    } catch {
      alert('Failed to create customer')
    } finally {
      setQcSubmitting(false)
    }
  }

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <h1 className="text-xl font-bold text-amber-400 mb-2">New RFQ</h1>
      <p className="text-xs text-slate-500 mb-4">
        Capture client requirements with full pharma-compliant carton specifications.
      </p>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* SECTION 1 — CLIENT DETAILS */}
        <section className="rounded-lg border border-slate-700 bg-slate-900/70 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-200">SECTION 1 — CLIENT DETAILS</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <div className="md:col-span-2">
              <MasterSearchSelect
                label="Customer"
                required
                query={customerSearch.query}
                onQueryChange={(value) => {
                  customerSearch.setQuery(value)
                  setCore((prev) => ({ ...prev, customerId: '', customerName: '' }))
                }}
                loading={customerSearch.loading}
                options={customerSearch.options}
                lastUsed={customerSearch.lastUsed}
                onSelect={applyCustomer}
                getOptionLabel={(c) => c.name}
                getOptionMeta={(c) =>
                  [c.contactName, c.contactPhone].filter(Boolean).join(' · ')
                }
                error={errors.customerId}
                placeholder="Type 1-2 letters to search customers..."
                emptyMessage="No customer found in master."
                recentLabel="Recent customers"
                loadingMessage="Searching customers..."
                emptyActionLabel={
                  customerSearch.query.trim()
                    ? `Create "${customerSearch.query.trim()}" as new customer`
                    : undefined
                }
                onEmptyAction={() => {
                  const suggestedName = customerSearch.query.trim()
                  setQcCustomer((prev) => ({
                    ...prev,
                    name: suggestedName || prev.name,
                  }))
                  setQuickCreateOpen(true)
                }}
              />
              <button
                type="button"
                className="mt-1 text-xs text-amber-400 hover:underline"
                onClick={() => setQuickCreateOpen(true)}
              >
                Create New Customer
              </button>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Contact Person<span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={core.contactPerson}
                onChange={(e) =>
                  setCore((prev) => ({ ...prev, contactPerson: e.target.value }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Phone<span className="text-red-400">*</span>
              </label>
              <input
                type="tel"
                value={core.contactPhone}
                onChange={(e) =>
                  setCore((prev) => ({ ...prev, contactPhone: e.target.value }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Email</label>
              <input
                type="email"
                value={core.contactEmail}
                onChange={(e) =>
                  setCore((prev) => ({ ...prev, contactEmail: e.target.value }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </div>
          </div>
        </section>

        {/* SECTION 2 — PRODUCT REQUIREMENT */}
        <section className="rounded-lg border border-slate-700 bg-slate-900/70 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-slate-200">
            SECTION 2 — PRODUCT REQUIREMENT
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <div className="md:col-span-2">
              <MasterSearchSelect
                label="Product Template From Carton Master"
                query={cartonSearch.query}
                onQueryChange={cartonSearch.setQuery}
                loading={cartonSearch.loading}
                options={cartonSearch.options}
                lastUsed={cartonSearch.lastUsed}
                onSelect={applyCartonTemplate}
                getOptionLabel={(carton) => carton.cartonName}
                getOptionMeta={(carton) =>
                  [carton.productType, carton.cartonSize].filter(Boolean).join(' · ')
                }
                placeholder={
                  core.customerId
                    ? 'Type 1-2 letters to search carton templates...'
                    : 'Select customer first to filter carton templates'
                }
                disabled={!core.customerId}
                emptyMessage="No carton template found for this customer."
                recentLabel="Recent carton templates"
                loadingMessage="Searching carton master..."
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Product Name<span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={core.productName}
                onChange={(e) =>
                  setCore((prev) => ({ ...prev, productName: e.target.value }))
                }
                className={`w-full px-3 py-2 rounded bg-slate-800 border ${
                  errors.productName ? 'border-red-500' : 'border-slate-600'
                } text-white`}
              />
              {errors.productName && (
                <p className="text-xs text-red-400 mt-1">{errors.productName}</p>
              )}
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Pack Type<span className="text-red-400">*</span>
              </label>
              <select
                value={core.packType}
                onChange={(e) =>
                  setCore((prev) => ({ ...prev, packType: e.target.value }))
                }
                className={`w-full px-3 py-2 rounded bg-slate-800 border ${
                  errors.packType ? 'border-red-500' : 'border-slate-600'
                } text-white`}
              >
                <option value="">Select…</option>
                <option value="Mono Carton">Mono Carton</option>
                <option value="Duplex Carton">Duplex Carton</option>
                <option value="Inner Carton">Inner Carton</option>
                <option value="Label">Label</option>
                <option value="Leaflet">Leaflet</option>
                <option value="Blister Foil">Blister Foil</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Drug Schedule</label>
              <select
                value={core.drugSchedule}
                onChange={(e) =>
                  setCore((prev) => ({ ...prev, drugSchedule: e.target.value }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="">Select…</option>
                {DRUG_SCHEDULES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs text-slate-400 mb-1">
                  Annual Estimated Volume<span className="text-red-400">*</span>
                </label>
                <input
                  type="number"
                  min={0}
                  value={core.annualVolume}
                  onChange={(e) =>
                    setCore((prev) => ({ ...prev, annualVolume: e.target.value }))
                  }
                  className={`w-full px-3 py-2 rounded bg-slate-800 border ${
                    errors.annualVolume ? 'border-red-500' : 'border-slate-600'
                  } text-white`}
                />
                {errors.annualVolume && (
                  <p className="text-xs text-red-400 mt-1">{errors.annualVolume}</p>
                )}
              </div>
              <div className="w-32">
                <label className="block text-xs text-slate-400 mb-1">Unit</label>
                <select
                  value={core.annualVolumeUnit}
                  onChange={(e) =>
                    setCore((prev) => ({ ...prev, annualVolumeUnit: e.target.value }))
                  }
                  className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
                >
                  <option value="cartons">Cartons</option>
                  <option value="labels">Labels</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Sample Quantity</label>
              <input
                type="number"
                min={0}
                value={core.sampleQty}
                onChange={(e) =>
                  setCore((prev) => ({ ...prev, sampleQty: e.target.value }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Delivery Timeline</label>
              <input
                type="date"
                value={core.deliveryTimeline}
                onChange={(e) =>
                  setCore((prev) => ({ ...prev, deliveryTimeline: e.target.value }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Reference Sample Available
              </label>
              <select
                value={core.referenceSampleAvailable}
                onChange={(e) =>
                  setCore((prev) => ({
                    ...prev,
                    referenceSampleAvailable: e.target.value as 'yes' | 'no' | '',
                  }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="">Select…</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs text-slate-400 mb-1">Special Requirements</label>
              <textarea
                rows={2}
                value={core.specialRequirements}
                onChange={(e) =>
                  setCore((prev) => ({ ...prev, specialRequirements: e.target.value }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </div>
          </div>
        </section>

        {/* SECTION 3 — PACKAGING SPECIFICATIONS */}
        <section className="rounded-lg border border-slate-700 bg-slate-900/70 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-slate-200">
            SECTION 3 — PACKAGING SPECIFICATIONS
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Carton Size L (mm)</label>
              <input
                type="number"
                min={0}
                value={spec.sizeL}
                onChange={(e) => setSpec((prev) => ({ ...prev, sizeL: e.target.value }))}
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Carton Size W (mm)</label>
              <input
                type="number"
                min={0}
                value={spec.sizeW}
                onChange={(e) => setSpec((prev) => ({ ...prev, sizeW: e.target.value }))}
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Carton Size H (mm)</label>
              <input
                type="number"
                min={0}
                value={spec.sizeH}
                onChange={(e) => setSpec((prev) => ({ ...prev, sizeH: e.target.value }))}
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm mt-2">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Board Grade</label>
              <select
                value={spec.boardGrade}
                onChange={(e) =>
                  setSpec((prev) => ({ ...prev, boardGrade: e.target.value }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="">Select…</option>
                {['SBS', 'FBB', 'Duplex', 'Art Card', 'Kraft'].map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                GSM<span className="text-red-400">*</span>
              </label>
              <input
                type="number"
                min={0}
                value={spec.gsm}
                onChange={(e) => setSpec((prev) => ({ ...prev, gsm: e.target.value }))}
                className={`w-full px-3 py-2 rounded bg-slate-800 border ${
                  errors.gsm ? 'border-red-500' : 'border-slate-600'
                } text-white`}
              />
              {errors.gsm && <p className="text-xs text-red-400 mt-1">{errors.gsm}</p>}
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Number of Colours</label>
              <select
                value={spec.colours}
                onChange={(e) =>
                  setSpec((prev) => ({ ...prev, colours: e.target.value }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="">Select…</option>
                {['1C', '2C', '4C', '5C', '6C'].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Colour Breakdown</label>
              <input
                type="text"
                value={spec.colourBreakdown}
                onChange={(e) =>
                  setSpec((prev) => ({ ...prev, colourBreakdown: e.target.value }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
                placeholder="e.g. CMYK + PANTONE 300C"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Coating Type</label>
              <select
                value={spec.coatingType}
                onChange={(e) =>
                  setSpec((prev) => ({ ...prev, coatingType: e.target.value }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="">Select…</option>
                {COATING_TYPES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Lamination</label>
              <select
                value={spec.lamination}
                onChange={(e) =>
                  setSpec((prev) => ({ ...prev, lamination: e.target.value }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="">Select…</option>
                {LAMINATE_TYPES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Foil</label>
              <select
                value={spec.foil}
                onChange={(e) => setSpec((prev) => ({ ...prev, foil: e.target.value }))}
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="">Select…</option>
                {FOIL_TYPES.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Embossing</label>
              <select
                value={spec.embossing}
                onChange={(e) =>
                  setSpec((prev) => ({ ...prev, embossing: e.target.value }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="">Select…</option>
                {EMBOSSING_TYPES.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Carton Construction</label>
              <select
                value={spec.construction}
                onChange={(e) =>
                  setSpec((prev) => ({ ...prev, construction: e.target.value }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="">Select…</option>
                {CARTON_CONSTRUCTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Barcode Type</label>
              <select
                value={spec.barcodeType}
                onChange={(e) =>
                  setSpec((prev) => ({ ...prev, barcodeType: e.target.value }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="">Select…</option>
                {BARCODE_TYPES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* SECTION 4 — PHARMA COMPLIANCE */}
        <section className="rounded-lg border border-slate-700 bg-slate-900/70 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-slate-200">
            SECTION 4 — PHARMA COMPLIANCE
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Regulatory Text Required
              </label>
              <select
                value={compliance.regulatoryText}
                onChange={(e) =>
                  setCompliance((prev) => ({
                    ...prev,
                    regulatoryText: e.target.value as 'yes' | 'no' | '',
                  }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="">Select…</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs text-slate-400 mb-1">Batch Space W (mm)</label>
                <input
                  type="number"
                  min={0}
                  value={compliance.batchSpaceW}
                  onChange={(e) =>
                    setCompliance((prev) => ({ ...prev, batchSpaceW: e.target.value }))
                  }
                  className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-slate-400 mb-1">Batch Space H (mm)</label>
                <input
                  type="number"
                  min={0}
                  value={compliance.batchSpaceH}
                  onChange={(e) =>
                    setCompliance((prev) => ({ ...prev, batchSpaceH: e.target.value }))
                  }
                  className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs text-slate-400 mb-1">MRP Space W (mm)</label>
                <input
                  type="number"
                  min={0}
                  value={compliance.mrpSpaceW}
                  onChange={(e) =>
                    setCompliance((prev) => ({ ...prev, mrpSpaceW: e.target.value }))
                  }
                  className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-slate-400 mb-1">MRP Space H (mm)</label>
                <input
                  type="number"
                  min={0}
                  value={compliance.mrpSpaceH}
                  onChange={(e) =>
                    setCompliance((prev) => ({ ...prev, mrpSpaceH: e.target.value }))
                  }
                  className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="who-gmp"
                type="checkbox"
                checked={compliance.whoGmp}
                onChange={(e) =>
                  setCompliance((prev) => ({ ...prev, whoGmp: e.target.checked }))
                }
                className="h-4 w-4 rounded border-slate-500 bg-slate-800"
              />
              <label htmlFor="who-gmp" className="text-xs text-slate-300">
                WHO-GMP Required
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="schedule-m"
                type="checkbox"
                checked={compliance.scheduleM}
                onChange={(e) =>
                  setCompliance((prev) => ({ ...prev, scheduleM: e.target.checked }))
                }
                className="h-4 w-4 rounded border-slate-500 bg-slate-800"
              />
              <label htmlFor="schedule-m" className="text-xs text-slate-300">
                Schedule M Required
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="fssai"
                type="checkbox"
                checked={compliance.fssai}
                onChange={(e) =>
                  setCompliance((prev) => ({ ...prev, fssai: e.target.checked }))
                }
                className="h-4 w-4 rounded border-slate-500 bg-slate-800"
              />
              <label htmlFor="fssai" className="text-xs text-slate-300">
                FSSAI Required
              </label>
            </div>
          </div>
        </section>

        {/* SECTION 5 — COMMERCIAL */}
        <section className="rounded-lg border border-slate-700 bg-slate-900/70 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-slate-200">SECTION 5 — COMMERCIAL</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Existing Supplier</label>
              <select
                value={commercial.existingSupplier}
                onChange={(e) =>
                  setCommercial((prev) => ({
                    ...prev,
                    existingSupplier: e.target.value as 'yes' | 'no' | '',
                    existingSupplierId:
                      e.target.value === 'yes' ? prev.existingSupplierId : '',
                    existingSupplierName:
                      e.target.value === 'yes' ? prev.existingSupplierName : '',
                  }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="">Select…</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </div>
            <div>
              <MasterSearchSelect
                label="Existing Supplier Name"
                query={supplierSearch.query}
                onQueryChange={(value) => {
                  supplierSearch.setQuery(value)
                  setCommercial((prev) => ({
                    ...prev,
                    existingSupplier: value ? 'yes' : prev.existingSupplier,
                    existingSupplierId: '',
                    existingSupplierName: value,
                  }))
                }}
                loading={supplierSearch.loading}
                options={supplierSearch.options}
                lastUsed={supplierSearch.lastUsed}
                onSelect={applySupplier}
                getOptionLabel={(supplier) => supplier.name}
                getOptionMeta={(supplier) =>
                  [supplier.contactName, supplier.contactPhone].filter(Boolean).join(' · ')
                }
                placeholder="Type 1-2 letters to search suppliers..."
                emptyMessage="No supplier found in master."
                recentLabel="Recent suppliers"
                loadingMessage="Searching suppliers..."
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Target Price per 1000 units (₹)
              </label>
              <input
                type="number"
                min={0}
                value={commercial.targetPricePerThousand}
                onChange={(e) =>
                  setCommercial((prev) => ({
                    ...prev,
                    targetPricePerThousand: e.target.value,
                  }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Competitor Reference</label>
              <input
                type="text"
                value={commercial.competitorRef}
                onChange={(e) =>
                  setCommercial((prev) => ({
                    ...prev,
                    competitorRef: e.target.value,
                  }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Priority</label>
              <select
                value={commercial.priority}
                onChange={(e) =>
                  setCommercial((prev) => ({
                    ...prev,
                    priority: e.target.value as 'Normal' | 'Urgent' | 'Critical',
                  }))
                }
                className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
              >
                <option value="Normal">Normal</option>
                <option value="Urgent">Urgent</option>
                <option value="Critical">Critical</option>
              </select>
            </div>
          </div>
        </section>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-medium text-sm"
          >
            {submitting ? 'Saving…' : 'Create RFQ'}
          </button>
        </div>
      </form>

      <SlideOverPanel
        title="Quick Create Customer"
        isOpen={quickCreateOpen}
        onClose={() => setQuickCreateOpen(false)}
      >
        <form onSubmit={submitQuickCreateCustomer} className="space-y-3 text-sm">
          <div>
            <label className="block text-xs text-slate-400 mb-1">
              Name<span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={qcCustomer.name}
              onChange={(e) =>
                setQcCustomer((prev) => ({ ...prev, name: e.target.value }))
              }
              className={`w-full px-3 py-2 rounded bg-slate-800 border ${
                qcErrors.name ? 'border-red-500' : 'border-slate-600'
              } text-white`}
            />
            {qcErrors.name && (
              <p className="text-xs text-red-400 mt-1">{qcErrors.name}</p>
            )}
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">GST</label>
            <input
              type="text"
              value={qcCustomer.gstNumber}
              onChange={(e) =>
                setQcCustomer((prev) => ({ ...prev, gstNumber: e.target.value }))
              }
              className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Contact Name</label>
            <input
              type="text"
              value={qcCustomer.contactName}
              onChange={(e) =>
                setQcCustomer((prev) => ({ ...prev, contactName: e.target.value }))
              }
              className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Phone</label>
            <input
              type="text"
              value={qcCustomer.contactPhone}
              onChange={(e) =>
                setQcCustomer((prev) => ({ ...prev, contactPhone: e.target.value }))
              }
              className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Email</label>
            <input
              type="email"
              value={qcCustomer.email}
              onChange={(e) =>
                setQcCustomer((prev) => ({ ...prev, email: e.target.value }))
              }
              className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Address</label>
            <textarea
              rows={3}
              value={qcCustomer.address}
              onChange={(e) =>
                setQcCustomer((prev) => ({ ...prev, address: e.target.value }))
              }
              className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 text-white"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              id="requires-artwork"
              type="checkbox"
              checked={qcCustomer.requiresArtworkApproval}
              onChange={(e) =>
                setQcCustomer((prev) => ({
                  ...prev,
                  requiresArtworkApproval: e.target.checked,
                }))
              }
              className="h-4 w-4 rounded border-slate-500 bg-slate-800"
            />
            <label htmlFor="requires-artwork" className="text-xs text-slate-300">
              Requires Artwork Approval
            </label>
          </div>
          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={qcSubmitting}
              className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium"
            >
              {qcSubmitting ? 'Saving…' : 'Save Customer'}
            </button>
          </div>
        </form>
      </SlideOverPanel>
    </div>
  )
}
