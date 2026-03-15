'use client'

import { useState, useCallback, useEffect } from 'react'
import { Html5Qrcode } from 'html5-qrcode'
import { toast } from 'sonner'

type BomLineInfo = {
  id: string
  materialCode: string
  materialDescription: string
  unit: string
  qtyApproved: number
  qtyAlreadyIssued: number
  remaining: number
}

type JobContext = {
  id: string
  jobNumber: string
  productName: string
  customerName: string
  bomLines: BomLineInfo[]
}

type IssueResult = {
  success: boolean
  message: string
  remaining?: number
  issuedQty?: number
  excessRequestId?: string
}

export default function StoresIssuePage() {
  const [scanning, setScanning] = useState(false)
  const [scanner, setScanner] = useState<Html5Qrcode | null>(null)
  const [jobContext, setJobContext] = useState<JobContext | null>(null)
  const [selectedBomLineId, setSelectedBomLineId] = useState<string>('')
  const [qtyToIssue, setQtyToIssue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [hardStop, setHardStop] = useState<{ message: string; excessRequestId: string } | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const startScanner = useCallback(() => {
    setJobContext(null)
    setSelectedBomLineId('')
    setQtyToIssue('')
    setHardStop(null)
    setSuccessMessage(null)
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
            if (jobId.length < 10) {
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
      .catch((err: Error) => {
        toast.error(err.message || 'Could not start camera')
      })
  }, [])

  function fetchJobContext(jobId: string) {
    fetch(`/api/jobs/${encodeURIComponent(jobId)}/sheet-context`)
      .then((res) => {
        if (!res.ok) {
          if (res.status === 404) throw new Error('Job not found')
          throw new Error('Failed to load job')
        }
        return res.json()
      })
      .then((data: JobContext) => {
        setJobContext(data)
        if (data.bomLines.length === 1) setSelectedBomLineId(data.bomLines[0].id)
        else if (data.bomLines.length > 0) setSelectedBomLineId(data.bomLines[0].id)
      })
      .catch((err: Error) => toast.error(err.message))
  }

  useEffect(() => {
    return () => {
      if (scanner?.isScanning) scanner.stop()
    }
  }, [scanner])

  const selectedLine = jobContext?.bomLines.find((l) => l.id === selectedBomLineId)
  const remaining = selectedLine?.remaining ?? 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedBomLineId || !qtyToIssue || !jobContext) return
    const qty = parseInt(qtyToIssue, 10)
    if (isNaN(qty) || qty <= 0) {
      toast.error('Enter a valid quantity')
      return
    }
    setSubmitting(true)
    setSuccessMessage(null)
    setHardStop(null)
    try {
      const res = await fetch('/api/sheet-issues/attempt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bomLineId: selectedBomLineId,
          qtyRequested: qty,
        }),
      })
      const result: IssueResult = await res.json()
      if (result.success) {
        setSuccessMessage(result.message)
        setQtyToIssue('')
        toast.success(result.message)
        fetchJobContext(jobContext.id)
      } else {
        setHardStop({
          message: result.message,
          excessRequestId: result.excessRequestId ?? '',
        })
        toast.error('Hard stop — excess request raised')
      }
    } catch {
      toast.error('Request failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 max-w-2xl mx-auto">
      <h1 className="text-xl font-bold mb-4">Stores — Sheet Issue</h1>

      {/* Hard stop overlay */}
      {hardStop && (
        <div className="fixed inset-0 z-50 bg-red-900/95 flex flex-col items-center justify-center p-6 text-center">
          <p className="text-2xl font-bold mb-2">⛔ HARD STOP</p>
          <p className="text-lg mb-4">Excess Request Raised. Awaiting supervisor approval.</p>
          <p className="text-sm text-red-200 mb-6 whitespace-pre-wrap">{hardStop.message}</p>
          <p className="text-xs text-red-300">Request ID: {hardStop.excessRequestId}</p>
          <button
            type="button"
            onClick={() => setHardStop(null)}
            className="mt-6 px-4 py-2 bg-red-800 rounded-lg text-sm"
          >
            Dismiss (request still pending)
          </button>
        </div>
      )}

      {!jobContext ? (
        <div className="space-y-4">
          <div id="qr-reader" className="rounded-lg overflow-hidden bg-black" />
          {!scanning && (
            <button
              type="button"
              onClick={startScanner}
              className="w-full py-3 px-4 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium"
            >
              Scan job QR code
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="bg-slate-800 rounded-lg p-4 mb-4">
            <p className="font-semibold text-amber-400">{jobContext.jobNumber}</p>
            <p>{jobContext.productName}</p>
            <p className="text-slate-400 text-sm">{jobContext.customerName}</p>
          </div>

          {successMessage && (
            <div className="mb-4 p-4 rounded-lg bg-green-900/50 border border-green-700 text-green-200">
              {successMessage}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Material</label>
              <select
                value={selectedBomLineId}
                onChange={(e) => setSelectedBomLineId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
              >
                {jobContext.bomLines.map((line) => (
                  <option key={line.id} value={line.id}>
                    {line.materialCode} — {line.materialDescription} (remaining: {line.remaining}{' '}
                    {line.unit})
                  </option>
                ))}
              </select>
            </div>

            {selectedLine && (
              <div className="grid grid-cols-3 gap-2 text-sm">
                <div className="bg-slate-800 rounded p-2 text-center">
                  <p className="text-slate-400">Approved</p>
                  <p className="font-semibold">{selectedLine.qtyApproved}</p>
                </div>
                <div className="bg-slate-800 rounded p-2 text-center">
                  <p className="text-slate-400">Issued</p>
                  <p className="font-semibold">{selectedLine.qtyAlreadyIssued}</p>
                </div>
                <div className="bg-slate-800 rounded p-2 text-center">
                  <p className="text-slate-400">Remaining</p>
                  <p className="font-semibold text-amber-400">{selectedLine.remaining}</p>
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm text-slate-400 mb-1">Qty to issue</label>
              <input
                type="number"
                min={1}
                max={remaining}
                value={qtyToIssue}
                onChange={(e) => setQtyToIssue(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white text-lg"
                placeholder="0"
              />
            </div>

            <button
              type="submit"
              disabled={submitting || !qtyToIssue || remaining <= 0}
              className="w-full py-3 px-4 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-medium"
            >
              {submitting ? 'Submitting…' : 'Issue sheets'}
            </button>
          </form>

          <button
            type="button"
            onClick={() => {
              setJobContext(null)
              setSuccessMessage(null)
            }}
            className="mt-4 w-full py-2 text-slate-400 hover:text-white text-sm"
          >
            Scan another job
          </button>
        </>
      )}
    </div>
  )
}
