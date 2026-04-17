'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { PROCUREMENT_DEFAULT_SIGNATORY } from '@/lib/procurement-mrp-service'
import { X } from 'lucide-react'

type Requirement = {
  key: string
  boardType: string
  gsm: number
  grainDirection: string
  totalSheets: number
  totalWeightKg: number
  totalMetricTons: number
  contributions: {
    poLineItemId: string
    poId: string
    poNumber: string
    customerName: string
    cartonName: string
    quantity: number
    sheets: number
    weightKg: number
    jobCardNumber: number | null
    customerDeliveryYmd: string | null
    vendorRequiredDeliveryYmd: string | null
  }[]
  suggestedSupplierId: string | null
  suggestedSupplierName: string | null
}

type SupplierOpt = {
  id: string
  name: string
  materialTypes: string[]
  defaultForBoardGrades?: string[]
}

type VendorPoDetail = {
  id: string
  poNumber: string
  status: string
  signatoryName: string
  requiredDeliveryDate: string | null
  remarks: string | null
  dispatchedAt?: string | null
  dispatchActor?: string | null
  supplier: { id: string; name: string; email?: string | null; contactPhone?: string | null }
  lines: {
    id: string
    boardGrade: string
    gsm: number
    grainDirection: string
    totalSheets: number
    totalWeightKg: string
    ratePerKg: string | null
  }[]
}

