'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

type JobCardRow = {
  id: string
  jobCardNumber: number
  setNumber: string | null
  customer: { id: string; name: string }
  requiredSheets: number
  wastageSheets: number
  totalSheets: number
  sheetsIssued: number
  status: string
  artworkApproved: boolean
  firstArticlePass: boolean
  finalQcPass: boolean
  qaReleased: boolean
  batchNumber: string | null
  jobDate: string
  poLine: { id: string; cartonName: string; cartonSize: string | null; quantity: number } | null
}

type Customer = { id: string; name: string }

export default function JobCardsPage() {
  const [list, setList] = useState<JobCardRow[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [customerId, setCustomerId] = useState('')

  useEffect(() => {
    async function load() {
      try {
        const params = new URLSearchParams()
        if (status) params.set('status', status)
        if (customerId) params.set('customerId', customerId)
        const [jcRes, custRes] = await Promise.all([
          fetch(`/api/job-cards?${params}`),
          fetch('/api/masters/customers'),
        ])
        const jcJson = await jcRes.json()
        const custJson = await custRes.json()
        setList(Array.isArray(jcJson) ? jcJson : [])
        setCustomers(Array.isArray(custJson) ? custJson : [])
      } catch {
        toast.error('Failed to load job cards')
      } finally {
        setLoading(false)
      }
    }
    setLoading(true)
    load()
  }, [status, customerId])

  const counts = useMemo(() => {
    const map: Record<string, number> = {}
    list.forEach((j) => {
      map[j.status] = (map[j.status] || 0) + 1
    })
    return map
  }, [list])

  if (loading) return <div className="p-4 text-slate-400">Loading…</div>

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-amber-400">Production Job Cards</h1>
        <Link
          href="/production/job-cards/new"
          className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium"
        >
          New job card
        </Link>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white"
        >
          <option value="">All statuses</option>
          <option value="design_ready">Design ready</option>
          <option value="in_progress">In progress</option>
          <option value="final_qc">Final QC</option>
          <option value="qa_released">QA released</option>
          <option value="closed">Closed</option>
        </select>
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white min-w-[180px]"
        >
          <option value="">All customers</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <div className="ml-auto text-xs text-slate-400 flex gap-3 items-center">
          <span>Design ready: {counts.design_ready ?? 0}</span>
          <span>In progress: {counts.in_progress ?? 0}</span>
          <span>Final QC: {counts.final_qc ?? 0}</span>
          <span>QA released: {counts.qa_released ?? 0}</span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-left">
            <tr>
              <th className="px-4 py-2">JC#</th>
              <th className="px-4 py-2">Customer</th>
              <th className="px-4 py-2">Carton</th>
              <th className="px-4 py-2">Set</th>
              <th className="px-4 py-2">Sheets</th>
              <th className="px-4 py-2">Compliance</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {list.map((jc) => (
              <tr key={jc.id} className="hover:bg-slate-800/60">
                <td className="px-4 py-2 font-mono text-amber-300">{jc.jobCardNumber}</td>
                <td className="px-4 py-2 text-slate-200">{jc.customer?.name}</td>
                <td className="px-4 py-2 text-slate-300">
                  {jc.poLine ? (
                    <>
                      <span>{jc.poLine.cartonName}</span>
                      {jc.poLine.cartonSize && (
                        <span className="text-slate-500 text-xs block">{jc.poLine.cartonSize}</span>
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-2 text-slate-300">{jc.setNumber ?? '—'}</td>
                <td className="px-4 py-2 text-slate-300">
                  {jc.requiredSheets} + {jc.wastageSheets} = {jc.totalSheets}
                  {jc.sheetsIssued > 0 && (
                    <span className="text-slate-500 text-xs block">Issued: {jc.sheetsIssued}</span>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-slate-300 space-x-2">
                  <span className={jc.artworkApproved ? 'text-green-400' : 'text-slate-500'}>Artwork</span>
                  <span className={jc.firstArticlePass ? 'text-green-400' : 'text-slate-500'}>FA</span>
                  <span className={jc.finalQcPass ? 'text-green-400' : 'text-slate-500'}>Final</span>
                  <span className={jc.qaReleased ? 'text-green-400' : 'text-slate-500'}>QA</span>
                </td>
                <td className="px-4 py-2">
                  <span className="px-2 py-0.5 rounded text-xs border bg-slate-900 text-slate-200 border-slate-600">
                    {jc.status}
                  </span>
                </td>
                <td className="px-4 py-2 space-x-2">
                  <Link href={`/production/job-cards/${jc.id}`} className="text-amber-400 hover:underline">
                    Open
                  </Link>
                  <a
                    href={`/api/job-cards/${jc.id}/card-pdf`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-slate-400 hover:underline"
                  >
                    PDF
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && (
        <p className="text-slate-500 text-center py-8 text-sm">No job cards found.</p>
      )}
    </div>
  )
}

