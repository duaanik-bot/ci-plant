'use client'

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { DataTable, type TableColumn } from '@/components/shared/DataTable'
import { PageHeader } from '@/components/design-system/PageHeader'
import { KpiTile } from '@/components/design-system/KpiTile'
import { Button } from '@/components/design-system/Button'

type OptionMaterial = {
  id: string
  materialCode: string
  description: string
  unit: string
  category: string
  qtyAvailable: number
  qtyReserved: number
  qtyQuarantine: number
  boardType: string | null
  gsm: number | null
}

type OptionSupplier = {
  id: string
  name: string
  contactName: string | null
  contactPhone: string | null
  gstNumber: string | null
  address: string | null
  paymentTerms: string | null
}

type Options = {
  materials: OptionMaterial[]
  suppliers: OptionSupplier[]
  approvedPrs: Array<{ id: string; materialCode: string; description: string; qtyRequired: number; unit: string; boardType: string | null; gsm: number | null }>
  openPos: Array<{ id: string; poNumber: string; supplierName: string; status: string }>
}

const nf = new Intl.NumberFormat('en-IN')
const money = (n: number) => `₹${nf.format(Math.round(n))}`
const fieldClass =
  'w-full rounded-ds-sm border border-ds-line/60 bg-background px-3 py-2 text-sm text-ds-ink outline-none transition focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/20 disabled:bg-ds-elevated/50 disabled:text-ds-ink-muted'

const jsonCache = new Map<string, unknown>()
const jsonInFlight = new Map<string, Promise<unknown>>()