export default function ProcurementWorkbenchPage() {
  const [requirements, setRequirements] = useState<Requirement[]>([])
  const [suggestedSupplier, setSuggestedSupplier] = useState<{ id: string; name: string } | null>(null)
  const [suppliers, setSuppliers] = useState<SupplierOpt[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [supplierId, setSupplierId] = useState('')
  const [generating, setGenerating] = useState(false)
  const [draft, setDraft] = useState<VendorPoDetail | null>(null)
  const [draftLoading, setDraftLoading] = useState(false)
  const [lineRates, setLineRates] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState(false)

  const loadRequirements = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/procurement/material-requirements')
      const json = (await res.json()) as {
        requirements?: Requirement[]
        suggestedSupplier?: { id: string; name: string } | null
        error?: string
      }
      if (!res.ok) throw new Error(json.error || 'Failed to load requirements')
      setRequirements(json.requirements ?? [])
      setSuggestedSupplier(json.suggestedSupplier ?? null)
      if (json.suggestedSupplier?.id) {
        setSupplierId((cur) => cur || json.suggestedSupplier!.id)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Load failed')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRequirements()
  }, [loadRequirements])

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/procurement/suppliers')
        if (!res.ok) return
        const list = (await res.json()) as SupplierOpt[]
        setSuppliers(Array.isArray(list) ? list : [])
      } catch {
        setSuppliers([])
      }
    })()
  }, [])

  const toggleKey = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectAll = () => {
    if (selected.size === requirements.length) {
      setSelected(new Set())
      return
    }
    setSelected(new Set(requirements.map((r) => r.key)))
  }

  const poHoverSummary = useMemo(
    () => (r: Requirement) =>
      r.contributions
        .map((c) => {
          const job =
            c.jobCardNumber != null ? `JC-${c.jobCardNumber}` : `line ${c.poLineItemId.slice(0, 8)}…`
          return `${c.poNumber} · ${job} · ${c.cartonName} (${c.quantity} pcs)`
        })
        .join('\n'),
    [],
  )

  const linkedJobIdsDisplay = useMemo(
    () => (r: Requirement) => {
      const tags = r.contributions.map((c) =>
        c.jobCardNumber != null ? `JC-${c.jobCardNumber}` : c.poLineItemId.slice(0, 8),
      )
      const uniq = Array.from(new Set(tags))
      if (uniq.length <= 5) return uniq.join(', ')
      return `${uniq.slice(0, 4).join(', ')} +${uniq.length - 4}`
    },
    [],
  )

  async function openDraft(id: string) {
    setDraftLoading(true)
    try {
      const res = await fetch(`/api/procurement/vendor-pos/${id}`)
      const json = (await res.json()) as VendorPoDetail & { error?: string }
      if (!res.ok) throw new Error(json.error || 'Failed to load vendor PO')
      setDraft(json)
      const rates: Record<string, string> = {}
      for (const ln of json.lines) {
        rates[ln.id] = ln.ratePerKg != null ? String(ln.ratePerKg) : ''
      }
      setLineRates(rates)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Load failed')
    } finally {
      setDraftLoading(false)
    }
  }

  async function generateVendorPo() {
    if (selected.size === 0) {
      toast.message('Select at least one requirement row')
      return
    }
    if (!supplierId) {
      toast.message('Select a supplier')
      return
    }
    setGenerating(true)
    try {
      const res = await fetch('/api/procurement/vendor-pos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requirementKeys: Array.from(selected),
          supplierId,
        }),
      })
      const json = (await res.json()) as { id?: string; error?: string }
      if (!res.ok) throw new Error(json.error || 'Could not create draft')
      toast.success('Draft vendor PO created')
      setSelected(new Set())
      await loadRequirements()
      if (json.id) await openDraft(json.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setGenerating(false)
    }
  }

  async function approveAndDispatch() {
    if (!draft) return
    setConfirming(true)
    try {
      const lineRatesPayload = draft.lines.map((ln) => ({
        lineId: ln.id,
        ratePerKg: lineRates[ln.id] === '' || lineRates[ln.id] == null ? null : Number(lineRates[ln.id]),
      }))
      const res = await fetch(`/api/procurement/vendor-pos/${draft.id}/approve-dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signatoryName: draft.signatoryName || PROCUREMENT_DEFAULT_SIGNATORY,
          lineRates: lineRatesPayload,
        }),
      })
      const json = (await res.json()) as { error?: string; email?: string; whatsapp?: string }
      if (!res.ok) throw new Error(json.error || 'Dispatch failed')
      toast.success(
        `Approved & dispatched (${PROCUREMENT_DEFAULT_SIGNATORY}). Email: ${json.email ?? '—'} · WhatsApp: ${json.whatsapp ?? '—'}`,
      )
      setDraft(null)
      await loadRequirements()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setConfirming(false)
    }
  }

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-4 pb-28 text-sm">
      <div>
        <h1 className="text-lg font-semibold text-white">Procurement Workbench</h1>
        <p className="text-slate-400 text-[11px] mt-1 max-w-3xl leading-snug">
          Pending board tonnage from <span className="text-slate-300">confirmed</span> customer POs, aggregated from the{' '}
          <code className="text-slate-500">material_queue</code> table (per-line sheets + kg + stored metric tons). Sheets
          = ceil((Qty/UPS)×(1+wastage%)); kg = (L×W×GSM×sheets)/10⁹. Suggested vendor from board-grade defaults. Zero-touch
          dispatch: PDF via Resend, WhatsApp via Wati; customer lines move to <span className="text-sky-300">on order</span>;{' '}
          <code className="text-slate-500">communication_logs</code> + <code className="text-slate-500">dispatched_at</code>{' '}
          for audit (default signatory Anik Dua).
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-700 bg-slate-900/80 p-3">
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">Supplier</label>
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className="min-w-[14rem] rounded-md border border-slate-600 bg-slate-800 px-2 py-1.5 text-xs text-white"
          >
            <option value="">Select…</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        {suggestedSupplier ? (
          <p className="text-[11px] text-slate-500 pb-1">
            Suggested: <span className="text-amber-200/90">{suggestedSupplier.name}</span>
          </p>
        ) : null}
        <button
          type="button"
          disabled={generating || selected.size === 0}
          onClick={() => void generateVendorPo()}
          className="ci-btn-procurement text-xs disabled:opacity-50"
        >
          {generating ? 'Generating…' : 'Generate Vendor PO'}
        </button>
        <button
          type="button"
          onClick={() => void loadRequirements()}
          className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="text-slate-500">Loading requirements…</p>
      ) : requirements.length === 0 ? (
        <p className="text-slate-500">
          No pending board requirements. Confirm customer POs and ensure lines have GSM, board grade, and linked
          dies with sheet sizes.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-700">
          <table className="w-full text-left text-[10px] leading-tight border-collapse">
            <thead className="bg-slate-800/90 text-slate-400">
              <tr>
                <th className="px-1.5 py-1 w-8 border-b border-slate-700/80">
                  <input
                    type="checkbox"
                    checked={selected.size === requirements.length && requirements.length > 0}
                    onChange={selectAll}
                    aria-label="Select all"
                  />
                </th>
                <th className="px-1.5 py-1 border-b border-slate-700/80">Board specs</th>
                <th className="px-1.5 py-1 text-right border-b border-slate-700/80">Total tonnage (t)</th>
                <th className="px-1.5 py-1 border-b border-slate-700/80">Linked job IDs</th>
                <th className="px-1.5 py-1 border-b border-slate-700/80">Suggested vendor</th>
              </tr>
            </thead>
            <tbody>
              {requirements.map((r, rowIdx) => (
                <tr
                  key={r.key}
                  className={`border-b border-slate-800/80 text-slate-200 ${
                    rowIdx % 2 === 0 ? 'bg-slate-900/35' : 'bg-slate-800/20'
                  }`}
                >
                  <td className="px-1.5 py-1 align-top">
                    <input
                      type="checkbox"
                      checked={selected.has(r.key)}
                      onChange={() => toggleKey(r.key)}
                      aria-label={`Select ${r.key}`}
                    />
                  </td>
                  <td className="px-1.5 py-1 align-top">
                    <div className="font-medium text-slate-100">{r.boardType}</div>
                    <div className="text-slate-500 tabular-nums">
                      {r.gsm} gsm · {r.grainDirection}
                    </div>
                    <div className="text-slate-600 tabular-nums">
                      {r.totalSheets.toLocaleString('en-IN')} sheets ·{' '}
                      {r.totalWeightKg.toLocaleString('en-IN', { maximumFractionDigits: 1 })} kg
                    </div>
                  </td>
                  <td className="px-1.5 py-1 align-top text-right tabular-nums font-semibold text-amber-200/95">
                    {r.totalMetricTons.toLocaleString('en-IN', { maximumFractionDigits: 4 })}
                  </td>
                  <td
                    className="px-1.5 py-1 align-top text-slate-400 font-mono text-[9px] cursor-help"
                    title={poHoverSummary(r)}
                  >
                    {linkedJobIdsDisplay(r)}
                  </td>
                  <td className="px-1.5 py-1 align-top text-slate-400">{r.suggestedSupplierName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {draft || draftLoading ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Vendor PO draft"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-600 bg-slate-950 p-4 shadow-2xl">
            <div className="flex items-start justify-between gap-2 mb-3">
              <div>
                <h2 className="text-sm font-semibold text-white">
                  {draft?.dispatchedAt ? 'Vendor PO (dispatched)' : 'Vendor PO draft'}
                </h2>
                {draft ? (
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {draft.poNumber} · {draft.supplier.name} · {draft.status}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {draftLoading || !draft ? (
              <p className="text-slate-500 text-xs">Loading…</p>
            ) : (
              <div className="space-y-3 text-xs">
                {draft.dispatchedAt ? (
                  <p className="rounded-md border border-sky-800/60 bg-sky-950/35 px-2 py-1.5 text-[11px] text-sky-100/95 leading-snug">
                    Dispatched{' '}
                    {new Date(draft.dispatchedAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })}
                    {draft.dispatchActor ? ` · ${draft.dispatchActor}` : ''}. PDF (email) and WhatsApp were sent; audit
                    trail in <code className="text-sky-200/80">communication_logs</code>.
                  </p>
                ) : null}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-slate-500">Required delivery</label>
                    <p className="text-slate-200">
                      {draft.requiredDeliveryDate
                        ? String(draft.requiredDeliveryDate).slice(0, 10)
                        : '— (set customer delivery on PO)'}
                    </p>
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500">Signatory</label>
                    <input
                      value={draft.signatoryName}
                      onChange={(e) => setDraft({ ...draft, signatoryName: e.target.value })}
                      disabled={!!draft.dispatchedAt}
                      className="mt-0.5 w-full rounded border border-slate-600 bg-slate-900 px-2 py-1 text-white disabled:opacity-50"
                    />
                  </div>
                </div>
                <ul className="space-y-2 border border-slate-800 rounded-md p-2">
                  {draft.lines.map((ln) => (
                    <li key={ln.id} className="border-b border-slate-800/80 pb-2 last:border-0 last:pb-0">
                      <p className="font-medium text-slate-200">
                        {ln.boardGrade} · {ln.gsm} GSM · {ln.grainDirection}
                      </p>
                      <p className="text-slate-500">
                        Sheets {ln.totalSheets.toLocaleString('en-IN')} · Weight{' '}
                        {Number(ln.totalWeightKg).toLocaleString('en-IN', { maximumFractionDigits: 2 })} kg
                      </p>
                      <label className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                        Rate / kg (₹)
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={lineRates[ln.id] ?? ''}
                          onChange={(e) =>
                            setLineRates((prev) => ({ ...prev, [ln.id]: e.target.value }))
                          }
                          disabled={!!draft.dispatchedAt}
                          className="w-28 rounded border border-slate-600 bg-slate-900 px-1.5 py-0.5 text-white disabled:opacity-50"
                        />
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setDraft(null)}
                    className="rounded-md border border-slate-600 px-3 py-1.5 text-slate-300 hover:bg-slate-800"
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    disabled={
                      confirming || !!draft.dispatchedAt || draft.status === 'cancelled'
                    }
                    onClick={() => void approveAndDispatch()}
                    className="ci-btn-procurement text-xs disabled:opacity-40"
                  >
                    {confirming ? 'Dispatching…' : 'Approve & dispatch'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
