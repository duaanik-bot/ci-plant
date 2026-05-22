'use client'

import { useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from '@/store/toastStore'
import { Search, X, AlertTriangle, TrendingUp, CheckCircle2 } from 'lucide-react'
import {
  IndustrialModuleShell,
  industrialTableClassName,
} from '@/components/industrial/IndustrialModuleShell'
import {
  Badge,
  Button,
  KpiTile,
  StandardDrawer,
  StatusBadge,
} from '@/components/design-system'

type SeRecord = {
  id: string
  poLineItemId: string
  jobCardId: string | null
  billId: string | null
  billNumber: string | null
  poQty: number
  actualQty: number
  tolerancePct: number
  varianceQty: number
  status: string
  notes: string | null
  closedAt: string | null
  createdAt: string
  cartonName: string
  poNumber: string
  customer: { id: string; name: string }
}

type Tab = 'all' | 'short' | 'excess' | 'closed'

function flagFor(r: SeRecord): 'short' | 'excess' | 'ok' {
  const band = (r.poQty * r.tolerancePct) / 100
  if (Math.abs(r.varianceQty) <= band) return 'ok'
  return r.varianceQty < 0 ? 'short' : 'excess'
}

const flagTone: Record<'short' | 'excess' | 'ok', 'danger' | 'warning' | 'success'> = {
  short: 'danger',
  excess: 'warning',
  ok: 'success',
}

function FgDrawer({
  record,
  isOpen,
  onClose,
  onDone,
}: {
  record: SeRecord
  isOpen: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [materialId, setMaterialId] = useState('')
  const [materialSearch, setMaterialSearch] = useState('')
  const [materialResults, setMaterialResults] = useState<{ id: string; materialCode: string; description: string }[]>([])
  const [qty, setQty] = useState(String(Math.abs(record.varianceQty)))
  const [saving, setSaving] = useState(false)

  const searchMaterial = useCallback(async (q: string) => {
    if (q.length < 2) { setMaterialResults([]); return }
    const res = await fetch(`/api/inventory?q=${encodeURIComponent(q)}&limit=10`)
    const data = await res.json().catch(() => [])
    setMaterialResults(Array.isArray(data) ? data : [])
  }, [])

  const confirm = async () => {
    if (!materialId) { toast.error('Select a material'); return }
    const qtyN = Number(qty)
    if (!qtyN || qtyN <= 0) { toast.error('Enter a valid qty'); return }
    setSaving(true)
    try {
      const res = await fetch(`/api/short-excess/${record.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send_to_fg', materialId, qty: qtyN }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed')
      toast.success(`${qtyN.toLocaleString('en-IN')} cartons sent to FG Warehouse`)
      onDone()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <StandardDrawer
      isOpen={isOpen}
      onClose={onClose}
      title="Send Excess to FG Warehouse"
      metadata={
        <span className="text-ds-ink-muted">
          {record.cartonName} · Excess: +{Math.abs(record.varianceQty).toLocaleString('en-IN')} cartons
        </span>
      }
      primaryAction={{
        label: 'Confirm → FG Warehouse',
        loadingLabel: 'Sending…',
        loading: saving,
        disabled: saving || !materialId,
        onClick: () => void confirm(),
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="se-material" className="block text-xs font-medium text-ds-ink-muted">
            Material / Product Code
          </label>
          <input
            id="se-material"
            value={materialSearch}
            onChange={(e) => { setMaterialSearch(e.target.value); void searchMaterial(e.target.value) }}
            placeholder="Search material code or description…"
            className="ds-input"
          />
          {materialResults.length > 0 && !materialId && (
            <div className="rounded-ds-sm border border-[var(--border)] bg-[var(--bg-card)] shadow-ds-depth-sm divide-y divide-[var(--border)] max-h-48 overflow-y-auto">
              {materialResults.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { setMaterialId(m.id); setMaterialSearch(`${m.materialCode} — ${m.description}`); setMaterialResults([]) }}
                  className="w-full px-3 py-2 text-left text-xs hover:bg-[var(--bg-muted)] transition-colors"
                >
                  <span className="font-mono text-[var(--brand-primary)]">{m.materialCode}</span>
                  <span className="ml-2 text-ds-ink-muted">{m.description}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="se-qty" className="block text-xs font-medium text-ds-ink-muted">
            Qty to send to FG (cartons)
          </label>
          <input
            id="se-qty"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            inputMode="numeric"
            className="ds-input text-right font-bold tabular-nums"
          />
        </div>
      </div>
    </StandardDrawer>
  )
}

export default function ShortExcessPage() {
  const [tab, setTab] = useState<Tab>('all')
  const [localSearch, setLocalSearch] = useState('')
  const [fgDrawerRecord, setFgDrawerRecord] = useState<SeRecord | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const qc = useQueryClient()

  const statusParam = tab === 'closed' ? 'closed' : tab === 'all' ? 'all' : 'open'
  const { data: list = [], isLoading } = useQuery<SeRecord[]>({
    queryKey: ['short-excess', statusParam],
    queryFn: () => fetch(`/api/short-excess?status=${statusParam}`).then((r) => r.json()).then((d) => Array.isArray(d) ? d : []),
  })

  const filtered = list.filter((r) => {
    const flag = flagFor(r)
    if (tab === 'short' && flag !== 'short') return false
    if (tab === 'excess' && flag !== 'excess') return false
    const q = localSearch.trim().toLowerCase()
    if (!q) return true
    return r.cartonName.toLowerCase().includes(q) || r.poNumber.toLowerCase().includes(q) || r.customer.name.toLowerCase().includes(q)
  })

  const openShort = list.filter((r) => r.status === 'open' && flagFor(r) === 'short').length
  const openExcess = list.filter((r) => r.status === 'open' && flagFor(r) === 'excess').length
  const closedAll = list.filter((r) => r.status !== 'open').length

  async function doAction(id: string, action: string, extra?: Record<string, unknown>) {
    setBusyId(id)
    try {
      const res = await fetch(`/api/short-excess/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed')
      toast.success(action === 'close' ? 'Shortage closed' : action === 'send_to_planning' ? 'Sent to Planning' : 'Done')
      await qc.invalidateQueries({ queryKey: ['short-excess'] })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const kpiTiles = (
    <>
      <KpiTile label="Open Shortages" value={openShort} tone="danger" />
      <KpiTile label="Open Excess" value={openExcess} tone="warning" />
      <KpiTile label="Resolved" value={closedAll} tone="success" />
    </>
  )

  return (
    <IndustrialModuleShell title="Short & Excess" subtitle="Finished goods reconciliation against PO" kpiRow={kpiTiles}>
      {fgDrawerRecord ? (
        <FgDrawer
          record={fgDrawerRecord}
          isOpen
          onClose={() => setFgDrawerRecord(null)}
          onDone={() => { setFgDrawerRecord(null); void qc.invalidateQueries({ queryKey: ['short-excess'] }) }}
        />
      ) : null}

      {/* Search */}
      <div className="ds-toolbar">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search className="pointer-events-none absolute left-3 h-4 w-4 text-ds-ink-faint" aria-hidden />
          <input
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            placeholder="Carton, PO #, or customer…"
            autoComplete="off"
            spellCheck={false}
            className="ds-input ds-toolbar-search pl-9"
          />
        </div>
        {localSearch.trim().length > 0 ? (
          <Button variant="icon" aria-label="Clear search" onClick={() => setLocalSearch('')}>
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1.5">
        {(['all', 'short', 'excess', 'closed'] as Tab[]).map((t) => (
          <Button
            key={t}
            type="button"
            variant={tab === t ? 'primary' : 'secondary'}
            className="rounded-full px-3 py-1 text-xs capitalize"
            onClick={() => setTab(t)}
          >
            {t}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-sm text-ds-ink-muted">Loading…</div>
      ) : (
        <div className={industrialTableClassName()}>
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--bg-elevated)] text-ds-ink-muted">
              <tr>
                <th className="px-3 py-2 font-medium">PO #</th>
                <th className="px-3 py-2 font-medium">Carton</th>
                <th className="hidden px-3 py-2 font-medium lg:table-cell">Customer</th>
                <th className="px-3 py-2 text-right font-medium">PO Qty</th>
                <th className="px-3 py-2 text-right font-medium">Actual Qty</th>
                <th className="px-3 py-2 text-right font-medium">Variance</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell">Flag</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">Bill #</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {filtered.map((r) => {
                const flag = flagFor(r)
                const isOpen = r.status === 'open'
                const busy = busyId === r.id
                const varianceClass =
                  flag === 'short'
                    ? 'text-[var(--error)]'
                    : flag === 'excess'
                      ? 'text-[var(--warning)]'
                      : 'text-[var(--success)]'
                return (
                  <tr key={r.id} className="transition-colors hover:bg-[var(--bg-muted)]">
                    <td className="px-3 py-2 font-mono text-xs text-[var(--brand-primary)]">{r.poNumber}</td>
                    <td className="max-w-[180px] px-3 py-2 text-xs text-ds-ink">
                      <div className="truncate" title={r.cartonName}>{r.cartonName}</div>
                    </td>
                    <td className="hidden px-3 py-2 text-xs text-ds-ink-muted lg:table-cell">{r.customer.name}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-ds-ink">{r.poQty.toLocaleString('en-IN')}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-ds-ink">{r.actualQty.toLocaleString('en-IN')}</td>
                    <td className={`px-3 py-2 text-right font-mono text-xs font-semibold ${varianceClass}`}>
                      {r.varianceQty > 0 ? '+' : ''}{r.varianceQty.toLocaleString('en-IN')}
                    </td>
                    <td className="hidden px-3 py-2 sm:table-cell">
                      <Badge tone={flagTone[flag]} className="gap-1">
                        {flag === 'short' ? <AlertTriangle className="h-3 w-3" /> : flag === 'excess' ? <TrendingUp className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                        {flag.toUpperCase()}
                      </Badge>
                    </td>
                    <td className="hidden px-3 py-2 text-xs text-ds-ink-faint md:table-cell">{r.billNumber ?? '—'}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={r.status.replace(/_/g, ' ')} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isOpen && flag === 'short' ? (
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <Button
                            variant="info"
                            className="px-2.5 py-1 text-xs"
                            disabled={busy}
                            onClick={() => void doAction(r.id, 'send_to_planning')}
                          >
                            → Planning
                          </Button>
                          <Button
                            variant="secondary"
                            className="px-2.5 py-1 text-xs"
                            disabled={busy}
                            onClick={() => void doAction(r.id, 'close')}
                          >
                            Close
                          </Button>
                        </div>
                      ) : isOpen && flag === 'excess' ? (
                        <Button
                          variant="warning"
                          className="px-2.5 py-1 text-xs"
                          disabled={busy}
                          onClick={() => setFgDrawerRecord(r)}
                        >
                          → FG Warehouse
                        </Button>
                      ) : (
                        <span className="text-xs text-ds-ink-faint">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-10 text-center text-sm text-ds-ink-faint">
                    {localSearch.trim() ? `No records matching "${localSearch.trim()}"` : 'No records found.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </IndustrialModuleShell>
  )
}
