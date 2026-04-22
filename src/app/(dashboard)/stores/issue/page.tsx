'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
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

type FifoSpecDto = {
  gsm: number
  boardNorm: string
  paperTypeNorm: string
  sheetSizeNorm: string
}

type FifoCheckResponse = {
  fifoSpec: FifoSpecDto | null
  violation: boolean
  olderBatches: {
    id: string
    lotNumber: string | null
    receiptDate: string
    ageDays: number
    qtySheets: number
  }[]
  selectedReceiptDate: string | null
  message?: string
}

type JobContext = {
  type?: 'job' | 'job_card'
  id: string
  jobNumber: string
  productName: string
  customerName: string
  bomLines: BomLineInfo[]
  fifoSpec?: FifoSpecDto | null
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
  const [fifoJobCardCheck, setFifoJobCardCheck] = useState<FifoCheckResponse | null>(null)
  const [fifoSkipReason, setFifoSkipReason] = useState('')
  const [fifoDrawerDismissed, setFifoDrawerDismissed] = useState(false)

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

  const jobCardLotKey = useMemo(() => {
    if (!jobContext || jobContext.type !== 'job_card') return ''
    const lineId = jobContext.bomLines[0]?.id
    if (!lineId) return ''
    return `${lineId}:${(lotNumber[lineId] ?? '').trim()}`
  }, [jobContext, lotNumber])

  useEffect(() => {
    setFifoSkipReason('')
  }, [jobCardLotKey])

  useEffect(() => {
    if (!fifoJobCardCheck?.violation) setFifoDrawerDismissed(false)
  }, [fifoJobCardCheck?.violation])

  useEffect(() => {
    if (!jobContext || jobContext.type !== 'job_card') {
      setFifoJobCardCheck(null)
      return
    }
    const lineId = jobContext.bomLines[0]?.id
    const lot = (lineId ? lotNumber[lineId] ?? '' : '').trim()
    if (!lineId || !lot) {
      setFifoJobCardCheck(null)
      return
    }
    const ac = new AbortController()
    const t = window.setTimeout(() => {
      fetch(
        `/api/inventory/fifo-check?jobCardId=${encodeURIComponent(jobContext.id)}&lotNumber=${encodeURIComponent(lot)}`,
        { signal: ac.signal },
      )
        .then((r) => r.json())
        .then((data: FifoCheckResponse) => {
          setFifoJobCardCheck(data)
          if (data.violation) setFifoDrawerDismissed(false)
        })
        .catch(() => {})
    }, 400)
    return () => {
      window.clearTimeout(t)
      ac.abort()
    }
  }, [jobContext?.id, jobContext?.type, lotNumber])

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
        ? {
            jobCardId: lineId,
            qtyRequested: qty,
            lotNumber: lotNumber[lineId] || undefined,
            ...(fifoJobCardCheck?.violation ? { fifoSkipReason: fifoSkipReason.trim() } : {}),
          }
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
        setFifoSkipReason('')
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('ci-paper-consumed'))
        if (isJobCard) fetchJobCardContext(jobContext.id)
        else fetchJobContext(jobContext.id)
      } else if (res.status === 409 && result.fifoViolation) {
        toast.error(result.message || 'FIFO violation — add a reason to skip.')
        if (Array.isArray(result.olderBatches)) {
          setFifoJobCardCheck((prev) =>
            prev
              ? { ...prev, violation: true, olderBatches: result.olderBatches }
              : {
                  fifoSpec: jobContext.fifoSpec ?? null,
                  violation: true,
                  olderBatches: result.olderBatches,
                  selectedReceiptDate: null,
                },
          )
        }
        setFifoDrawerDismissed(false)
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
    if (pct < 20) return 'text-ds-warning'
    return 'text-green-400'
  }

  const showFifoDrawer =
    jobContext?.type === 'job_card' &&
    fifoJobCardCheck?.violation === true &&
    !fifoDrawerDismissed

  return (
    <div className="min-h-screen bg-background text-foreground p-4 max-w-2xl mx-auto">
      <h1 className="text-xl font-bold mb-4">Stores — Sheet Issue</h1>

      {showFifoDrawer && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-[60] bg-background/55"
            aria-label="Close FIFO panel"
            onClick={() => setFifoDrawerDismissed(true)}
          />
          <aside
            className="fixed top-0 right-0 z-[70] h-full w-full max-w-md border-l border-red-600 bg-[#0a0a0a] shadow-2xl flex flex-col p-4 overflow-y-auto"
            aria-labelledby="fifo-violation-title"
          >
            <div className="flex items-start justify-between gap-2 mb-3">
              <h2 id="fifo-violation-title" className="text-lg font-bold text-red-400">
                FIFO violation
              </h2>
              <button
                type="button"
                onClick={() => setFifoDrawerDismissed(true)}
                className="rounded px-2 py-1 text-ds-ink-muted hover:bg-ds-elevated hover:text-foreground text-sm"
              >
                Close
              </button>
            </div>
            <p className="text-sm text-ds-ink-muted mb-4">
              Older stock exists for the same GSM, grade, and paper spec. Record a reason to use a newer lot (minimum 8
              characters).
            </p>
            <p className="text-xs font-mono text-ds-ink-faint mb-2">Older batches (gate date)</p>
            <ul className="space-y-2 mb-4">
              {fifoJobCardCheck.olderBatches.map((b) => (
                <li
                  key={b.id}
                  className="rounded-lg border border-ds-line/50 bg-background/40 px-3 py-2 font-mono text-xs text-ds-ink"
                >
                  <span className="text-ds-warning">Lot {b.lotNumber ?? '—'}</span>
                  <span className="block text-ds-ink-muted">
                    {b.receiptDate} · {b.ageDays}d · {b.qtySheets} sh
                  </span>
                </li>
              ))}
            </ul>
            <label htmlFor="fifo-skip-reason" className="text-xs text-ds-ink-faint mb-1 block">
              Reason for skip
            </label>
            <textarea
              id="fifo-skip-reason"
              value={fifoSkipReason}
              onChange={(e) => setFifoSkipReason(e.target.value)}
              placeholder='e.g. "Older stock inaccessible in rack A3"'
              rows={4}
              className="w-full rounded-lg border border-ds-line/60 bg-card px-3 py-2 font-mono text-sm text-foreground placeholder:text-ds-ink-faint"
            />
            <p className="mt-2 text-xs text-ds-ink-faint">
              {fifoSkipReason.trim().length < 8
                ? `${Math.max(0, 8 - fifoSkipReason.trim().length)} more characters required to issue.`
                : 'You can issue from the line below.'}
            </p>
          </aside>
        </>
      )}

      {jobContext?.type === 'job_card' && fifoJobCardCheck?.violation && fifoDrawerDismissed && (
        <button
          type="button"
          onClick={() => setFifoDrawerDismissed(false)}
          className="fixed bottom-4 right-4 z-50 rounded-full border border-red-600 bg-red-950 px-4 py-2 text-sm font-medium text-red-200 shadow-lg animate-pulse"
        >
          FIFO violation — open panel
        </button>
      )}

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
            className="mt-4 px-6 py-3 rounded-lg bg-orange-600 hover:bg-orange-500 text-foreground font-medium"
          >
            Request Excess Sheets
          </button>
        </div>
      )}

      {/* Excess request form */}
      {excessForm && (
        <div className="fixed inset-0 z-50 bg-ds-card flex flex-col items-center justify-center p-6 overflow-y-auto">
          <h2 className="text-lg font-bold text-ds-warning mb-4">Excess Request</h2>
          <div className="w-full max-w-sm space-y-4">
            <div>
              <label className="block text-sm text-ds-ink-muted mb-1">Reason (required)</label>
              <select
                value={excessForm.reasonCode}
                onChange={(e) => setExcessForm((f) => f ? { ...f, reasonCode: e.target.value } : null)}
                className="w-full px-3 py-2 rounded-lg bg-card border border-ds-line/60 text-foreground"
              >
                <option value="">— Select —</option>
                {REASON_CODES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            {excessForm.reasonCode === 'other' && (
              <div>
                <label className="block text-sm text-ds-ink-muted mb-1">Detail (required)</label>
                <textarea
                  value={excessForm.reasonDetail}
                  onChange={(e) => setExcessForm((f) => f ? { ...f, reasonDetail: e.target.value } : null)}
                  className="w-full px-3 py-2 rounded-lg bg-card border border-ds-line/60 text-foreground"
                  rows={3}
                />
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleExcessSubmit}
                disabled={excessSubmitting || !excessForm.reasonCode}
                className="flex-1 py-2 rounded-lg bg-ds-warning hover:bg-ds-warning disabled:opacity-50 text-primary-foreground font-medium"
              >
                {excessSubmitting ? 'Sending…' : 'Submit'}
              </button>
              <button
                type="button"
                onClick={() => { setExcessForm(null); setHardStop(null) }}
                className="px-4 py-2 rounded-lg bg-muted text-foreground text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
          {pollingApproval && (
            <p className="mt-6 text-ds-ink-muted text-sm flex items-center gap-2">
              <span className="animate-spin w-4 h-4 border-2 border-ds-warning border-t-transparent rounded-full" />
              Waiting for supervisor approval…
            </p>
          )}
        </div>
      )}

      {!jobContext ? (
        <div className="space-y-4">
          <div id="qr-reader" className="rounded-lg overflow-hidden bg-card hidden" />
          {scanning && <p className="text-ds-ink-muted text-sm">Scan job QR code</p>}
          {!scanning && (
            <>
              <button
                type="button"
                onClick={startScanner}
                className="w-full py-3 px-4 rounded-lg bg-ds-warning hover:bg-ds-warning text-primary-foreground font-medium"
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
                  <label className="block text-sm text-ds-ink-muted mb-1">Or enter job / job card number or ID</label>
                  <input
                    type="text"
                    value={manualJobId}
                    onChange={(e) => setManualJobId(e.target.value)}
                    placeholder="e.g. CI-JOB-2025-0001 or JC# 12345"
                    className="w-full px-3 py-2 rounded-lg bg-card border border-ds-line/60 text-foreground"
                  />
                  <button
                    type="button"
                    onClick={() => manualJobId.trim() && fetchJobContext(manualJobId.trim())}
                    className="mt-2 w-full py-2 rounded-lg bg-muted hover:bg-muted/80 text-foreground text-sm"
                  >
                    Load job / job card
                  </button>
                </div>
              </div>
              <p className="text-xs text-ds-ink-faint">
                <Link href="/production/job-cards" className="text-ds-warning hover:underline">Job cards</Link>
                {' · '}
                <Link href="/production/stages" className="text-ds-warning hover:underline">Production planning</Link>
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="bg-ds-elevated rounded-lg p-4 mb-4">
            <p className="font-semibold text-ds-warning">{jobContext.jobNumber}</p>
            <p>{jobContext.productName}</p>
            <p className="text-ds-ink-muted text-sm">{jobContext.customerName}</p>
            {jobContext.type === 'job_card' && fifoJobCardCheck?.message && (
              <p className="mt-2 text-xs text-ds-warning font-mono">{fifoJobCardCheck.message}</p>
            )}
          </div>

          <div className="space-y-4">
            {jobContext.bomLines.map((line) => {
              const remaining = line.remaining
              const isLocked = remaining <= 0
              const isJobCardLine = jobContext.type === 'job_card' || line.type === 'job_card'
              const fifoBlocked =
                isJobCardLine &&
                fifoJobCardCheck?.violation === true &&
                fifoSkipReason.trim().length < 8
              return (
                <div
                  key={line.id}
                  className={`rounded-lg border p-4 ${isLocked ? 'border-red-700 bg-red-900/20' : 'border-ds-line/60 bg-ds-elevated/50'}`}
                >
                  {isLocked && (
                    <div className="mb-2 py-1.5 px-2 rounded bg-red-900/50 text-red-200 text-sm font-medium">
                      LOCKED — 0 remaining
                    </div>
                  )}
                  <p className="font-mono text-ds-warning">{line.materialCode}</p>
                  <p className="text-ds-ink-muted text-sm">{line.materialDescription}</p>
                  <div className="grid grid-cols-3 gap-2 my-2 text-sm">
                    <div className="text-center">
                      <p className="text-ds-ink-muted">Approved</p>
                      <p className="text-green-400 font-semibold text-lg">{line.qtyApproved.toLocaleString()} {line.unit}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-ds-ink-muted">Issued so far</p>
                      <p className="text-blue-400 font-semibold">{line.qtyAlreadyIssued.toLocaleString()}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-ds-ink-muted">Remaining</p>
                      <p className={`font-semibold text-lg ${remainingColor(remaining, line.qtyApproved)}`}>
                        {remaining.toLocaleString()} {line.unit}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 items-end">
                    <div>
                      <label className="block text-xs text-ds-ink-faint">Issue qty</label>
                      <input
                        type="number"
                        min={1}
                        max={remaining}
                        value={issueQty[line.id] ?? ''}
                        onChange={(e) => setIssueQty((prev) => ({ ...prev, [line.id]: e.target.value }))}
                        disabled={isLocked}
                        className="w-24 px-2 py-2 rounded bg-card border border-ds-line/60 text-foreground"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-ds-ink-faint">Lot</label>
                      <input
                        type="text"
                        value={lotNumber[line.id] ?? ''}
                        onChange={(e) => setLotNumber((prev) => ({ ...prev, [line.id]: e.target.value }))}
                        placeholder="Lot #"
                        className="w-28 px-2 py-2 rounded bg-card border border-ds-line/60 text-foreground text-sm"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => handleIssue(line.id)}
                      disabled={
                        submitting ||
                        isLocked ||
                        !issueQty[line.id] ||
                        parseInt(issueQty[line.id], 10) > remaining ||
                        fifoBlocked
                      }
                      className="px-4 py-2 rounded-lg bg-ds-warning hover:bg-ds-warning disabled:opacity-50 text-primary-foreground font-medium"
                    >
                      Issue
                    </button>
                  </div>
                  {isJobCardLine && fifoJobCardCheck?.violation && (
                    <p className="mt-2 text-xs text-red-300">
                      FIFO: use the side panel to enter a skip reason before issuing this lot.
                    </p>
                  )}
                </div>
              )
            })}
          </div>

          <button
            type="button"
            onClick={() => { setJobContext(null); setIssueQty({}); setLotNumber({}) }}
            className="mt-6 w-full py-2 text-ds-ink-muted hover:text-foreground text-sm"
          >
            Scan another job
          </button>
        </>
      )}
    </div>
  )
}
