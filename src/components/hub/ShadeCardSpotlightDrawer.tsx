'use client'

import { useEffect, useMemo, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { COLOR_VERIFICATION_AUDIT } from '@/lib/shade-card-hub-audit'
import { shadeCardAgeTier } from '@/lib/shade-card-age'
import { shadeCardPhysicalLabel } from '@/lib/shade-card-custody-condition'
import { SHADE_SUBSTRATE_VALUES, shadeSubstrateLabel } from '@/lib/shade-card-substrate'
import { SHADE_CARD_ACTION } from '@/lib/shade-card-events'
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
  currentHolder?: string | null
  /** Operator display name when card is on floor (custody chain). */
  issuedOperator?: string | null
  industrialPriority: boolean
  fadeAlert: boolean
  deltaEAlert: boolean
  daysSinceVerified?: number | null
  remarks?: string | null
  remarksEditedAt?: string | null
  remarksEditedByName?: string | null
  updatedAt?: string
}

type UsageEventRow = {
  id: string
  actionType: string
  details: unknown
  createdAt: string
}

function previewIsPdf(url: string): boolean {
  const u = url.toLowerCase().split('?')[0] ?? ''
  return u.endsWith('.pdf')
}

function previewIsImage(url: string): boolean {
  const u = url.toLowerCase().split('?')[0] ?? ''
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(u)
}

function formatUsageDetails(actionType: string, details: unknown): string {
  const d =
    details && typeof details === 'object' && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : {}
  const pickStr = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null)
  const pickNum = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : null)

  if (actionType === SHADE_CARD_ACTION.ISSUED) {
    const mc = pickStr('machineCode') ?? pickStr('machineId')
    const op = pickStr('operatorName')
    const uid = pickStr('operatorUserId')
    const jn = pickNum('jobCardNumber')
    const ic = pickStr('initialCondition')
    const icLabel =
      ic === 'mint' || ic === 'used' || ic === 'minor_damage' ? shadeCardPhysicalLabel(ic) : ic
    const parts = [
      mc ? `Machine ${mc}` : null,
      jn != null ? `JC #${jn}` : null,
      op ? `Operator ${op}` : null,
      uid ? `Operator ID ${uid}` : null,
      icLabel ? `Checkout ${icLabel}` : null,
    ].filter(Boolean)
    return parts.length ? parts.join(' · ') : 'Issued to floor'
  }
  if (actionType === SHADE_CARD_ACTION.RECEIVED) {
    const imp = pickNum('finalImpressions')
    const cond = pickStr('condition')
    const loc = pickStr('returnLocation')
    const usable = typeof d.usable === 'boolean' ? (d.usable ? 'Usable' : 'Damaged') : null
    const ret = pickStr('returningOperatorName')
    const end = pickStr('endCondition')
    const endLabel =
      end === 'mint' || end === 'used' || end === 'minor_damage' ? shadeCardPhysicalLabel(end) : end
    const dmg = d.damageReport === true ? '⚠ Damage report' : null
    return [
      ret ? `Returned by ${ret}` : null,
      endLabel ? `End ${endLabel}` : null,
      dmg,
      loc ? `→ ${loc}` : null,
      usable,
      imp != null && imp > 0 ? `Impressions +${imp}` : null,
      cond ? `Ledger ${cond}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'Received to rack'
  }
  if (actionType === SHADE_CARD_ACTION.VENDOR_RECEIVED) {
    const notes = pickStr('notes')
    const cond = pickStr('condition')
    return [notes, cond ? `Condition ${cond}` : null].filter(Boolean).join(' · ') || 'Vendor receive'
  }
  if (actionType === SHADE_CARD_ACTION.VERIFICATION_SCAN) {
    const de = pickNum('deltaE')
    const lv = pickStr('lastVerifiedAt')
    const uid = pickStr('performedByUserId')
    return [
      lv ? `Verified ${lv}` : null,
      de != null ? `ΔE ${de}` : null,
      uid ? `Actor ${uid}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'Verification scan'
  }
  if (actionType === SHADE_CARD_ACTION.LOCATION_CHANGE) {
    const from = pickStr('fromLocation')
    const to = pickStr('toLocation')
    const ph = pickStr('phase')
    return [from && to ? `${from} → ${to}` : null, ph ? ph.replace(/_/g, ' ') : null]
      .filter(Boolean)
      .join(' · ') || 'Location change'
  }
  return '—'
}

