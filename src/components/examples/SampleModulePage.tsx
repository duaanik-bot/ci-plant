'use client'

/**
 * SampleModulePage — Template for any CRUD module
 * ────────────────────────────────────────────────
 * Demonstrates a typical ERP CRUD page using the design system:
 *   KpiCard strip → PageHeader → SearchInput → DataTable → Pagination
 *   "Add" button → Modal with form (Input, Select, Textarea)
 *   Row action "Delete" → ConfirmDialog
 *   API feedback → toast notifications
 *
 * To build a real module page:
 *   1. Replace MOCK data with `useQuery` from @tanstack/react-query
 *   2. Replace `setTimeout` in handleSave / handleDelete with real API calls
 *   3. Rename the component and adjust columns, form fields, status options
 */

import { useState } from 'react'
import { Plus, Pencil, Trash2, Users } from 'lucide-react'

import { PageHeader }    from '@/components/shared/PageHeader'
import { DataTable }     from '@/components/shared/DataTable'
import { StatusBadge }   from '@/components/shared/StatusBadge'
import { KpiCard }       from '@/components/shared/KpiCard'
import { Button }        from '@/components/ui/Button'
import { SearchInput }   from '@/components/ui/SearchInput'
import { Pagination }    from '@/components/ui/Pagination'
import { Modal }         from '@/components/ui/Modal'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Input }         from '@/components/ui/Input'
import { Select }        from '@/components/ui/Select'
import { Textarea }      from '@/components/ui/Textarea'
import { toast }         from '@/store/toastStore'

/* ── Types ── replace with your own domain types */
interface SampleRecord {
  id: string
  name: string
  email: string
  gstin: string
  status: string
}

type FormData = { name: string; email: string; gstin: string; status: string; notes: string }
type FormErrors = Partial<{ [K in keyof FormData]: string }>

/* ── Mock data ── replace with useQuery() */
const MOCK: SampleRecord[] = [
  { id: '1', name: 'Acme Corp',  email: 'acme@example.com',  status: 'active',   gstin: '22AAAAA0000A1Z5' },
  { id: '2', name: 'Beta Ltd',   email: 'beta@example.com',  status: 'inactive', gstin: '07BBBBB0000B1Z3' },
  { id: '3', name: 'Gamma Pvt',  email: 'gamma@example.com', status: 'active',   gstin: '29CCCCC0000C1Z1' },
  { id: '4', name: 'Delta Inc',  email: 'delta@example.com', status: 'pending',  gstin: '19DDDDD0000D1Z9' },
  { id: '5', name: 'Epsilon Co', email: 'eps@example.com',   status: 'active',   gstin: '33EEEEE0000E1Z7' },
]

const STATUS_OPTIONS = [
  { value: 'active',   label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'pending',  label: 'Pending' },
]

const FORM_DEFAULTS: FormData = { name: '', email: '', gstin: '', status: 'active', notes: '' }

