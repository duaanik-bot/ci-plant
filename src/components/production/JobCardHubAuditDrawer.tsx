'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from 'lucide-react'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { toast } from 'sonner'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type LiveOee = {
  oee: number
  availability: number
  performance: number
  quality: number
  currentSpeedPph: number
  ratedSpeedPph: number
  secondsSinceLastTick: number | null
  downtimeLock: boolean
} | null

type HubAuditPayload = {
  jobCardNumber: number
  liveOee: LiveOee
  waste: {
    setupSheets: number
    runningWasteSheets: number
    sheetIssueCount: number
  }
  tooling: {
    dieNumberSpec: number | null
    shadeCodeSpec: string | null
    embossBlockCode: string | null
    shadeCodesIssued: string[]
    verification: {
      shadeMatch: boolean | null
      dieMatch: boolean | null
    }
  }
  remarksTimeline: { at: string; kind: string; text: string }[]
}

function Verdict({
  label,
  value,
}: {
  label: string
  value: boolean | null
}) {
  if (value === true) {
    return (
      <div className="flex items-center gap-2 text-emerald-400 text-sm">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span>{label}: verified</span>
      </div>
    )
  }
  if (value === false) {
    return (
      <div className="flex items-center gap-2 text-rose-400 text-sm">
        <XCircle className="h-4 w-4 shrink-0" />
        <span>{label}: mismatch</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 text-ds-ink-faint text-sm">
      <HelpCircle className="h-4 w-4 shrink-0" />
      <span>{label}: not enough data</span>
    </div>
  )
}

export function JobCardHubAuditDrawer({
  jobCardId,
  jobCardNumber,
  onClose,
}: {
  jobCardId: string | null
  jobCardNumber: number | null
  onClose: () => void
}) {
  const [data, setData] = useState<HubAuditPayload | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!jobCardId) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    fetch(`/api/job-cards/${jobCardId}/hub-audit`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        if (j?.error) {
          setData(null)
          toast.error(j.error)
          return
        }
        setData(j as HubAuditPayload)
      })
      .catch(() => {
        if (!cancelled) {
          setData(null)
          toast.error('Failed to load audit')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [jobCardId])

  const open = jobCardId != null

  return (
    <SlideOverPanel
      title={`Live Production Audit · JC ${jobCardNumber ?? '—'}`}
      isOpen={open}
      onClose={onClose}
      widthClass="max-w-lg"
    >
      {loading && <p className="text-ds-ink-faint text-sm">Loading audit…</p>}
      {!loading && data && (
        <div className="space-y-6 text-ds-ink">
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">OEE tracker</h3>
            {data.liveOee ? (
              <div className={`rounded-lg border border-ds-line/40 bg-ds-main/80 p-3 space-y-2 ${mono} text-sm`}>
                <div className="flex justify-between gap-4">
                  <span className="text-ds-ink-faint">Live speed</span>
                  <span className="text-emerald-300">{data.liveOee.currentSpeedPph} sh/h</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-ds-ink-faint">Rated capacity</span>
                  <span className="text-ds-ink">{data.liveOee.ratedSpeedPph} sh/h</span>
                </div>
                <div className="flex justify-between gap-4 border-t border-ds-line/40 pt-2">
                  <span className="text-ds-ink-faint">Performance</span>
                  <span>{data.liveOee.performance}%</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-ds-ink-faint">Availability</span>
                  <span>{data.liveOee.availability}%</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-ds-ink-faint">Quality</span>
                  <span>{data.liveOee.quality}%</span>
                </div>
                <div className="flex justify-between gap-4 font-semibold text-ds-warning">
                  <span>OEE</span>
                  <span>{data.liveOee.oee}%</span>
                </div>
                {data.liveOee.downtimeLock ? (
                  <p className="text-rose-400 text-xs flex items-center gap-1 pt-1">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Downtime lock — speed gated idle
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-ds-ink-faint text-sm">No live printing stage in progress — OEE not active.</p>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">Waste ledger</h3>
            <div className={`rounded-lg border border-ds-line/40 bg-ds-main/80 p-3 space-y-2 ${mono} text-sm`}>
              <div className="flex justify-between">
                <span className="text-ds-ink-faint">Setup sheets (job card)</span>
                <span>{data.waste.setupSheets}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ds-ink-faint">Running waste (excess issues)</span>
                <span className="text-rose-300">{data.waste.runningWasteSheets}</span>
              </div>
              <div className="flex justify-between text-xs text-ds-ink-faint">
                <span>Sheet issue rows</span>
                <span>{data.waste.sheetIssueCount}</span>
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">Tooling verification</h3>
            <div className="rounded-lg border border-ds-line/40 bg-ds-main/80 p-3 space-y-3 text-sm">
              <div className={`grid grid-cols-2 gap-2 ${mono} text-xs`}>
                <div>
                  <div className="text-ds-ink-faint">PO die # (spec)</div>
                  <div>{data.tooling.dieNumberSpec ?? '—'}</div>
                </div>
                <div>
                  <div className="text-ds-ink-faint">Emboss on card</div>
                  <div>{data.tooling.embossBlockCode ?? '—'}</div>
                </div>
                <div>
                  <div className="text-ds-ink-faint">PO shade (spec)</div>
                  <div>{data.tooling.shadeCodeSpec ?? '—'}</div>
                </div>
                <div>
                  <div className="text-ds-ink-faint">Shade issued to job</div>
                  <div>{data.tooling.shadeCodesIssued.length ? data.tooling.shadeCodesIssued.join(', ') : '—'}</div>
                </div>
              </div>
              <Verdict label="Die / emboss alignment" value={data.tooling.verification.dieMatch} />
              <Verdict label="Shade card" value={data.tooling.verification.shadeMatch} />
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">Operator remarks timeline</h3>
            <div className="max-h-56 overflow-y-auto rounded-lg border border-ds-line/40 bg-ds-main/80 divide-y divide-ds-line/40">
              {data.remarksTimeline.length === 0 ? (
                <p className="p-3 text-ds-ink-faint text-sm">No floor notes yet.</p>
              ) : (
                data.remarksTimeline.map((row, i) => (
                  <div key={`${row.at}-${i}`} className="p-2.5 text-sm">
                    <div className={`text-[10px] uppercase tracking-wide text-ds-ink-faint ${mono}`}>
                      {new Date(row.at).toLocaleString()} · {row.kind}
                    </div>
                    <p className="text-ds-ink mt-0.5">{row.text}</p>
                  </div>
                ))
              )}
            </div>
          </section>

          <div className="flex flex-wrap gap-2 pt-2 border-t border-ds-line/40">
            <Link
              href={jobCardId ? `/production/job-cards/${jobCardId}` : '#'}
              className="px-3 py-2 rounded-lg bg-ds-elevated text-ds-ink text-sm hover:bg-ds-elevated"
            >
              Open job card
            </Link>
            <a
              href={jobCardId ? `/api/job-cards/${jobCardId}/card-pdf` : '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-2 rounded-lg bg-ds-warning text-primary-foreground text-sm font-medium hover:bg-ds-warning"
            >
              Print official card
            </a>
          </div>
        </div>
      )}
    </SlideOverPanel>
  )
}