function statusPill(status: string) {
  const raw = status.replace(/_/g, ' ')
  const tone =
    /approved|received|posted|sent/i.test(status) ? 'bg-[var(--success-bg)] text-[var(--success)]'
    : /reject|cancel|overdue/i.test(status) ? 'bg-[var(--error-bg)] text-[var(--error)]'
    : /draft|pending|partial/i.test(status) ? 'bg-ds-warning/10 text-ds-warning'
    : 'bg-ds-elevated text-ds-ink-muted'
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${tone}`}>{raw}</span>
}

function ProcurementNav() {
  const links = [
    ['/procurement', 'Dashboard'],
    ['/procurement/pr', 'Purchase Requisitions'],
    ['/procurement/po', 'Purchase Orders'],
    ['/procurement/grn', 'GRN'],
    ['/procurement/analytics', 'Analytics'],
    ['/procurement/reports', 'Reports'],
    ['/procurement/suppliers', 'Supplier Analytics'],
    ['/masters/suppliers', 'Suppliers'],
  ] as const
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {links.map(([href, label]) => (
        <Link key={href} href={href} className="rounded-ds-md bg-ds-elevated/55 px-3 py-2 text-sm font-medium text-ds-ink hover:bg-ds-elevated">
          {label}
        </Link>
      ))}
    </div>
  )
}

function ModuleFrame({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <main className="w-full px-4 py-4 text-ds-ink">
      <ProcurementNav />
      <PageHeader title={title} description={description} actions={actions} />
      {children}
    </main>
  )
}

function useJson<T>(url: string) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const cached = jsonCache.get(url) as T | undefined
    if (cached) {
      setData(cached)
      setLoading(false)
      return () => {
        cancelled = true
      }
    }
    const request =
      jsonInFlight.get(url) ??
      fetch(url, { cache: 'no-store' }).then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(j.error || 'Request failed')
        jsonCache.set(url, j)
        return j as T
      })
    jsonInFlight.set(url, request)
    request
      .then((j) => { if (!cancelled) setData(j as T) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Request failed') })
      .finally(() => {
        jsonInFlight.delete(url)
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [url])
  return { data, loading, error }
}

export function ProcurementDashboard() {
  const { data, loading } = useJson<any>('/api/procurement/dashboard')
  const tower = data?.controlTower
  const cards = [
    ['Critical shortages', tower?.cards?.criticalShortages ?? data?.criticalShortagesLinkedToPr ?? 0, 'danger'],
    ['Pending approvals', tower?.cards?.pendingApprovals ?? data?.pendingApprovalPrs ?? 0, 'warning'],
    ['Open POs', tower?.cards?.openPos ?? data?.openPos ?? 0, 'brand'],
    ['Overdue deliveries', tower?.cards?.overdueDeliveries ?? data?.overduePos ?? 0, 'danger'],
    ['GRN pending posting', tower?.cards?.grnPendingPosting ?? data?.pendingGrns ?? 0, 'warning'],
    ['QC rejected receipts', tower?.cards?.qcRejectedReceipts ?? 0, 'danger'],
    ['Supplier follow-ups', tower?.cards?.suppliersRequiringFollowUp ?? 0, 'info'],
    ['Pending payable value', money(tower?.cards?.pendingPayableValue ?? 0), 'neutral'],
  ] as const
  return (
    <ModuleFrame
      title="Procurement Control Tower"
      description="Operational purchasing view across shortages, approvals, POs, GRNs, suppliers, and payable readiness."
      actions={<><Link href="/procurement/pr/new"><Button>New PR</Button></Link><Link href="/procurement/po/new"><Button variant="secondary">New PO</Button></Link></>}
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map(([label, value, tone]) => <KpiTile key={label} label={label} value={loading ? '...' : value} tone={tone as any} raw={typeof value === 'string'} />)}
      </div>
      <div className="mt-5 grid gap-4 xl:grid-cols-3">
        <TowerList title="Critical Shortages" rows={tower?.criticalShortages ?? []} />
        <TowerList title="Pending Approvals" rows={tower?.pendingApprovals ?? []} />
        <TowerList title="Overdue Deliveries" rows={tower?.overdueDeliveries ?? []} />
        <TowerList title="GRN Pending Posting" rows={tower?.grnPendingPosting ?? []} />
        <TowerList title="Supplier Follow-Up" rows={tower?.supplierFollowUps ?? []} />
        <TowerList title="Accounts Payable Prep" rows={tower?.pendingPayables ?? []} moneyKey="amount" />
      </div>
      <div className="mt-6 rounded-ds-md bg-ds-elevated/35 p-4 text-sm text-ds-ink-muted">
        Primary flow: Sales Order → Planning Engine → Material Requirement → PR → PO → GRN → Warehouse Stock → Production Consumption → Accounts Payable.
      </div>
    </ModuleFrame>
  )
}

export function ProcurementAnalytics() {
  const { data, loading } = useJson<any>('/api/procurement/analytics')
  return (
    <ModuleFrame title="Procurement Analytics" description="Lazy-loaded purchasing trends, aging, overdue, and QC insights.">
      {loading ? <div className="rounded-ds-md bg-background p-6 text-sm text-ds-ink-muted">Loading analytics...</div> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <InsightList title="Monthly Purchase Value" rows={data?.monthlyPurchaseValue ?? []} labelKey="month" valueKey="value" moneyValue />
          <InsightList title="Category-wise Purchase Value" rows={data?.categoryWisePurchaseValue ?? []} labelKey="category" valueKey="value" moneyValue />
          <InsightList title="Supplier-wise Purchase Value" rows={data?.supplierWisePurchaseValue ?? []} labelKey="supplier" valueKey="value" moneyValue />
          <InsightList title="Top Purchased Items" rows={data?.topPurchasedItems ?? []} labelKey="item" valueKey="qty" />
          <InsightList title="GRN Posting Trend" rows={data?.grnPostingTrend ?? []} labelKey="month" valueKey="count" />
          <InsightList title="Items With Repeated Rejection" rows={data?.itemsWithRepeatedRejection ?? []} labelKey="item" valueKey="rejectedQty" />
        </div>
      )}
    </ModuleFrame>
  )
}

export function SupplierAnalytics() {
  const { data, loading } = useJson<{ rows: any[] }>('/api/procurement/supplier-analytics')
  const columns: TableColumn<any>[] = [
    { key: 'supplierName', label: 'Supplier', render: (r) => <span className="font-semibold">{r.supplierName}</span> },
    { key: 'supplierScore', label: 'Score', align: 'right', render: (r) => `${r.supplierScore}%` },
    { key: 'totalPurchaseValue', label: 'Total Value', align: 'right', render: (r) => money(r.totalPurchaseValue) },
    { key: 'openPoValue', label: 'Open PO Value', align: 'right', render: (r) => money(r.openPoValue) },
    { key: 'averageDeliveryLeadTime', label: 'Avg Lead', align: 'right', render: (r) => `${r.averageDeliveryLeadTime}d` },
    { key: 'onTimeDeliveryPct', label: 'On-time %', align: 'right', render: (r) => `${r.onTimeDeliveryPct}%` },
    { key: 'qcRejectionPct', label: 'QC Reject %', align: 'right', render: (r) => `${r.qcRejectionPct}%` },
    { key: 'lastPurchaseRate', label: 'Last Rate', align: 'right', render: (r) => r.lastPurchaseRate == null ? '-' : money(r.lastPurchaseRate) },
  ]
  return (
    <ModuleFrame title="Supplier Analytics" description="Supplier performance, purchase value, delivery, quality, and price trend scorecards.">
      <DataTable columns={columns} data={data?.rows ?? []} loading={loading} />
    </ModuleFrame>
  )
}

export function ProcurementReports() {
  const [type, setType] = useState('open-pr')
  const [q, setQ] = useState('')
  const debouncedQ = useDebouncedValue(q)
  const { data, loading } = useJson<{ rows: any[]; total: number }>(`/api/procurement/reports?type=${encodeURIComponent(type)}&q=${encodeURIComponent(debouncedQ)}&limit=50`)
  const columns: TableColumn<any>[] = Object.keys(data?.rows?.[0] ?? { report: '' }).map((key) => ({
    key,
    label: key.replace(/([A-Z])/g, ' $1'),
    render: (r) => typeof r[key] === 'number' && key.toLowerCase().includes('value') ? money(r[key]) : String(r[key] ?? '-'),
  }))
  const reportOptions = [
    'open-pr',
    'approved-pr-pending-po',
    'open-po',
    'overdue-po',
    'pending-grn',
    'supplier-performance',
    'purchase-rate-variation',
    'qc-rejection',
    'monthly-procurement-summary',
    'pending-supplier-invoices',
  ]
  return (
    <ModuleFrame title="Procurement Reports" description="Paginated procurement reports with CSV export.">
      <FilterBar>
        <Select value={type} onChange={setType} options={reportOptions} />
        <Input value={q} onChange={setQ} placeholder="Search report" />
        <a className="inline-flex items-center justify-center rounded-ds-sm border border-ds-line/60 bg-background px-3 py-2 text-sm font-medium" href={`/api/procurement/reports?type=${encodeURIComponent(type)}&q=${encodeURIComponent(debouncedQ)}&export=csv`}>
          Export CSV
        </a>
      </FilterBar>
      <DataTable columns={columns} data={data?.rows ?? []} loading={loading} emptyMessage="No report rows." />
    </ModuleFrame>
  )
}

export function PrList() {
  const router = useRouter()
  const [filters, setFilters] = useState({ q: '', status: '', priority: '', source: '' })
  const debouncedQ = useDebouncedValue(filters.q)
  const url = `/api/procurement/pr?limit=50&q=${encodeURIComponent(debouncedQ)}&status=${encodeURIComponent(filters.status)}&priority=${encodeURIComponent(filters.priority)}&source=${encodeURIComponent(filters.source)}`
  const { data, loading } = useJson<{ rows: any[]; total: number }>(url)
  const columns: TableColumn<any>[] = [
    { key: 'prNo', label: 'PR No', render: (r) => <span className="font-semibold">{r.prNo}</span> },
    { key: 'date', label: 'Date' },
    { key: 'source', label: 'Source' },
    { key: 'items', label: 'Items', render: (r) => <div><p className="font-medium">{r.items}</p><p className="text-xs text-ds-ink-muted">{r.itemDescription}</p></div> },
    { key: 'priority', label: 'Priority' },
    { key: 'requiredDate', label: 'Required Date' },
    { key: 'status', label: 'Status', render: (r) => statusPill(r.status) },
    { key: 'lineStatus', label: 'Line', render: (r) => statusPill(r.lineStatus || 'Open') },
    { key: 'createdBy', label: 'Created By' },
  ]
  return (
    <ModuleFrame title="Purchase Requisitions" description="Draft, approve, and convert procurement requirements." actions={<Link href="/procurement/pr/new"><Button>New PR</Button></Link>}>
      <FilterBar>
        <Input value={filters.q} onChange={(q) => setFilters((f) => ({ ...f, q }))} placeholder="Search item or remark" />
        <Select value={filters.status} onChange={(status) => setFilters((f) => ({ ...f, status }))} options={['', 'draft', 'pending', 'approved', 'rejected', 'converted_to_po']} />
        <Select value={filters.priority} onChange={(priority) => setFilters((f) => ({ ...f, priority }))} options={['', 'Critical', 'High', 'Medium', 'Low']} />
        <Select value={filters.source} onChange={(source) => setFilters((f) => ({ ...f, source }))} options={['', 'Planning', 'Warehouse', 'Manual']} />
      </FilterBar>
      <DataTable columns={columns} data={data?.rows ?? []} loading={loading} onRowClick={(r) => router.push(`/procurement/pr/${r.id}`)} />
    </ModuleFrame>
  )
}

export function PoList() {
  const router = useRouter()
  const [filters, setFilters] = useState({ q: '', status: '', supplier: '', overdueOnly: false })
  const debouncedQ = useDebouncedValue(filters.q)
  const url = `/api/procurement/po?limit=50&q=${encodeURIComponent(debouncedQ)}&status=${encodeURIComponent(filters.status)}&supplier=${encodeURIComponent(filters.supplier)}&overdueOnly=${filters.overdueOnly}`
  const { data, loading } = useJson<{ rows: any[]; total: number }>(url)
  const columns: TableColumn<any>[] = [
    { key: 'poNo', label: 'PO No', render: (r) => <span className="font-semibold">{r.poNo}</span> },
    { key: 'supplier', label: 'Supplier' },
    { key: 'date', label: 'Date' },
    { key: 'expectedDelivery', label: 'Expected Delivery' },
    { key: 'items', label: 'Items', align: 'right' },
    { key: 'value', label: 'Value', align: 'right', render: (r) => money(r.value) },
    { key: 'receivedPct', label: 'Received %', align: 'right', render: (r) => `${Math.round(r.receivedPct)}%` },
    { key: 'status', label: 'Status', render: (r) => statusPill(r.status) },
  ]
  return (
    <ModuleFrame title="Purchase Orders" description="Supplier orders created from approved PRs or manual procurement." actions={<Link href="/procurement/po/new"><Button>New PO</Button></Link>}>
      <FilterBar>
        <Input value={filters.q} onChange={(q) => setFilters((f) => ({ ...f, q }))} placeholder="Search PO or item" />
        <Input value={filters.supplier} onChange={(supplier) => setFilters((f) => ({ ...f, supplier }))} placeholder="Supplier" />
        <Select value={filters.status} onChange={(status) => setFilters((f) => ({ ...f, status }))} options={['', 'draft', 'sent', 'partial_received', 'received', 'closed', 'cancelled']} />
        <label className="flex items-center gap-2 text-sm text-ds-ink-muted"><input type="checkbox" checked={filters.overdueOnly} onChange={(e) => setFilters((f) => ({ ...f, overdueOnly: e.target.checked }))} /> Overdue only</label>
      </FilterBar>
      <DataTable columns={columns} data={data?.rows ?? []} loading={loading} onRowClick={(r) => router.push(`/procurement/po/${r.id}`)} />
    </ModuleFrame>
  )
}

export function GrnList() {
  const router = useRouter()
  const [filters, setFilters] = useState({ q: '', status: '', supplier: '', posted: '' })
  const debouncedQ = useDebouncedValue(filters.q)
  const url = `/api/procurement/grn?limit=50&q=${encodeURIComponent(debouncedQ)}&status=${encodeURIComponent(filters.status)}&supplier=${encodeURIComponent(filters.supplier)}&posted=${filters.posted}`
  const { data, loading } = useJson<{ rows: any[]; total: number }>(url)
  const columns: TableColumn<any>[] = [
    { key: 'grnNo', label: 'GRN No', render: (r) => <span className="font-semibold">{r.grnNo}</span> },
    { key: 'poNo', label: 'PO No' },
    { key: 'supplier', label: 'Supplier' },
    { key: 'receivedDate', label: 'Received Date' },
    { key: 'receivingQty', label: 'Receiving Qty', align: 'right', render: (r) => nf.format(r.receivingQty) },
    { key: 'acceptedQty', label: 'Accepted Qty', align: 'right', render: (r) => nf.format(r.acceptedQty) },
    { key: 'rejectedQty', label: 'Rejected Qty', align: 'right', render: (r) => nf.format(r.rejectedQty) },
    { key: 'status', label: 'Status', render: (r) => statusPill(r.status) },
  ]
  return (
    <ModuleFrame title="GRN" description="Goods receipt notes created from purchase orders." actions={<Link href="/procurement/grn/new"><Button>New GRN</Button></Link>}>
      <FilterBar>
        <Input value={filters.q} onChange={(q) => setFilters((f) => ({ ...f, q }))} placeholder="PO or invoice" />
        <Input value={filters.supplier} onChange={(supplier) => setFilters((f) => ({ ...f, supplier }))} placeholder="Supplier" />
        <Select value={filters.status} onChange={(status) => setFilters((f) => ({ ...f, status }))} options={['', 'DRAFT', 'QC_PENDING', 'QC_ACCEPTED', 'QC_REJECTED', 'PARTIALLY_ACCEPTED', 'POSTED_TO_STOCK', 'CANCELLED']} />
        <Select value={filters.posted} onChange={(posted) => setFilters((f) => ({ ...f, posted }))} options={['', 'true', 'false']} />
      </FilterBar>
      <DataTable columns={columns} data={data?.rows ?? []} loading={loading} onRowClick={(r) => router.push(`/procurement/grn/${r.id}`)} />
    </ModuleFrame>
  )
}

function useDebouncedValue(value: string, delay = 250) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(t)
  }, [value, delay])
  return debounced
}

function useOptions(query = '') {
  const q = query.trim()
  return useJson<Options>(`/api/procurement/options${q ? `?q=${encodeURIComponent(q)}` : ''}`)
}

export function PrForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [optionSearch, setOptionSearch] = useState(searchParams.get('q') || '')
  const debouncedOptionSearch = useDebouncedValue(optionSearch)
  const { data } = useOptions(debouncedOptionSearch)
  const [form, setForm] = useState({ source: 'Manual', requestedBy: '', department: '', requiredDate: '', priority: 'Medium', remarks: '', sourcePlanningId: '', materialId: '', requiredQty: '1' })
  const material = data?.materials.find((m) => m.id === form.materialId)
  useEffect(() => {
    const materialId = searchParams.get('materialId')
    const source = searchParams.get('source')
    const qty = searchParams.get('qty')
    const sourcePlanningId = searchParams.get('sourcePlanningId')
    setForm((prev) => ({
      ...prev,
      ...(materialId ? { materialId } : {}),
      ...(source === 'Planning' || source === 'Warehouse' || source === 'Manual' ? { source } : {}),
      ...(qty ? { requiredQty: qty } : {}),
      ...(sourcePlanningId ? { sourcePlanningId } : {}),
    }))
  }, [searchParams])
  async function submit(e: FormEvent) {
    e.preventDefault()
    const res = await fetch('/api/procurement/pr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, requiredQty: Number(form.requiredQty) }) })
    const out = await res.json().catch(() => ({}))
    if (res.ok) router.push(`/procurement/pr/${out.id}`)
    else alert(out.error || 'Failed to save PR')
  }
  return (
    <ModuleFrame title="New Purchase Requisition" description="Full-page PR form for planning, warehouse, or manual procurement requirements.">
      <form onSubmit={submit} className="space-y-5 rounded-ds-md bg-background p-4 shadow-ds-depth-sm">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Source"><Select value={form.source} onChange={(v) => setForm({ ...form, source: v })} options={['Planning', 'Warehouse', 'Manual']} /></Field>
          <Field label="Requested By"><Input value={form.requestedBy} onChange={(v) => setForm({ ...form, requestedBy: v })} /></Field>
          <Field label="Department"><Input value={form.department} onChange={(v) => setForm({ ...form, department: v })} /></Field>
          <Field label="Required Date"><Input type="date" value={form.requiredDate} onChange={(v) => setForm({ ...form, requiredDate: v })} /></Field>
          <Field label="Priority"><Select value={form.priority} onChange={(v) => setForm({ ...form, priority: v })} options={['Critical', 'High', 'Medium', 'Low']} /></Field>
          <Field label="Item Search"><Input value={optionSearch} onChange={setOptionSearch} /></Field>
          <Field label="Item"><select required value={form.materialId} onChange={(e) => setForm({ ...form, materialId: e.target.value })} className={fieldClass}><option value="">Select item</option>{data?.materials.map((m) => <option key={m.id} value={m.id}>{m.materialCode} - {m.description}</option>)}</select></Field>
          <Field label="Required Qty"><Input type="number" value={form.requiredQty} onChange={(v) => setForm({ ...form, requiredQty: v })} /></Field>
          <Field label="UOM"><Input value={material?.unit ?? ''} onChange={() => {}} disabled /></Field>
        </div>
        {material ? <StockPreview material={material} /> : null}
        <Field label="Remarks"><textarea value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} className={`${fieldClass} min-h-[90px]`} /></Field>
        <div className="flex justify-end gap-2"><Link href="/procurement/pr"><Button variant="secondary">Cancel</Button></Link><Button type="submit">Save Draft PR</Button></div>
      </form>
    </ModuleFrame>
  )
}

export function PoForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [optionSearch, setOptionSearch] = useState('')
  const debouncedOptionSearch = useDebouncedValue(optionSearch)
  const { data } = useOptions(debouncedOptionSearch)
  const [form, setForm] = useState({ supplierId: '', prIds: [] as string[], expectedDeliveryDate: '', paymentTerms: '', deliveryTerms: '', buyer: '', remarks: '', item: '', description: '', quantity: '1', rate: '0', tax: '0' })
  const supplier = data?.suppliers.find((s) => s.id === form.supplierId)
  const selectedPrs = useMemo(() => data?.approvedPrs.filter((p) => form.prIds.includes(p.id)) ?? [], [data?.approvedPrs, form.prIds])
  const pr = selectedPrs[0]
  useEffect(() => {
    if (!pr) return
    const qty = selectedPrs.reduce((s, p) => s + p.qtyRequired, 0)
    setForm((f) => ({ ...f, item: selectedPrs.map((p) => p.materialCode).join(', '), description: selectedPrs.map((p) => p.description).join('; '), quantity: String(qty || pr.qtyRequired) }))
  }, [pr, selectedPrs])
  useEffect(() => {
    const prId = searchParams.get('prId')
    if (prId) setForm((f) => ({ ...f, prIds: [prId] }))
  }, [searchParams])
  async function submit(e: FormEvent) {
    e.preventDefault()
    const payload = { ...form, prIds: form.prIds.length ? form.prIds : undefined, quantity: Number(form.quantity), rate: Number(form.rate), tax: Number(form.tax) }
    const res = await fetch('/api/procurement/po', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    const out = await res.json().catch(() => ({}))
    if (res.ok) router.push(`/procurement/po/${out.id}`)
    else alert(out.error || 'Failed to save PO')
  }
  return (
    <ModuleFrame title="New Purchase Order" description="Full-page supplier order form for approved PR conversion or manual procurement.">
      <form onSubmit={submit} className="space-y-5 rounded-ds-md bg-background p-4 shadow-ds-depth-sm">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Search PR / Supplier"><Input value={optionSearch} onChange={setOptionSearch} /></Field>
          <Field label="Approved PRs"><select multiple value={form.prIds} onChange={(e) => setForm({ ...form, prIds: Array.from(e.target.selectedOptions).map((o) => o.value) })} className={`${fieldClass} min-h-[86px]`}>{data?.approvedPrs.map((p) => <option key={p.id} value={p.id}>{p.materialCode} - {nf.format(p.qtyRequired)} {p.unit}</option>)}</select></Field>
          <Field label="Supplier"><select required value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value, paymentTerms: data?.suppliers.find((s) => s.id === e.target.value)?.paymentTerms ?? form.paymentTerms })} className={fieldClass}><option value="">Select supplier</option>{data?.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Expected Delivery"><Input type="date" value={form.expectedDeliveryDate} onChange={(v) => setForm({ ...form, expectedDeliveryDate: v })} /></Field>
        </div>
        {supplier ? <div className="grid gap-3 rounded-ds-md bg-ds-elevated/35 p-3 text-sm md:grid-cols-3"><p><b>Contact:</b> {supplier.contactName ?? '-'}</p><p><b>GST:</b> {supplier.gstNumber ?? '-'}</p><p><b>Address:</b> {supplier.address ?? '-'}</p></div> : null}
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Payment Terms"><Input value={form.paymentTerms} onChange={(v) => setForm({ ...form, paymentTerms: v })} /></Field>
          <Field label="Delivery Terms"><Input value={form.deliveryTerms} onChange={(v) => setForm({ ...form, deliveryTerms: v })} /></Field>
          <Field label="Buyer"><Input value={form.buyer} onChange={(v) => setForm({ ...form, buyer: v })} /></Field>
        </div>
        <div className="grid gap-3 md:grid-cols-5">
          <Field label="Item"><Input value={form.item} onChange={(v) => setForm({ ...form, item: v })} /></Field>
          <Field label="Description"><Input value={form.description} onChange={(v) => setForm({ ...form, description: v })} /></Field>
          <Field label="Quantity"><Input type="number" value={form.quantity} onChange={(v) => setForm({ ...form, quantity: v })} /></Field>
          <Field label="Rate"><Input type="number" value={form.rate} onChange={(v) => setForm({ ...form, rate: v })} /></Field>
          <Field label="Tax %"><Input type="number" value={form.tax} onChange={(v) => setForm({ ...form, tax: v })} /></Field>
        </div>
        <div className="rounded-ds-md bg-ds-elevated/35 p-3 text-right text-sm font-semibold">Amount: {money(Number(form.quantity || 0) * Number(form.rate || 0))}</div>
        <Field label="Remarks"><textarea value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} className={`${fieldClass} min-h-[90px]`} /></Field>
        <div className="flex justify-end gap-2"><Link href="/procurement/po"><Button variant="secondary">Cancel</Button></Link><Button type="submit">Save Draft PO</Button><Button type="button" variant="secondary" disabled>Mark Sent after save</Button><Button type="button" variant="ghost" disabled>Print after save</Button></div>
      </form>
    </ModuleFrame>
  )
}

export function GrnForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [optionSearch, setOptionSearch] = useState('')
  const debouncedOptionSearch = useDebouncedValue(optionSearch)
  const { data } = useOptions(debouncedOptionSearch)
  const [form, setForm] = useState({ poId: '', supplierInvoiceNumber: '', supplierInvoiceDate: '', vehicleNumber: '', receivedDate: new Date().toISOString().slice(0, 10), receivedBy: '', warehouse: 'Main Warehouse', remarks: '', receivingQty: '1', acceptedQty: '0', rejectedQty: '0', rejectionReason: '', qcRemarks: '', binLocation: '' })
  const po = data?.openPos.find((p) => p.id === form.poId)
  useEffect(() => {
    const poId = searchParams.get('poId')
    if (poId) setForm((f) => ({ ...f, poId }))
  }, [searchParams])
  async function submit(e: FormEvent) {
    e.preventDefault()
    const res = await fetch('/api/procurement/grn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, receivingQty: Number(form.receivingQty), acceptedQty: Number(form.acceptedQty), rejectedQty: Number(form.rejectedQty) }) })
    const out = await res.json().catch(() => ({}))
    if (res.ok) router.push(`/procurement/grn/${out.id}`)
    else alert(out.error || 'Failed to save GRN')
  }
  return (
    <ModuleFrame title="New GRN" description="Create GRN from a purchase order. Draft save does not post stock.">
      <form onSubmit={submit} className="space-y-5 rounded-ds-md bg-background p-4 shadow-ds-depth-sm">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="PO Search"><Input value={optionSearch} onChange={setOptionSearch} /></Field>
          <Field label="PO Number"><select required value={form.poId} onChange={(e) => setForm({ ...form, poId: e.target.value })} className={fieldClass}><option value="">Select PO</option>{data?.openPos.map((p) => <option key={p.id} value={p.id}>{p.poNumber} - {p.supplierName}</option>)}</select></Field>
          <Field label="Supplier"><Input value={po?.supplierName ?? ''} onChange={() => {}} disabled /></Field>
          <Field label="Supplier Invoice Number"><Input value={form.supplierInvoiceNumber} onChange={(v) => setForm({ ...form, supplierInvoiceNumber: v })} /></Field>
          <Field label="Supplier Invoice Date"><Input type="date" value={form.supplierInvoiceDate} onChange={(v) => setForm({ ...form, supplierInvoiceDate: v })} /></Field>
          <Field label="Vehicle Number"><Input required value={form.vehicleNumber} onChange={(v) => setForm({ ...form, vehicleNumber: v })} /></Field>
          <Field label="Received Date"><Input type="date" value={form.receivedDate} onChange={(v) => setForm({ ...form, receivedDate: v })} /></Field>
          <Field label="Received By"><Input value={form.receivedBy} onChange={(v) => setForm({ ...form, receivedBy: v })} /></Field>
          <Field label="Warehouse"><Input value={form.warehouse} onChange={(v) => setForm({ ...form, warehouse: v })} /></Field>
        </div>
        <div className="grid gap-3 md:grid-cols-5">
          <Field label="Receiving Qty"><Input type="number" value={form.receivingQty} onChange={(v) => setForm({ ...form, receivingQty: v })} /></Field>
          <Field label="Accepted Qty"><Input type="number" value={form.acceptedQty} onChange={(v) => setForm({ ...form, acceptedQty: v })} /></Field>
          <Field label="Rejected Qty"><Input type="number" value={form.rejectedQty} onChange={(v) => setForm({ ...form, rejectedQty: v })} /></Field>
          <Field label="QC Status"><Input value="Draft" onChange={() => {}} disabled /></Field>
          <Field label="Bin/Rack Location"><Input value={form.binLocation} onChange={(v) => setForm({ ...form, binLocation: v })} /></Field>
          <Field label="Rejection Reason"><Input value={form.rejectionReason} onChange={(v) => setForm({ ...form, rejectionReason: v })} /></Field>
        </div>
        <Field label="QC Remarks"><textarea value={form.qcRemarks} onChange={(e) => setForm({ ...form, qcRemarks: e.target.value })} className={`${fieldClass} min-h-[70px]`} /></Field>
        <Field label="Remarks"><textarea value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} className={`${fieldClass} min-h-[90px]`} /></Field>
        <div className="flex justify-end gap-2"><Link href="/procurement/grn"><Button variant="secondary">Cancel</Button></Link><Button type="submit">Save Draft GRN</Button></div>
      </form>
    </ModuleFrame>
  )
}

export function DetailPage({ kind, id }: { kind: 'pr' | 'po' | 'grn'; id: string }) {
  const router = useRouter()
  const { data, loading } = useJson<any>(`/api/procurement/${kind}/${id}`)
  async function patch(body: Record<string, unknown>) {
    const res = await fetch(`/api/procurement/${kind}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const out = await res.json().catch(() => ({}))
    if (!res.ok) alert(out.error || 'Action failed')
    else window.location.reload()
  }
  const title = kind === 'pr' ? data?.prNo ?? 'Purchase Requisition' : kind === 'po' ? data?.poNo ?? 'Purchase Order' : data?.grnNo ?? 'GRN'
  return (
    <ModuleFrame
      title={loading ? 'Loading...' : title}
      description={kind === 'pr' ? 'Header, source reference, line items, and status timeline.' : kind === 'po' ? 'Supplier order with line items, totals, and receipt progress.' : 'Receipt details, QC quantities, and stock posting.'}
      actions={<DetailActions kind={kind} data={data} onPatch={patch} />}
    >
      {!data ? <div className="rounded-ds-md bg-background p-6 text-sm text-ds-ink-muted">Loading...</div> : <DetailBody kind={kind} data={data} />}
    </ModuleFrame>
  )
}

