'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'
import { toast } from 'sonner'
import { COLOR_VERIFICATION_AUDIT } from '@/lib/shade-card-hub-audit'
import { shadeCardAgeTier } from '@/lib/shade-card-age'
import { SHADE_SUBSTRATE_VALUES, shadeSubstrateLabel } from '@/lib/shade-card-substrate'
import type { SpectroScanLogEntry } from '@/lib/shade-card-spectro-log'

const mono =
  'font-[family-name:var(--font-designing-queue),ui-monospace,monospace] tabular-nums tracking-tight'

export type ShadeCardSpotlightRow = {
  id: string
  shadeCode: string
  productId?: string | null
  product?: {
    id: string
    cartonName: string
    artworkCode: string | null
    customer: { id: string; name: string }
  } | null
  productMaster: string | null
  masterArtworkRef: string | null
  mfgDate?: string | null
  currentAgeMonths?: number | null
  substrateType?: string | null
  labL?: number | null
  labA?: number | null
  labB?: number | null
  inkRecipeNotes?: string | null
  spectroScanLog?: SpectroScanLogEntry[]
  customer: { id: string; name: string } | null
  lastVerifiedAt: string | null
  approvalDate: string | null
  deltaEReading: number | null
  approvalAttachmentUrl: string | null
  inkRecipeLink: string | null
  customerApprovalDoc: string | null
  validUntil: string | null
  spectroReportSummary: string | null
  colorSwatchHex: string | null
  custodyStatus: string
  industrialPriority: boolean
  fadeAlert: boolean
  deltaEAlert: boolean
}

function previewIsPdf(url: string): boolean {
  const u = url.toLowerCase().split('?')[0] ?? ''
  return u.endsWith('.pdf')
}

function previewIsImage(url: string): boolean {
  const u = url.toLowerCase().split('?')[0] ?? ''
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(u)
}

