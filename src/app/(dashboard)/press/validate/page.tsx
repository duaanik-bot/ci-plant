'use client'

import { useState, useCallback, useEffect } from 'react'
import { Html5Qrcode } from 'html5-qrcode'
import { toast } from 'sonner'

type ValidateResult = {
  valid: boolean
  message: string
  artworkVersion?: number
  jobNumber?: string
  productName?: string
  approvedByName?: string
  approvedAt?: string
}

export default function PressValidatePage() {
  const [scanning, setScanning] = useState(false)
  const [scanner, setScanner] = useState<Html5Qrcode | null>(null)
  const [result, setResult] = useState<ValidateResult | null>(null)
  const [manualBarcode, setManualBarcode] = useState('')

  const validatePlate = useCallback((plateBarcode: string) => {
    const barcode = plateBarcode.trim()
    if (!barcode) {
      toast.error('Enter or scan plate barcode')
      return
    }
    fetch('/api/press/validate-plate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plateBarcode: barcode }),
    })
      .then((r) => r.json())
      .then((data: ValidateResult) => setResult(data))
      .catch(() => {
        setResult({ valid: false, message: 'Request failed. Contact your supervisor immediately.' })
      })
  }, [])

  const startScanner = useCallback(() => {
    setResult(null)
    const el = document.getElementById('press-qr-reader')
    if (!el) return
    const html5Qr = new Html5Qrcode('press-qr-reader')
    html5Qr
      .start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 280, height: 280 } },
        (decodedText) => {
          html5Qr.stop().then(() => {
            setScanner(null)
            setScanning(false)
            validatePlate(decodedText.trim())
          })
        },
        () => {}
      )
      .then(() => {
        setScanner(html5Qr)
        setScanning(true)
      })
      .catch((err: Error) => toast.error(err.message || 'Could not start camera'))
  }, [validatePlate])

  useEffect(() => {
    return () => {
      if (scanner?.isScanning) scanner.stop()
    }
  }, [scanner])

  return (
    <div className="min-h-screen bg-slate-900 text-foreground p-4 max-w-2xl mx-auto flex flex-col">
      <h1 className="text-xl font-bold mb-4">Press — Validate plate</h1>

      {!result ? (
        <>
          <div id="press-qr-reader" className="rounded-lg overflow-hidden bg-background mb-4 hidden" />
          <button
            type="button"
            onClick={startScanner}
            className="w-full py-6 px-4 rounded-xl bg-amber-600 hover:bg-amber-500 text-primary-foreground font-bold text-lg mb-4"
          >
            TAP TO SCAN PLATE
          </button>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Or enter barcode manually</label>
            <input
              type="text"
              value={manualBarcode}
              onChange={(e) => setManualBarcode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && validatePlate(manualBarcode)}
              placeholder="e.g. PLT-CI-JOB-2025-0001-XXXX"
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-foreground font-mono"
            />
            <button
              type="button"
              onClick={() => validatePlate(manualBarcode)}
              className="mt-2 w-full py-2 rounded-lg bg-slate-600 hover:bg-slate-500 text-foreground text-sm"
            >
              Validate
            </button>
          </div>
        </>
      ) : (
        <div
          className={`flex-1 flex flex-col items-center justify-center p-6 rounded-xl text-center min-h-[60vh] ${
            result.valid
              ? 'bg-green-900/80 border-2 border-green-500'
              : 'bg-red-900/80 border-2 border-red-500'
          }`}
        >
          <p className="text-3xl font-bold mb-4 whitespace-pre-wrap">
            {result.valid ? '✅ PRESS CLEARED' : '❌ DO NOT RUN'}
          </p>
          <p className="text-lg whitespace-pre-wrap mb-4">{result.message}</p>
          {result.artworkVersion != null && (
            <p className="text-sm opacity-90">Artwork Version {result.artworkVersion}</p>
          )}
          <button
            type="button"
            onClick={() => { setResult(null); setManualBarcode('') }}
            className="mt-8 w-full max-w-xs py-3 rounded-lg bg-slate-700 hover:bg-slate-600 text-foreground font-medium"
          >
            Scan Another Plate
          </button>
        </div>
      )}
    </div>
  )
}
