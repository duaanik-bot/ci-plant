'use client'

import { useState, useEffect, useCallback } from 'react'
import { Html5Qrcode } from 'html5-qrcode'
import { toast } from 'sonner'

type Job = {
  id: string
  jobNumber: string
  productName: string
  qtyOrdered: number
  qtyProducedGood: number
}
type ActiveStage = {
  id: string
  stageNumber: number
  job: Job
  machine: { machineCode: string; name: string }
}
type SheetContext = {
  jobNumber: string
  bomLines: Array<{ remaining: number; qtyApproved?: number; unit: string }>
}

export default function ShopfloorPage() {
  const [machines, setMachines] = useState<Array<{ id: string; machineCode: string; name: string }>>([])
  const [machineId, setMachineId] = useState('')
  const [active, setActive] = useState<ActiveStage | null>(null)
  const [sheetContext, setSheetContext] = useState<SheetContext | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanner, setScanner] = useState<Html5Qrcode | null>(null)
  const [completing, setCompleting] = useState(false)
  const [qtyOut, setQtyOut] = useState('')
  const [qtyWaste, setQtyWaste] = useState('0')

  useEffect(() => {
    fetch('/api/machines')
      .then((r) => r.json())
      .then((data) => setMachines(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  const fetchActive = useCallback(() => {
    if (!machineId) return
    fetch(`/api/stages/active?machineId=${encodeURIComponent(machineId)}`)
      .then((r) => r.json())
      .then((data) => {
        setActive(data.active ?? null)
        if (data.active?.job?.id) {
          fetch(`/api/jobs/${data.active.job.id}/sheet-context`)
            .then((r) => r.json())
            .then(setSheetContext)
            .catch(() => setSheetContext(null))
        } else {
          setSheetContext(null)
        }
      })
      .catch(() => setActive(null))
  }, [machineId])

  useEffect(() => {
    fetchActive()
    const t = setInterval(fetchActive, 15000)
    return () => clearInterval(t)
  }, [fetchActive])

  const startScanner = () => {
    setScanner(null)
    const html5Qr = new Html5Qrcode('shopfloor-qr')
    html5Qr
      .start(
        { facingMode: 'environment' },
        { fps: 8, qrbox: { width: 260, height: 260 } },
        (decodedText) => {
          html5Qr.stop().then(() => {
            setScanning(false)
            setScanner(null)
            const jobId = decodedText.trim()
            if (!jobId) return
            startStage(jobId)
          })
        },
        () => {}
      )
      .then(() => {
        setScanner(html5Qr)
        setScanning(true)
      })
      .catch((err: Error) => toast.error(err.message || 'Camera error'))
  }

  async function startStage(jobId: string) {
    if (!machineId) {
      toast.error('Select machine first')
      return
    }
    const stageNumber = 1
    const res = await fetch('/api/stages/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, machineId, stageNumber }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error || 'Failed to start')
      return
    }
    toast.success('Stage started')
    fetchActive()
  }

  async function completeStage() {
    if (!active) return
    const out = parseInt(qtyOut, 10)
    const waste = parseInt(qtyWaste, 10)
    if (isNaN(out) || out < 0) {
      toast.error('Enter valid qty out')
      return
    }
    setCompleting(true)
    try {
      const res = await fetch(`/api/stages/${active.id}/complete`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qtyOut: out, qtyWaste: isNaN(waste) ? 0 : waste }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      toast.success('Stage completed')
      setQtyOut('')
      setQtyWaste('0')
      fetchActive()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setCompleting(false)
    }
  }

  useEffect(() => {
    return () => { if (scanner?.isScanning) scanner.stop() }
  }, [scanner])

  const totalRemaining = sheetContext?.bomLines?.reduce((s, l) => s + l.remaining, 0) ?? 0
  const totalApproved = sheetContext?.bomLines?.reduce((s, l) => s + (l.qtyApproved ?? 0), 0) ?? 1
  const remainingPct = totalApproved > 0 ? (totalRemaining / totalApproved) * 100 : 100

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 flex flex-col">
      <h1 className="text-2xl font-bold text-amber-400 mb-4">Shopfloor</h1>

      <div className="mb-4">
        <label className="block text-sm text-slate-400 mb-1">Machine</label>
        <select
          value={machineId}
          onChange={(e) => setMachineId(e.target.value)}
          className="w-full max-w-xs px-4 py-3 rounded-lg bg-slate-800 border border-slate-600 text-white text-lg"
        >
          <option value="">Select machine</option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>{m.machineCode} — {m.name}</option>
          ))}
        </select>
      </div>

      {active ? (
        <div className="flex-1 space-y-4">
          <div className="bg-slate-800 rounded-xl p-6 text-center">
            <p className="text-slate-400 text-sm">Current job</p>
            <p className="text-2xl font-bold text-amber-400 mt-1">{active.job.jobNumber}</p>
            <p className="text-lg mt-1">{active.job.productName}</p>
            <p className="text-slate-400 mt-2">
              Qty produced today: <strong className="text-white">{active.job.qtyProducedGood}</strong>
            </p>
            <p className="text-slate-400">
              Qty remaining: <strong className="text-white">{active.job.qtyOrdered - active.job.qtyProducedGood}</strong>
            </p>
            <p className="text-sm text-slate-500 mt-2">Stage {active.stageNumber} · {active.machine.machineCode}</p>
          </div>

          {sheetContext && sheetContext.bomLines?.length > 0 && (
            <div className="bg-slate-800 rounded-xl p-4">
              <p className="text-sm text-slate-400 mb-2">Sheets remaining</p>
              <div className="h-4 rounded-full bg-slate-700 overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    remainingPct < 15 ? 'bg-red-500' : remainingPct < 30 ? 'bg-amber-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${Math.min(100, remainingPct)}%` }}
                />
              </div>
              <p className="text-sm mt-1">{totalRemaining} sheets</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Qty out</label>
              <input
                type="number"
                min={0}
                value={qtyOut}
                onChange={(e) => setQtyOut(e.target.value)}
                className="w-full px-4 py-3 rounded-lg bg-slate-800 border border-slate-600 text-white text-xl"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Waste</label>
              <input
                type="number"
                min={0}
                value={qtyWaste}
                onChange={(e) => setQtyWaste(e.target.value)}
                className="w-full px-4 py-3 rounded-lg bg-slate-800 border border-slate-600 text-white text-xl"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={completeStage}
            disabled={completing}
            className="w-full py-4 rounded-xl bg-green-600 hover:bg-green-500 disabled:bg-slate-600 text-white font-bold text-xl"
          >
            {completing ? 'Completing…' : 'COMPLETE STAGE'}
          </button>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center">
          <p className="text-slate-400 text-lg mb-4">No active job on this machine</p>
          <div id="shopfloor-qr" className="rounded-lg overflow-hidden bg-black mb-4" />
          {!scanning && (
            <button
              type="button"
              onClick={startScanner}
              className="w-full max-w-sm py-4 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold text-xl"
            >
              START STAGE (scan job card)
            </button>
          )}
        </div>
      )}
    </div>
  )
}