export default function SampleModulePage() {
  const [q,         setQ]         = useState('')
  const [page,      setPage]      = useState(1)
  const [showForm,  setShowForm]  = useState(false)
  const [editRow,   setEditRow]   = useState<SampleRecord | null>(null)
  const [deleteRow, setDeleteRow] = useState<SampleRecord | null>(null)
  const [form,      setForm]      = useState<FormData>(FORM_DEFAULTS)
  const [saving,    setSaving]    = useState(false)
  const [deleting,  setDeleting]  = useState(false)
  const [errors,    setErrors]    = useState<FormErrors>({})

  const filtered = MOCK.filter(r =>
    r.name.toLowerCase().includes(q.toLowerCase()) ||
    r.email.toLowerCase().includes(q.toLowerCase())
  )

  /* ── Table column definitions ─────────────────────────────────────── */
  const columns = [
    { key: 'name',   label: 'Name',   className: 'font-medium' },
    { key: 'email',  label: 'Email',  className: 'text-ds-ink-muted' },
    { key: 'gstin',  label: 'GSTIN',  className: 'font-mono text-xs' },
    {
      key: 'status', label: 'Status',
      render: (row: SampleRecord) => <StatusBadge status={row.status} />,
    },
    {
      key: 'actions', label: '',
      render: (row: SampleRecord) => (
        <div className="flex items-center gap-1 justify-end">
          <button
            onClick={() => {
              setEditRow(row)
              setForm({ name: row.name, email: row.email, gstin: row.gstin, status: row.status, notes: '' })
              setShowForm(true)
            }}
            className="p-1.5 rounded-ds-sm text-ds-ink-faint hover:text-ds-brand hover:bg-ds-brand/8 transition-colors"
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={() => setDeleteRow(row)}
            className="p-1.5 rounded-ds-sm text-ds-ink-faint hover:text-ds-error hover:bg-ds-error/8 transition-colors"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ),
    },
  ]

  /* ── Save handler ─────────────────────────────────────────────────── */
  const handleSave = async () => {
    const errs: FormErrors = {}
    if (!form.name)  errs.name  = 'Required'
    if (!form.email) errs.email = 'Required'
    if (Object.keys(errs).length) { setErrors(errs); return }

    setSaving(true)
    await new Promise(r => setTimeout(r, 800)) // TODO: replace with real API call
    setSaving(false)
    setShowForm(false)
    setEditRow(null)
    setForm(FORM_DEFAULTS)
    setErrors({})
    toast.success(editRow ? 'Record updated successfully.' : 'Record created successfully.')
  }

  /* ── Delete handler ───────────────────────────────────────────────── */
  const handleDelete = async () => {
    setDeleting(true)
    await new Promise(r => setTimeout(r, 600)) // TODO: replace with real API call
    setDeleting(false)
    setDeleteRow(null)
    toast.success(`"${deleteRow?.name}" deleted.`)
  }

  return (
    <div className="p-6 space-y-6">

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiCard title="Total Records" value={MOCK.length}                                   icon={Users} color="blue" />
        <KpiCard title="Active"        value={MOCK.filter(r => r.status === 'active').length}  icon={Users} color="green" />
        <KpiCard title="Pending"       value={MOCK.filter(r => r.status === 'pending').length} icon={Users} color="orange" />
      </div>

      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader
        title="Sample Module"
        subtitle="Manage your records"
        action={
          <Button
            icon={Plus}
            onClick={() => { setEditRow(null); setForm(FORM_DEFAULTS); setErrors({}); setShowForm(true) }}
          >
            Add Record
          </Button>
        }
      />

      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <SearchInput value={q} onChange={setQ} placeholder="Search by name or email…" className="w-72" />
      </div>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <DataTable
        columns={columns}
        data={filtered}
        loading={false}
        emptyMessage="No records match your search."
      />

      {/* ── Pagination ────────────────────────────────────────────────── */}
      <Pagination page={page} total={filtered.length} limit={20} onChange={setPage} />

      {/* ── Add / Edit Modal ──────────────────────────────────────────── */}
      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editRow ? 'Edit Record' : 'Add Record'}
        size="md"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Name *"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              error={errors.name}
              placeholder="Company name"
            />
            <Input
              label="Email *"
              type="email"
              value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              error={errors.email}
              placeholder="contact@company.com"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="GSTIN"
              value={form.gstin}
              onChange={e => setForm(f => ({ ...f, gstin: e.target.value }))}
              placeholder="22AAAAA0000A1Z5"
            />
            <Select
              label="Status"
              options={STATUS_OPTIONS}
              value={form.status}
              onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
            />
          </div>
          <Textarea
            label="Notes"
            value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            placeholder="Internal remarks…"
            rows={3}
          />
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 mt-6 pt-5 border-t border-ds-line">
          <Button variant="secondary" onClick={() => setShowForm(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} loading={saving}>
            {editRow ? 'Save Changes' : 'Create Record'}
          </Button>
        </div>
      </Modal>

      {/* ── Delete confirmation ───────────────────────────────────────── */}
      <ConfirmDialog
        open={!!deleteRow}
        onClose={() => setDeleteRow(null)}
        onConfirm={handleDelete}
        title="Delete Record"
        message={`Are you sure you want to delete "${deleteRow?.name}"? This cannot be undone.`}
        confirmLabel="Yes, Delete"
        loading={deleting}
      />

    </div>
  )
}