export function ShadeCardSpotlightDrawer({
  row,
  onClose,
  onSaved,
}: {
  row: ShadeCardSpotlightRow | null
  onClose: () => void
  onSaved?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [deltaE, setDeltaE] = useState('')
  const [verified, setVerified] = useState('')
  const [attach, setAttach] = useState('')
  const [spectro, setSpectro] = useState('')
  const [hex, setHex] = useState('')
  const [inkLink, setInkLink] = useState('')
  const [custDoc, setCustDoc] = useState('')
  const [substrate, setSubstrate] = useState<string>('')
  const [labL, setLabL] = useState('')
  const [labA, setLabA] = useState('')
  const [labB, setLabB] = useState('')
  const [inkRecipeNotes, setInkRecipeNotes] = useState('')

  useEffect(() => {
    if (!row) return
    setDeltaE(row.deltaEReading != null ? String(row.deltaEReading) : '')
    setVerified(row.lastVerifiedAt ?? new Date().toISOString().slice(0, 10))
    setAttach(row.approvalAttachmentUrl ?? '')
    setInkLink(row.inkRecipeLink ?? '')
    setCustDoc(row.customerApprovalDoc ?? row.approvalAttachmentUrl ?? '')
    setSpectro(row.spectroReportSummary ?? '')
    setHex(row.colorSwatchHex ?? '')
    setSubstrate(row.substrateType?.trim() || '')
    setLabL(row.labL != null ? String(row.labL) : '')
    setLabA(row.labA != null ? String(row.labA) : '')
    setLabB(row.labB != null ? String(row.labB) : '')
    setInkRecipeNotes(row.inkRecipeNotes ?? '')
  }, [row])

  async function saveVerification() {
    if (!row) return
    setBusy(true)
    try {
      const payload: Record<string, unknown> = {
        lastVerifiedAt: verified || undefined,
        approvalAttachmentUrl: attach.trim() || undefined,
        inkRecipeLink: inkLink.trim() || undefined,
        customerApprovalDoc: custDoc.trim() || undefined,
        spectroReportSummary: spectro.trim() || undefined,
        inkRecipeNotes: inkRecipeNotes.trim() || undefined,
      }
      if (substrate.trim() && SHADE_SUBSTRATE_VALUES.includes(substrate as (typeof SHADE_SUBSTRATE_VALUES)[number])) {
        payload.substrateType = substrate
      }
      if (labL.trim()) payload.labL = Number(labL)
      if (labA.trim()) payload.labA = Number(labA)
      if (labB.trim()) payload.labB = Number(labB)
      if (deltaE.trim()) payload.deltaEReading = Number(deltaE)
      if (hex.trim()) payload.colorSwatchHex = hex.trim()
      const res = await fetch(`/api/shade-cards/${row.id}/verify-color`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((j as { error?: string }).error ?? 'Save failed')
      toast.success((j as { message?: string }).message ?? COLOR_VERIFICATION_AUDIT)
      onSaved?.()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  const approvalUrl = (row?.customerApprovalDoc || row?.approvalAttachmentUrl || '').trim()
  const awLine =
    row?.masterArtworkRef?.trim() || row?.product?.artworkCode?.trim() || '—'

  return (
    <SlideOverPanel
      title={row ? `${row.shadeCode} · Color DNA` : 'Shade card'}
      isOpen={row != null}
      onClose={onClose}
      widthClass="max-w-lg"
    >
      {row ? (
        <div className={`space-y-4 text-sm bg-[#000000] text-zinc-300 ${mono}`}>
          <div
            className={`rounded-xl border px-3 py-3 flex gap-4 items-center ${
              row.fadeAlert ? 'border-red-600 animate-pulse bg-red-950/20' : 'border-zinc-800 bg-zinc-950/60'
            }`}
          >
            <div
              className="h-16 w-16 rounded-lg border border-zinc-700 shrink-0 shadow-inner"
              style={{
                backgroundColor:
                  row.colorSwatchHex && /^#[0-9A-Fa-f]{6}$/.test(row.colorSwatchHex)
                    ? row.colorSwatchHex
                    : '#27272a',
              }}
              title="Color swatch"
            />
            <div className="min-w-0 font-sans">
              <p className="text-sm font-bold text-emerald-400 truncate">
                {row.product?.customer?.name?.trim() || row.customer?.name?.trim() || '—'}
              </p>
              {row.product?.id || row.productId ? (
                <Link
                  href={`/product-master/${row.product?.id ?? row.productId}`}
                  className="text-sm text-white hover:text-sky-300 hover:underline block truncate mt-0.5"
                >
                  {row.product?.cartonName?.trim() || row.productMaster?.trim() || '—'}
                </Link>
              ) : (
                <p className="text-sm text-white truncate mt-0.5">{row.productMaster ?? '—'}</p>
              )}
              <p className={`text-[10px] text-zinc-500 mt-1 ${mono}`}>
                <span className="text-zinc-400">{awLine}</span>
                <span className="text-zinc-700"> | </span>
                <span className="text-amber-300/90">{row.shadeCode}</span>
              </p>
              {row.mfgDate ? (
                <p className={`text-[10px] text-zinc-500 mt-1 ${mono}`}>
                  MFG {row.mfgDate}
                  {row.currentAgeMonths != null ? (
                    <>
                      {' '}
                      ·{' '}
                      {shadeCardAgeTier(row.currentAgeMonths) === 'expired' ? (
                        <span className="text-rose-300 inline-flex items-center gap-0.5">
                          <AlertTriangle className="h-3 w-3 inline" />
                          EXPIRED · {row.currentAgeMonths.toFixed(2)} mo
                        </span>
                      ) : shadeCardAgeTier(row.currentAgeMonths) === 'reverify' ? (
                        <span className="text-orange-300 animate-pulse">
                          RE-VERIFY · {row.currentAgeMonths.toFixed(2)} mo
                        </span>
                      ) : (
                        <span className="text-emerald-500">{row.currentAgeMonths.toFixed(2)} mo</span>
                      )}
                    </>
                  ) : null}
                </p>
              ) : null}
              <p className="text-[10px] text-zinc-500 mt-1" title="ΔE Limit Enforced < 2.0">
                ΔE{' '}
                <span className={row.deltaEAlert ? 'text-red-400 font-semibold' : 'text-emerald-400'}>
                  {row.deltaEReading != null ? row.deltaEReading : '—'}
                </span>{' '}
                <span className="text-zinc-600">(limit &lt; 2.0)</span>
              </p>
              {row.validUntil ? (
                <p className="text-[10px] text-zinc-500 mt-1">
                  Valid until{' '}
                  <span className={`${mono} text-zinc-300`}>{row.validUntil}</span>{' '}
                  <span className="text-zinc-600">(last verify + 180d)</span>
                </p>
              ) : null}
            </div>
          </div>

          <section className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-3 space-y-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 font-sans">
              Color DNA (CIE L*a*b*)
            </h3>
            <div className={`grid grid-cols-3 gap-2 text-xs ${mono}`}>
              <label className="block text-[10px] text-zinc-500 font-sans">
                L*
                <input
                  value={labL}
                  onChange={(e) => setLabL(e.target.value)}
                  className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-zinc-200"
                  inputMode="decimal"
                />
              </label>
              <label className="block text-[10px] text-zinc-500 font-sans">
                a*
                <input
                  value={labA}
                  onChange={(e) => setLabA(e.target.value)}
                  className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-zinc-200"
                  inputMode="decimal"
                />
              </label>
              <label className="block text-[10px] text-zinc-500 font-sans">
                b*
                <input
                  value={labB}
                  onChange={(e) => setLabB(e.target.value)}
                  className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-zinc-200"
                  inputMode="decimal"
                />
              </label>
            </div>
            <label className="block text-[10px] text-zinc-500 font-sans">
              Substrate type
              <select
                value={substrate}
                onChange={(e) => setSubstrate(e.target.value)}
                className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-zinc-200 text-xs"
              >
                <option value="">—</option>
                {SHADE_SUBSTRATE_VALUES.map((v) => (
                  <option key={v} value={v}>
                    {shadeSubstrateLabel(v)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[10px] text-zinc-500 font-sans">
              Ink recipe (PMS / lab mix)
              <textarea
                value={inkRecipeNotes}
                onChange={(e) => setInkRecipeNotes(e.target.value)}
                rows={4}
                className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-zinc-200 text-xs resize-y"
                placeholder="Pigment loads, varnish, white underprint…"
              />
            </label>
          </section>

          {approvalUrl ? (
            <section>
              <h3 className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 font-sans">
                Approval doc (signed sample)
              </h3>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 overflow-hidden max-h-64">
                {previewIsImage(approvalUrl) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={approvalUrl} alt="Approval" className="w-full max-h-64 object-contain bg-black" />
                ) : previewIsPdf(approvalUrl) ? (
                  <iframe title="Approval PDF" src={approvalUrl} className="w-full h-64 bg-zinc-900" />
                ) : (
                  <p className="text-xs text-zinc-500 p-3 font-sans">
                    Preview not available for this URL type.{' '}
                    <a href={approvalUrl} target="_blank" rel="noopener noreferrer" className="text-sky-400 underline">
                      Open file →
                    </a>
                  </p>
                )}
              </div>
            </section>
          ) : null}

          <section>
            <h3 className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 font-sans">Spectro summary</h3>
            <p className="text-xs text-zinc-400 whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950/50 px-2 py-2 min-h-[4rem]">
              {row.spectroReportSummary ?? 'No spectro report on file.'}
            </p>
          </section>

          {row.spectroScanLog && row.spectroScanLog.length > 0 ? (
            <section>
              <h3 className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2 font-sans">
                Spectro-scan log
              </h3>
              <ol className="relative border-s border-zinc-800 ms-2 ps-4 space-y-3 max-h-48 overflow-y-auto">
                {row.spectroScanLog.map((e, i) => (
                  <li key={`${e.scannedAt}-${i}`} className="relative">
                    <span
                      className="absolute -start-[21px] top-1.5 flex h-2 w-2 rounded-full bg-emerald-500 ring-4 ring-black"
                      aria-hidden
                    />
                    <p className={`text-[10px] text-zinc-500 ${mono}`}>
                      {new Date(e.scannedAt).toLocaleString(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </p>
                    {e.deltaE != null ? (
                      <p className={`text-xs text-orange-300/90 ${mono}`}>ΔE {e.deltaE}</p>
                    ) : null}
                    {e.note ? <p className="text-[10px] text-zinc-400 font-sans">{e.note}</p> : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {row.inkRecipeLink ? (
            <a
              href={row.inkRecipeLink}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-xs text-sky-400 hover:underline font-sans"
            >
              Ink Kitchen recipe URL →
            </a>
          ) : null}

          <div className="border-t border-zinc-800 pt-3 space-y-2">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-sans">Record verification</p>
            <label className="block text-[10px] text-zinc-500 font-sans">
              Last verified date
              <input
                type="date"
                value={verified}
                onChange={(e) => setVerified(e.target.value)}
                className={`mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-zinc-200 text-xs ${mono}`}
              />
            </label>
            <label className="block text-[10px] text-zinc-500 font-sans">
              ΔE reading
              <input
                value={deltaE}
                onChange={(e) => setDeltaE(e.target.value)}
                className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-zinc-200 text-xs"
                inputMode="decimal"
              />
            </label>
            <label className="block text-[10px] text-zinc-500 font-sans">
              Approval URL (legacy / mirror)
              <input
                value={attach}
                onChange={(e) => setAttach(e.target.value)}
                className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-zinc-200 text-xs"
              />
            </label>
            <label className="block text-[10px] text-zinc-500 font-sans">
              Ink recipe link (PMS / lab)
              <input
                value={inkLink}
                onChange={(e) => setInkLink(e.target.value)}
                className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-zinc-200 text-xs"
                placeholder="https://…"
              />
            </label>
            <label className="block text-[10px] text-zinc-500 font-sans">
              Customer approval document (signed scan)
              <input
                value={custDoc}
                onChange={(e) => setCustDoc(e.target.value)}
                className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-zinc-200 text-xs"
                placeholder="https://…"
              />
            </label>
            <label className="block text-[10px] text-zinc-500 font-sans">
              Spectro summary
              <textarea
                value={spectro}
                onChange={(e) => setSpectro(e.target.value)}
                rows={3}
                className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-zinc-200 text-xs"
              />
            </label>
            <label className="block text-[10px] text-zinc-500 font-sans">
              Swatch hex (#RRGGBB)
              <input
                value={hex}
                onChange={(e) => setHex(e.target.value)}
                className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-zinc-200 text-xs"
                placeholder="#C41E3A"
              />
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => void saveVerification()}
              className="w-full rounded-lg bg-emerald-800 hover:bg-emerald-700 text-white text-xs font-semibold py-2 disabled:opacity-50 font-sans"
            >
              {busy ? '…' : `Save & log — ${COLOR_VERIFICATION_AUDIT}`}
            </button>
          </div>

          <p className="text-[10px] text-zinc-600 text-center font-sans pt-1">
            Color Integrity Audit Enabled - 12 Month Limit Enforced.
          </p>
        </div>
      ) : null}
    </SlideOverPanel>
  )
}
