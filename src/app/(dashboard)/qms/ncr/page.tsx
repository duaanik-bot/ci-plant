'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

type Ncr = {
  id: string
  jobId: string
  trigger: string
  severity: string
  description: string
  quantityAffected: number | null
  status: string
  raisedAt: string
  dueDate: string | null
  job: { jobNumber: string; productName: string }
  raiser: { name: string }
  assignee: { name: string } | null
}

type Job = { id: string; jobNumber: string; productName: string }

const TRIGGERS = ['qc_fail', 'excess_wastage', 'customer_complaint', 'old_stock', 'other']

export default function NcrListPage() {
  const [list, setList] = useState<Ncr[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [jobId, setJobId] = useState('')
  const [status, setStatus] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    jobId: '',
    trigger: 'qc_fail',
    severity: 'major' as 'critical' | 'major' | 'minor',
    description: '',
    quantityAffected: '',
  })
  const [saving, setSaving] = useState(false)

  const fetchList = () => {
    const params = new URLSearchParams()
    if (jobId) params.set('jobId', jobId)
    if (status) params.set('status', status)
    return fetch(`/api/ncrs?${params}`)
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
  }

  useEffect(() => {
    const params = new URLSearchParams()
    if (jobId) params.set('jobId', jobId)
    if (status) params.set('status', status)
    fetchList().catch(() => toast.error('Failed to load NCRs'))
  }, [jobId, status])

  useEffect(() => {
    fetch('/api/jobs')
      .then((r) => r.json())
      .then((data) => setJobs(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  const statusBadge = (s: string) => {
    const cls =
      s === 'closed'
        ? 'bg-green-900/40 text-green-300 border-green-600'
        : s === 'overdue'
        ? 'bg-red-900/40 text-red-300 border-red-600'
        : s === 'in_progress'
        ? 'bg-blue-900/40 text-blue-300 border-blue-600'
        : 'bg-amber-900/40 text-amber-300 border-amber-600'
    return (
      <span className={`px-2 py-0.5 rounded text-xs border ${cls}`}>{s}</span>
    )
  }

  const severityBadge = (s: string) => {
    const cls =
      s === 'critical'
        ? 'text-red-400'
        : s === 'major'
        ? 'text-amber-400'
        : 'text-slate-400'
    return <span className={cls}>{s}</span>
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.jobId || !form.description) {
      toast.error('Job and description required')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/ncrs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: form.jobId,
          trigger: form.trigger,
          severity: form.severity,
          description: form.description,
          quantityAffected: form.quantityAffected ? Number(form.quantityAffected) : null,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to create')
      toast.success('NCR created')
      setShowForm(false)
      setForm({ jobId: '', trigger: 'qc_fail', severity: 'major', description: '', quantityAffected: '' })
      await fetchList()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-amber-400">NCR / CAPA</h1>
        <button
          type="button"
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-primary-foreground text-sm font-medium"
        >
          {showForm ? 'Cancel' : 'Raise NCR'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-xl bg-slate-900 border border-slate-700 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-slate-200">Raise NCR</h2>
          <div className="grid md:grid-cols-2 gap-3 text-sm">
            <div>
              <label className="block text-slate-400 mb-1">Job *</label>
              <select
                value={form.jobId}
                onChange={(e) => setForm((f) => ({ ...f, jobId: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
              >
                <option value="">Select job…</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.jobNumber} — {j.productName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Trigger</label>
              <select
                value={form.trigger}
                onChange={(e) => setForm((f) => ({ ...f, trigger: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
              >
                {TRIGGERS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Severity</label>
              <select
                value={form.severity}
                onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value as any }))}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
              >
                <option value="critical">Critical</option>
                <option value="major">Major</option>
                <option value="minor">Minor</option>
              </select>
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Qty affected</label>
              <input
                type="number"
                min={0}
                value={form.quantityAffected}
                onChange={(e) => setForm((f) => ({ ...f, quantityAffected: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-slate-400 mb-1">Description *</label>
              <textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={2}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-primary-foreground text-sm font-medium"
          >
            {saving ? 'Saving…' : 'Create NCR'}
          </button>
        </form>
      )}

      <div className="flex flex-wrap gap-3 text-sm">
        <select
          value={jobId}
          onChange={(e) => setJobId(e.target.value)}
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-foreground"
        >
          <option value="">All jobs</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.jobNumber}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-foreground"
        >
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="closed">Closed</option>
          <option value="overdue">Overdue</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-4 py-2">Job</th>
              <th className="px-4 py-2">Trigger</th>
              <th className="px-4 py-2">Severity</th>
              <th className="px-4 py-2">Description</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Assignee</th>
              <th className="px-4 py-2">Due</th>
              <th className="px-4 py-2">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {list.map((n) => (
              <tr key={n.id} className="hover:bg-slate-800/60">
                <td className="px-4 py-2 font-mono text-amber-300">{n.job.jobNumber}</td>
                <td className="px-4 py-2 text-slate-200">{n.trigger}</td>
                <td className="px-4 py-2">{severityBadge(n.severity)}</td>
                <td className="px-4 py-2 text-slate-300 max-w-xs truncate">{n.description}</td>
                <td className="px-4 py-2">{statusBadge(n.status)}</td>
                <td className="px-4 py-2 text-slate-300">{n.assignee?.name ?? '—'}</td>
                <td className="px-4 py-2 text-slate-400">
                  {n.dueDate ? new Date(n.dueDate).toLocaleDateString() : '—'}
                </td>
                <td className="px-4 py-2">
                  <Link href={`/qms/ncr/${n.id}`} className="text-amber-400 hover:underline">
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && (
        <p className="text-slate-500 text-center py-8 text-sm">No NCRs found.</p>
      )}
    </div>
  )
}
