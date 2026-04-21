'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { format, differenceInDays } from 'date-fns'
import {
  EnterpriseTableShell,
  enterpriseTableClass,
  enterpriseTheadClass,
  enterpriseTbodyClass,
  enterpriseTrClass,
  enterpriseThClass,
  enterpriseTdClass,
  enterpriseTdMonoClass,
  enterpriseTdMutedClass,
} from '@/components/ui/EnterpriseTableShell'

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

  if (loading) {
    return <div className="p-4 text-sm text-slate-600 dark:text-slate-400">Loading…</div>
  }

  const statusBadge = (status: string) => {
    const colours: Record<string, string> = {
      pending_artwork: 'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200',
      artwork_approved: 'bg-blue-100 text-blue-900 dark:bg-blue-900/50 dark:text-blue-200',
      in_production: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-200',
      closed: 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-300',
      dispatched: 'bg-purple-100 text-purple-900 dark:bg-purple-900/50 dark:text-purple-200',
    }
    return (
      <span className={`rounded px-2 py-0.5 text-xs font-medium ${colours[status] ?? 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-300'}`}>
        {status.replace(/_/g, ' ')}
      </span>
    )
  }

  const inputCls =
    'min-h-[40px] min-w-[80px] rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-card-foreground'

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold text-slate-900 dark:text-slate-50">Jobs</h1>
        <Link href="/jobs/new" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          New job
        </Link>
      </div>

      <div className="mb-4 flex flex-wrap gap-4">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputCls}>
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
          className={`${inputCls} w-48`}
        />
      </div>

      <EnterpriseTableShell>
        <table className={enterpriseTableClass}>
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>Job #</th>
              <th className={enterpriseThClass}>Customer</th>
              <th className={enterpriseThClass}>Product</th>
              <th className={enterpriseThClass}>Qty</th>
              <th className={enterpriseThClass}>Status</th>
              <th className={enterpriseThClass}>Due date</th>
              <th className={enterpriseThClass}>Days left</th>
              <th className={enterpriseThClass}>Actions</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {jobs.map((job) => {
              const due = new Date(job?.dueDate ?? '')
              const daysLeft = Number.isNaN(due.getTime()) ? '—' : differenceInDays(due, new Date())
              return (
                <tr key={job.id} className={enterpriseTrClass}>
                  <td className={`${enterpriseTdMonoClass} text-amber-800 dark:text-amber-400`}>{job?.jobNumber ?? '—'}</td>
                  <td className={enterpriseTdClass}>{job?.customer?.name ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{job?.productName ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{job?.qtyOrdered ?? '—'}</td>
                  <td className={enterpriseTdClass}>{statusBadge(job?.status ?? '')}</td>
                  <td className={enterpriseTdMonoClass}>{Number.isNaN(due.getTime()) ? '—' : format(due, 'dd MMM yyyy')}</td>
                  <td
                    className={`${enterpriseTdMonoClass} ${
                      typeof daysLeft === 'number' && daysLeft < 2 ? 'font-semibold text-rose-600 dark:text-rose-400' : ''
                    }`}
                  >
                    {daysLeft}
                  </td>
                  <td className={enterpriseTdClass}>
                    <Link href={`/jobs/${job?.id ?? ''}`} className="mr-2 text-blue-600 hover:underline dark:text-blue-400">
                      View
                    </Link>
                    <a
                      href={`/api/jobs/${job?.id ?? ''}/card-pdf`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-slate-600 hover:underline dark:text-slate-400"
                    >
                      PDF
                    </a>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </EnterpriseTableShell>
      {jobs.length === 0 && <p className="py-8 text-center text-sm text-slate-600 dark:text-slate-400">No jobs found.</p>}
    </div>
  )
}
