'use client'

/**
 * Material Master — rebuilt with ERP design system
 * ─────────────────────────────────────────────────
 * Before: raw fetch + useEffect, browser confirm(), EnterpriseTableShell, useMemo sort
 * After:  useQuery/useMutation, DataTable, PageHeader, KpiCard,
 *         SearchInput, Pagination, ConfirmDialog, toast
 *         Sort is preserved via local state (sortKey + sortDir)
 */

import { useState, useMemo }                  from 'react'
import Link                                   from 'next/link'
import { useRouter }                          from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Package, CheckCircle, XCircle, Pencil, Trash2, ChevronsUpDown } from 'lucide-react'

import { PageHeader }    from '@/components/shared/PageHeader'
import { DataTable }     from '@/components/shared/DataTable'
import { StatusBadge }   from '@/components/shared/StatusBadge'
import { KpiCard }       from '@/components/shared/KpiCard'
import { Button }        from '@/components/ui/Button'
import { SearchInput }   from '@/components/ui/SearchInput'
import { Pagination }    from '@/components/ui/Pagination'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { toast }         from '@/store/toastStore'

/* ── Types ──────────────────────────────────────────────────────────────── */
type Material = {
  id: string
  materialCode: string
  description: string
  unit: string
  attributes: string | null
  sheetLength: number | null
  sheetWidth: number | null
  packetWeight: number
  boardType: string | null
  gsm: number | null
  supplier: { id: string; name: string } | null
  active: boolean
}

const PAGE_LIMIT = 20

/* ── API helpers ─────────────────────────────────────────────────────────── */
async function fetchMaterials(): Promise<Material[]> {
  const res = await fetch('/api/masters/materials')
  if (!res.ok) throw new Error('Failed to load materials')
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

async function deleteMaterial(id: string): Promise<void> {
  const res = await fetch(`/api/masters/materials/${id}`, { method: 'DELETE' })
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    throw new Error((j as { error?: string }).error ?? 'Failed to delete material')
  }
}

/* ── Sort button helper ──────────────────────────────────────────────────── */
function SortBtn({
  label, active, dir, onClick,
}: {
  label: string
  active: boolean
  dir: 'asc' | 'desc'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-ds-ink-muted hover:text-ds-ink"
    >
      {label}
      <ChevronsUpDown
        size={12}
        className={active ? 'text-ds-brand' : 'text-ds-ink-faint'}
      />
      {active && <span className="text-ds-brand">{dir === 'asc' ? '↑' : '↓'}</span>}
    </button>
  )
}

