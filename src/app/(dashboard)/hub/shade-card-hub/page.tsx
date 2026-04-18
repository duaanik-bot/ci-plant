'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Star } from 'lucide-react'
import { HubCategoryNav } from '@/components/hub/HubCategoryNav'
import {
  ShadeCardSpotlightDrawer,
  type ShadeCardSpotlightRow,
} from '@/components/hub/ShadeCardSpotlightDrawer'
import { shadeCardAgeTier, shadeCardIsFadingStandard } from '@/lib/shade-card-age'

const mono =
  'font-[family-name:var(--font-designing-queue),ui-monospace,monospace] tabular-nums tracking-tight'

export default function ShadeCardHubPage() {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<ShadeCardSpotlightRow[]>([])
  const [loading, setLoading] = useState(true)
  const [spotlight, setSpotlight] = useState<ShadeCardSpotlightRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (q.trim()) params.set('q', q.trim())
      const r = await fetch(`/api/hub/shade-card-hub?${params}`)
      const j = await r.json()
      setRows(Array.isArray(j.rows) ? j.rows : [])
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [q])

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 200)
    return () => window.clearTimeout(t)
  }, [load])

  const fadingStandardsCount = useMemo(
    () => rows.filter((r) => shadeCardIsFadingStandard(r.currentAgeMonths ?? null)).length,
    [rows],
  )

  return (
    <div className="min-h-screen bg-[#000000] text-zinc-200">
      <div className="max-w-[1600px] mx-auto p-3 md:p-4 space-y-4 pb-20">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-amber-400 tracking-tight">Shade Card Hub</h1>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Color ledger · director spotlight · 12-month card age policy · Product Master links
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div
              className={`rounded-lg border border-orange-900/40 bg-zinc-950 px-3 py-2 ${mono}`}
              title="ΔE Limit Enforced < 2.0"
            >
              <p className="text-[9px] uppercase tracking-wider text-zinc-500 font-sans">Fading Standards</p>
              <p className="text-xl font-bold text-orange-400 tabular-nums leading-tight">{fadingStandardsCount}</p>
            </div>
            <Link
              href="/hub/shade_cards"
              className="text-xs px-3 py-1.5 rounded-lg border border-zinc-600 text-zinc-300 hover:bg-zinc-900 font-sans"
            >
              Floor / custody
            </Link>
          </div>
        </header>

        <HubCategoryNav active="shade_cards" />

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search shade, product, customer…"
            className={`flex-1 min-w-[200px] max-w-md rounded-lg border border-zinc-700 bg-black px-3 py-2 text-sm text-white placeholder:text-zinc-600 ${mono}`}
          />
        </div>

        <div className={`overflow-x-auto rounded-xl border border-zinc-800 bg-black ring-1 ring-white/5 ${mono}`}>
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-950 text-[10px] uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-2 h-12 align-middle w-8">Pri</th>
                <th className="px-2 h-12 align-middle whitespace-nowrap">Code</th>
                <th className="px-2 h-12 align-middle min-w-[12rem]">Client / product</th>
                <th className="px-2 h-12 align-middle whitespace-nowrap">Card age</th>
                <th className="px-2 h-12 align-middle">Last verified</th>
                <th className="px-2 h-12 align-middle font-sans" title="ΔE Limit Enforced < 2.0">
                  ΔE
                </th>
                <th className="px-2 h-12 align-middle">Attachment</th>
                <th className="px-2 h-12 align-middle">Custody</th>
                <th className="px-2 h-12 align-middle"> </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-zinc-500 text-center font-sans">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-zinc-600 text-center font-sans">
                    No shade cards match.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const months = r.currentAgeMonths ?? null
                  const tier = shadeCardAgeTier(months)
                  const clientName =
                    r.product?.customer?.name?.trim() || r.customer?.name?.trim() || '—'
                  const productName =
                    r.product?.cartonName?.trim() || r.productMaster?.trim() || '—'
                  const productLinkId = r.product?.id ?? r.productId ?? null
                  const aw =
                    r.masterArtworkRef?.trim() || r.product?.artworkCode?.trim() || '—'

                  return (
                    <tr
                      key={r.id}
                      className={`h-12 max-h-12 hover:bg-zinc-950/80 ${
                        r.fadeAlert ? 'ring-1 ring-red-900/40' : ''
                      }`}
                      style={
                        tier === 'expired' ? { backgroundColor: 'rgba(225, 29, 72, 0.2)' } : undefined
                      }
                    >
                      <td className="px-2 align-middle">
                        {r.industrialPriority ? (
                          <Star
                            className="h-3.5 w-3.5 fill-amber-400 text-amber-400 drop-shadow-[0_0_6px_rgba(251,191,36,0.5)]"
                          />
                        ) : (
                          <span className="text-zinc-700">·</span>
                        )}
                      </td>
                      <td className={`px-2 align-middle text-amber-300/95 whitespace-nowrap ${mono}`}>
                        {r.shadeCode}
                      </td>
                      <td className="px-2 align-middle min-w-0 font-sans">
                        <p className="font-bold text-emerald-400 truncate leading-tight">{clientName}</p>
                        {productLinkId ? (
                          <Link
                            href={`/product-master/${productLinkId}`}
                            className="text-sm text-white hover:text-sky-300 hover:underline block truncate"
                          >
                            {productName}
                          </Link>
                        ) : (
                          <span className="text-sm text-white block truncate">{productName}</span>
                        )}
                        <p className={`text-[10px] text-zinc-500 mt-0.5 ${mono}`}>
                          <span className="text-zinc-400">{aw}</span>
                          <span className="text-zinc-700"> | </span>
                          <span className="text-amber-300/90">{r.shadeCode}</span>
                        </p>
                      </td>
                      <td className="px-2 align-middle whitespace-nowrap">
                        {months == null ? (
                          <span className="text-zinc-600">—</span>
                        ) : tier === 'fresh' ? (
                          <span className={`text-[10px] font-medium text-emerald-500 ${mono}`}>
                            {months.toFixed(2)} mo
                          </span>
                        ) : tier === 'reverify' ? (
                          <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold bg-orange-500/20 text-orange-200 animate-pulse">
                            RE-VERIFY · {months.toFixed(2)} mo
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-rose-500/30 text-rose-100">
                            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                            EXPIRED
                          </span>
                        )}
                      </td>
                      <td
                        className={`px-2 align-middle whitespace-nowrap font-sans ${
                          r.fadeAlert ? 'text-red-400 font-semibold' : 'text-zinc-400'
                        }`}
                      >
                        <span className={mono}>{r.lastVerifiedAt ?? r.approvalDate ?? '—'}</span>
                      </td>
                      <td
                        className={`px-2 align-middle whitespace-nowrap ${
                          r.deltaEAlert ? 'text-red-400 animate-pulse' : 'text-emerald-400/90'
                        }`}
                      >
                        {r.deltaEReading != null ? r.deltaEReading : '—'}
                      </td>
                      <td className="px-2 align-middle font-sans">
                        {r.approvalAttachmentUrl ? (
                          <a
                            href={r.approvalAttachmentUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sky-400 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            PDF / image
                          </a>
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </td>
                      <td className="px-2 align-middle font-sans">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-medium border border-zinc-700/80 ${
                            tier === 'expired'
                              ? 'bg-rose-950/80 text-rose-200'
                              : 'bg-slate-800 text-zinc-200'
                          }`}
                        >
                          {tier === 'expired' ? 'EXPIRED' : r.custodyStatus}
                        </span>
                      </td>
                      <td className="px-2 align-middle font-sans">
                        <button
                          type="button"
                          onClick={() => setSpotlight(r)}
                          className="text-[10px] font-semibold uppercase tracking-wide text-orange-400 hover:text-orange-300"
                        >
                          Spotlight
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        <p className="text-center text-[10px] text-zinc-600 pt-4 border-t border-zinc-900 font-sans">
          Color Integrity Audit Enabled - 12 Month Limit Enforced.
        </p>
      </div>
      <ShadeCardSpotlightDrawer
        row={spotlight}
        onClose={() => setSpotlight(null)}
        onSaved={() => void load()}
      />
    </div>
  )
}