function usageLabel(actionType: string): string {
  if (actionType === SHADE_CARD_ACTION.ISSUED) return 'Issue'
  if (actionType === SHADE_CARD_ACTION.RECEIVED) return 'Receive'
  if (actionType === SHADE_CARD_ACTION.VENDOR_RECEIVED) return 'Receive (vendor)'
  if (actionType === SHADE_CARD_ACTION.VERIFICATION_SCAN) return 'Verification scan'
  if (actionType === SHADE_CARD_ACTION.LOCATION_CHANGE) return 'Location'
  return actionType
}

/** Usage ledger: [Timestamp] | [Operator Name] | [Job #] | [Resulting ΔE] */
function handshakeLedgerPipeLine(evt: UsageEventRow): string {
  const ts = new Date(evt.createdAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  })
  const d =
    evt.details && typeof evt.details === 'object' && !Array.isArray(evt.details)
      ? (evt.details as Record<string, unknown>)
      : {}
  const pickStr = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null)
  const pickNum = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : null)
  const de = pickNum('resultingDeltaE')
  const deltaCol = de != null && Number.isFinite(de) ? String(de) : '—'

  if (evt.actionType === SHADE_CARD_ACTION.ISSUED) {
    const op = pickStr('operatorName')?.trim() || '—'
    const jn = pickNum('jobCardNumber')
    const job = jn != null ? `#${jn}` : '—'
    return `${ts} | ${op} | ${job} | ${deltaCol}`
  }
  if (evt.actionType === SHADE_CARD_ACTION.RECEIVED) {
    const op = pickStr('returningOperatorName')?.trim() || '—'
    return `${ts} | ${op} | — | ${deltaCol}`
  }
  return `${ts} | — | — | —`
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
  const [usageEvents, setUsageEvents] = useState<UsageEventRow[]>([])
  const [usageLoading, setUsageLoading] = useState(false)

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

  useEffect(() => {
    if (!row?.id) {
      setUsageEvents([])
      return
    }
    let cancelled = false
    setUsageLoading(true)
    void fetch(`/api/inventory-hub/shade-cards/${row.id}/events`)
      .then((r) => r.json())
      .then((j: { events?: UsageEventRow[] }) => {
        if (cancelled || !Array.isArray(j.events)) return
        const allow = new Set<string>([
          SHADE_CARD_ACTION.ISSUED,
          SHADE_CARD_ACTION.RECEIVED,
          SHADE_CARD_ACTION.VENDOR_RECEIVED,
          SHADE_CARD_ACTION.VERIFICATION_SCAN,
          SHADE_CARD_ACTION.LOCATION_CHANGE,
        ])
        setUsageEvents(j.events.filter((e) => allow.has(e.actionType)))
      })
      .catch(() => {
        if (!cancelled) setUsageEvents([])
      })
      .finally(() => {
        if (!cancelled) setUsageLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [row?.id])

  const issueEventCount = useMemo(
    () => usageEvents.filter((e) => e.actionType === SHADE_CARD_ACTION.ISSUED).length,
    [usageEvents],
  )

  const handshakeLedger = useMemo(
    () =>
      usageEvents
        .filter(
          (e) =>
            e.actionType === SHADE_CARD_ACTION.ISSUED || e.actionType === SHADE_CARD_ACTION.RECEIVED,
        )
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [usageEvents],
  )

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

  const proofUrl = (row?.customerApprovalDoc || row?.approvalAttachmentUrl || '').trim()
  const awLine = row?.masterArtworkRef?.trim() || row?.product?.artworkCode?.trim() || '—'
  const productTitle = row?.product?.cartonName?.trim() || row?.productMaster?.trim() || '—'
  const productLinkId = row?.product?.id ?? row?.productId ?? null
  const clientName = row?.product?.customer?.name?.trim() || row?.customer?.name?.trim() || '—'

  return (
    <Dialog.Root
      open={row != null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className={`fixed z-[70] right-0 top-0 flex h-full w-full max-w-lg flex-col border-l border-zinc-800 bg-[#000000] shadow-2xl outline-none ${mono}`}
        >
          <Dialog.Title className="sr-only">
            {row ? `Product DNA — ${productTitle}` : 'Shade card'}
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            Color specification, digital proof, and custody usage for this shade card.
          </Dialog.Description>

          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3 shrink-0">
            <h2 className="min-w-0 text-sm font-semibold leading-tight text-zinc-100 font-sans">
              <span className="text-zinc-500 font-normal">Product DNA — </span>
              <span className="text-white">{row ? productTitle : '—'}</span>
            </h2>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-white font-sans"
                aria-label="Close"
              >
                ✕
              </button>
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3">
            {row ? (
              <div className="space-y-4 text-sm text-zinc-300">
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 font-sans">
                    Total cumulative runs
                  </p>
                  <p className={`mt-1 text-2xl font-bold text-amber-400 tabular-nums ${mono}`}>
                    {issueEventCount}
                  </p>
                  <p className={`mt-0.5 text-[10px] text-zinc-600 ${mono}`}>
                    Issued-to-floor handshakes (ledger count)
                  </p>
                </div>
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
                    <p className="text-sm font-bold text-emerald-400 truncate">{clientName}</p>
                    {productLinkId ? (
                      <Link
                        href={`/product/${productLinkId}`}
                        className="mt-0.5 block truncate text-sm text-white hover:text-sky-300 hover:underline"
                      >
                        {productTitle}
                      </Link>
                    ) : (
                      <p className="mt-0.5 truncate text-sm text-white">{productTitle}</p>
                    )}
                    <p className={`mt-1 text-[10px] text-zinc-500 ${mono}`}>
                      <span className="text-zinc-400">{awLine}</span>
                      <span className="text-zinc-700"> | </span>
                      <span className="text-amber-300/90">{row.shadeCode}</span>
                    </p>
                    {row.mfgDate ? (
                      <p className={`mt-1 text-[10px] text-zinc-500 ${mono}`}>
                        MFG {row.mfgDate}
                        {row.currentAgeMonths != null ? (
                          <>
                            {' '}
                            ·{' '}
                            {shadeCardAgeTier(row.currentAgeMonths) === 'expired' ? (
                              <span className="text-rose-500 inline-flex items-center gap-0.5">
                                <AlertTriangle className="h-3 w-3 inline" aria-hidden />
                                EXPIRED · {row.currentAgeMonths.toFixed(2)} mo
                              </span>
                            ) : shadeCardAgeTier(row.currentAgeMonths) === 'reverify' ? (
                              <span className="inline-flex items-center gap-1 text-amber-500">
                                <RefreshCw className="h-3 w-3 shrink-0 animate-pulse" aria-hidden />
                                {row.currentAgeMonths.toFixed(2)} mo
                              </span>
                            ) : (
                              <span className="text-emerald-500">{row.currentAgeMonths.toFixed(2)} mo</span>
                            )}
                          </>
                        ) : null}
                      </p>
                    ) : null}
                    <p className="mt-1 text-[10px] text-zinc-500" title="ΔE Limit Enforced < 2.0">
                      ΔE{' '}
                      <span className={row.deltaEAlert ? 'text-red-400 font-semibold' : 'text-emerald-400'}>
                        {row.deltaEReading != null ? row.deltaEReading : '—'}
                      </span>{' '}
                      <span className="text-zinc-600">(limit &lt; 2.0)</span>
                    </p>
                  </div>
                </div>

                <section className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-3 space-y-2">
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 font-sans">
                    LAB values
                  </h3>
                  <div className={`grid grid-cols-3 gap-2 text-center ${mono}`}>
                    <div className="rounded-lg border border-zinc-800 bg-black px-2 py-2">
                      <p className="text-[9px] uppercase text-zinc-500">L*</p>
                      <p className="text-base font-semibold text-zinc-100 tabular-nums">{labL.trim() || '—'}</p>
                    </div>
                    <div className="rounded-lg border border-zinc-800 bg-black px-2 py-2">
                      <p className="text-[9px] uppercase text-zinc-500">a*</p>
                      <p className="text-base font-semibold text-zinc-100 tabular-nums">{labA.trim() || '—'}</p>
                    </div>
                    <div className="rounded-lg border border-zinc-800 bg-black px-2 py-2">
                      <p className="text-[9px] uppercase text-zinc-500">b*</p>
                      <p className="text-base font-semibold text-zinc-100 tabular-nums">{labB.trim() || '—'}</p>
                    </div>
                  </div>
                  <div className={`grid grid-cols-3 gap-2 pt-1 ${mono}`}>
                    <label className="block text-[9px] text-zinc-500 font-sans">
                      Edit L*
                      <input
                        value={labL}
                        onChange={(e) => setLabL(e.target.value)}
                        className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-xs text-zinc-200"
                        inputMode="decimal"
                      />
                    </label>
                    <label className="block text-[9px] text-zinc-500 font-sans">
                      Edit a*
                      <input
                        value={labA}
                        onChange={(e) => setLabA(e.target.value)}
                        className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-xs text-zinc-200"
                        inputMode="decimal"
                      />
                    </label>
                    <label className="block text-[9px] text-zinc-500 font-sans">
                      Edit b*
                      <input
                        value={labB}
                        onChange={(e) => setLabB(e.target.value)}
                        className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-xs text-zinc-200"
                        inputMode="decimal"
                      />
                    </label>
                  </div>
                </section>

                {proofUrl ? (
                  <section>
                    <h3 className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500 font-sans">
                      Digital proof (client-signed)
                    </h3>
                    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/50">
                      {previewIsImage(proofUrl) ? (
                        <div className="relative h-64 w-full bg-black">
                          <Image
                            src={proofUrl}
                            alt="Client-signed approval"
                            fill
                            unoptimized
                            className="object-contain"
                            sizes="(max-width: 512px) 100vw, 512px"
                          />
                        </div>
                      ) : previewIsPdf(proofUrl) ? (
                        <iframe title="Approval PDF" src={proofUrl} className="h-64 w-full bg-zinc-900" />
                      ) : (
                        <p className="p-3 text-xs text-zinc-500 font-sans">
                          Preview not available.{' '}
                          <a href={proofUrl} target="_blank" rel="noopener noreferrer" className="text-sky-400 underline">
                            Open file →
                          </a>
                        </p>
                      )}
                    </div>
                  </section>
                ) : null}

                <section>
                  <h3 className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500 font-sans">
                    Usage ledger (handshake)
                  </h3>
                  <p className={`text-[10px] text-zinc-600 font-sans mb-2 ${mono}`}>
                    [Timestamp] | [Operator] | [Job #] | [Resulting ΔE]
                  </p>
                  {usageLoading ? (
                    <p className="text-xs text-zinc-500 font-sans">Loading…</p>
                  ) : handshakeLedger.length === 0 ? (
                    <p className="text-xs text-zinc-600 font-sans">No issue / receive handshakes yet.</p>
                  ) : (
                    <ul className="max-h-[min(28rem,50vh)] space-y-2 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/40 px-2 py-2">
                      {handshakeLedger.map((e) => (
                        <li
                          key={e.id}
                          className={`text-[10px] leading-relaxed text-zinc-300 border-b border-zinc-900/80 pb-2 last:border-0 last:pb-0 ${mono}`}
                          title={usageLabel(e.actionType)}
                        >
                          {handshakeLedgerPipeLine(e)}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-3 space-y-3">
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 font-sans">
                    Substrate &amp; ink
                  </h3>
                  <label className="block text-[10px] text-zinc-500 font-sans">
                    Substrate type
                    <select
                      value={substrate}
                      onChange={(e) => setSubstrate(e.target.value)}
                      className={`mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-xs text-zinc-200 ${mono}`}
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
                      rows={3}
                      className="mt-0.5 w-full resize-y rounded border border-zinc-700 bg-black px-2 py-1.5 text-xs text-zinc-200"
                      placeholder="Pigment loads, varnish, white underprint…"
                    />
                  </label>
                </section>

                <section>
                  <h3 className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500 font-sans">Spectro summary</h3>
                  <p className="min-h-[4rem] whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950/50 px-2 py-2 text-xs text-zinc-400">
                    {row.spectroReportSummary ?? 'No spectro report on file.'}
                  </p>
                </section>

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

                <div className="space-y-2 border-t border-zinc-800 pt-3">
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-sans">Record verification</p>
                  <label className="block text-[10px] text-zinc-500 font-sans">
                    Last verified date
                    <input
                      type="date"
                      value={verified}
                      onChange={(e) => setVerified(e.target.value)}
                      className={`mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-xs text-zinc-200 ${mono}`}
                    />
                  </label>
                  <label className="block text-[10px] text-zinc-500 font-sans">
                    ΔE reading
                    <input
                      value={deltaE}
                      onChange={(e) => setDeltaE(e.target.value)}
                      className={`mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-xs text-zinc-200 ${mono}`}
                      inputMode="decimal"
                    />
                  </label>
                  <label className="block text-[10px] text-zinc-500 font-sans">
                    Approval URL (legacy / mirror)
                    <input
                      value={attach}
                      onChange={(e) => setAttach(e.target.value)}
                      className={`mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-xs text-zinc-200 ${mono}`}
                    />
                  </label>
                  <label className="block text-[10px] text-zinc-500 font-sans">
                    Ink recipe link (PMS / lab)
                    <input
                      value={inkLink}
                      onChange={(e) => setInkLink(e.target.value)}
                      className={`mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-xs text-zinc-200 ${mono}`}
                      placeholder="https://…"
                    />
                  </label>
                  <label className="block text-[10px] text-zinc-500 font-sans">
                    Customer approval document (signed scan)
                    <input
                      value={custDoc}
                      onChange={(e) => setCustDoc(e.target.value)}
                      className={`mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-xs text-zinc-200 ${mono}`}
                      placeholder="https://…"
                    />
                  </label>
                  <label className="block text-[10px] text-zinc-500 font-sans">
                    Spectro summary
                    <textarea
                      value={spectro}
                      onChange={(e) => setSpectro(e.target.value)}
                      rows={3}
                      className="mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-xs text-zinc-200"
                    />
                  </label>
                  <label className="block text-[10px] text-zinc-500 font-sans">
                    Swatch hex (#RRGGBB)
                    <input
                      value={hex}
                      onChange={(e) => setHex(e.target.value)}
                      className={`mt-0.5 w-full rounded border border-zinc-700 bg-black px-2 py-1.5 text-xs text-zinc-200 ${mono}`}
                      placeholder="#C41E3A"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void saveVerification()}
                    className="w-full rounded-lg bg-emerald-800 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50 font-sans"
                  >
                    {busy ? '…' : `Save & log — ${COLOR_VERIFICATION_AUDIT}`}
                  </button>
                </div>

                <p className="pt-1 text-center text-[10px] text-zinc-600 font-sans">
                  Custody Handshake Verified - 100% Audit Traceability Active.
                </p>
              </div>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
