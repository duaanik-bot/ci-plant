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
  openPos: Array<{
    id: string
    poNumber: string
    supplierName: string
    status: string
    lines?: Array<{ id: string; boardGrade: string | null; gsm: number | null; totalSheets: number | null; totalWeightKg: number; ratePerKg: number | null }>
  }>
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const debouncedQ = useDebouncedValue(filters.q)
  const url = `/api/procurement/pr?limit=50&q=${encodeURIComponent(debouncedQ)}&status=${encodeURIComponent(filters.status)}&priority=${encodeURIComponent(filters.priority)}&source=${encodeURIComponent(filters.source)}`
  const { data, loading } = useJson<{ rows: any[]; total: number }>(url)
  const rows = data?.rows ?? []
  const visibleIds = rows.map((row) => String(row.id))
  const selectedRows = rows.filter((row) => selectedIds.has(String(row.id)))
  const eligibleSelectedRows = selectedRows.filter((row) => canCreatePoFromPr(row))
  const selectedPrIdsParam = eligibleSelectedRows.map((row) => String(row.id)).join(',')
  const groupedSelections = useMemo(() => {
    const groups = new Map<string, { code: string; description: string; qty: number; unit: string; ids: string[]; sources: Set<string>; priority: string }>()
    for (const row of eligibleSelectedRows) {
      const code = String(row.items || row.materialCode || 'Manual item')
      const current = groups.get(code) ?? {
        code,
        description: row.itemDescription || row.description || '-',
        qty: 0,
        unit: row.uom || row.unit || 'unit',
        ids: [],
        sources: new Set<string>(),
        priority: row.priority || '-',
      }
      current.qty += Number(row.qtyRequired ?? row.requiredQty ?? row.quantity ?? 0)
      current.ids.push(String(row.id))
      if (row.source) current.sources.add(String(row.source))
      if (/critical|high/i.test(String(row.priority))) current.priority = String(row.priority)
      groups.set(code, current)
    }
    return Array.from(groups.values())
  }, [eligibleSelectedRows])
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))
  function toggleSelected(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }
  function toggleAllVisible(checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const id of visibleIds) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }
  const columns: TableColumn<any>[] = [
    {
      key: 'select',
      label: () => (
        <input
          type="checkbox"
          checked={allVisibleSelected}
          aria-label="Select all visible PRs"
          onChange={(e) => toggleAllVisible(e.target.checked)}
          className="h-3.5 w-3.5"
        />
      ),
      render: (r) => (
        <input
          type="checkbox"
          checked={selectedIds.has(String(r.id))}
          aria-label={`Select PR ${r.prNo}`}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => toggleSelected(String(r.id), e.target.checked)}
          className="h-3.5 w-3.5"
        />
      ),
      className: 'w-10',
    },
    { key: 'prNo', label: 'PR No', render: (r) => <span className="font-semibold">{r.prNo}</span> },
    { key: 'date', label: 'Date' },
    { key: 'source', label: 'Source' },
    { key: 'items', label: 'Items', render: (r) => <div><p className="font-medium">{r.items}</p><p className="text-xs text-ds-ink-muted">{r.itemDescription}</p></div> },
    { key: 'qtyRequired', label: 'Required', align: 'right', render: (r) => `${nf.format(Number(r.qtyRequired ?? r.requiredQty ?? 0))} ${r.uom || r.unit || ''}` },
    { key: 'priority', label: 'Priority' },
    { key: 'requiredDate', label: 'Required Date' },
    { key: 'status', label: 'Status', render: (r) => statusPill(r.status) },
    { key: 'lineStatus', label: 'Line', render: (r) => statusPill(r.lineStatus || 'Open') },
    { key: 'createdBy', label: 'Created By' },
    {
      key: 'decision',
      label: 'Decision',
      render: (r) => canCreatePoFromPr(r) ? (
        <Link
          href={`/procurement/po/new?prIds=${encodeURIComponent(String(r.id))}`}
          onClick={(e) => e.stopPropagation()}
        >
          <Button type="button" variant="secondary">Create PO</Button>
        </Link>
      ) : (
        <span className="text-xs text-ds-ink-faint">Approve first</span>
      ),
    },
  ]
  return (
    <ModuleFrame title="Purchase Requisitions" description="Draft, approve, and convert procurement requirements." actions={<Link href="/procurement/pr/new"><Button>New PR</Button></Link>}>
      <FilterBar>
        <Input value={filters.q} onChange={(q) => setFilters((f) => ({ ...f, q }))} placeholder="Search item or remark" />
        <Select value={filters.status} onChange={(status) => setFilters((f) => ({ ...f, status }))} options={['', 'draft', 'pending', 'approved', 'rejected', 'converted_to_po']} />
        <Select value={filters.priority} onChange={(priority) => setFilters((f) => ({ ...f, priority }))} options={['', 'Critical', 'High', 'Medium', 'Low']} />
        <Select value={filters.source} onChange={(source) => setFilters((f) => ({ ...f, source }))} options={['', 'Planning', 'Warehouse', 'Manual']} />
      </FilterBar>
      {selectedRows.length ? (
        <section className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-ds-md border border-ds-line/60 bg-background p-3 shadow-ds-depth-sm">
          <div>
            <h3 className="text-sm font-semibold text-ds-ink">{selectedRows.length} PR selected</h3>
            <p className="text-xs text-ds-ink-muted">
              {eligibleSelectedRows.length} approved and open PR{eligibleSelectedRows.length === 1 ? '' : 's'} ready for PO creation.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {eligibleSelectedRows.length ? (
              <>
                <Link href={`/procurement/po/new?prIds=${encodeURIComponent(selectedPrIdsParam)}`}>
                  <Button type="button">Push Selected To PO</Button>
                </Link>
                <Link href={`/procurement/po/new?prIds=${encodeURIComponent(selectedPrIdsParam)}`}>
                  <Button type="button" variant="secondary">Create PO From Selection</Button>
                </Link>
              </>
            ) : (
              <span className="text-xs text-ds-ink-faint">Select approved/open PRs to create PO.</span>
            )}
            <Button type="button" variant="secondary" onClick={() => setSelectedIds(new Set())}>Clear Selection</Button>
          </div>
        </section>
      ) : null}
      {groupedSelections.length ? (
        <section className="mb-3 rounded-ds-md border border-ds-line/60 bg-background p-3 shadow-ds-depth-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ds-ink">Selected PRs grouped for purchase order</h3>
              <p className="text-xs text-ds-ink-muted">Same material codes are accumulated before you decide which row to push to PO.</p>
            </div>
            <Link href={`/procurement/po/new?prIds=${encodeURIComponent(selectedPrIdsParam)}`}>
              <Button type="button" variant="secondary">Create One PO For All</Button>
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-ds-elevated/45 text-xs uppercase tracking-wider text-ds-ink-faint">
                <tr>
                  {['Code', 'Description', 'Total Qty', 'Source', 'Priority', 'Decision'].map((h) => <th key={h} className="px-3 py-2 text-left font-semibold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {groupedSelections.map((group) => (
                  <tr key={group.code} className="border-t border-ds-line/50">
                    <td className="px-3 py-2 font-semibold">{group.code}</td>
                    <td className="px-3 py-2 text-ds-ink-muted">{group.description}</td>
                    <td className="px-3 py-2 font-semibold tabular-nums">{nf.format(group.qty)} {group.unit}</td>
                    <td className="px-3 py-2">{Array.from(group.sources).join(', ') || '-'}</td>
                    <td className="px-3 py-2">{group.priority}</td>
                    <td className="px-3 py-2">
                      <Link href={`/procurement/po/new?prIds=${encodeURIComponent(group.ids.join(','))}`}>
                        <Button type="button">Create PO</Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <DataTable columns={columns} data={rows} loading={loading} onRowClick={(r) => router.push(`/procurement/pr/${r.id}`)} />
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

function canCreatePoFromPr(row: any): boolean {
  const status = String(row?.status ?? '').toLowerCase()
  const lineStatus = String(row?.lineStatus ?? '').toLowerCase()
  return status === 'approved' && !/converted|cancelled|rejected/.test(lineStatus)
}

function useOptions(query = '', materialId = '') {
  const q = query.trim()
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (materialId) params.set('materialId', materialId)
  const suffix = params.toString()
  return useJson<Options>(`/api/procurement/options${suffix ? `?${suffix}` : ''}`)
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
  const [optionSearch, setOptionSearch] = useState(searchParams.get('q') || '')
  const materialIdParam = searchParams.get('materialId') || ''
  const debouncedOptionSearch = useDebouncedValue(optionSearch)
  const { data } = useOptions(debouncedOptionSearch, materialIdParam)
  const [form, setForm] = useState({ supplierId: '', prIds: [] as string[], materialId: '', expectedDeliveryDate: '', paymentTerms: '', deliveryTerms: '', buyer: '', remarks: '', item: '', description: '', quantity: '1', rate: '0', tax: '0' })
  const supplier = data?.suppliers.find((s) => s.id === form.supplierId)
  const selectedPrs = useMemo(() => data?.approvedPrs.filter((p) => form.prIds.includes(p.id)) ?? [], [data?.approvedPrs, form.prIds])
  const selectedMaterial = data?.materials.find((m) => m.id === form.materialId)
  const pr = selectedPrs[0]
  useEffect(() => {
    if (!pr) return
    const qty = selectedPrs.reduce((s, p) => s + p.qtyRequired, 0)
    setForm((f) => ({ ...f, materialId: '', item: selectedPrs.map((p) => p.materialCode).join(', '), description: selectedPrs.map((p) => p.description).join('; '), quantity: String(qty || pr.qtyRequired) }))
  }, [pr, selectedPrs])
  useEffect(() => {
    const prId = searchParams.get('prId')
    const prIds = searchParams.get('prIds')
    const materialId = searchParams.get('materialId')
    const qty = searchParams.get('qty')
    if (prIds) {
      const ids = prIds.split(',').map((id) => id.trim()).filter(Boolean)
      setForm((f) => ({ ...f, prIds: Array.from(new Set(ids)) }))
      return
    }
    if (prId) {
      setForm((f) => ({ ...f, prIds: [prId] }))
      return
    }
    if (materialId || qty) {
      setForm((f) => ({
        ...f,
        ...(materialId ? { materialId } : {}),
        ...(qty ? { quantity: qty } : {}),
      }))
    }
  }, [searchParams])
  useEffect(() => {
    if (!selectedMaterial || selectedPrs.length) return
    setForm((f) => ({
      ...f,
      item: selectedMaterial.materialCode,
      description: selectedMaterial.description,
    }))
  }, [selectedMaterial, selectedPrs.length])
  async function submit(e: FormEvent) {
    e.preventDefault()
    const payload = { ...form, prIds: form.prIds.length ? form.prIds : undefined, uom: selectedMaterial?.unit, quantity: Number(form.quantity), rate: Number(form.rate), tax: Number(form.tax) }
    const res = await fetch('/api/procurement/po', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    const out = await res.json().catch(() => ({}))
    if (res.ok) router.push(`/procurement/po/${out.id}`)
    else alert(out.error || 'Failed to save PO')
  }
  const qty = Number(form.quantity || 0)
  const rate = Number(form.rate || 0)
  const tax = Number(form.tax || 0)
  const taxable = qty * rate
  const taxAmount = taxable * (tax / 100)
  const gross = taxable + taxAmount
  return (
    <ModuleFrame title="New Purchase Order" description="Supplier-facing order form aligned with the Sales Order entry layout.">
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-ds-md border border-ds-line/60 bg-background p-4 shadow-ds-depth-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--brand-primary)]">Purchase Order</p>
              <h2 className="mt-1 text-xl font-semibold text-ds-ink">Supplier Order Draft</h2>
              <p className="mt-1 text-sm text-ds-ink-muted">Convert approved PRs or create a direct material purchase order.</p>
            </div>
            <div className="grid min-w-[22rem] grid-cols-3 overflow-hidden rounded-ds-md border border-ds-line/60 text-sm">
              <div className="bg-ds-elevated/35 p-3">
                <p className="text-[10px] uppercase tracking-wider text-ds-ink-faint">Taxable</p>
                <p className="mt-1 font-semibold tabular-nums">{money(taxable)}</p>
              </div>
              <div className="border-x border-ds-line/60 bg-ds-elevated/20 p-3">
                <p className="text-[10px] uppercase tracking-wider text-ds-ink-faint">Tax</p>
                <p className="mt-1 font-semibold tabular-nums">{money(taxAmount)}</p>
              </div>
              <div className="bg-[var(--brand-primary)]/10 p-3">
                <p className="text-[10px] uppercase tracking-wider text-[var(--brand-primary)]">Total</p>
                <p className="mt-1 font-semibold tabular-nums text-[var(--brand-primary)]">{money(gross)}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
          <FormCard title="Supplier & Source">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Search PR / Supplier / Item"><Input value={optionSearch} onChange={setOptionSearch} placeholder="Search approved PR, supplier, or material" /></Field>
              <Field label="Supplier"><select required value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value, paymentTerms: data?.suppliers.find((s) => s.id === e.target.value)?.paymentTerms ?? form.paymentTerms })} className={fieldClass}><option value="">Select supplier</option>{data?.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
              <Field label="Approved PRs"><select multiple value={form.prIds} onChange={(e) => setForm({ ...form, prIds: Array.from(e.target.selectedOptions).map((o) => o.value) })} className={`${fieldClass} min-h-[104px] md:col-span-2`}>{data?.approvedPrs.map((p) => <option key={p.id} value={p.id}>{p.materialCode} - {nf.format(p.qtyRequired)} {p.unit}</option>)}</select></Field>
              <Field label="Direct Item"><select value={form.materialId} onChange={(e) => setForm({ ...form, materialId: e.target.value, prIds: [] })} className={`${fieldClass} md:col-span-2`}><option value="">Select item for direct PO</option>{data?.materials.map((m) => <option key={m.id} value={m.id}>{m.materialCode} - {m.description}</option>)}</select></Field>
            </div>
          </FormCard>

          <FormCard title="Supplier Snapshot">
            {supplier ? (
              <div className="space-y-3 text-sm">
                <InfoLine label="Contact" value={supplier.contactName ?? '-'} />
                <InfoLine label="Phone" value={supplier.contactPhone ?? '-'} />
                <InfoLine label="GST" value={supplier.gstNumber ?? '-'} />
                <InfoLine label="Address" value={supplier.address ?? '-'} />
              </div>
            ) : (
              <p className="text-sm text-ds-ink-muted">Select supplier to preview GST, contact, address, and terms.</p>
            )}
          </FormCard>
        </div>

        {selectedMaterial && !selectedPrs.length ? <StockPreview material={selectedMaterial} /> : null}

        <FormCard title="Commercial Terms">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Expected Delivery"><Input type="date" value={form.expectedDeliveryDate} onChange={(v) => setForm({ ...form, expectedDeliveryDate: v })} /></Field>
            <Field label="Payment Terms"><Input value={form.paymentTerms} onChange={(v) => setForm({ ...form, paymentTerms: v })} /></Field>
            <Field label="Delivery Terms"><Input value={form.deliveryTerms} onChange={(v) => setForm({ ...form, deliveryTerms: v })} /></Field>
            <Field label="Buyer"><Input value={form.buyer} onChange={(v) => setForm({ ...form, buyer: v })} /></Field>
          </div>
        </FormCard>

        <FormCard title="Line Items">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead className="bg-ds-elevated/45 text-xs uppercase tracking-wider text-ds-ink-faint">
                <tr>
                  {['Item', 'Description', 'Qty', 'Rate', 'Tax %', 'Taxable', 'Total'].map((h) => <th key={h} className="px-2 py-2 text-left font-semibold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-ds-line/50 align-top">
                  <td className="px-2 py-2"><Input value={form.item} onChange={(v) => setForm({ ...form, item: v })} /></td>
                  <td className="px-2 py-2"><Input value={form.description} onChange={(v) => setForm({ ...form, description: v })} /></td>
                  <td className="px-2 py-2"><Input type="number" value={form.quantity} onChange={(v) => setForm({ ...form, quantity: v })} /></td>
                  <td className="px-2 py-2"><Input type="number" value={form.rate} onChange={(v) => setForm({ ...form, rate: v })} /></td>
                  <td className="px-2 py-2"><Input type="number" value={form.tax} onChange={(v) => setForm({ ...form, tax: v })} /></td>
                  <td className="px-2 py-3 font-semibold tabular-nums">{money(taxable)}</td>
                  <td className="px-2 py-3 font-semibold tabular-nums text-[var(--brand-primary)]">{money(gross)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </FormCard>

        <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
          <FormCard title="Remarks">
            <textarea value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} className={`${fieldClass} min-h-[100px]`} placeholder="Supplier instructions, dispatch notes, price reference, or buyer remarks" />
          </FormCard>
          <FormCard title="Order Summary">
            <div className="space-y-2 text-sm">
              <InfoLine label="Selected PRs" value={String(form.prIds.length)} />
              <InfoLine label="Quantity" value={nf.format(qty)} />
              <InfoLine label="Taxable" value={money(taxable)} />
              <InfoLine label="Tax" value={money(taxAmount)} />
              <div className="mt-3 rounded-ds-sm bg-[var(--brand-primary)]/10 p-3 text-right">
                <p className="text-xs uppercase tracking-wider text-[var(--brand-primary)]">Payable Total</p>
                <p className="mt-1 text-lg font-semibold text-[var(--brand-primary)]">{money(gross)}</p>
              </div>
            </div>
          </FormCard>
        </div>

        <div className="sticky bottom-3 z-20 flex flex-wrap justify-end gap-2 rounded-ds-md border border-ds-line/60 bg-background/95 p-3 shadow-ds-depth-sm backdrop-blur">
          <Link href="/procurement/po"><Button variant="secondary">Cancel</Button></Link>
          <Button type="submit">Save Draft PO</Button>
          <Button type="button" variant="secondary" disabled>Mark Sent after save</Button>
          <Button type="button" variant="ghost" disabled>Print after save</Button>
        </div>
      </form>
    </ModuleFrame>
  )
}

type GrnLineDraft = {
  id: string
  item: string
  description: string
  orderedQty: string
  balanceQty: string
  receivingQty: string
  acceptedQty: string
  rejectedQty: string
  rate: string
  tax: string
  binLocation: string
  rejectionReason: string
}

function blankGrnLine(id = 'manual-1'): GrnLineDraft {
  return {
    id,
    item: '',
    description: '',
    orderedQty: '0',
    balanceQty: '0',
    receivingQty: '0',
    acceptedQty: '0',
    rejectedQty: '0',
    rate: '0',
    tax: '0',
    binLocation: '',
    rejectionReason: '',
  }
}

function lineFromPoLine(line: NonNullable<Options['openPos'][number]['lines']>[number], index: number): GrnLineDraft {
  const boardGrade = line.boardGrade || 'Material'
  const item = [boardGrade, line.gsm ? `${line.gsm} gsm` : null].filter(Boolean).join(' · ')
  const orderedQty = Number(line.totalWeightKg || line.totalSheets || 0)
  return {
    id: line.id || `po-line-${index}`,
    item,
    description: [boardGrade, line.totalSheets ? `${nf.format(Number(line.totalSheets))} sheets` : null].filter(Boolean).join(' · '),
    orderedQty: String(orderedQty),
    balanceQty: String(orderedQty),
    receivingQty: String(orderedQty),
    acceptedQty: String(orderedQty),
    rejectedQty: '0',
    rate: String(Number(line.ratePerKg || 0)),
    tax: '0',
    binLocation: '',
    rejectionReason: '',
  }
}

export function GrnForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [optionSearch, setOptionSearch] = useState('')
  const debouncedOptionSearch = useDebouncedValue(optionSearch)
  const { data } = useOptions(debouncedOptionSearch)
  const [form, setForm] = useState({ poId: '', supplierInvoiceNumber: '', supplierInvoiceDate: '', vehicleNumber: '', receivedDate: new Date().toISOString().slice(0, 10), receivedBy: '', warehouse: 'Main Warehouse', remarks: '', receivingQty: '1', acceptedQty: '0', rejectedQty: '0', rejectionReason: '', qcRemarks: '', binLocation: '' })
  const [lineDrafts, setLineDrafts] = useState<GrnLineDraft[]>([blankGrnLine()])
  const po = data?.openPos.find((p) => p.id === form.poId)
  useEffect(() => {
    const poId = searchParams.get('poId')
    if (poId) setForm((f) => ({ ...f, poId }))
  }, [searchParams])
  useEffect(() => {
    if (!po?.id) return
    if (po.lines?.length) {
      setLineDrafts(po.lines.map((line, index) => lineFromPoLine(line, index)))
    }
  }, [po?.id])
  const lineTotals = useMemo(() => lineDrafts.map((line) => {
    const receivingQty = Number(line.receivingQty || 0)
    const acceptedQty = Number(line.acceptedQty || 0)
    const rejectedQty = Number(line.rejectedQty || 0)
    const rate = Number(line.rate || 0)
    const tax = Number(line.tax || 0)
    const taxable = receivingQty * rate
    const taxAmount = taxable * tax / 100
    return { receivingQty, acceptedQty, rejectedQty, rate, tax, taxable, taxAmount, total: taxable + taxAmount }
  }), [lineDrafts])
  const receiving = lineTotals.reduce((s, row) => s + row.receivingQty, 0)
  const accepted = lineTotals.reduce((s, row) => s + row.acceptedQty, 0)
  const rejected = lineTotals.reduce((s, row) => s + row.rejectedQty, 0)
  const taxable = lineTotals.reduce((s, row) => s + row.taxable, 0)
  const taxAmount = lineTotals.reduce((s, row) => s + row.taxAmount, 0)
  const gross = taxable + taxAmount
  const variance = receiving - accepted - rejected
  function updateLine(id: string, patch: Partial<GrnLineDraft>) {
    setLineDrafts((rows) => rows.map((row) => row.id === id ? { ...row, ...patch } : row))
  }
  function addLine() {
    setLineDrafts((rows) => [...rows, blankGrnLine(`manual-${Date.now()}`)])
  }
  function removeLine(id: string) {
    setLineDrafts((rows) => rows.length === 1 ? [blankGrnLine()] : rows.filter((row) => row.id !== id))
  }
  async function submit(e: FormEvent) {
    e.preventDefault()
    const lineItems = lineDrafts.map((line) => ({
      item: line.item.trim(),
      description: line.description.trim(),
      orderedQty: Number(line.orderedQty || 0),
      balanceQty: Number(line.balanceQty || 0),
      receivingQty: Number(line.receivingQty || 0),
      acceptedQty: Number(line.acceptedQty || 0),
      rejectedQty: Number(line.rejectedQty || 0),
      rate: Number(line.rate || 0),
      tax: Number(line.tax || 0),
      binLocation: line.binLocation.trim(),
      rejectionReason: line.rejectionReason.trim(),
    }))
    const res = await fetch('/api/procurement/grn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, receivingQty: receiving, acceptedQty: accepted, rejectedQty: rejected, lineItems }) })
    const out = await res.json().catch(() => ({}))
    if (res.ok) router.push(`/procurement/grn/${out.id}`)
    else alert(out.error || 'Failed to save GRN')
  }
  return (
    <ModuleFrame title="New GRN" description="Invoice-style goods receipt with item-wise quantities, rates, QC split, tax, and receipt value.">
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-ds-md border border-ds-line/60 bg-background p-4 shadow-ds-depth-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--brand-primary)]">Goods Receipt Note</p>
              <h2 className="mt-1 text-xl font-semibold text-ds-ink">GRN Draft</h2>
              <p className="mt-1 text-sm text-ds-ink-muted">Receive against a supplier PO, capture invoice quantities and value, and keep posting to stock as a separate controlled action.</p>
            </div>
            <div className="grid min-w-[34rem] grid-cols-4 overflow-hidden rounded-ds-md border border-ds-line/60 text-sm">
              <div className="bg-ds-elevated/35 p-3">
                <p className="text-[10px] uppercase tracking-wider text-ds-ink-faint">Receiving</p>
                <p className="mt-1 font-semibold tabular-nums">{nf.format(receiving)}</p>
              </div>
              <div className="border-x border-ds-line/60 bg-[var(--success-bg)] p-3">
                <p className="text-[10px] uppercase tracking-wider text-[var(--success)]">Accepted</p>
                <p className="mt-1 font-semibold tabular-nums text-[var(--success)]">{nf.format(accepted)}</p>
              </div>
              <div className="bg-[var(--error-bg)] p-3">
                <p className="text-[10px] uppercase tracking-wider text-[var(--error)]">Rejected</p>
                <p className="mt-1 font-semibold tabular-nums text-[var(--error)]">{nf.format(rejected)}</p>
              </div>
              <div className="border-l border-ds-line/60 bg-[var(--brand-primary)]/10 p-3">
                <p className="text-[10px] uppercase tracking-wider text-[var(--brand-primary)]">Invoice Value</p>
                <p className="mt-1 font-semibold tabular-nums text-[var(--brand-primary)]">{money(gross)}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
          <FormCard title="PO & Supplier">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="PO Search"><Input value={optionSearch} onChange={setOptionSearch} placeholder="Search open PO or supplier" /></Field>
              <Field label="PO Number"><select required value={form.poId} onChange={(e) => setForm({ ...form, poId: e.target.value })} className={fieldClass}><option value="">Select PO</option>{data?.openPos.map((p) => <option key={p.id} value={p.id}>{p.poNumber} - {p.supplierName}</option>)}</select></Field>
              <Field label="Supplier"><Input value={po?.supplierName ?? ''} onChange={() => {}} disabled /></Field>
              <Field label="Warehouse"><Input value={form.warehouse} onChange={(v) => setForm({ ...form, warehouse: v })} /></Field>
            </div>
          </FormCard>

          <FormCard title="Receipt Controls">
            <div className="grid gap-3">
              <Field label="Vehicle Number"><Input required value={form.vehicleNumber} onChange={(v) => setForm({ ...form, vehicleNumber: v })} /></Field>
              <Field label="Received Date"><Input type="date" value={form.receivedDate} onChange={(v) => setForm({ ...form, receivedDate: v })} /></Field>
              <Field label="Received By"><Input value={form.receivedBy} onChange={(v) => setForm({ ...form, receivedBy: v })} /></Field>
            </div>
          </FormCard>
        </div>

        <FormCard title="Supplier Invoice">
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Supplier Invoice Number"><Input value={form.supplierInvoiceNumber} onChange={(v) => setForm({ ...form, supplierInvoiceNumber: v })} /></Field>
            <Field label="Supplier Invoice Date"><Input type="date" value={form.supplierInvoiceDate} onChange={(v) => setForm({ ...form, supplierInvoiceDate: v })} /></Field>
            <Field label="Bin/Rack Location"><Input value={form.binLocation} onChange={(v) => setForm({ ...form, binLocation: v })} /></Field>
          </div>
        </FormCard>

        <FormCard title="Invoice / GRN Line Items" actions={<Button type="button" variant="secondary" onClick={addLine}>Add Line</Button>}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1320px] border-collapse text-sm">
              <thead className="bg-ds-elevated/45 text-xs uppercase tracking-wider text-ds-ink-faint">
                <tr>
                  {['Item', 'Description', 'PO Qty', 'Receiving Qty', 'Accepted', 'Rejected', 'Rate', 'Tax %', 'Taxable', 'Total', 'Bin', 'Rejection Reason', ''].map((h) => <th key={h || 'action'} className="px-2 py-2 text-left font-semibold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {lineDrafts.map((line, index) => (
                  <tr key={line.id} className="border-t border-ds-line/50 align-top">
                    <td className="w-44 px-2 py-2"><Input value={line.item} onChange={(v) => updateLine(line.id, { item: v })} placeholder="Material / board" /></td>
                    <td className="w-56 px-2 py-2"><Input value={line.description} onChange={(v) => updateLine(line.id, { description: v })} placeholder="Specification" /></td>
                    <td className="w-28 px-2 py-2"><Input type="number" value={line.orderedQty} onChange={(v) => updateLine(line.id, { orderedQty: v, balanceQty: v })} /></td>
                    <td className="w-32 px-2 py-2"><Input type="number" value={line.receivingQty} onChange={(v) => updateLine(line.id, { receivingQty: v, acceptedQty: v })} /></td>
                    <td className="w-28 px-2 py-2"><Input type="number" value={line.acceptedQty} onChange={(v) => updateLine(line.id, { acceptedQty: v })} /></td>
                    <td className="w-28 px-2 py-2"><Input type="number" value={line.rejectedQty} onChange={(v) => updateLine(line.id, { rejectedQty: v })} /></td>
                    <td className="w-28 px-2 py-2"><Input type="number" value={line.rate} onChange={(v) => updateLine(line.id, { rate: v })} /></td>
                    <td className="w-24 px-2 py-2"><Input type="number" value={line.tax} onChange={(v) => updateLine(line.id, { tax: v })} /></td>
                    <td className="px-2 py-3 font-semibold tabular-nums">{money(lineTotals[index]?.taxable ?? 0)}</td>
                    <td className="px-2 py-3 font-semibold tabular-nums text-[var(--brand-primary)]">{money(lineTotals[index]?.total ?? 0)}</td>
                    <td className="w-32 px-2 py-2"><Input value={line.binLocation} onChange={(v) => updateLine(line.id, { binLocation: v })} placeholder={form.binLocation || 'Bin'} /></td>
                    <td className="w-52 px-2 py-2"><Input value={line.rejectionReason} onChange={(v) => updateLine(line.id, { rejectionReason: v })} /></td>
                    <td className="px-2 py-2 text-right"><Button type="button" variant="ghost" onClick={() => removeLine(line.id)}>Remove</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </FormCard>

        <div className="grid gap-4 xl:grid-cols-[1fr_24rem]">
          <FormCard title="Remarks & QC">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="QC Remarks"><textarea value={form.qcRemarks} onChange={(e) => setForm({ ...form, qcRemarks: e.target.value })} className={`${fieldClass} min-h-[104px] normal-case tracking-normal`} placeholder="Inspection notes, rejection observation, sampling reference" /></Field>
              <Field label="Receiving Remarks"><textarea value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} className={`${fieldClass} min-h-[104px] normal-case tracking-normal`} placeholder="Gate entry, transporter, unloading, or warehouse remarks" /></Field>
            </div>
          </FormCard>
          <FormCard title="Invoice Summary">
            <div className="space-y-2 text-sm">
              <InfoLine label="Receiving Qty" value={nf.format(receiving)} />
              <InfoLine label="Accepted Qty" value={nf.format(accepted)} />
              <InfoLine label="Rejected Qty" value={nf.format(rejected)} />
              <InfoLine label="QC Variance" value={nf.format(variance)} />
              <InfoLine label="Taxable" value={money(taxable)} />
              <InfoLine label="Tax" value={money(taxAmount)} />
              <div className="mt-3 rounded-ds-sm bg-[var(--brand-primary)]/10 p-3 text-right">
                <p className="text-xs uppercase tracking-wider text-[var(--brand-primary)]">Receipt Value</p>
                <p className="mt-1 text-lg font-semibold text-[var(--brand-primary)]">{money(gross)}</p>
              </div>
            </div>
          </FormCard>
        </div>

        <div className="sticky bottom-3 z-20 flex flex-wrap justify-end gap-2 rounded-ds-md border border-ds-line/60 bg-background/95 p-3 shadow-ds-depth-sm backdrop-blur">
          <Link href="/procurement/grn"><Button variant="secondary">Cancel</Button></Link>
          <Button type="submit">Save Draft GRN</Button>
        </div>
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

function FormCard({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-ds-md border border-ds-line/60 bg-background p-4 shadow-ds-depth-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-ds-ink">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  )
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-ds-line/40 pb-2 last:border-b-0 last:pb-0">
      <span className="text-xs uppercase tracking-wider text-ds-ink-faint">{label}</span>
      <span className="max-w-[70%] text-right font-medium text-ds-ink">{value}</span>
    </div>
  )
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
