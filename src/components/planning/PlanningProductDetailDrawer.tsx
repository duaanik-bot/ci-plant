'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

const shell = 'border-l border-[#334155] bg-[#1E293B] shadow-[-10px_0_40px_rgba(0,0,0,0.25)]'
const mono = 'font-designing-queue tabular-nums text-[13px] font-semibold'

type Insight = {
  master?: Record<string, unknown>
  lastRuns?: {
    jobCardNumber: number
    jobDate: string
    status: string
    grainFitStatus: string
    issuedStockDisplay: string | null
  }[]
  grainDirectionNote?: string
  hub?: {
    die: { dyeNumber: number; ups: number; sheetSize: string } | null
    shadeCard: { id: string; shadeCode: string; custodyStatus: string } | null
  }
}

export function PlanningProductDetailDrawer({
  open,
  cartonId,
  onClose,
}: {
  open: boolean
  cartonId: string | null
  onClose: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<Insight | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !cartonId) {
      setData(null)
      setErr(null)
      return
    }
    setLoading(true)
    setErr(null)
    void fetch(`/api/planning/product-insight/${cartonId}`)
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { error?: string } & Insight
        if (!r.ok) throw new Error(j.error ?? 'Failed to load')
        setData(j)
      })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Error'))
      .finally(() => setLoading(false))
  }, [open, cartonId])

  if (!open || !cartonId) return null

  const m = data?.master ?? {}
  const name = String(m?.cartonName ?? '—')

  return (
    <div className="fixed inset-0 z-[91] flex justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        aria-label="Close"
        onClick={onClose}
      />
      <aside
        className={`relative flex h-full w-full max-w-[480px] flex-col ${shell}`}
        role="dialog"
        aria-modal="true"
        aria-label="Product detail"
      >
        <div className="flex items-start justify-between gap-2 border-b border-[#334155] bg-[#0F172A] px-4 py-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-500">Product master</p>
            <h2 className="pr-2 text-sm font-semibold text-slate-100">{name}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1.5 text-slate-400 hover:bg-[#1E293B] hover:text-slate-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-[13px]">
          {err ? <p className="text-sm text-rose-400">{err}</p> : null}
          {loading ? <p className="text-slate-500">Loading…</p> : null}
          {!loading && data && (
            <>
              <div className="space-y-1.5 rounded border border-[#334155] bg-[#0F172A]/50 p-3 text-slate-200">
                <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Master specs</p>
                <p>
                  <span className="text-slate-500">GSM:</span>{' '}
                  <span className={mono}>{m?.gsm != null ? String(m.gsm) : '—'}</span>
                </p>
                <p>
                  <span className="text-slate-500">Paper:</span> {String(m?.paperType ?? '—')}
                </p>
                <p>
                  <span className="text-slate-500">Coating:</span> {String(m?.coatingType ?? '—')}
                </p>
                <p>
                  <span className="text-slate-500">Laminate / secondary:</span> {String(m?.laminateType ?? '—')}
                </p>
                <p>
                  <span className="text-slate-500">AW code:</span>{' '}
                  <span className={`text-amber-400 ${mono}`}>{String(m?.artworkCode ?? '—')}</span>
                </p>
              </div>

              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-500">
                  Grain direction
                </p>
                <p className="whitespace-pre-wrap text-slate-300">{String(data.grainDirectionNote ?? '—')}</p>
              </div>

              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-500">
                  Hub readiness (live)
                </p>
                <ul className="space-y-1 text-slate-200">
                  <li>
                    Plates / die:{' '}
                    {data.hub?.die ? (
                      <span className="text-emerald-400">
                        Die {data.hub.die.dyeNumber}/{data.hub.die.ups} · {data.hub.die.sheetSize}
                      </span>
                    ) : (
                      <span className="text-amber-400/90">—</span>
                    )}
                  </li>
                  <li>
                    Shade:{' '}
                    {data.hub?.shadeCard ? (
                      <span>
                        {data.hub.shadeCard.shadeCode} · {data.hub.shadeCard.custodyStatus}
                      </span>
                    ) : (
                      '—'
                    )}
                  </li>
                </ul>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">
                  Last production runs
                </p>
                <ul className="space-y-2">
                  {(data.lastRuns ?? []).map((r) => (
                    <li
                      key={r?.jobCardNumber}
                      className="rounded border border-[#334155] bg-[#0F172A]/50 px-2 py-1.5 text-slate-300"
                    >
                      <p className={`${mono} text-amber-400`}>JC #{r?.jobCardNumber ?? '—'}</p>
                      <p className="text-xs text-slate-500">
                        {r?.jobDate != null
                          ? new Date(r.jobDate).toISOString().slice(0, 10)
                          : '—'}{' '}
                        · {r?.status ?? '—'}
                      </p>
                      <p className="text-xs">
                        Grain: {r?.grainFitStatus ?? '—'}
                        {r?.issuedStockDisplay ? ` · ${r.issuedStockDisplay}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
                {(data.lastRuns?.length ?? 0) === 0 ? (
                  <p className="text-slate-500">No prior job cards linked to this product.</p>
                ) : null}
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}
