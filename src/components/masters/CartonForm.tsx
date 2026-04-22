'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { cityFromAddress } from '@/lib/customer-address'
import type { PastingStyle } from '@prisma/client'
import { PASTING_STYLE_ORDER, pastingStyleLabel } from '@/lib/pasting-style'
import { MASTER_BOARD_GRADES, MASTER_COATINGS_AND_VARNISHES } from '@/lib/master-enums'

const PRINTING_TYPES = ['Offset', 'Metallic']
const BOARD_GRADES = [...MASTER_BOARD_GRADES]
const COATING_SPECS = [...MASTER_COATINGS_AND_VARNISHES]

type Customer = { id: string; name: string; address?: string | null; city?: string | null }

type SectionId = 'identity' | 'dimensions' | 'specifications' | 'instructions'

type CustomerSearchState = {
  loading: boolean
  open: boolean
  activeIndex: number
}

function parseSpecialInstructions(raw: string | undefined) {
  const fallback = {
    notes: raw || '',
    brailleEnabled: false,
    leafingEnabled: false,
    embossingEnabled: false,
    spotUvEnabled: false,
  }
  if (!raw) return fallback
  try {
    const obj = JSON.parse(raw)
    return {
      notes: typeof obj.notes === 'string' ? obj.notes : '',
      brailleEnabled: !!obj.brailleEnabled,
      leafingEnabled: !!obj.leafingEnabled,
      embossingEnabled: !!obj.embossingEnabled,
      spotUvEnabled: !!obj.spotUvEnabled,
    }
  } catch {
    return fallback
  }
}

function blockInvalidNumericKeys(e: React.KeyboardEvent<HTMLInputElement>) {
  if (['e', 'E', '+', '-'].includes(e.key)) e.preventDefault()
}

function toCaps(value: string) {
  return value.toUpperCase()
}

