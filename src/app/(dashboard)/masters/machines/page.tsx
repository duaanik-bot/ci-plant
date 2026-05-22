'use client'

/**
 * Machine Master — rebuilt with ERP design system
 * ─────────────────────────────────────────────────
 * Before: raw fetch + useEffect, browser confirm(), EnterpriseTableShell
 * After:  useQuery/useMutation, DataTable, PageHeader, KpiCard,
 *         SearchInput, Pagination, ConfirmDialog, toast
 *         MachineHealthMeter + PmSpotlightDrawer are preserved.
 */

import { useState }                           from 'react'
import Link                                   from 'next/link'
import { useRouter }                          from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Cpu, Activity, AlertTriangle, Pencil, Trash2 } from 'lucide-react'

import { PageHeader }    from '@/components/shared/PageHeader'
import { DataTable }     from '@/components/shared/DataTable'
import { StatusBadge }   from '@/components/shared/StatusBadge'
import { KpiCard }       from '@/components/shared/KpiCard'
import { Button }        from '@/components/ui/Button'
import { SearchInput }   from '@/components/ui/SearchInput'
import { Pagination }    from '@/components/ui/Pagination'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { toast }         from '@/store/toastStore'
import { MachineHealthMeter } from '@/components/industrial/MachineHealthMeter'
import { PmSpotlightDrawer }  from '@/components/industrial/PmSpotlightDrawer'

/* ── Types ──────────────────────────────────────────────────────────────── */
type Machine = {
  id: string
  machineCode: string
  name: string
  make: string | null
  specification: string | null
  capacityPerShift: number
  stdWastePct: number
  status: string
  lastPmDate: string | null
  nextPmDue: string | null
}

type PmRow = {
  machineId: string
  healthPct: number
  hasSchedule: boolean
  overdue: boolean
  usageRunHours: number
  usageImpressions: string
}

type PmResponse = {
  machines: PmRow[]
}

const PAGE_LIMIT = 20

/* ── API helpers ─────────────────────────────────────────────────────────── */
async function fetchMachines(): Promise<Machine[]> {
  const res = await fetch('/api/masters/machines')
  if (!res.ok) throw new Error('Failed to load machines')
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

async function fetchMachineHealth(): Promise<Record<string, PmRow>> {
  const res = await fetch('/api/production/machine-health')
  if (!res.ok) return {}
  const json = (await res.json()) as PmResponse
  const map: Record<string, PmRow> = {}
  if (json.machines && Array.isArray(json.machines)) {
    for (const row of json.machines) {
      map[row.machineId] = row
    }
  }
  return map
}

async function deleteMachine(id: string): Promise<void> {
  const res = await fetch(`/api/masters/machines/${id}`, { method: 'DELETE' })
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    throw new Error((j as { error?: string }).error ?? 'Failed to delete machine')
  }
}