function DetailActions({ kind, data, onPatch }: { kind: 'pr' | 'po' | 'grn'; data: any; onPatch: (body: Record<string, unknown>) => void }) {
  if (!data) return null
  if (kind === 'pr') {
    return <><a href={`/api/procurement/pr/${data.id}/pdf`} target="_blank" rel="noreferrer"><Button variant="secondary">Print PR</Button></a><Button variant="secondary" disabled={data.status !== 'draft'} onClick={() => onPatch({ action: 'submit' })}>Submit</Button><Button variant="success" disabled={data.status !== 'pending'} onClick={() => onPatch({ action: 'approve' })}>Approve</Button><Button variant="danger" disabled={!['pending', 'approved'].includes(data.status)} onClick={() => { const reason = window.prompt('Reject reason'); if (reason) onPatch({ action: 'reject', rejectionReason: reason }) }}>Reject</Button>{data.status === 'approved' ? <Link href={`/procurement/po/new?prId=${data.id}`}><Button>Convert To PO</Button></Link> : null}</>
  }
  if (kind === 'po') {
    return <><Button variant="secondary" disabled={data.status !== 'draft'} onClick={() => onPatch({ action: 'mark_sent' })}>Mark Sent</Button><Link href={`/procurement/grn/new?poId=${data.id}`}><Button>Create GRN</Button></Link><a href={`/api/procurement/po/${data.id}/pdf`} target="_blank" rel="noreferrer"><Button variant="secondary">Print PO</Button></a><Button variant="secondary" onClick={async () => { const res = await fetch(`/api/procurement/po/${data.id}/message`); const msg = await res.json().catch(() => ({})); if (msg.message) await navigator.clipboard?.writeText(msg.message) }}>Copy Supplier Message</Button><Button variant="secondary" onClick={() => { void fetch(`/api/procurement/po/${data.id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'Confirmed from detail action' }) }).then(() => window.location.reload()) }}>Confirm Supplier</Button><Button variant="warning" onClick={() => { const reason = window.prompt('Close reason') || 'Closed from Procurement'; onPatch({ action: 'close', reason }) }}>Close</Button><Button variant="danger" onClick={() => { const reason = window.prompt('Cancel reason'); if (reason) onPatch({ action: 'cancel', reason }) }}>Cancel</Button></>
  }
  return <><a href={`/api/procurement/grn/${data.id}/pdf`} target="_blank" rel="noreferrer"><Button variant="secondary">Print GRN</Button></a><Button variant="secondary" disabled={data.status === 'POSTED_TO_STOCK'} onClick={() => onPatch({ action: 'qc_update' })}>Save QC</Button><Button variant="success" disabled={data.status === 'POSTED_TO_STOCK'} onClick={() => onPatch({ action: 'post_to_stock' })}>Post To Stock</Button><Button variant="danger" disabled={data.status === 'POSTED_TO_STOCK'} onClick={() => { const reason = window.prompt('Cancel reason') || 'Cancelled'; onPatch({ action: 'cancel', remarks: reason }) }}>Cancel GRN</Button></>
}

function DetailBody({ kind, data }: { kind: 'pr' | 'po' | 'grn'; data: any }) {
  const lines = data.lineItems ?? []
  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-ds-md bg-background p-4 text-sm shadow-ds-depth-sm md:grid-cols-4">
        {Object.entries(kind === 'pr'
          ? { Status: statusPill(data.status), Source: data.source, Priority: data.priority, 'Required Date': data.requiredDate ?? '-', 'Requested By': data.requestedBy, Shortage: data.sourceReference?.shortageId ?? '-', Remarks: data.remarks ?? '-' }
          : kind === 'po'
            ? { Status: statusPill(data.status), Supplier: data.supplier?.name, Date: data.date, 'Expected Delivery': data.expectedDelivery ?? '-', Buyer: data.buyer, Value: money(data.value ?? 0), Received: `${nf.format(data.receivedKg ?? 0)} / ${nf.format(data.orderedKg ?? 0)} kg` }
            : { Status: statusPill(data.status), PO: data.poNo, Supplier: data.supplier?.name, Vehicle: data.vehicleNumber, 'Received Date': data.receivedDate, 'Received By': data.receivedBy, Posted: data.postedAt ? new Date(data.postedAt).toLocaleString() : '-' }
        ).map(([k, v]) => <div key={k}><p className="text-xs uppercase tracking-wider text-ds-ink-faint">{k}</p><div className="mt-1 font-medium text-ds-ink">{v as any}</div></div>)}
      </div>
      <DataTable columns={lineColumns(kind)} data={lines.map((l: any, i: number) => ({ id: i, ...l }))} emptyMessage="No line items." />
      {kind === 'pr' ? <div className="rounded-ds-md bg-background p-4 shadow-ds-depth-sm"><h3 className="text-sm font-semibold">Approval / Status Timeline</h3><div className="mt-2 space-y-2 text-sm text-ds-ink-muted">{(data.timeline ?? []).map((t: any, i: number) => <p key={i}>{t.label} · {t.by} · {t.at ? new Date(t.at).toLocaleString() : '-'}</p>)}</div></div> : null}
    </div>
  )
}

function lineColumns(kind: 'pr' | 'po' | 'grn'): TableColumn<any>[] {
  if (kind === 'pr') return [
    { key: 'item', label: 'Item' }, { key: 'itemCategory', label: 'Category' }, { key: 'currentStock', label: 'Current', align: 'right' }, { key: 'reservedStock', label: 'Reserved', align: 'right' }, { key: 'availableStock', label: 'Available', align: 'right' }, { key: 'requiredQty', label: 'Required', align: 'right' }, { key: 'balanceQty', label: 'Balance', align: 'right' }, { key: 'lineStatus', label: 'Line Status', render: (r) => statusPill(r.lineStatus) }, { key: 'uom', label: 'UOM' },
  ]
  if (kind === 'po') return [
    { key: 'item', label: 'Item' }, { key: 'description', label: 'Description' }, { key: 'quantity', label: 'Ordered', align: 'right' }, { key: 'receivedQty', label: 'Received', align: 'right', render: (r) => nf.format(r.receivedQty ?? 0) }, { key: 'balanceQty', label: 'Balance', align: 'right', render: (r) => nf.format(r.balanceQty ?? 0) }, { key: 'receivingPct', label: 'Receiving %', align: 'right', render: (r) => `${Math.round(r.receivingPct ?? 0)}%` }, { key: 'rate', label: 'Rate', align: 'right', render: (r) => money(r.rate) }, { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) },
  ]
  return [
    { key: 'item', label: 'Item' }, { key: 'orderedQty', label: 'Ordered', align: 'right' }, { key: 'previouslyReceivedQty', label: 'Prev Received', align: 'right' }, { key: 'balanceQty', label: 'Balance', align: 'right' }, { key: 'receivingQty', label: 'Receiving', align: 'right' }, { key: 'acceptedQty', label: 'Accepted', align: 'right' }, { key: 'rejectedQty', label: 'Rejected', align: 'right' }, { key: 'qcStatus', label: 'QC Status', render: (r) => statusPill(r.qcStatus) },
  ]
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block text-xs font-semibold uppercase tracking-wider text-ds-ink-faint"><span>{label}</span><div className="mt-1">{children}</div></label>
}

function FilterBar({ children }: { children: ReactNode }) {
  return <div className="mb-3 grid gap-2 rounded-ds-md bg-background p-3 shadow-ds-depth-sm md:grid-cols-4">{children}</div>
}

function Input({ value, onChange, type = 'text', disabled, required, placeholder }: { value: string; onChange: (value: string) => void; type?: string; disabled?: boolean; required?: boolean; placeholder?: string }) {
  return <input required={required} disabled={disabled} type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={fieldClass} />
}

function Select({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: string[] }) {
  return <select value={value} onChange={(e) => onChange(e.target.value)} className={fieldClass}>{options.map((o) => <option key={o} value={o}>{o}</option>)}</select>
}

function StockPreview({ material }: { material: OptionMaterial }) {
  return (
    <div className="grid gap-3 rounded-ds-md bg-ds-elevated/35 p-3 text-sm md:grid-cols-4">
      <p><b>Current:</b> {nf.format(material.qtyAvailable + material.qtyReserved)}</p>
      <p><b>Reserved:</b> {nf.format(material.qtyReserved)}</p>
      <p><b>Available:</b> {nf.format(material.qtyAvailable)}</p>
      <p><b>Category:</b> {material.category}</p>
    </div>
  )
}

function TowerList({ title, rows, moneyKey }: { title: string; rows: any[]; moneyKey?: string }) {
  return (
    <section className="rounded-ds-md bg-background p-4 shadow-ds-depth-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-ds-ink">{title}</h3>
        <span className="text-xs font-semibold text-ds-ink-muted">{rows.length}</span>
      </div>
      <div className="space-y-2">
        {rows.length === 0 ? (
          <p className="text-sm text-ds-ink-muted">No active items.</p>
        ) : rows.map((row) => (
          <Link
            key={`${title}-${row.id}`}
            href={row.href ?? '/procurement'}
            className="block rounded-ds-sm border border-ds-line/50 bg-ds-elevated/25 px-3 py-2 text-sm transition hover:bg-ds-elevated/55"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="truncate font-semibold text-ds-ink">{row.label ?? row.material ?? row.poNumber}</span>
              <span className="shrink-0 text-xs font-semibold text-[var(--brand-primary)]">{row.action ?? 'Open'}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ds-ink-muted">
              {row.material ? <span>{row.material}</span> : null}
              {row.supplier ? <span>{row.supplier}</span> : null}
              {row.poNumber ? <span>{row.poNumber}</span> : null}
              {row.expectedDelivery ? <span>ETA {row.expectedDelivery}</span> : null}
              {moneyKey && row[moneyKey] != null ? <span>{money(Number(row[moneyKey] || 0))}</span> : null}
              {row.status ? <span>{String(row.status).replace(/_/g, ' ')}</span> : null}
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}

function InsightList({ title, rows, labelKey, valueKey, moneyValue }: { title: string; rows: any[]; labelKey: string; valueKey: string; moneyValue?: boolean }) {
  return (
    <div className="rounded-ds-md bg-background p-4 shadow-ds-depth-sm">
      <h3 className="text-sm font-semibold text-ds-ink">{title}</h3>
      <div className="mt-3 space-y-2">
        {rows.length === 0 ? <p className="text-sm text-ds-ink-muted">No data.</p> : rows.map((row, i) => (
          <div key={`${row[labelKey]}-${i}`} className="flex items-center justify-between gap-3 border-b border-ds-line/30 pb-2 text-sm last:border-b-0">
            <span className="truncate text-ds-ink-muted">{row[labelKey]}</span>
            <span className="font-semibold tabular-nums">{moneyValue ? money(Number(row[valueKey] || 0)) : nf.format(Number(row[valueKey] || 0))}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
