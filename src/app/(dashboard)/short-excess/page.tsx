'use client'

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from '@/store/toastStore'
import {
  AlertTriangle,
  CheckCircle2,
  FolderInput,
  Package,
  RotateCcw,
  Search,
  X,
} from 'lucide-react'
import {
  IndustrialModuleShell,
  industrialTableClassName,
} from '@/components/industrial/IndustrialModuleShell'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import {
  Badge,
  Button,
  CardSection,
  KpiTile,
  SectionLabel,
  StatusBadge,
} from '@/components/design-system'

type Row = {
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

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  closed: 'Closed',
  sent_to_planning: 'Replan',
  sent_to_fg: 'In FG Stock',
}

function fmtDate(iso?: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  })
}
function fmtDateTime(iso?: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function InfoGrid({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <div className="text-ds-ink-muted">{label}</div>
          <div className="text-ds-ink">{value}</div>
        </div>
      ))}
    </div>
  )
}

export default function ShortExcessPage() {
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<'open' | 'closed' | 'sent_to_planning' | 'sent_to_fg' | 'all'>('open')
  const [q, setQ] = useState('')
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [closeNotes, setCloseNotes] = useState('')
  const [busy, setBusy] = useState(false)

  const { data: list = [], isLoading, isFetching } = useQuery<Row[]>({
    queryKey: ['short-excess', statusFilter],
    queryFn: () =>
      fetch(`/api/short-excess?status=${statusFilter}`).then((r) => r.json()),
    refetchInterval: 30_000,
  })

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    if (!ql) return list
    return list.filter(
      (r) =>
        r.cartonName.toLowerCase().includes(ql) ||
        r.customer.name.toLowerCase().includes(ql) ||
        r.poNumber.toLowerCase().includes(ql),
    )
  }, [list, q])

  const kpiOpen = list.filter((r) => r.status === 'open').length
  const kpiVarianceTotal = list.reduce((sum, r) => sum + Math.abs(r.varianceQty), 0)
  const kpiExcess = list.filter((r) => r.varianceQty > 0).length
  const kpiShort = list.filter((r) => r.varianceQty < 0).length

  const drawerRow = drawerId ? list.find((r) => r.id === drawerId) ?? null : null

  async function act(
    id: string,
    action: 'close' | 'send_to_planning',
    payload: Record<string, unknown> = {},
  ) {
    setBusy(true)
    try {
      const res = await fetch(`/api/short-excess/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json?.error ?? 'Action failed')
        return
      }
      toast.success(
        action === 'close'
          ? 'Record closed'
          : action === 'send_to_planning'
          ? 'Sent back to planning — short qty queued for replan'
          : 'Done',
      )
      setDrawerId(null)
      setCloseNotes('')
      await qc.invalidateQueries({ queryKey: ['short-excess'] })
    } catch {
      toast.error('Network error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <IndustrialModuleShell
      title="Short & Excess"
      subtitle={`Variance reconciliation · auto-refresh 30s${isFetching ? ' · refreshing…' : ''}`}
      kpiRow={
        <>
          <KpiTile label="Open" tone="warning" value={kpiOpen} icon={<AlertTriangle />} />
          <KpiTile label="Excess Cases" tone="danger" value={kpiExcess} icon={<Package />} />
          <KpiTile label="Short Cases" tone="danger" value={kpiShort} icon={<AlertTriangle />} />
          <KpiTile
            label="Total Variance"
            tone="info"
            value={kpiVarianceTotal.toLocaleString('en-IN')}
            icon={<RotateCcw />}
          />
        </>
      }
    >
      {/* Toolbar */}
      <div className="ds-toolbar">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search className="pointer-events-none absolute left-3 h-4 w-4 text-ds-ink-faint" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Product, PO #, or customer…"
            className="ds-input ds-toolbar-search pl-9"
          />
        </div>
        {q && (
          <Button variant="icon" aria-label="Clear search" onClick={() => setQ('')}>
            <X className="h-4 w-4" />
          </Button>
        )}
        <select
          value={statusFilter}
          onChange={(e) =>
            setStatusFilter(e.target.value as typeof statusFilter)
          }
          className="ds-input h-9 min-w-[160px] cursor-pointer py-1.5"
        >
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="sent_to_planning">Sent to Planning</option>
          <option value="sent_to_fg">In FG Stock</option>
          <option value="all">All</option>
        </select>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="py-12 text-center text-sm text-ds-ink-muted">Loading…</div>
      ) : (
        <div className={industrialTableClassName()}>
          <table className="w-full text-left text-sm">
            <thead className="bg-[var(--bg-elevated)]">
              <tr className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-muted">
                <th className="px-3 py-2.5">Product</th>
                <th className="px-3 py-2.5">Customer</th>
                <th className="px-3 py-2.5">PO #</th>
                <th className="px-3 py-2.5 text-right">PO Qty</th>
                <th className="px-3 py-2.5 text-right">Actual</th>
                <th className="px-3 py-2.5 text-right">Variance</th>
                <th className="hidden px-3 py-2.5 text-right lg:table-cell">Tolerance</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="hidden px-3 py-2.5 lg:table-cell">Created</th>
                <th className="px-3 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const isExcess = r.varianceQty > 0
                return (
                  <tr
                    key={r.id}
                    className="transition-colors hover:bg-[var(--bg-muted)]"
                  >
                    <td className="max-w-[200px] px-3 py-2.5">
                      <span className="block truncate text-xs font-medium text-ds-ink">
                        {r.cartonName}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-ds-ink">
                      {r.customer.name}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-ds-ink-muted">
                      {r.poNumber}
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums text-ds-ink-muted">
                      {r.poQty.toLocaleString('en-IN')}
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums text-ds-ink">
                      {r.actualQty.toLocaleString('en-IN')}
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums">
                      <span
                        className={`font-semibold ${
                          isExcess ? 'text-[var(--warning)]' : 'text-[var(--error)]'
                        }`}
                      >
                        {isExcess ? '+' : ''}
                        {r.varianceQty.toLocaleString('en-IN')}
                      </span>
                      <Badge
                        tone={isExcess ? 'warning' : 'danger'}
                        className="ml-1.5 px-1 py-0 text-[9px]"
                      >
                        {isExcess ? 'EXCESS' : 'SHORT'}
                      </Badge>
                    </td>
                    <td className="hidden px-3 py-2.5 text-right text-xs tabular-nums text-ds-ink-muted lg:table-cell">
                      {r.tolerancePct}%
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={STATUS_LABELS[r.status] ?? r.status} />
                    </td>
                    <td className="hidden px-3 py-2.5 text-xs text-ds-ink-muted lg:table-cell">
                      {fmtDate(r.createdAt)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Button
                        variant="warning"
                        className="px-2.5 py-1 text-xs"
                        onClick={() => {
                          setDrawerId(r.id)
                          setCloseNotes(r.notes ?? '')
                        }}
                      >
                        Review →
                      </Button>
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={10}
                    className="px-3 py-12 text-center text-sm text-ds-ink-faint"
                  >
                    {q
                      ? `No records matching "${q}"`
                      : statusFilter === 'open'
                      ? 'No open variance — production is matching PO qty within tolerance.'
                      : 'No records.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail drawer */}
      <SlideOverPanel
        isOpen={!!drawerRow}
        onClose={() => (busy ? undefined : setDrawerId(null))}
        title={drawerRow ? `${drawerRow.cartonName} · Variance` : ''}
        headerMeta={
          drawerRow
            ? `${drawerRow.customer.name} · PO ${drawerRow.poNumber}`
            : undefined
        }
        footer={
          drawerRow ? (
            <div className="flex flex-wrap items-center gap-2">
              {drawerRow.status === 'open' && drawerRow.varianceQty < 0 && (
                <Button
                  variant="warning"
                  className="gap-1.5"
                  disabled={busy}
                  onClick={() => void act(drawerRow.id, 'send_to_planning')}
                >
                  <FolderInput className="h-4 w-4" /> Send to Planning (replan short)
                </Button>
              )}
              {drawerRow.status === 'open' && (
                <Button
                  variant="success"
                  className="gap-1.5"
                  disabled={busy}
                  onClick={() => void act(drawerRow.id, 'close', { notes: closeNotes })}
                >
                  <CheckCircle2 className="h-4 w-4" /> Close
                </Button>
              )}
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setDrawerId(null)}
              >
                Close drawer
              </Button>
            </div>
          ) : null
        }
      >
        {drawerRow && (
          <div className="space-y-3">
            <div className="space-y-3 rounded-ds-md bg-[var(--brand-bg-soft)] px-4 py-3.5">
              <SectionLabel accent>Variance Summary</SectionLabel>
              <InfoGrid
                rows={[
                  ['PO Qty', <span key="po" className="tabular-nums">{drawerRow.poQty.toLocaleString('en-IN')}</span>],
                  ['Actual Qty', <span key="aq" className="tabular-nums">{drawerRow.actualQty.toLocaleString('en-IN')}</span>],
                  ['Tolerance', <span key="tp" className="tabular-nums">{drawerRow.tolerancePct}%</span>],
                  [
                    'Variance',
                    <span
                      key="vq"
                      className={`font-semibold tabular-nums ${
                        drawerRow.varianceQty > 0
                          ? 'text-[var(--warning)]'
                          : 'text-[var(--error)]'
                      }`}
                    >
                      {drawerRow.varianceQty > 0 ? '+' : ''}
                      {drawerRow.varianceQty.toLocaleString('en-IN')}{' '}
                      <Badge
                        tone={drawerRow.varianceQty > 0 ? 'warning' : 'danger'}
                        className="ml-1 px-1 py-0 text-[9px]"
                      >
                        {drawerRow.varianceQty > 0 ? 'EXCESS' : 'SHORT'}
                      </Badge>
                    </span>,
                  ],
                  ['Status', <StatusBadge key="st" status={STATUS_LABELS[drawerRow.status] ?? drawerRow.status} />],
                  ['Opened', fmtDateTime(drawerRow.createdAt)],
                  ...(drawerRow.closedAt
                    ? ([['Closed', fmtDateTime(drawerRow.closedAt)]] as [string, React.ReactNode][])
                    : []),
                  ...(drawerRow.billNumber
                    ? ([['Bill', <span key="bn" className="font-mono">{drawerRow.billNumber}</span>]] as [string, React.ReactNode][])
                    : []),
                ]}
              />
            </div>

            {drawerRow.varianceQty > 0 && (
              <CardSection title="Excess Decisions">
                <p className="text-xs leading-relaxed text-ds-ink-muted">
                  Excess inventory needs a destination. The architecture supports:
                </p>
                <ul className="list-disc space-y-1 pl-4 text-xs text-ds-ink">
                  <li>Reuse against a future PO (mark in notes, then close)</li>
                  <li>Scrap (mark in notes, then close)</li>
                  <li>
                    Convert to internal stock — currently uses the legacy{' '}
                    <code className="rounded bg-ds-elevated px-1 font-mono text-[10px]">send_to_fg</code>{' '}
                    flow against the raw-material inventory.
                  </li>
                  <li>Customer approval workflow (future)</li>
                  <li>Debit/Credit adjustment (future, ties into invoicing)</li>
                </ul>
                <p className="text-[11px] text-ds-ink-faint">
                  For now, capture the decision in notes and close the record. The full multi-path workflow ships in a later phase.
                </p>
              </CardSection>
            )}

            <CardSection title="Notes">
              <textarea
                value={closeNotes}
                onChange={(e) => setCloseNotes(e.target.value)}
                rows={4}
                placeholder="Decision rationale (reuse / scrap / replan / customer approval)…"
                className="ds-input resize-none"
                disabled={busy || drawerRow.status !== 'open'}
              />
            </CardSection>
          </div>
        )}
      </SlideOverPanel>
    </IndustrialModuleShell>
  )
}
