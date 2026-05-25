'use client'

import { useEffect, useState } from 'react'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'

const mono = 'font-designing-queue tabular-nums text-sm font-semibold'

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

  const m = data?.master ?? {}
  const name = String(m?.cartonName ?? '—')

  return (
    <GlobalPopoutModal
      isOpen={open && !!cartonId}
      onClose={onClose}
      title="Product master"
      metadata={
        data ? (
          <span className="text-xs text-ds-ink-faint">{name}</span>
        ) : loading ? (
          <span className="text-xs text-ds-ink-faint">Loading…</span>
        ) : null
      }
      mode="preview"
      size="sm"
      zIndexClass="z-[91]"
    >
      <div className="space-y-4 text-sm text-ds-ink">
        {err ? <p className="text-sm text-[var(--error)]">{err}</p> : null}
        {loading ? <p className="text-ds-ink-faint">Loading…</p> : null}
        {!loading && data && (
          <>
            <div className="space-y-2 rounded-ds-md bg-ds-elevated/40 p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-ds-ink-faint">Master specs</p>
              <p>
                <span className="text-ds-ink-faint">GSM:</span>{' '}
                <span className={mono}>{m?.gsm != null ? String(m.gsm) : '—'}</span>
              </p>
              <p>
                <span className="text-ds-ink-faint">Paper:</span> {String(m?.paperType ?? '—')}
              </p>
              <p>
                <span className="text-ds-ink-faint">Coating:</span> {String(m?.coatingType ?? '—')}
              </p>
              <p>
                <span className="text-ds-ink-faint">Laminate / secondary:</span> {String(m?.laminateType ?? '—')}
              </p>
              <p>
                <span className="text-ds-ink-faint">AW code:</span>{' '}
                <span className={`text-ds-warning ${mono}`}>{String(m?.artworkCode ?? '—')}</span>
              </p>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-ds-ink-faint">
                Grain direction
              </p>
              <p className="whitespace-pre-wrap text-ds-ink-muted">{String(data.grainDirectionNote ?? '—')}</p>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-ds-ink-faint">
                Hub readiness (live)
              </p>
              <ul className="space-y-1">
                <li>
                  Plates / die:{' '}
                  {data.hub?.die ? (
                    <span className="text-[var(--success)]">
                      Die {data.hub.die.dyeNumber}/{data.hub.die.ups} · {data.hub.die.sheetSize}
                    </span>
                  ) : (
                    <span className="text-ds-warning">—</span>
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
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-ds-ink-faint">
                Last production runs
              </p>
              <ul className="space-y-2">
                {(data.lastRuns ?? []).map((r) => (
                  <li
                    key={r?.jobCardNumber}
                    className="rounded-ds-md bg-ds-elevated/40 px-3 py-2 text-ds-ink-muted"
                  >
                    <p className={`${mono} text-ds-warning`}>JC #{r?.jobCardNumber ?? '—'}</p>
                    <p className="text-xs text-ds-ink-faint">
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
                <p className="text-ds-ink-faint">No prior job cards linked to this product.</p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </GlobalPopoutModal>
  )
}