/* ── Page component ──────────────────────────────────────────────────────── */
export default function MastersMachinesPage() {
  const router = useRouter()
  const qc     = useQueryClient()

  const [q,            setQ]            = useState('')
  const [page,         setPage]         = useState(1)
  const [deleteTarget, setDeleteTarget] = useState<Machine | null>(null)
  const [pmMachineId,  setPmMachineId]  = useState<string | null>(null)

  /* ── Fetch ───────────────────────────────────────────────────────────── */
  const { data: list = [], isLoading: machinesLoading } = useQuery<Machine[]>({
    queryKey: ['masters', 'machines'],
    queryFn:  fetchMachines,
  })

  const { data: pmById = {} } = useQuery<Record<string, PmRow>>({
    queryKey: ['production', 'machine-health'],
    queryFn:  fetchMachineHealth,
  })

  const isLoading = machinesLoading

  /* ── Delete mutation ─────────────────────────────────────────────────── */
  const deleteMut = useMutation({
    mutationFn: deleteMachine,
    onSuccess: () => {
      toast.success('Machine deleted')
      void qc.invalidateQueries({ queryKey: ['masters', 'machines'] })
      void qc.invalidateQueries({ queryKey: ['production', 'machine-health'] })
      setDeleteTarget(null)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  /* ── Filter + paginate ───────────────────────────────────────────────── */
  const ql = q.toLowerCase()
  const filtered = list.filter(m =>
    m.machineCode.toLowerCase().includes(ql) ||
    m.name.toLowerCase().includes(ql) ||
    (m.make ?? '').toLowerCase().includes(ql) ||
    m.status.toLowerCase().includes(ql),
  )
  const paginated = filtered.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT)

  const overdueCount  = Object.values(pmById).filter(p => p.overdue).length
  const activeCount   = list.filter(m => m.status === 'active').length
  const maintCount    = list.filter(m => m.status === 'under_maintenance').length

  /* ── Column definitions ──────────────────────────────────────────────── */
  const columns = [
    {
      key:       'machineCode',
      label:     'Code',
      className: 'font-mono text-sm text-ds-warning font-semibold',
      render:    (row: Machine) => (
        <Link
          href={`/masters/machines/${row.id}`}
          className="hover:text-ds-brand hover:underline"
        >
          {row.machineCode}
        </Link>
      ),
    },
    {
      key:       'name',
      label:     'Name',
      className: 'font-medium',
      render:    (row: Machine) => row.name,
    },
    {
      key:    'health',
      label:  'Health',
      render: (row: Machine) => {
        const pm = pmById[row.id]
        return pm?.hasSchedule ? (
          <MachineHealthMeter
            healthPct={pm.healthPct}
            hasSchedule
            onClick={() => setPmMachineId(row.id)}
          />
        ) : (
          <MachineHealthMeter healthPct={0} hasSchedule={false} />
        )
      },
    },
    {
      key:       'pmUsage',
      label:     'PM Usage',
      className: 'font-mono text-xs text-ds-ink-muted',
      render:    (row: Machine) => {
        const pm = pmById[row.id]
        return pm?.hasSchedule ? `${pm.usageRunHours}h · ${pm.usageImpressions}` : '—'
      },
    },
    {
      key:       'make',
      label:     'Make',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: Machine) => row.make ?? '—',
    },
    {
      key:       'capacityPerShift',
      label:     'Cap/Shift',
      align:     'right' as const,
      className: 'font-mono text-sm',
      render:    (row: Machine) => (row.capacityPerShift ?? 0).toLocaleString('en-IN'),
    },
    {
      key:       'stdWastePct',
      label:     'Std Waste',
      align:     'right' as const,
      className: 'font-mono text-sm',
      render:    (row: Machine) => `${row.stdWastePct ?? '—'}%`,
    },
    {
      key:    'status',
      label:  'Status',
      render: (row: Machine) => (
        <StatusBadge
          status={
            row.status === 'active'            ? 'active'
            : row.status === 'under_maintenance' ? 'under_maintenance'
            : 'inactive'
          }
        />
      ),
    },
    {
      key:       'lastPmDate',
      label:     'Last PM',
      className: 'font-mono text-xs text-ds-ink-muted',
      render:    (row: Machine) => row.lastPmDate ?? '—',
    },
    {
      key:    'nextPmDue',
      label:  'Next PM Due',
      render: (row: Machine) => {
        const overdue = row.nextPmDue && new Date(row.nextPmDue) < new Date()
        return row.nextPmDue ? (
          <span className={`font-mono text-xs ${overdue ? 'font-semibold text-ds-error' : 'text-ds-ink-muted'}`}>
            {row.nextPmDue}
          </span>
        ) : (
          <span className="text-ds-ink-faint">—</span>
        )
      },
    },
    {
      key:    'actions',
      label:  '',
      render: (row: Machine) => (
        <div className="flex items-center gap-1 justify-end">
          <Link
            href={`/masters/machines/${row.id}`}
            className="p-1.5 rounded-ds-sm text-ds-ink-faint hover:text-ds-brand hover:bg-ds-brand/8 transition-colors"
            title="Edit"
          >
            <Pencil size={14} />
          </Link>
          <button
            onClick={() => setDeleteTarget(row)}
            className="p-1.5 rounded-ds-sm text-ds-ink-faint hover:text-ds-error hover:bg-ds-error/8 transition-colors"
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ),
    },
  ]

  /* ── Row class — highlight overdue PM rows ───────────────────────────── */
  function getRowClassName(row: Machine): string {
    const pm = pmById[row.id]
    return pm?.overdue ? 'bg-rose-50 dark:bg-[var(--error-bg)]/30' : ''
  }

  /* ── Render ──────────────────────────────────────────────────────────── */
  return (
    <div className="p-6 space-y-6">

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiCard
          title="Total Machines"
          value={list.length}
          icon={Cpu}
          color="blue"
          loading={isLoading}
        />
        <KpiCard
          title="Active"
          value={activeCount}
          icon={Activity}
          color="green"
          loading={isLoading}
        />
        <KpiCard
          title="PM Overdue"
          value={overdueCount}
          icon={AlertTriangle}
          color={overdueCount > 0 ? 'red' : 'slate'}
          loading={isLoading}
        />
      </div>

      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader
        title="Machine Master"
        subtitle="Manage machine specifications, PM schedules and health status"
        action={
          <Button icon={Plus} onClick={() => router.push('/masters/machines/new')}>
            Add Machine
          </Button>
        }
      />

      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <SearchInput
          value={q}
          onChange={v => { setQ(v); setPage(1) }}
          placeholder="Search by code, name, make or status…"
          className="w-80"
        />
        {maintCount > 0 && (
          <span className="rounded-ds-md bg-ds-warning/10 px-3 py-1.5 text-xs font-medium text-ds-warning">
            {maintCount} under maintenance
          </span>
        )}
      </div>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <DataTable
        columns={columns}
        data={paginated}
        loading={isLoading}
        rowClassName={getRowClassName}
        emptyMessage={
          q ? 'No machines match your search.' : 'No machines yet. Add one to get started.'
        }
      />

      {/* ── Pagination ────────────────────────────────────────────────── */}
      <Pagination
        page={page}
        total={filtered.length}
        limit={PAGE_LIMIT}
        onChange={setPage}
      />

      {/* ── Delete confirmation ───────────────────────────────────────── */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget.id)}
        title="Delete Machine"
        message={`Are you sure you want to delete "${deleteTarget?.machineCode}"? This cannot be undone.`}
        confirmLabel="Yes, Delete"
        loading={deleteMut.isPending}
      />

      {/* ── PM Spotlight drawer ───────────────────────────────────────── */}
      <PmSpotlightDrawer machineId={pmMachineId} onClose={() => setPmMachineId(null)} />

    </div>
  )
}
