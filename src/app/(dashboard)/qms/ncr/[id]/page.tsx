'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

type NcrDetail = {
  id: string
  jobId: string
  qcRecordId: string | null
  trigger: string
  severity: string
  description: string
  quantityAffected: number | null
  raisedBy: string
  raisedAt: string
  rootCause: string | null
  correctiveAction: string | null
  preventiveAction: string | null
  assignedTo: string | null
  dueDate: string | null
  closedBy: string | null
  closedAt: string | null
  status: string
  job: { id: string; jobNumber: string; productName: string }
  qcRecord: { id: string; checkType: string; result: string } | null
  raiser: { name: string }
  assignee: { name: string } | null
  closer: { name: string } | null
}

type User = { id: string; name: string }

export default function NcrDetailPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const [ncr, setNcr] = useState<NcrDetail | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    rootCause: '',
    correctiveAction: '',
    preventiveAction: '',
    assignedTo: '',
    dueDate: '',
    status: '',
  })

  useEffect(() => {
    fetch(`/api/ncrs/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data || data.error) throw new Error(data.error || 'Failed to load')
        setNcr(data)
        setForm({
          rootCause: data.rootCause ?? '',
          correctiveAction: data.correctiveAction ?? '',
          preventiveAction: data.preventiveAction ?? '',
          assignedTo: data.assignedTo ?? '',
          dueDate: data.dueDate ? data.dueDate.slice(0, 10) : '',
          status: data.status ?? 'open',
        })
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [id])

  useEffect(() => {
    fetch('/api/users')
      .then((r) => r.json())
      .then((data) => setUsers(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch(`/api/ncrs/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rootCause: form.rootCause || null,
          correctiveAction: form.correctiveAction || null,
          preventiveAction: form.preventiveAction || null,
          assignedTo: form.assignedTo || null,
          dueDate: form.dueDate || null,
          status: form.status,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Save failed')
      toast.success('Updated')
      const updated = await fetch(`/api/ncrs/${id}`).then((r) => r.json())
      setNcr(updated)
      setForm({
        rootCause: updated.rootCause ?? '',
        correctiveAction: updated.correctiveAction ?? '',
        preventiveAction: updated.preventiveAction ?? '',
        assignedTo: updated.assignedTo ?? '',
        dueDate: updated.dueDate ? updated.dueDate.slice(0, 10) : '',
        status: updated.status ?? 'open',
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (!ncr) return <div className="p-4 text-slate-400">Loading…</div>

  return (
    <div className="p-4 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/qms/ncr" className="text-sm text-slate-400 hover:text-foreground mb-1 inline-block">
            ← NCR list
          </Link>
          <h1 className="text-xl font-bold text-amber-400">NCR — {ncr.job.jobNumber}</h1>
          <p className="text-sm text-slate-400">
            {ncr.trigger} · {ncr.severity} · Raised by {ncr.raiser.name} ·{' '}
            {new Date(ncr.raisedAt).toLocaleString()}
          </p>
        </div>
      </div>

      <div className="rounded-xl bg-slate-900 border border-slate-700 p-4">
        <h2 className="text-sm font-semibold text-slate-200 mb-2">Description</h2>
        <p className="text-slate-300">{ncr.description}</p>
        {ncr.quantityAffected != null && (
          <p className="text-slate-400 text-sm mt-1">Quantity affected: {ncr.quantityAffected}</p>
        )}
        {ncr.qcRecord && (
          <p className="text-slate-400 text-sm mt-1">
            Linked QC: {ncr.qcRecord.checkType} — {ncr.qcRecord.result}
          </p>
        )}
      </div>

      <form onSubmit={handleSave} className="rounded-xl bg-slate-900 border border-slate-700 p-4 space-y-4">
        <h2 className="text-sm font-semibold text-slate-200">CAPA</h2>
        <div className="grid md:grid-cols-2 gap-4 text-sm">
          <div>
            <label className="block text-slate-400 mb-1">Root cause</label>
            <textarea
              value={form.rootCause}
              onChange={(e) => setForm((f) => ({ ...f, rootCause: e.target.value }))}
              rows={2}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">Corrective action</label>
            <textarea
              value={form.correctiveAction}
              onChange={(e) => setForm((f) => ({ ...f, correctiveAction: e.target.value }))}
              rows={2}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">Preventive action</label>
            <textarea
              value={form.preventiveAction}
              onChange={(e) => setForm((f) => ({ ...f, preventiveAction: e.target.value }))}
              rows={2}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
            />
          </div>
          <div className="space-y-2">
            <div>
              <label className="block text-slate-400 mb-1">Assignee</label>
              <select
                value={form.assignedTo}
                onChange={(e) => setForm((f) => ({ ...f, assignedTo: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
              >
                <option value="">—</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Due date</label>
              <input
                type="date"
                value={form.dueDate}
                onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Status</label>
              <select
                value={form.status}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
              >
                <option value="open">Open</option>
                <option value="in_progress">In progress</option>
                <option value="closed">Closed</option>
                <option value="overdue">Overdue</option>
              </select>
            </div>
          </div>
        </div>
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-primary-foreground text-sm font-medium"
        >
          {saving ? 'Saving…' : 'Save CAPA'}
        </button>
      </form>

      {ncr.closedAt && (
        <p className="text-sm text-slate-500">
          Closed by {ncr.closer?.name ?? '—'} on {new Date(ncr.closedAt).toLocaleString()}
        </p>
      )}
    </div>
  )
}
