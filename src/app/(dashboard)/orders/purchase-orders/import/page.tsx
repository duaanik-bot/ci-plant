'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { toast } from '@/store/toastStore'

type ItemStatus = 'pending' | 'extracting' | 'ready' | 'needs_review' | 'failed' | 'committed'

type InboxItem = {
  id: string
  filename: string
  status: ItemStatus
  errorMessage: string | null
  committedPoId: string | null
  customerName: string | null
  customerConfidence: number | null
  poNumber: string | null
  lineCount: number | null
  /** Set when an earlier file in this same batch already used this poNumber. */
  duplicateOf: string | null
  createdAt: string
}

type JobResponse = {
  ok: true
  job: { id: string; fileCount: number; createdAt: string; allDone: boolean }
  items: InboxItem[]
}

const STATUS_LABEL: Record<ItemStatus, string> = {
  pending: 'Queued',
  extracting: 'Extracting…',
  ready: 'Ready',
  needs_review: 'Needs review',
  failed: 'Failed',
  committed: 'Committed',
}

const STATUS_TONE: Record<ItemStatus, string> = {
  pending: 'bg-slate-100 text-slate-700',
  extracting: 'bg-blue-100 text-blue-700',
  ready: 'bg-emerald-100 text-emerald-700',
  needs_review: 'bg-amber-100 text-amber-800',
  failed: 'bg-rose-100 text-rose-700',
  committed: 'bg-violet-100 text-violet-700',
}

export default function PoBulkImportPage() {
  const [jobId, setJobId] = useState<string | null>(null)
  const [items, setItems] = useState<InboxItem[]>([])
  const [allDone, setAllDone] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Poll the job until every item reaches a terminal status.
  useEffect(() => {
    if (!jobId || allDone) return
    let cancelled = false
    const tick = async () => {
      try {
        const res = await fetch(`/api/purchase-orders/import/jobs/${jobId}`, { cache: 'no-store' })
        if (!res.ok) return
        const data = (await res.json()) as JobResponse
        if (cancelled) return
        setItems(data.items)
        setAllDone(data.job.allDone)
      } catch {
        // transient; next tick will retry
      }
    }
    tick()
    const interval = setInterval(tick, 2000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [jobId, allDone])

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return
    const form = new FormData()
    for (const f of Array.from(files)) form.append('files', f)
    setUploading(true)
    try {
      const res = await fetch('/api/purchase-orders/import/bulk', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Upload failed')
        return
      }
      setJobId(data.jobId)
      setItems([])
      setAllDone(false)
      toast.success(`Queued ${data.itemCount} PDF${data.itemCount === 1 ? '' : 's'}`)
    } catch {
      toast.error('Upload failed — please retry')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const readyCount = items.filter((i) => i.status === 'ready').length
  const reviewCount = items.filter((i) => i.status === 'needs_review').length
  const failedCount = items.filter((i) => i.status === 'failed').length

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-end justify-between">
        <div>
          <Link
            href="/orders/purchase-orders"
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            ← Purchase orders
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Bulk PO Import</h1>
          <p className="text-sm text-slate-500">
            Upload up to 20 PO PDFs. Each one is extracted in parallel and lands in the inbox below.
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8">
        <label className="block cursor-pointer text-center">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="application/pdf,.pdf"
            className="sr-only"
            onChange={(e) => handleUpload(e.target.files)}
            disabled={uploading}
          />
          <div className="text-sm font-medium text-slate-700">
            {uploading ? 'Uploading…' : 'Click to select PDFs (up to 20)'}
          </div>
          <div className="mt-1 text-xs text-slate-500">Max 8 MB each. Text-based PDFs only.</div>
        </label>
      </div>

      {jobId && (
        <>
          <div className="flex flex-wrap gap-2 text-xs">
            <Pill tone="emerald">{readyCount} ready</Pill>
            <Pill tone="amber">{reviewCount} need review</Pill>
            <Pill tone="rose">{failedCount} failed</Pill>
            {!allDone && <Pill tone="blue">processing…</Pill>}
          </div>

          <div className="overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">File</th>
                  <th className="px-4 py-2">Customer</th>
                  <th className="px-4 py-2">PO #</th>
                  <th className="px-4 py-2 text-right">Lines</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((it) => (
                  <tr key={it.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2 font-medium text-slate-800">{it.filename}</td>
                    <td className="px-4 py-2 text-slate-600">{it.customerName ?? '—'}</td>
                    <td className="px-4 py-2 text-slate-600">
                      {it.poNumber ?? '—'}
                      {it.duplicateOf && (
                        <div className="mt-0.5 text-xs text-amber-700">
                          ⚠ same PO # as {it.duplicateOf}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-slate-600">{it.lineCount ?? '—'}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[it.status]}`}
                      >
                        {STATUS_LABEL[it.status]}
                      </span>
                      {it.status === 'failed' && it.errorMessage && (
                        <div className="mt-1 text-xs text-rose-600">{it.errorMessage}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {/* Wired up in the next milestone — opens the existing PoImportDrawer
                          seeded with this item's extracted JSON, or fires a commit. */}
                      {(it.status === 'ready' || it.status === 'needs_review') && (
                        <button
                          type="button"
                          className="text-xs font-medium text-blue-600 hover:text-blue-700"
                          onClick={() => toast.info('Drawer wiring lands in the next step')}
                        >
                          Open
                        </button>
                      )}
                      {it.status === 'committed' && it.committedPoId && (
                        <Link
                          href={`/orders/purchase-orders/${it.committedPoId}`}
                          className="text-xs font-medium text-violet-600 hover:text-violet-700"
                        >
                          View PO
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td className="px-4 py-6 text-center text-sm text-slate-400" colSpan={6}>
                      Waiting for first item to start extracting…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function Pill({ tone, children }: { tone: 'emerald' | 'amber' | 'rose' | 'blue'; children: React.ReactNode }) {
  const map = {
    emerald: 'bg-emerald-100 text-emerald-800',
    amber: 'bg-amber-100 text-amber-800',
    rose: 'bg-rose-100 text-rose-800',
    blue: 'bg-blue-100 text-blue-800',
  } as const
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 font-medium ${map[tone]}`}>
      {children}
    </span>
  )
}
