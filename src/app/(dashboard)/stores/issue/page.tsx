'use client'

import { useState, useCallback, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Html5Qrcode } from 'html5-qrcode'
import { toast } from 'sonner'
import { useAutoPopulate } from '@/hooks/useAutoPopulate'
import { MasterSearchSelect } from '@/components/ui/MasterSearchSelect'

type IssueContextOption = { id: string; label: string }

type BomLineInfo = {
  id: string
  type?: 'job_card'
  materialCode: string
  materialDescription: string
  unit: string
  qtyApproved: number
  qtyAlreadyIssued: number
  remaining: number
}

type JobContext = {
  type?: 'job' | 'job_card'
  id: string
  jobNumber: string
  productName: string
  customerName: string
  bomLines: BomLineInfo[]
}

const REASON_CODES = [
  { value: 'substrate_quality', label: 'Substrate quality issue' },
  { value: 'machine_setting', label: 'Machine setting problem' },
  { value: 'colour_standard', label: 'Customer colour standard issue' },
  { value: 'die_cutting_waste', label: 'Die cutting waste higher than expected' },
  { value: 'other', label: 'Other (requires detail)' },
] as const

export default function StoresIssuePage() {
  const [scanning, setScanning] = useState(false)
  const [scanner, setScanner] = useState<Html5Qrcode | null>(null)
  const [jobContext, setJobContext] = useState<JobContext | null>(null)
  const [manualJobId, setManualJobId] = useState('')
  const [issueQty, setIssueQty] = useState<Record<string, string>>({})
  const [lotNumber, setLotNumber] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [hardStop, setHardStop] = useState<{
    message: string
    excessRequestId: string
    jobNumber: string
    materialCode: string
    approvedQty: number
    totalIssued: number
  } | null>(null)
  const [excessForm, setExcessForm] = useState<{
    requestId: string
    reasonCode: string
    reasonDetail: string
    additionalQty: string
  } | null>(null)
  const [excessSubmitting, setExcessSubmitting] = useState(false)
  const [pollingApproval, setPollingApproval] = useState<string | null>(null)

  const contextSearch = useAutoPopulate<IssueContextOption>({
    storageKey: 'issue-job-card',
    search: async (query: string) => {
      const res = await fetch('/api/job-cards')
      const list = (await res.json()) as { id: string; jobCardNumber: number; customer?: { name: string } }[]
      if (!Array.isArray(list)) return []
      const q = query.toLowerCase()
      return list
        .map((jc) => ({
          id: jc.id,
          label: `JC#${jc.jobCardNumber} ${(jc.customer?.name ?? '').trim()}`,
        }))
        .filter((x) => x.label.toLowerCase().includes(q))
    },
    getId: (x) => x.id,
    getLabel: (x) => x.label,
  })

  const applyContext = (item: IssueContextOption) => {
    contextSearch.select(item)
    fetchJobCardContext(item.id)
  }

  const startScanner = useCallback(() => {
    setJobContext(null)
    setManualJobId('')
    setIssueQty({})
    setLotNumber({})
    setHardStop(null)
    setExcessForm(null)
    const el = document.getElementById('qr-reader')
    if (!el) return
    const html5Qr = new Html5Qrcode('qr-reader')
    html5Qr
      .start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 280, height: 280 } },
        (decodedText) => {
          html5Qr.stop().then(() => {
            setScanner(null)
            setScanning(false)
            const jobId = decodedText.trim()
            if (jobId.length < 5) {
              toast.error('Invalid QR code')
              return
            }
            fetchJobContext(jobId)
          })
        },
        () => {}
      )
      .then(() => {
        setScanner(html5Qr)
        setScanning(true)
      })
      .catch((err: Error) => toast.error(err.message || 'Could not start camera'))
  }, [])

  const searchParams = useSearchParams()

  function fetchJobContext(input: string) {
    const trimmed = input.trim()
    if (!trimmed) return

    const isUuid = /^[0-9a-f-]{36}$/i.test(trimmed)

    if (isUuid) {
      fetch(`/api/jobs/${trimmed}/sheet-context`)
        .then((res) => {
          if (res.ok) return res.json() as Promise<JobContext>
          if (res.status === 404) {
            fetchJobCardContext(trimmed)
            return null
          }
          throw new Error('Failed to load job')
        })
        .then((data) => {
          if (data) {
            setJobContext({ ...data, type: data.type ?? 'job' })
            setHardStop(null)
            setExcessForm(null)
          }
        })
        .catch((err: Error) => toast.error(err.message))
      return
    }

    fetch(`/api/jobs/${trimmed}/sheet-context`)
      .then((res) => {
        if (res.ok) return res.json() as Promise<JobContext>
        if (res.status === 404) {
          fetchJobCardsByNumber(trimmed)
          return null
        }
        throw new Error('Failed to load job')
      })
      .then((data) => {
        if (data) {
          setJobContext({ ...data, type: data.type ?? 'job' })
          setHardStop(null)
          setExcessForm(null)
        }
      })
      .catch((err: Error) => toast.error(err.message))
  }

  function fetchJobCardContext(jobCardId: string) {
    return fetch(`/api/job-cards/${jobCardId}/sheet-context`)
      .then((res) => {
        if (!res.ok) {
          if (res.status === 404) throw new Error('Job card not found')
          throw new Error('Failed to load job card')
        }
        return res.json() as Promise<JobContext>
      })
      .then((data) => {
        setJobContext({ ...data, type: 'job_card' })
        setHardStop(null)
        setExcessForm(null)
      })
      .catch((err: Error) => toast.error(err.message))
  }

  function fetchJobCardsByNumber(numStr: string) {
    const num = parseInt(numStr, 10)
    if (isNaN(num)) {
      toast.error('Enter a valid job number or JC number')
      return Promise.resolve()
    }
    return fetch(`/api/job-cards?jobCardNumber=${num}`)
      .then((r) => r.json())
      .then((list: { id: string }[]) => {
        if (!Array.isArray(list) || list.length === 0) {
          toast.error('Job card not found')
          return
        }
        return fetchJobCardContext(list[0].id)
      })
      .catch(() => toast.error('Failed to load job card'))
  }

  useEffect(() => {
    const jobCardId = searchParams.get('jobCardId')
    if (jobCardId && !jobContext) fetchJobCardContext(jobCardId)
  }, [searchParams])

  useEffect(() => {
    return () => {
      if (scanner?.isScanning) scanner.stop()
    }
  }, [scanner])

  useEffect(() => {
    if (!pollingApproval) return
    const t = setInterval(() => {
      fetch(`/api/sheet-issues/${pollingApproval}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.approvedAt) {
            setPollingApproval(null)
            setHardStop(null)
            setExcessForm(null)
            toast.success('Excess approved. You can continue issuing.')
            if (jobContext) (jobContext.type === 'job_card' ? fetchJobCardContext(jobContext.id) : fetchJobContext(jobContext.id))
          }
          if (data.rejectedAt) {
            setPollingApproval(null)
            toast.error('Excess request rejected')
          }
        })
        .catch(() => {})
    }, 10_000)
    return () => clearInterval(t)
  }, [pollingApproval, jobContext])

  async function handleIssue(lineId: string) {
    if (!jobContext) return
    const qtyStr = issueQty[lineId]?.trim()
    const qty = parseInt(qtyStr || '0', 10)
    const line = jobContext.bomLines.find((l) => l.id === lineId)
    if (!line || isNaN(qty) || qty <= 0 || qty > line.remaining) {
      toast.error('Enter a valid quantity')
      return
    }
    setSubmitting(true)
    try {
      const isJobCard = jobContext.type === 'job_card' || line.type === 'job_card'
      const url = isJobCard ? '/api/sheet-issues/job-card-issue' : '/api/sheet-issues/attempt'
      const body = isJobCard
        ? { jobCardId: lineId, qtyRequested: qty, lotNumber: lotNumber[lineId] || undefined }
        : { bomLineId: lineId, qtyRequested: qty, lotNumber: lotNumber[lineId] || undefined }

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await res.json()
      if (result.success) {
        toast.success(result.message)
        setIssueQty((prev) => ({ ...prev, [lineId]: '' }))
        if (isJobCard) fetchJobCardContext(jobContext.id)
        else fetchJobContext(jobContext.id)
      } else {
        if (result.excessRequestId) {
          setHardStop({
            message: result.message,
            excessRequestId: result.excessRequestId ?? '',
            jobNumber: jobContext.jobNumber,
            materialCode: line.materialCode,
            approvedQty: line.qtyApproved,
            totalIssued: line.qtyAlreadyIssued + qty,
          })
          setExcessForm({
            requestId: result.excessRequestId,
            reasonCode: '',
            reasonDetail: '',
            additionalQty: String(qty),
          })
          setPollingApproval(result.excessRequestId)
        }
        toast.error(result.message || 'Request failed')
      }
    } catch {
      toast.error('Request failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleExcessSubmit() {
    if (!excessForm?.requestId || !excessForm.reasonCode) {
      toast.error('Select a reason code')
      return
    }
    if (excessForm.reasonCode === 'other' && !excessForm.reasonDetail?.trim()) {
      toast.error('Detail required for Other')
      return
    }
    setExcessSubmitting(true)
    try {
      await fetch(`/api/sheet-issues/${excessForm.requestId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reasonCode: excessForm.reasonCode,
          reasonDetail: excessForm.reasonDetail || undefined,
        }),
      })
      toast.success('Request sent to Shift Supervisor via WhatsApp')
    } catch {
      toast.error('Failed to update request')
    } finally {
      setExcessSubmitting(false)
    }
  }

  const remainingColor = (remaining: number, approved: number) => {
    if (remaining <= 0) return 'text-red-400 bg-red-900/30'
    const pct = (remaining / approved) * 100
    if (pct < 5) return 'text-red-400'
    if (pct < 20) return 'text-amber-400'
    return 'text-green-400'
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 max-w-2xl mx-auto">
      <h1 className="text-xl font-bold mb-4">Stores — Sheet Issue</h1>

      {/* Hard stop overlay — full red */}
      {hardStop && !excessForm && (
        <div className="fixed inset-0 z-50 bg-red-900/95 flex flex-col items-center justify-center p-6 text-center">
          <p className="text-2xl font-bold mb-2">⛔ HARD STOP</p>
          <p className="text-lg mb-2">All approved sheets issued</p>
          <p className="text-sm text-red-200 mb-1">Job: {hardStop.jobNumber}</p>
          <p className="text-sm text-red-200 mb-1">Material: {hardStop.materialCode}</p>
          <p className="text-sm text-red-200 mb-4">Approved: {hardStop.approvedQty} · Issued: {hardStop.totalIssued}</p>
          <button
            type="button"
            onClick={() => setExcessForm({
              requestId: hardStop.excessRequestId,
              reasonCode: '',
              reasonDetail: '',
              additionalQty: '',
            })}
            className="mt-4 px-6 py-3 rounded-lg bg-orange-600 hover:bg-orange-500 text-white font-medium"
          >
            Request Excess Sheets
          </button>
        </div>
      )}

      {/* Excess request form */}
      {excessForm && (
        <div className="fixed inset-0 z-50 bg-slate-900 flex flex-col items-center justify-center p-6 overflow-y-auto">
          <h2 className="text-lg font-bold text-amber-400 mb-4">Excess Request</h2>
          <div className="w-full max-w-sm space-y-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Reason (required)</label>
              <select
                value={excessForm.reasonCode}
                onChange={(e) => setExcessForm((f) => f ? { ...f, reasonCode: e.target.value } : null)}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
              >
                <option value="">— Select —</option>
                {REASON_CODES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            {excessForm.reasonCode === 'other' && (
              <div>
                <label className="block text-sm text-slate-400 mb-1">Detail (required)</label>
                <textarea
                  value={excessForm.reasonDetail}
                  onChange={(e) => setExcessForm((f) => f ? { ...f, reasonDetail: e.target.value } : null)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
                  rows={3}
                />
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleExcessSubmit}
                disabled={excessSubmitting || !excessForm.reasonCode}
                className="flex-1 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-medium"
              >
                {excessSubmitting ? 'Sending…' : 'Submit'}
              </button>
              <button
                type="button"
                onClick={() => { setExcessForm(null); setHardStop(null) }}
                className="px-4 py-2 rounded-lg bg-slate-600 text-white text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
          {pollingApproval && (
            <p className="mt-6 text-slate-400 text-sm flex items-center gap-2">
              <span className="animate-spin w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full" />
              Waiting for supervisor approval…
            </p>
          )}
        </div>
      )}

      {!jobContext ? (
        <div className="space-y-4">
          <div id="qr-reader" className="rounded-lg overflow-hidden bg-black hidden" />
          {scanning && <p className="text-slate-400 text-sm">Scan job QR code</p>}
          {!scanning && (
            <>
              <button
                type="button"
                onClick={startScanner}
                className="w-full py-3 px-4 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium"
              >
                Scan job QR code
              </button>
              <div className="pt-4 space-y-3">
                <div>
                  <MasterSearchSelect
                    label="Quick select job card"
                    query={contextSearch.query}
                    onQueryChange={contextSearch.setQuery}
                    loading={contextSearch.loading}
                    options={contextSearch.options}
                    lastUsed={contextSearch.lastUsed}
                    onSelect={applyContext}
                    getOptionLabel={(x) => x.label}
                    placeholder="Type JC# or customer..."
                    emptyMessage="No matching job card found."
                    recentLabel="Recent job cards"
                    loadingMessage="Searching job cards..."
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Or enter job / job card number or ID</label>
                  <input
                    type="text"
                    value={manualJobId}
                    onChange={(e) => setManualJobId(e.target.value)}
                    placeholder="e.g. CI-JOB-2025-0001 or JC# 12345"
                    className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
                  />
                  <button
                    type="button"
                    onClick={() => manualJobId.trim() && fetchJobContext(manualJobId.trim())}
                    className="mt-2 w-full py-2 rounded-lg bg-slate-600 hover:bg-slate-500 text-white text-sm"
                  >
                    Load job / job card
                  </button>
                </div>
              </div>
              <p className="text-xs text-slate-500">
                <Link href="/production/job-cards" className="text-amber-400 hover:underline">Job cards</Link>
                {' · '}
                <Link href="/production/stages" className="text-amber-400 hover:underline">Production planning</Link>
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="bg-slate-800 rounded-lg p-4 mb-4">
            <p className="font-semibold text-amber-400">{jobContext.jobNumber}</p>
            <p>{jobContext.productName}</p>
            <p className="text-slate-400 text-sm">{jobContext.customerName}</p>
          </div>

          <div className="space-y-4">
            {jobContext.bomLines.map((line) => {
              const remaining = line.remaining
              const isLocked = remaining <= 0
              const pct = line.qtyApproved > 0 ? (remaining / line.qtyApproved) * 100 : 0
              return (
                <div
                  key={line.id}
                  className={`rounded-lg border p-4 ${isLocked ? 'border-red-700 bg-red-900/20' : 'border-slate-600 bg-slate-800/50'}`}
                >
                  {isLocked && (
                    <div className="mb-2 py-1.5 px-2 rounded bg-red-900/50 text-red-200 text-sm font-medium">
                      LOCKED — 0 remaining
                    </div>
                  )}
                  <p className="font-mono text-amber-400">{line.materialCode}</p>
                  <p className="text-slate-400 text-sm">{line.materialDescription}</p>
                  <div className="grid grid-cols-3 gap-2 my-2 text-sm">
                    <div className="text-center">
                      <p className="text-slate-400">Approved</p>
                      <p className="text-green-400 font-semibold text-lg">{line.qtyApproved.toLocaleString()} {line.unit}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-slate-400">Issued so far</p>
                      <p className="text-blue-400 font-semibold">{line.qtyAlreadyIssued.toLocaleString()}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-slate-400">Remaining</p>
                      <p className={`font-semibold text-lg ${remainingColor(remaining, line.qtyApproved)}`}>
                        {remaining.toLocaleString()} {line.unit}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 items-end">
                    <div>
                      <label className="block text-xs text-slate-500">Issue qty</label>
                      <input
                        type="number"
                        min={1}
                        max={remaining}
                        value={issueQty[line.id] ?? ''}
                        onChange={(e) => setIssueQty((prev) => ({ ...prev, [line.id]: e.target.value }))}
                        disabled={isLocked}
                        className="w-24 px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500">Lot</label>
                      <input
                        type="text"
                        value={lotNumber[line.id] ?? ''}
                        onChange={(e) => setLotNumber((prev) => ({ ...prev, [line.id]: e.target.value }))}
                        placeholder="Lot #"
                        className="w-28 px-2 py-2 rounded bg-slate-800 border border-slate-600 text-white text-sm"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => handleIssue(line.id)}
                      disabled={submitting || isLocked || !issueQty[line.id] || parseInt(issueQty[line.id], 10) > remaining}
                      className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-medium"
                    >
                      Issue
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          <button
            type="button"
            onClick={() => { setJobContext(null); setIssueQty({}); setLotNumber({}) }}
            className="mt-6 w-full py-2 text-slate-400 hover:text-white text-sm"
          >
            Scan another job
          </button>
        </>
      )}
    </div>
  )
}
