'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { format, differenceInDays } from 'date-fns'
import { Button, StatusBadge } from '@/components/design-system'
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
  const [localSearch, setLocalSearch] = useState('')

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
    return <div className="p-4 text-sm text-ds-ink-faint dark:text-ds-ink-muted">Loading…</div>
  }

  const inputCls = 'ds-input h-9 min-w-[80px] py-1.5'
  const filteredJobs = jobs.filter((job) => {
    const q = localSearch.trim().toLowerCase()
    if (!q) return true
    return (
      String(job.jobNumber ?? '').toLowerCase().includes(q) ||
      String(job.productName ?? '').toLowerCase().includes(q) ||
      String(job.customer?.name ?? '').toLowerCase().includes(q)
    )
  })

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold text-neutral-900 dark:text-ds-ink">Jobs</h1>
        <Link href="/jobs/new"><Button>New Job</Button></Link>
      </div>

      <div className="ds-toolbar mb-4">
        <input
          type="search"
          placeholder="Search by job card, product, client…"
          value={localSearch}
          onChange={(e) => setLocalSearch(e.target.value)}
          className="ds-toolbar-search"
        />
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
            {filteredJobs.map((job) => {
              const due = new Date(job?.dueDate ?? '')
              const daysLeft = Number.isNaN(due.getTime()) ? '—' : differenceInDays(due, new Date())
              return (
                <tr key={job.id} className={enterpriseTrClass}>
                  <td className={`${enterpriseTdMonoClass} text-ds-warning dark:text-ds-warning`}>{job?.jobNumber ?? '—'}</td>
                  <td className={enterpriseTdClass}>{job?.customer?.name ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{job?.productName ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{job?.qtyOrdered ?? '—'}</td>
                  <td className={enterpriseTdClass}><StatusBadge status={(job?.status ?? '').replace(/_/g, ' ')} /></td>
                  <td className={enterpriseTdMonoClass}>{Number.isNaN(due.getTime()) ? '—' : format(due, 'dd MMM yyyy')}</td>
                  <td
                    className={`${enterpriseTdMonoClass} ${
                      typeof daysLeft === 'number' && daysLeft < 2 ? 'font-semibold text-[var(--error)] dark:text-[var(--error)]' : ''
                    }`}
                  >
                    {daysLeft}
                  </td>
                  <td className={enterpriseTdClass}>
                    <div className="flex items-center gap-2">
                      <Link href={`/jobs/${job?.id ?? ''}`} className="rounded border border-[var(--info)]/40 bg-[var(--info-bg)] px-2 py-1 text-xs font-medium text-[var(--info)] hover:bg-[var(--info-bg)]">
                        View
                      </Link>
                      <a
                        href={`/api/jobs/${job?.id ?? ''}/card-pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded border border-ds-line/70 px-2 py-1 text-xs text-ds-ink-muted hover:bg-ds-elevated"
                      >
                        PDF
                      </a>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </EnterpriseTableShell>
      {filteredJobs.length === 0 && <p className="ds-empty-state">No jobs match current filters. Try clearing filters or search.</p>}
    </div>
  )
}