function normalizeCustomerName(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export type CartonFormData = {
  cartonName: string
  customerId: string
  /** Display name for the selected client (synced with Customer Master). */
  customerName: string
  artworkCode: string
  rate: string
  gstPct: string
  finishedLength: string
  finishedWidth: string
  finishedHeight: string
  /** `PastingStyle` enum value or empty when unset. */
  pastingStyle: string
  boardGrade: string
  gsm: string
  printingType: string
  coatingType: string
  brailleEnabled: boolean
  leafingEnabled: boolean
  embossingEnabled: boolean
  spotUvEnabled: boolean
  specialInstructions: string
  remarks: string
  /** Linked Die Master (tooling) — UUID or empty */
  dieMasterId: string
  /** Linked shade card for production kit / color ledger */
  shadeCardId: string
  active: boolean
}

const EMPTY: CartonFormData = {
  cartonName: '',
  customerId: '',
  customerName: '',
  artworkCode: '',
  rate: '',
  gstPct: '5',
  finishedLength: '',
  finishedWidth: '',
  finishedHeight: '',
  pastingStyle: '',
  boardGrade: '',
  gsm: '',
  printingType: '',
  coatingType: '',
  brailleEnabled: false,
  leafingEnabled: false,
  embossingEnabled: false,
  spotUvEnabled: false,
  specialInstructions: '',
  remarks: '',
  dieMasterId: '',
  shadeCardId: '',
  active: true,
}

type Props = {
  mode: 'ADD' | 'EDIT'
  initialData?: Partial<CartonFormData> & { id?: string }
}

type DieMasterOption = { id: string; dyeNumber: number; dyeType: string }
type ShadeCardOption = { id: string; shadeCode: string }

export default function CartonForm({ mode, initialData }: Props) {
  const router = useRouter()
  const [dieMasters, setDieMasters] = useState<DieMasterOption[]>([])
  const [shadeCards, setShadeCards] = useState<ShadeCardOption[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [customerResults, setCustomerResults] = useState<Customer[]>([])
  const [customerState, setCustomerState] = useState<CustomerSearchState>({
    loading: false,
    open: false,
    activeIndex: -1,
  })
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [activeSection, setActiveSection] = useState<SectionId>('identity')
  const suppressCustomerSearchRef = useRef(false)
  const sectionEls = useRef<Record<SectionId, HTMLElement | null>>({
    identity: null,
    dimensions: null,
    specifications: null,
    instructions: null,
  })

  const specials = parseSpecialInstructions(initialData?.specialInstructions)
  const [f, setF] = useState<CartonFormData>(() => ({
    ...EMPTY,
    ...(initialData || {}),
    customerName: initialData?.customerName ?? '',
    brailleEnabled: initialData?.brailleEnabled ?? specials.brailleEnabled,
    leafingEnabled: initialData?.leafingEnabled ?? specials.leafingEnabled,
    embossingEnabled: initialData?.embossingEnabled ?? specials.embossingEnabled,
    spotUvEnabled: initialData?.spotUvEnabled ?? specials.spotUvEnabled,
    specialInstructions: initialData?.specialInstructions ?? specials.notes,
  }))
  const [customerQuery, setCustomerQuery] = useState(() => toCaps(initialData?.customerName ?? ''))

  function refreshCustomerList() {
    fetch('/api/customers')
      .then((r) => r.json())
      .then((data) => {
        const list = Array.isArray(data) ? data : []
        setCustomers(list)
      })
      .catch(() => toast.error('Failed to load clients'))
  }

  useEffect(() => {
    let cancelled = false
    fetch('/api/customers')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        const list = Array.isArray(data) ? data : []
        setCustomers(list)
        const cid = initialData?.customerId
        if (cid && !initialData?.customerName) {
          const c = list.find((x: Customer) => x.id === cid)
          if (c) {
            setCustomerQuery(toCaps(c.name))
            setF((prev) => ({ ...prev, customerName: toCaps(c.name) }))
          }
        }
      })
      .catch(() => toast.error('Failed to load clients'))
    return () => {
      cancelled = true
    }
  }, [initialData?.customerId, initialData?.customerName])

  useEffect(() => {
    const onUpdated = () => refreshCustomerList()
    window.addEventListener('ci-customers-updated', onUpdated)
    return () => window.removeEventListener('ci-customers-updated', onUpdated)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/masters/dyes')
        const data = await res.json()
        if (cancelled || !res.ok || !Array.isArray(data)) {
          if (!cancelled && !res.ok) setDieMasters([])
          return
        }
        setDieMasters(
          data.map((d: { id: string; dyeNumber: number; dyeType: string }) => ({
            id: d.id,
            dyeNumber: d.dyeNumber,
            dyeType: d.dyeType,
          })),
        )
      } catch {
        if (!cancelled) setDieMasters([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/hub/shade-card-hub')
        const j = await res.json()
        if (cancelled) return
        const list = Array.isArray(j.rows) ? j.rows : []
        setShadeCards(
          list.map((row: { id: string; shadeCode: string }) => ({ id: row.id, shadeCode: row.shadeCode })),
        )
      } catch {
        if (!cancelled) setShadeCards([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (suppressCustomerSearchRef.current) {
      suppressCustomerSearchRef.current = false
      return
    }

    const q = customerQuery.trim()
    if (q.length < 2) {
      setCustomerResults([])
      setCustomerState((s) => ({ ...s, open: false, activeIndex: -1, loading: false }))
      return
    }

    setCustomerState((s) => ({ ...s, loading: true }))
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/customers?q=${encodeURIComponent(q)}&limit=12`)
        const data = await res.json()
        if (!res.ok) {
          const msg = typeof data?.error === 'string' ? data.error : 'Search failed'
          toast.error(msg)
          setCustomerResults([])
          setCustomerState((s) => ({ ...s, loading: false, open: true, activeIndex: -1 }))
          return
        }
        const list = Array.isArray(data) ? data : []
        setCustomerResults(list)
        setCustomerState((s) => ({ ...s, loading: false, open: true, activeIndex: list.length ? 0 : -1 }))
      } catch {
        setCustomerResults([])
        setCustomerState((s) => ({ ...s, loading: false, open: true, activeIndex: -1 }))
      }
    }, 300)

    return () => clearTimeout(t)
  }, [customerQuery])

  useEffect(() => {
    const ids: SectionId[] = ['identity', 'dimensions', 'specifications', 'instructions']
    const onScroll = () => {
      const offsets = ids.map((id) => {
        const el = document.getElementById(id)
        if (!el) return { id, top: Number.POSITIVE_INFINITY }
        return { id, top: Math.abs(el.getBoundingClientRect().top - 100) }
      })
      offsets.sort((a, b) => a.top - b.top)
      setActiveSection(offsets[0].id)
    }
    window.addEventListener('scroll', onScroll)
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const cartonL = Number(f.finishedLength) || 0
  const cartonW = Number(f.finishedWidth) || 0
  const cartonH = Number(f.finishedHeight) || 0
  const customerPool = useMemo(() => {
    const m = new Map<string, Customer>()
    for (const c of customers) m.set(c.id, c)
    for (const c of customerResults) m.set(c.id, c)
    return Array.from(m.values())
  }, [customers, customerResults])
  const selectedCustomer = customerPool.find((c) => c.id === f.customerId)
  const queryNormalized = normalizeCustomerName(customerQuery.trim())
  const selectedCustomerNormalized = normalizeCustomerName(f.customerName || selectedCustomer?.name || '')
  const shouldHideCustomerSuggestions = Boolean(
    f.customerId &&
    queryNormalized &&
    selectedCustomerNormalized &&
    queryNormalized === selectedCustomerNormalized
  )

  function patch<K extends keyof CartonFormData>(key: K, value: CartonFormData[K]) {
    setF((p) => ({ ...p, [key]: value }))
  }

  function selectCustomer(c: Customer) {
    suppressCustomerSearchRef.current = true
    const nm = toCaps(c.name)
    patch('customerId', c.id)
    patch('customerName', nm)
    setCustomerQuery(nm)
    setCustomerState((s) => ({ ...s, open: false, activeIndex: -1 }))
  }

  function resolveCustomerIdFromInput() {
    if (f.customerId) return f.customerId
    const q = normalizeCustomerName(customerQuery.trim())
    if (!q) return ''

    const pool = customerPool
    const exact = pool.find((c) => normalizeCustomerName(c.name) === q)
    if (exact) return exact.id

    const startsWith = pool.filter((c) => normalizeCustomerName(c.name).startsWith(q))
    if (startsWith.length === 1) return startsWith[0].id

    const includes = pool.filter((c) => normalizeCustomerName(c.name).includes(q))
    if (includes.length === 1) return includes[0].id

    return ''
  }

  async function resolveCustomerIdForSubmit() {
    const local = resolveCustomerIdFromInput()
    if (local) return local

    const q = customerQuery.trim()
    if (q.length < 2) return ''

    try {
      const res = await fetch(`/api/customers?q=${encodeURIComponent(q)}&limit=20`)
      const data = await res.json()
      const list: Customer[] = Array.isArray(data) ? data : []
      if (list.length === 0) return ''

      const normalized = normalizeCustomerName(q)
      const exact = list.find((c) => normalizeCustomerName(c.name) === normalized)
      if (exact) return exact.id
      if (list.length === 1) return list[0].id
      return ''
    } catch {
      return ''
    }
  }

  function scrollToSection(id: SectionId) {
    const el = sectionEls.current[id]
    if (!el) return
    setActiveSection(id)
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function toOptionalInt(value: string) {
    if (!value.trim()) return undefined
    const n = parseInt(value, 10)
    return Number.isFinite(n) ? n : undefined
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const resolvedCustomerId = await resolveCustomerIdForSubmit()

    if (!f.cartonName.trim()) return toast.error('Carton name is required')
    if (!resolvedCustomerId) return toast.error('Please select a valid client from suggestions')

    setSaving(true)
    const payload = {
      cartonName: toCaps(f.cartonName.trim()),
      customerId: resolvedCustomerId,
      artworkCode: toCaps(f.artworkCode.trim()) || undefined,
      rate: f.rate ? Number(f.rate) : undefined,
      gstPct: f.gstPct ? Number(f.gstPct) : 5,
      finishedLength: f.finishedLength ? Number(f.finishedLength) : undefined,
      finishedWidth: f.finishedWidth ? Number(f.finishedWidth) : undefined,
      finishedHeight: f.finishedHeight ? Number(f.finishedHeight) : undefined,
      pastingStyle: f.pastingStyle
        ? (f.pastingStyle as PastingStyle)
        : null,
      boardGrade: f.boardGrade || undefined,
      gsm: toOptionalInt(f.gsm),
      printingType: f.printingType || undefined,
      coatingType: f.coatingType || undefined,
      embossingLeafing: f.embossingEnabled && f.leafingEnabled
        ? 'Embossing + Leafing'
        : f.embossingEnabled
          ? 'Embossing'
          : f.leafingEnabled
            ? 'Leafing'
            : undefined,
      specialInstructions: JSON.stringify({
        notes: toCaps(f.specialInstructions || ''),
        brailleEnabled: f.brailleEnabled,
        leafingEnabled: f.leafingEnabled,
        embossingEnabled: f.embossingEnabled,
        spotUvEnabled: f.spotUvEnabled,
      }),
      remarks: toCaps(f.remarks || '') || undefined,
      dieMasterId: f.dieMasterId.trim() || undefined,
      shadeCardId: f.shadeCardId.trim() || undefined,
      active: f.active,
    }

    try {
      const url = mode === 'ADD' ? '/api/masters/cartons' : `/api/masters/cartons/${initialData?.id}`
      const method = mode === 'ADD' ? 'POST' : 'PUT'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) {
        const fieldMsg = json?.fields ? Object.values(json.fields)[0] : ''
        throw new Error(fieldMsg || json.error || 'Failed to save')
      }
      toast.success(mode === 'ADD' ? 'Carton created' : 'Carton updated')
      router.push('/masters/cartons')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (mode !== 'EDIT' || !initialData?.id) return
    const ok = window.confirm('Delete this master permanently? This action cannot be undone.')
    if (!ok) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/masters/cartons/${initialData.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Failed to delete')
      toast.success('Master deleted')
      router.push('/masters/cartons')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete')
    } finally {
      setDeleting(false)
    }
  }

  const cls = 'w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground text-sm'
  const activeCls = (id: SectionId) =>
    `w-full text-left px-3 py-2 rounded text-xs ${activeSection === id ? 'bg-ds-warning/8 text-ds-warning border border-ds-warning/30' : 'text-ds-ink-muted hover:bg-ds-elevated'}`

  return (
    <form onSubmit={handleSubmit} className='relative'>
      <div className='sticky top-0 z-20 mb-4 rounded-lg border border-ds-line/50 bg-ds-main/95 backdrop-blur p-3 flex items-center justify-between'>
        <h2 className='text-lg font-semibold text-foreground'>{mode === 'ADD' ? 'New Product' : 'Edit Product'}</h2>
        <div className='flex items-center gap-3'>
          <label className='inline-flex items-center gap-2 text-ds-ink-muted text-sm'>
            <input type='checkbox' checked={f.active} onChange={(e) => patch('active', e.target.checked)} />
            {f.active ? 'Active' : 'Deactivated'}
          </label>
          {mode === 'EDIT' && (
            <button
              type='button'
              onClick={handleDelete}
              disabled={deleting || saving}
              className='px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-50 text-foreground text-sm'
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          )}
          <button type='button' onClick={() => router.push('/masters/cartons')} className='px-3 py-1.5 rounded-lg border border-ds-line/60 text-ds-ink text-sm'>Cancel</button>
          <button type='submit' disabled={saving} className='px-4 py-1.5 rounded-lg bg-ds-warning hover:bg-ds-warning disabled:opacity-50 text-primary-foreground text-sm font-medium'>
            {saving ? 'Saving...' : mode === 'ADD' ? 'Save' : 'Update'}
          </button>
        </div>
      </div>

      <div className='md:flex md:gap-4'>
        <aside className='hidden md:block w-44 shrink-0'>
          <div className='sticky top-24 z-40 pointer-events-auto rounded-lg border border-ds-line/50 bg-ds-card p-2 space-y-1'>
            <button type='button' className={`${activeCls('identity')} cursor-pointer`} onClick={() => scrollToSection('identity')}>Identity</button>
            <button type='button' className={`${activeCls('dimensions')} cursor-pointer`} onClick={() => scrollToSection('dimensions')}>Dimensions</button>
            <button type='button' className={`${activeCls('specifications')} cursor-pointer`} onClick={() => scrollToSection('specifications')}>Specifications</button>
            <button type='button' className={`${activeCls('instructions')} cursor-pointer`} onClick={() => scrollToSection('instructions')}>Instructions</button>
          </div>
        </aside>

        <div className='flex-1 space-y-4'>
          <section id='identity' ref={(el) => { sectionEls.current.identity = el }} className='scroll-mt-28 rounded-lg border border-ds-line/50 bg-ds-card p-4'>
            <h3 className='text-sm font-semibold text-ds-ink mb-3'>Identity</h3>
            <div className='grid md:grid-cols-3 gap-3 text-sm'>
              <div>
                <label className='block text-ds-ink-muted mb-1'>Carton Name *</label>
                <input className={cls} value={f.cartonName} onChange={(e) => patch('cartonName', toCaps(e.target.value))} />
              </div>
              <div>
                <label className='block text-ds-ink-muted mb-1'>Artwork Code</label>
                <input className={cls} value={f.artworkCode} onChange={(e) => patch('artworkCode', toCaps(e.target.value))} />
              </div>
              <div className='relative'>
                <label className='block text-ds-ink-muted mb-1'>Client Name *</label>
                <input
                  className={cls}
                  value={customerQuery}
                  onChange={(e) => {
                    setCustomerQuery(toCaps(e.target.value))
                    patch('customerId', '')
                    patch('customerName', '')
                  }}
                  onFocus={() => customerResults.length > 0 && setCustomerState((s) => ({ ...s, open: true }))}
                  onBlur={() => setTimeout(() => setCustomerState((s) => ({ ...s, open: false })), 120)}
                  onKeyDown={(e) => {
                    if (!customerState.open || customerResults.length === 0) return
                    if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      setCustomerState((s) => ({ ...s, activeIndex: (s.activeIndex + 1) % customerResults.length }))
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      setCustomerState((s) => ({ ...s, activeIndex: s.activeIndex <= 0 ? customerResults.length - 1 : s.activeIndex - 1 }))
                    }
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      const i = customerState.activeIndex
                      if (i >= 0) selectCustomer(customerResults[i])
                    }
                  }}
                  placeholder='Type at least 2 characters...'
                />
                {customerState.loading && <p className='absolute right-3 top-9 text-[11px] text-ds-ink-muted'>Searching...</p>}
                {customerState.open && !shouldHideCustomerSuggestions && (
                  <div className='absolute z-20 mt-1 w-full max-h-64 overflow-auto rounded-lg border border-ds-line/50 bg-ds-card shadow-lg'>
                    {customerState.loading ? (
                      <div className='px-3 py-2 text-xs text-ds-ink-muted'>Searching…</div>
                    ) : customerQuery.trim().length >= 2 && customerResults.length === 0 ? (
                      <div className='px-3 py-2 space-y-2'>
                        <p className='text-xs text-ds-ink-muted'>No customers match this search.</p>
                        <Link
                          href={`/masters/customers/new?name=${encodeURIComponent(customerQuery.trim())}`}
                          className='block text-sm text-ds-warning hover:text-ds-warning underline'
                          onMouseDown={(e) => e.preventDefault()}
                        >
                          + Add New Customer {toCaps(customerQuery.trim())}
                        </Link>
                      </div>
                    ) : (
                      customerResults.map((c, idx) => {
                        const cityLine = c.city || cityFromAddress(c.address)
                        return (
                          <button
                            key={c.id}
                            type='button'
                            onMouseDown={(e) => {
                              e.preventDefault()
                              selectCustomer(c)
                            }}
                            className={`w-full text-left px-3 py-2 border-b border-ds-line/40 last:border-0 ${idx === customerState.activeIndex ? 'bg-ds-elevated' : 'hover:bg-ds-elevated/70'}`}
                          >
                            <div className='text-sm text-foreground'>{toCaps(c.name)}</div>
                            <div className='text-xs text-ds-ink-muted'>{cityLine}</div>
                          </button>
                        )
                      })
                    )}
                  </div>
                )}
              </div>
              <div className='md:col-span-2 grid grid-cols-2 gap-3'>
                <div>
                  <label className='block text-ds-ink-muted mb-1'>Rate</label>
                  <input type='number' inputMode='decimal' onKeyDown={blockInvalidNumericKeys} className={cls} value={f.rate} onChange={(e) => patch('rate', e.target.value)} />
                </div>
                <div>
                  <label className='block text-ds-ink-muted mb-1'>GST %</label>
                  <input type='number' inputMode='decimal' onKeyDown={blockInvalidNumericKeys} className={cls} value={f.gstPct} onChange={(e) => patch('gstPct', e.target.value)} />
                </div>
              </div>
            </div>
          </section>

          <section id='dimensions' ref={(el) => { sectionEls.current.dimensions = el }} className='scroll-mt-28 rounded-lg border border-ds-line/50 bg-ds-card p-4'>
            <h3 className='text-sm font-semibold text-ds-ink mb-3'>Dimensions</h3>
            <div className='grid md:grid-cols-3 gap-3 text-sm'>
              <div>
                <label className='block text-ds-ink-muted mb-1'>L x W x H (mm)</label>
                <div className='grid grid-cols-3 gap-2'>
                  <input type='number' inputMode='decimal' onKeyDown={blockInvalidNumericKeys} placeholder='L' className={cls} value={f.finishedLength} onChange={(e) => patch('finishedLength', e.target.value)} />
                  <input type='number' inputMode='decimal' onKeyDown={blockInvalidNumericKeys} placeholder='W' className={cls} value={f.finishedWidth} onChange={(e) => patch('finishedWidth', e.target.value)} />
                  <input type='number' inputMode='decimal' onKeyDown={blockInvalidNumericKeys} placeholder='H' className={cls} value={f.finishedHeight} onChange={(e) => patch('finishedHeight', e.target.value)} />
                </div>
              </div>
              <div>
                <label className='block text-ds-ink-muted mb-1'>Pasting style</label>
                <select className={cls} value={f.pastingStyle} onChange={(e) => patch('pastingStyle', e.target.value)}>
                  <option value=''>Select...</option>
                  {PASTING_STYLE_ORDER.map((p) => (
                    <option key={p} value={p}>{pastingStyleLabel(p)}</option>
                  ))}
                </select>
              </div>
              <div className='md:col-span-1'>
                <label className='block text-ds-ink-muted mb-1'>Die Master (tooling)</label>
                <select
                  className={cls}
                  value={f.dieMasterId}
                  onChange={(e) => patch('dieMasterId', e.target.value)}
                >
                  <option value=''>None — unlinked tooling</option>
                  {dieMasters.map((d) => (
                    <option key={d.id} value={d.id}>
                      DYE-{d.dyeNumber} · {d.dyeType}
                    </option>
                  ))}
                </select>
                <p className='mt-1 text-[10px] text-ds-ink-faint'>
                  PO and Die Hub use this record for type and L×W×H.
                </p>
              </div>
              <div className='md:col-span-1'>
                <label className='block text-ds-ink-muted mb-1'>Shade card (production kit)</label>
                <select
                  className={cls}
                  value={f.shadeCardId}
                  onChange={(e) => patch('shadeCardId', e.target.value)}
                >
                  <option value=''>None — unlink</option>
                  {shadeCards.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.shadeCode}
                    </option>
                  ))}
                </select>
                <p className='mt-1 text-[10px] text-ds-ink-faint'>
                  Links PO production readiness to Ink Kitchen + approval doc on the shade master.
                </p>
              </div>
              {/* Open Size removed as requested */}
            </div>
          </section>

          <section id='specifications' ref={(el) => { sectionEls.current.specifications = el }} className='scroll-mt-28 rounded-lg border border-ds-line/50 bg-ds-card p-4'>
            <h3 className='text-sm font-semibold text-ds-ink mb-3'>Specifications</h3>
            <div className='grid md:grid-cols-4 gap-3 text-sm'>
              <div>
                <label className='block text-ds-ink-muted mb-1'>Board Grade</label>
                <select className={cls} value={f.boardGrade} onChange={(e) => patch('boardGrade', e.target.value)}>
                  <option value=''>Select grade...</option>
                  {BOARD_GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <div>
                <label className='block text-ds-ink-muted mb-1'>GSM</label>
                <input type='number' inputMode='decimal' onKeyDown={blockInvalidNumericKeys} className={cls} value={f.gsm} onChange={(e) => patch('gsm', e.target.value)} />
              </div>
              <div>
                <label className='block text-ds-ink-muted mb-1'>Printing Type</label>
                <select className={cls} value={f.printingType} onChange={(e) => patch('printingType', e.target.value)}>
                  <option value=''>Select printing...</option>
                  {PRINTING_TYPES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label className='block text-ds-ink-muted mb-1'>Coating Spec</label>
                <select className={cls} value={f.coatingType} onChange={(e) => patch('coatingType', e.target.value)}>
                  <option value=''>Select coating...</option>
                  {COATING_SPECS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className='md:col-span-3 flex flex-wrap items-end gap-4'>
                <label className='inline-flex items-center gap-2 text-ds-ink-muted'>
                  <input type='checkbox' checked={f.embossingEnabled} onChange={(e) => patch('embossingEnabled', e.target.checked)} />
                  Embossing
                </label>
                <label className='inline-flex items-center gap-2 text-ds-ink-muted'>
                  <input type='checkbox' checked={f.leafingEnabled} onChange={(e) => patch('leafingEnabled', e.target.checked)} />
                  Leafing
                </label>
                <label className='inline-flex items-center gap-2 text-ds-ink-muted'>
                  <input type='checkbox' checked={f.spotUvEnabled} onChange={(e) => patch('spotUvEnabled', e.target.checked)} />
                  Spot UV
                </label>
                <label className='inline-flex items-center gap-2 text-ds-ink-muted'>
                  <input type='checkbox' checked={f.brailleEnabled} onChange={(e) => patch('brailleEnabled', e.target.checked)} />
                  Braille
                </label>
              </div>
            </div>
          </section>

          <section id='instructions' ref={(el) => { sectionEls.current.instructions = el }} className='scroll-mt-28 rounded-lg border border-ds-line/50 bg-ds-card p-4'>
            <h3 className='text-sm font-semibold text-ds-ink mb-3'>Instructions</h3>
            <div className='grid md:grid-cols-2 gap-3 text-sm'>
              <div>
                <label className='block text-ds-ink-muted mb-1'>Special Instructions</label>
                <textarea rows={5} className={`${cls} resize-none`} value={f.specialInstructions} onChange={(e) => patch('specialInstructions', toCaps(e.target.value))} />
              </div>
              <div>
                <label className='block text-ds-ink-muted mb-1'>Remarks</label>
                <textarea rows={5} className={`${cls} resize-none`} value={f.remarks} onChange={(e) => patch('remarks', toCaps(e.target.value))} />
              </div>
            </div>
          </section>
        </div>
      </div>
    </form>
  )
}
