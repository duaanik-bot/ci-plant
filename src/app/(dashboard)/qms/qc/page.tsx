'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { QC_INSTRUMENTS } from '@/lib/constants'

type QcRecord = {
  id: string
  jobId: string
  checkType: string
  instrumentName: string
  measuredValue: string | null
  specMin: string | null
  specMax: string | null
  result: string
  isFirstArticle: boolean
  checkedAt: string
  job: { jobNumber: string; productName: string }
  checker: { name: string }
}

type Job = { id: string; jobNumber: string; productName: string }

export default function QcRecordsPage() {
  const [list, setList] = useState<QcRecord[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [jobId, setJobId] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    jobId: '',
    checkType: 'colour_delta_e',
    instrumentName: QC_INSTRUMENTS[0] ?? '',
    measuredValue: '',
    specMin: '',
    specMax: '',
    result: 'PASS' as 'PASS' | 'FAIL',
    isFirstArticle: false,
    notes: '',
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const params = jobId ? `?jobId=${jobId}` : ''
    fetch(`/api/qc-records${params}`)
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load QC records'))
  }, [jobId])

  useEffect(() => {
    fetch('/api/jobs')
      .then((r) => r.json())
      .then((data) => setJobs(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.jobId) {
      toast.error('Select a job')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/qc-records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          measuredValue: form.measuredValue || null,
          specMin: form.specMin || null,
          specMax: form.specMax || null,
          notes: form.notes || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to create')
      toast.success('QC record added')
      setShowForm(false)
      setForm({
        jobId: '',
        checkType: 'colour_delta_e',
        instrumentName: QC_INSTRUMENTS[0] ?? '',
        measuredValue: '',
        specMin: '',
        specMax: '',
        result: 'PASS',
        isFirstArticle: false,
        notes: '',
      })
      const params = jobId ? `?jobId=${jobId}` : ''
      const listRes = await fetch(`/api/qc-records${params}`)
      const listData = await listRes.json()
      setList(Array.isArray(listData) ? listData : [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-amber-400">QC Records</h1>
        <button
          type="button"
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium"
        >
          {showForm ? 'Cancel' : 'Add QC record'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-xl bg-slate-900 border border-slate-700 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-slate-200">New QC record</h2>
          <div className="grid md:grid-cols-2 gap-3 text-sm">
            <div>
              <label className="block text-slate-400 mb-1">Job *</label>
              <select
                value={form.jobId}
                onChange={(e) => setForm((f) => ({ ...f, jobId: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
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
              <label className="block text-slate-400 mb-1">Check type</label>
              <input
                type="text"
                value={form.checkType}
                onChange={(e) => setForm((f) => ({ ...f, checkType: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Instrument</label>
              <select
                value={form.instrumentName}
                onChange={(e) => setForm((f) => ({ ...f, instrumentName: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
              >
                {QC_INSTRUMENTS.map((inst) => (
                  <option key={inst} value={inst}>
                    {inst}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Result *</label>
              <select
                value={form.result}
                onChange={(e) => setForm((f) => ({ ...f, result: e.target.value as 'PASS' | 'FAIL' }))}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
              >
                <option value="PASS">PASS</option>
                <option value="FAIL">FAIL</option>
              </select>
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Measured value</label>
              <input
                type="text"
                value={form.measuredValue}
                onChange={(e) => setForm((f) => ({ ...f, measuredValue: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Spec min / max</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Min"
                  value={form.specMin}
                  onChange={(e) => setForm((f) => ({ ...f, specMin: e.target.value }))}
                  className="flex-1 px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
                />
                <input
                  type="text"
                  placeholder="Max"
                  value={form.specMax}
                  onChange={(e) => setForm((f) => ({ ...f, specMax: e.target.value }))}
                  className="flex-1 px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
                />
              </div>
            </div>
            <div className="md:col-span-2 flex items-center gap-2">
              <input
                id="fa"
                type="checkbox"
                checked={form.isFirstArticle}
                onChange={(e) => setForm((f) => ({ ...f, isFirstArticle: e.target.checked }))}
                className="rounded border-slate-600 bg-slate-800"
              />
              <label htmlFor="fa" className="text-slate-300 text-sm">
                First article
              </label>
            </div>
            <div className="md:col-span-2">
              <label className="block text-slate-400 mb-1">Notes</label>
              <input
                type="text"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}

      <div className="flex gap-2 text-sm">
        <select
          value={jobId}
          onChange={(e) => setJobId(e.target.value)}
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
        >
          <option value="">All jobs</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.jobNumber}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-4 py-2">Job</th>
              <th className="px-4 py-2">Check</th>
              <th className="px-4 py-2">Instrument</th>
              <th className="px-4 py-2">Value</th>
              <th className="px-4 py-2">Result</th>
              <th className="px-4 py-2">FA</th>
              <th className="px-4 py-2">Checked by</th>
              <th className="px-4 py-2">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {list.map((r) => (
              <tr key={r.id} className="hover:bg-slate-800/60">
                <td className="px-4 py-2 font-mono text-amber-300">{r.job.jobNumber}</td>
                <td className="px-4 py-2 text-slate-200">{r.checkType}</td>
                <td className="px-4 py-2 text-slate-300">{r.instrumentName}</td>
                <td className="px-4 py-2 text-slate-300">{r.measuredValue ?? '—'}</td>
                <td className="px-4 py-2">
                  <span className={r.result === 'PASS' ? 'text-green-400' : 'text-red-400'}>
                    {r.result}
                  </span>
                </td>
                <td className="px-4 py-2 text-slate-400">{r.isFirstArticle ? 'Yes' : '—'}</td>
                <td className="px-4 py-2 text-slate-300">{r.checker.name}</td>
                <td className="px-4 py-2 text-slate-400">
                  {new Date(r.checkedAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && (
        <p className="text-slate-500 text-center py-8 text-sm">No QC records found.</p>
      )}
    </div>
  )
}
