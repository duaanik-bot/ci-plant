'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { format, differenceInDays } from 'date-fns'

type Job = {
  id: string
  jobNumber: string
  productName: string
  qtyOrdered: number
  dueDate: string
  status: string
  customer: { name: string }
  artwork?: { versionNumber: number; status: string; locksCompleted: number } | null
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [customerFilter, setCustomerFilter] = useState('')

  useEffect(() => {
    const params = new URLSearchParams()
    if (statusFilter) params.set('status', statusFilter)
    if (customerFilter) params.set('customerId', customerFilter)
    fetch(`/api/jobs?${params}`)
      .then((r) => r.json())
      .then(setJobs)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [statusFilter, customerFilter])

  if (loading) return <div className="p-4 text-slate-400">Loading…</div>

  const statusBadge = (status: string) => {
    const colours: Record<string, string> = {
      pending_artwork: 'bg-amber-900/50 text-amber-200',
      artwork_approved: 'bg-blue-900/50 text-blue-200',
      in_production: 'bg-green-900/50 text-green-200',
      closed: 'bg-slate-700 text-slate-300',
      dispatched: 'bg-purple-900/50 text-purple-200',
    }
    return (
      <span
        className={`px-2 py-0.5 rounded text-xs ${
          colours[status] ?? 'bg-slate-700 text-slate-300'
        }`}
      >
        {status.replace(/_/g, ' ')}
      </span>
    )
  }

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-amber-400">Jobs</h1>
        <Link
          href="/jobs/new"
          className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium"
        >
          New job
        </Link>
      </div>

      <div className="flex gap-4 mb-4 flex-wrap">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white text-sm"
        >
          <option value="">All statuses</option>
          <option value="pending_artwork">Pending artwork</option>
          <option value="artwork_approved">Artwork approved</option>
          <option value="in_production">In production</option>
          <option value="folding">Folding</option>
          <option value="final_qc">Final QC</option>
          <option value="packing">Packing</option>
          <option value="dispatched">Dispatched</option>
          <option value="closed">Closed</option>
        </select>
        <input
          type="text"
          placeholder="Customer ID filter"
          value={customerFilter}
          onChange={(e) => setCustomerFilter(e.target.value)}
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white text-sm w-48"
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">Job #</th>
              <th className="px-4 py-2 font-medium">Customer</th>
              <th className="px-4 py-2 font-medium">Product</th>
              <th className="px-4 py-2 font-medium">Qty</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Due date</th>
              <th className="px-4 py-2 font-medium">Days left</th>
              <th className="px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {jobs.map((job) => {
              const due = new Date(job.dueDate)
              const daysLeft = differenceInDays(due, new Date())
              return (
                <tr key={job.id} className="hover:bg-slate-800/50">
                  <td className="px-4 py-2 font-mono text-amber-400">{job.jobNumber}</td>
                  <td className="px-4 py-2">{job.customer.name}</td>
                  <td className="px-4 py-2">{job.productName}</td>
                  <td className="px-4 py-2">{job.qtyOrdered}</td>
                  <td className="px-4 py-2">{statusBadge(job.status)}</td>
                  <td className="px-4 py-2">{format(due, 'dd MMM yyyy')}</td>
                  <td className={`px-4 py-2 ${daysLeft < 2 ? 'text-red-400 font-semibold' : ''}`}>
                    {daysLeft}
                  </td>
                  <td className="px-4 py-2">
                    <Link
                      href={`/jobs/${job.id}`}
                      className="text-amber-400 hover:underline mr-2"
                    >
                      View
                    </Link>
                    <a
                      href={`/api/jobs/${job.id}/card-pdf`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-slate-400 hover:underline"
                    >
                      PDF
                    </a>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {jobs.length === 0 && (
        <p className="text-slate-400 text-center py-8">No jobs found.</p>
      )}
    </div>
  )
}
