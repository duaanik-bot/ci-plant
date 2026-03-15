'use client'

import { useState, useCallback, useEffect } from 'react'
import { Html5Qrcode } from 'html5-qrcode'
import { toast } from 'sonner'

type ValidateResult = {
  valid: boolean
  message: string
  artworkVersion?: number
}

export default function PressValidatePage() {
  const [scanning, setScanning] = useState(false)
  const [scanner, setScanner] = useState<Html5Qrcode | null>(null)
  const [result, setResult] = useState<ValidateResult | null>(null)
  const [jobId, setJobId] = useState('')
  const [machineCode, setMachineCode] = useState('')

  const startScanner = useCallback(() => {
    setResult(null)
    const html5Qr = new Html5Qrcode('press-qr-reader')
    html5Qr
      .start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 280, height: 280 } },
        (decodedText) => {
          html5Qr.stop().then(() => {
            setScanner(null)
            setScanning(false)
            const plateBarcode = decodedText.trim()
            if (!plateBarcode) {
              toast.error('Invalid scan')
              return
            }
            validatePlate(plateBarcode)
          })
        },
        () => {}
      )
      .then(() => {
        setScanner(html5Qr)
        setScanning(true)
      })
      .catch((err: Error) => toast.error(err.message || 'Could not start camera'))
  }, [jobId, machineCode])

  function validatePlate(plateBarcode: string) {
    if (!jobId || !machineCode) {
      toast.error('Enter Job ID and Machine code first')
      return
    }
    fetch('/api/press/validate-plate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plateBarcode,
        jobId,
        machineCode,
      }),
    })
      .then((r) => r.json())
      .then((data: ValidateResult) => setResult(data))
      .catch(() => {
        setResult({ valid: false, message: 'Request failed' })
      })
  }

  useEffect(() => {
    return () => {
      if (scanner?.isScanning) scanner.stop()
    }
  }, [scanner])

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 max-w-2xl mx-auto">
      <h1 className="text-xl font-bold mb-4">Press — Validate plate</h1>

      <div className="space-y-4 mb-6">
        <div>
          <label className="block text-sm text-slate-400 mb-1">Job ID (UUID)</label>
          <input
            type="text"
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white font-mono text-sm"
            placeholder="Paste or scan job ID"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Machine code</label>
          <input
            type="text"
            value={machineCode}
            onChange={(e) => setMachineCode(e.target.value.toUpperCase())}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white"
            placeholder="e.g. CI-01"
          />
        </div>
      </div>

      <div id="press-qr-reader" className="rounded-lg overflow-hidden bg-black mb-4" />

      {!scanning && (
        <button
          type="button"
          onClick={startScanner}
          className="w-full py-4 px-4 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-semibold text-lg"
        >
          SCAN PLATE
        </button>
      )}

      {result && (
        <div
          className={`mt-6 p-6 rounded-xl text-center ${
            result.valid
              ? 'bg-green-900/50 border-2 border-green-500'
              : 'bg-red-900/50 border-2 border-red-500'
          }`}
        >
          <p className="text-2xl font-bold mb-2">
            {result.valid ? '✅ PRESS CLEARED' : '❌ DO NOT RUN'}
          </p>
          <p className="text-lg whitespace-pre-wrap">{result.message}</p>
          {result.artworkVersion != null && (
            <p className="text-sm mt-2 opacity-80">Version {result.artworkVersion}</p>
          )}
        </div>
      )}
    </div>
  )
}