/* ── Page component ──────────────────────────────────────────────────────── */
export default function MastersMaterialsPage() {
  const router = useRouter()
  const qc     = useQueryClient()

  const [q,            setQ]            = useState('')
  const [page,         setPage]         = useState(1)
  const [deleteTarget, setDeleteTarget] = useState<Material | null>(null)
  const [sortKey,      setSortKey]      = useState<'gsm' | 'packetWeight' | 'active'>('gsm')
  const [sortDir,      setSortDir]      = useState<'asc' | 'desc'>('asc')

  /* ── Fetch ───────────────────────────────────────────────────────────── */
  const { data: list = [], isLoading } = useQuery<Material[]>({
    queryKey: ['masters', 'materials'],
    queryFn:  fetchMaterials,
  })

  /* ── Delete mutation ─────────────────────────────────────────────────── */
  const deleteMut = useMutation({
    mutationFn: deleteMaterial,
    onSuccess: () => {
      toast.success('Material deleted')
      void qc.invalidateQueries({ queryKey: ['masters', 'materials'] })
      setDeleteTarget(null)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  /* ── Sort toggle ─────────────────────────────────────────────────────── */
  function toggleSort(key: typeof sortKey) {
    if (sortKey === key) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc')
      return
    }
    setSortKey(key)
    setSortDir('asc')
  }

  /* ── Filter + sort + paginate ────────────────────────────────────────── */
  const ql = q.toLowerCase()
  const filtered = useMemo(() => {
    if (!ql.trim()) return list
    return list.filter(m =>
      [m.materialCode, m.description, m.boardType ?? '', m.attributes ?? '',
       m.gsm != null ? String(m.gsm) : '', String(m.packetWeight),
       m.active ? 'active' : 'inactive']
        .join(' ').toLowerCase().includes(ql),
    )
  }, [list, ql])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    arr.sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1
      const av = sortKey === 'active' ? (a.active ? 1 : 0)
               : sortKey === 'gsm'    ? (a.gsm ?? 0)
               : a.packetWeight
      const bv = sortKey === 'active' ? (b.active ? 1 : 0)
               : sortKey === 'gsm'    ? (b.gsm ?? 0)
               : b.packetWeight
      return av === bv
        ? a.materialCode.localeCompare(b.materialCode)
        : (av > bv ? 1 : -1) * dir
    })
    return arr
  }, [filtered, sortDir, sortKey])

  const paginated = sorted.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT)

  /* ── Column definitions ──────────────────────────────────────────────── */
  const columns = [
    {
      key:       'materialCode',
      label:     'Code',
      className: 'font-mono text-xs font-medium',
      render:    (row: Material) => (
        <Link
          href={`/masters/materials/${row.id}`}
          className="hover:text-ds-brand hover:underline"
        >
          {row.materialCode}
        </Link>
      ),
    },
    {
      key:       'boardType',
      label:     'Board Type',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: Material) => row.boardType ?? '—',
    },
    {
      key:       'size',
      label:     'Size',
      className: 'font-mono text-xs',
      render:    (row: Material) =>
        row.sheetLength && row.sheetWidth
          ? `${row.sheetLength} × ${row.sheetWidth}`
          : '—',
    },
    {
      key:    'gsm',
      label:  () => (
        <SortBtn
          label="GSM"
          active={sortKey === 'gsm'}
          dir={sortDir}
          onClick={() => { toggleSort('gsm'); setPage(1) }}
        />
      ),
      align:     'right' as const,
      className: 'font-mono text-sm',
      render:    (row: Material) => row.gsm ?? '—',
    },
    {
      key:    'packetWeight',
      label:  () => (
        <SortBtn
          label="Pkt Wt"
          active={sortKey === 'packetWeight'}
          dir={sortDir}
          onClick={() => { toggleSort('packetWeight'); setPage(1) }}
        />
      ),
      align:     'right' as const,
      className: 'font-mono text-sm',
      render:    (row: Material) => Number(row.packetWeight ?? 0).toFixed(3),
    },
    {
      key:       'attributes',
      label:     'Attributes',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: Material) => row.attributes ?? '—',
    },
    {
      key:       'supplier',
      label:     'Supplier',
      className: 'text-ds-ink-muted text-sm',
      render:    (row: Material) => row.supplier?.name ?? '—',
    },
    {
      key:    'active',
      label:  () => (
        <SortBtn
          label="Status"
          active={sortKey === 'active'}
          dir={sortDir}
          onClick={() => { toggleSort('active'); setPage(1) }}
        />
      ),
      render: (row: Material) => (
        <StatusBadge status={row.active ? 'active' : 'inactive'} />
      ),
    },
    {
      key:    'actions',
      label:  '',
      render: (row: Material) => (
        <div className="flex items-center gap-1 justify-end">
          <Link
            href={`/masters/materials/${row.id}`}
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

  /* ── Render ──────────────────────────────────────────────────────────── */
  return (
    <div className="p-6 space-y-6">

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiCard
          title="Total Materials"
          value={list.length}
          icon={Package}
          color="blue"
          loading={isLoading}
        />
        <KpiCard
          title="Active"
          value={list.filter(m => m.active).length}
          icon={CheckCircle}
          color="green"
          loading={isLoading}
        />
        <KpiCard
          title="Inactive"
          value={list.filter(m => !m.active).length}
          icon={XCircle}
          color="orange"
          loading={isLoading}
        />
      </div>

      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader
        title="Material Master"
        subtitle="Manage board materials, GSM specifications and suppliers"
        action={
          <Button icon={Plus} onClick={() => router.push('/masters/materials/new')}>
            Add Material
          </Button>
        }
      />

      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <SearchInput
          value={q}
          onChange={v => { setQ(v); setPage(1) }}
          placeholder="Search code, board type, size, GSM…"
          className="w-80"
        />
      </div>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <DataTable
        columns={columns}
        data={paginated}
        loading={isLoading}
        emptyMessage={
          q ? 'No materials match your search.' : 'No materials yet. Add one to get started.'
        }
      />

      {/* ── Pagination ────────────────────────────────────────────────── */}
      <Pagination
        page={page}
        total={sorted.length}
        limit={PAGE_LIMIT}
        onChange={setPage}
      />

      {/* ── Delete confirmation ───────────────────────────────────────── */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget.id)}
        title="Delete Material"
        message={`Are you sure you want to delete "${deleteTarget?.materialCode}"? This cannot be undone.`}
        confirmLabel="Yes, Delete"
        loading={deleteMut.isPending}
      />

    </div>
  )
}
