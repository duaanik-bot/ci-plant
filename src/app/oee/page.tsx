'use client'

import { useState, useEffect } from 'react'

type OeeItem = {
  machineCode: string
  machineName: string
  oee: number
  availability: number
  performance: number
  quality: number
  totalSheets: number
  goodSheets: number
  activeJob: {
    jobNumber: string
    productName: string
    qtyOrdered: number
  } | null
}

export default function OeePage() {
  const [data, setData] = useState<OeeItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    function fetch_() {
      fetch('/api/oee/live')
        .then((r) => r.json())
        .then(setData)
        .catch(() => {})
        .finally(() => setLoading(false))
    }
    fetch_()
    const t = setInterval(fetch_, 60000)
    return () => clearInterval(t)
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-500 text-2xl">
        Loading…
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-950 text-foreground p-8">
      <h1 className="text-4xl font-bold text-amber-400 text-center mb-8">
        OEE Live — Colour Impressions
      </h1>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto">
        {data.map((press) => (
          <div
            key={press.machineCode}
            className="bg-slate-900 rounded-2xl border border-slate-700 p-6 text-center"
          >
            <h2 className="text-2xl font-bold text-slate-200 mb-1">
              {press.machineCode}
            </h2>
            <p className="text-slate-500 text-sm mb-4">{press.machineName}</p>
            <div className="relative w-32 h-32 mx-auto mb-4">
              <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                <path
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  className="text-slate-700"
                />
                <path
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  strokeWidth="2.5"
                  strokeDasharray={`${press.oee}, 100`}
                  className="text-amber-400"
                  stroke="currentColor"
                />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-2xl font-bold">
                {press.oee}%
              </span>
            </div>
            <p className="text-slate-400 text-sm">OEE</p>
            <div className="mt-4 pt-4 border-t border-slate-700 text-left text-sm">
              <p>Sheets today: {press.totalSheets} in / {press.goodSheets} good</p>
              {press.activeJob ? (
                <p className="mt-2 text-amber-400">
                  Job: {press.activeJob.jobNumber} — {press.activeJob.productName}
                </p>
              ) : (
                <p className="mt-2 text-slate-500">No active job</p>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="text-center text-slate-600 text-sm mt-8">
        Auto-refresh 60s · Readable from 3m
      </p>
    </div>
  )
}
