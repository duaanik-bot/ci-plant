'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import type { EmbossTimelineEntry } from '@/lib/emboss-asset-timeline'

const mono =
  'font-[family-name:var(--font-designing-queue),ui-monospace,monospace] tabular-nums tracking-tight'

type Payload = {
  block: {
    id: string
    blockCode: string
    productName: string
    linkedProductId: string | null
    versionDisplay: string
    materialSpec: string
    reliefDepthMm: number | null
    cumulativeStrikes: number
    currentMachine: { id: string; code: string; name: string } | null
    issuedAt: string | null
  }
  timeline: EmbossTimelineEntry[]
}

function formatAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function EmbossHubSpotlightDrawer({
  blockId,
  onClose,
}: {
  blockId: string | null
  onClose: () => void
}) {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!blockId) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    fetch(`/api/emboss-blocks/${blockId}/spotlight`)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && !j.error) setData(j as Payload)
        else if (!cancelled) setData(null)
      })
      .catch(() => {
        if (!cancelled) setData(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [blockId])

  const b = data?.block

  return (
    <SlideOverPanel
      title={b ? `${b.productName} · asset lifecycle` : 'Emboss block'}
      isOpen={blockId != null}
      onClose={onClose}
      widthClass="max-w-lg"
    >
      <div className={`space-y-5 text-sm text-neutral-400 bg-background min-h-[100px] ${mono}`}>
        {loading ? (
          <p className="text-neutral-500 font-sans">Loading…</p>
        ) : data && b ? (
          <>
            <section className="rounded-xl border border-ds-line/40 bg-ds-main/80 px-3 py-3 space-y-2">
              <p className="text-neutral-500 text-[10px] uppercase tracking-wider font-sans">Rich identity</p>
              {b.linkedProductId ? (
                <Link
                  href={`/masters/cartons/${b.linkedProductId}`}
                  className="block text-base font-bold text-emerald-400 font-sans leading-snug hover:text-emerald-300 hover:underline"
                >
                  {b.productName}
                </Link>
              ) : (
                <p className="text-base font-bold text-emerald-400 font-sans leading-snug">{b.productName}</p>
              )}
              <p className={`text-xs text-ds-ink-muted ${mono}`}>
                <span className="text-ds-ink-faint font-sans">Code: </span>
                <span className="text-ds-ink">{b.blockCode}</span>
                <span className="text-neutral-600"> | </span>
                <span className="text-ds-ink-faint font-sans">Ver: </span>
                <span className="text-ds-ink">{b.versionDisplay}</span>
              </p>
              <p className="text-[10px] text-neutral-500 font-sans">
                {b.materialSpec}
                {b.reliefDepthMm != null ? (
                  <>
                    {' '}
                    • <span className={mono}>{b.reliefDepthMm}mm</span>
                  </>
                ) : null}
              </p>
            </section>

            <section className="rounded-xl border border-ds-line/40 bg-ds-main/80 px-3 py-3 space-y-2">
              <p className="text-neutral-500 text-[10px] uppercase tracking-wider font-sans">Current mount</p>
              {b.currentMachine ? (
                <Link
                  href={`/production/machine-flow?highlightMachineId=${encodeURIComponent(b.currentMachine.id)}`}
                  className="block text-ds-ink hover:text-emerald-300 hover:underline"
                >
                  {b.currentMachine.code} · {b.currentMachine.name}
                </Link>
              ) : (
                <p className="text-neutral-500 font-sans">Not issued to a press</p>
              )}
              {b.issuedAt ? (
                <p className="text-[10px] text-neutral-500 font-sans">
                  Issued {formatAt(b.issuedAt)}
                </p>
              ) : null}
              <p className={`text-[10px] text-neutral-500 pt-1 font-sans`}>
                Cumulative strikes (master):{' '}
                <span className={`text-orange-300 ${mono}`}>{b.cumulativeStrikes.toLocaleString()}</span>
              </p>
            </section>

            <section>
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 mb-3 font-sans">
                Usage history
              </h3>
              {data.timeline.length === 0 ? (
                <p className="text-neutral-600 text-xs font-sans">No timeline events yet.</p>
              ) : (
                <ol className="relative border-s border-ds-line/40 ms-2 ps-4 space-y-4 max-h-[52vh] overflow-y-auto">
                  {data.timeline.map((e) => (
                    <li key={e.id} className="relative">
                      <span
                        className="absolute -start-[21px] top-1.5 flex h-2.5 w-2.5 rounded-full bg-emerald-500 ring-4 ring-ring"
                        aria-hidden
                      />
                      <p className="text-[10px] text-neutral-500 font-sans">{formatAt(e.atIso)}</p>
                      <p className="text-sm text-ds-ink font-semibold font-sans">{e.actionLabel}</p>
                      <div className="mt-1 space-y-0.5 text-xs text-neutral-500">
                        {e.jobCardId && e.jobDisplay ? (
                          <p>
                            Job:{' '}
                            <Link
                              href={`/production/job-cards/${e.jobCardId}`}
                              className="text-sky-400 hover:underline"
                            >
                              {e.jobDisplay}
                            </Link>
                          </p>
                        ) : null}
                        {e.impressionsDelta != null ? (
                          <p className={mono}>
                            <span className="text-orange-300/95">+{e.impressionsDelta.toLocaleString()}</span>
                            {e.impressionsCumulative != null ? (
                              <span className="text-neutral-500">
                                {' '}
                                → Σ {e.impressionsCumulative.toLocaleString()} imp.
                              </span>
                            ) : null}
                          </p>
                        ) : null}
                        {e.operatorName ? (
                          <p className="text-[10px] text-neutral-500 font-sans">Operator: {e.operatorName}</p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        ) : (
          <p className="text-neutral-600 text-sm font-sans">Could not load block.</p>
        )}
      </div>
    </SlideOverPanel>
  )
}
