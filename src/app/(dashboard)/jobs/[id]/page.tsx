'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { format } from 'date-fns'

type Job = {
  id: string
  jobNumber: string
  productName: string
  qtyOrdered: number
  qtyProducedGood: number
  imposition: number
  status: string
  dueDate: string
  specialInstructions: string | null
  customer: { name: string }
  creator: { name: string; email: string }
  artwork?: { versionNumber: number; status: string; locksCompleted: number } | null
  bomLines: Array<{
    id: string
    netQty: number
    qtyApproved: number
    qtyIssued: number
    material: { materialCode: string; description: string; unit: string }
    machine?: { machineCode: string; name: string } | null
  }>
  stages: Array<{
    id: string
    stageNumber: number
    startedAt: string
    completedAt: string | null
    qtyIn: number | null
    qtyOut: number | null
    qtyWaste: number
    machine?: { machineCode: string; name: string } | null
    starter: { name: string }
    completer?: { name: string } | null
  }>
  qcRecords: Array<{ id: string; checkType: string; result: string; checkedAt: string }>
}

const TABS = ['Overview', 'Stages', 'Materials', 'QC Records', 'Artwork', 'Cost'] as const

export default function JobDetailPage() {
  const params = useParams()
  const id = params.id as string
  const [job, setJob] = useState<Job | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<(typeof TABS)[number]>('Overview')

  useEffect(() => {
    fetch(`/api/jobs/${id}`)
      .then((r) => r.json())
      .then(setJob)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [id])

  if (loading || !job) {
    return <div className="p-4 text-slate-400">Loading…</div>
  }

  return (
    <div className="p-4 max-w-4xl mx-auto">
      <div className="flex items-center gap-4 mb-4">
        <Link href="/jobs" className="text-slate-400 hover:text-white text-sm">← Jobs</Link>
        <h1 className="text-xl font-bold text-amber-400">{job.jobNumber}</h1>
        <span className="px-2 py-0.5 rounded text-xs bg-slate-700 text-slate-300">{job.status.replace(/_/g, ' ')}</span>
        <a
          href={`/api/jobs/${id}/card-pdf`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-amber-400 hover:underline"
        >
          Job card PDF
        </a>
      </div>

      <div className="flex gap-2 mb-6 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded text-sm whitespace-nowrap ${
              tab === t ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Overview' && (
        <div className="space-y-2 bg-slate-800 rounded-lg p-4">
          <p><span className="text-slate-400">Customer:</span> {job.customer.name}</p>
          <p><span className="text-slate-400">Product:</span> {job.productName}</p>
          <p><span className="text-slate-400">Qty ordered:</span> {job.qtyOrdered}</p>
          <p><span className="text-slate-400">Qty produced (good):</span> {job.qtyProducedGood}</p>
          <p><span className="text-slate-400">Imposition:</span> {job.imposition}</p>
          <p><span className="text-slate-400">Due date:</span> {format(new Date(job.dueDate), 'dd MMM yyyy')}</p>
          <p><span className="text-slate-400">Created by:</span> {job.creator.name}</p>
          {job.specialInstructions && (
            <p><span className="text-slate-400">Instructions:</span> {job.specialInstructions}</p>
          )}
        </div>
      )}

      {tab === 'Stages' && (
        <div className="space-y-2">
          {job.stages.length === 0 ? (
            <p className="text-slate-400">No stages yet.</p>
          ) : (
            job.stages.map((s) => (
              <div key={s.id} className="bg-slate-800 rounded-lg p-3 flex flex-wrap gap-4">
                <span>Stage {s.stageNumber}</span>
                <span>{s.machine?.machineCode ?? '—'}</span>
                <span>Started: {format(new Date(s.startedAt), 'dd MMM HH:mm')} by {s.starter.name}</span>
                {s.completedAt && (
                  <span>Completed: {format(new Date(s.completedAt), 'dd MMM HH:mm')} {s.completer?.name && `by ${s.completer.name}`}</span>
                )}
                {s.qtyIn != null && <span>Qty in: {s.qtyIn}</span>}
                {s.qtyOut != null && <span>Qty out: {s.qtyOut}</span>}
                <span>Waste: {s.qtyWaste}</span>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'Materials' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left border-b border-slate-700"><th className="py-2">Material</th><th className="py-2">Net</th><th className="py-2">Approved</th><th className="py-2">Issued</th><th className="py-2">Unit</th></tr></thead>
            <tbody>
              {job.bomLines.map((line) => (
                <tr key={line.id} className="border-b border-slate-700">
                  <td className="py-2">{line.material.materialCode} — {line.material.description}</td>
                  <td className="py-2">{Number(line.netQty)}</td>
                  <td className="py-2">{Number(line.qtyApproved)}</td>
                  <td className="py-2">{Number(line.qtyIssued)}</td>
                  <td className="py-2">{line.material.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {job.bomLines.length === 0 && <p className="text-slate-400 py-4">No BOM lines.</p>}
        </div>
      )}

      {tab === 'QC Records' && (
        <div className="space-y-2">
          {job.qcRecords.length === 0 ? (
            <p className="text-slate-400">No QC records.</p>
          ) : (
            job.qcRecords.map((qc) => (
              <div key={qc.id} className="bg-slate-800 rounded-lg p-3 flex gap-4">
                <span>{qc.checkType}</span>
                <span className={qc.result === 'PASS' ? 'text-green-400' : 'text-red-400'}>{qc.result}</span>
                <span className="text-slate-400">{format(new Date(qc.checkedAt), 'dd MMM HH:mm')}</span>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'Artwork' && (
        <div className="bg-slate-800 rounded-lg p-4">
          {job.artwork ? (
            <p>Version {job.artwork.versionNumber}, status: {job.artwork.status}, locks: {job.artwork.locksCompleted}/4</p>
          ) : (
            <p className="text-slate-400">No artwork yet.</p>
          )}
          <Link href={`/artwork/${id}`} className="text-amber-400 hover:underline text-sm mt-2 inline-block">Open artwork page →</Link>
        </div>
      )}

      {tab === 'Cost' && (
        <div className="bg-slate-800 rounded-lg p-4">
          <p className="text-slate-400">Material cost actual vs planned — Phase 3/4.</p>
        </div>
      )}
    </div>
  )
}
