'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'

type RfqDetail = {
  id: string
  rfqNumber: string
  status: string
  productName: string
  packType: string
  estimatedVolume: number | null
  feasibilityData: unknown
  quotationNumber?: string | null
  quotedPrice?: number | null
  poNumber?: string | null
  poValue?: number | null
  customer: { id: string; name: string }
  createdAt: string
}

export default function RfqDetailPage() {
  const params = useParams()
  const id = params.id as string
  const router = useRouter()

  const { data: rfq, isLoading, refetch } = useQuery<RfqDetail>({
    queryKey: ['rfq', id],
    queryFn: () => fetch(`/api/rfq/${id}`).then((r) => r.json()),
    refetchInterval: 30000,
  })

  const fd = (rfq?.feasibilityData ?? {}) as any

  const [feas, setFeas] = useState({
    boardSpec: '',
    printProcess: '',
    estimatedCostPer1000: '',
    toolingCost: '',
    moq: '',
  })

  const [quote, setQuote] = useState({
    quotationNumber: '',
    unitPrice: '',
    tooling: '',
    paymentTerms: '',
    validity: '',
    notes: '',
    clientDecision: '' as '' | 'approved' | 'rejected',
    rejectReason: '',
    poNumber: '',
    poValue: '',
  })

  const [saving, setSaving] = useState(false)

  useEffect(() => {
    // hydrate forms from saved feasibilityData
    setFeas({
      boardSpec: fd?.feasibility?.boardSpec ?? '',
      printProcess: fd?.feasibility?.printProcess ?? '',
      estimatedCostPer1000:
        fd?.feasibility?.estimatedCostPer1000 != null ? String(fd.feasibility.estimatedCostPer1000) : '',
      toolingCost: fd?.feasibility?.toolingCost != null ? String(fd.feasibility.toolingCost) : '',
      moq: fd?.feasibility?.moq != null ? String(fd.feasibility.moq) : '',
    })
    setQuote((prev) => ({
      ...prev,
      quotationNumber: rfq?.quotationNumber ?? prev.quotationNumber,
      unitPrice: fd?.quotation?.unitPrice != null ? String(fd.quotation.unitPrice) : prev.unitPrice,
      tooling: fd?.quotation?.tooling != null ? String(fd.quotation.tooling) : prev.tooling,
      paymentTerms: fd?.quotation?.paymentTerms ?? prev.paymentTerms,
      validity: fd?.quotation?.validity ?? prev.validity,
      notes: fd?.quotation?.notes ?? prev.notes,
      clientDecision: fd?.quotation?.decision ?? prev.clientDecision,
      rejectReason: fd?.quotation?.rejectionReason ?? prev.rejectReason,
      poNumber: rfq?.poNumber ?? prev.poNumber,
      poValue: rfq?.poValue != null ? String(rfq.poValue) : prev.poValue,
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfq?.id])

  const canConfirmPo = useMemo(() => {
    return (rfq?.status ?? '') !== 'po_received'
  }, [rfq?.status])

  if (isLoading) return <div className="p-4 text-slate-400">Loading RFQ…</div>
  if (!rfq || (rfq as any).error) return <div className="p-4 text-red-400">RFQ not found.</div>

  const saveFeasibility = async () => {
    setSaving(true)
    try {
      const next = {
        ...fd,
        feasibility: {
          boardSpec: feas.boardSpec || null,
          printProcess: feas.printProcess || null,
          estimatedCostPer1000: feas.estimatedCostPer1000 ? Number(feas.estimatedCostPer1000) : null,
          toolingCost: feas.toolingCost ? Number(feas.toolingCost) : null,
          moq: feas.moq ? Number(feas.moq) : null,
        },
      }
      const res = await fetch(`/api/rfq/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feasibilityData: next, status: 'feasibility' }),
      })
      if (!res.ok) throw new Error('Failed to save feasibility')
      await refetch()
    } finally {
      setSaving(false)
    }
  }

  const generateQuotationNumber = async () => {
    const res = await fetch('/api/rfq/next-quotation-number')
    const data = await res.json()
    setQuote((p) => ({ ...p, quotationNumber: data.quotationNumber || '' }))
  }

  const saveQuotation = async () => {
    setSaving(true)
    try {
      const next = {
        ...fd,
        quotation: {
          unitPrice: quote.unitPrice ? Number(quote.unitPrice) : null,
          tooling: quote.tooling ? Number(quote.tooling) : null,
          paymentTerms: quote.paymentTerms || null,
          validity: quote.validity || null,
          notes: quote.notes || null,
          decision: quote.clientDecision || null,
          rejectionReason: quote.clientDecision === 'rejected' ? quote.rejectReason || null : null,
        },
      }
      const res = await fetch(`/api/rfq/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feasibilityData: next,
          status: 'quoted',
          quotationNumber: quote.quotationNumber || undefined,
          quotedPrice: quote.unitPrice ? Number(quote.unitPrice) : undefined,
        }),
      })
      if (!res.ok) throw new Error('Failed to save quotation')
      await refetch()
    } finally {
      setSaving(false)
    }
  }

  const confirmPo = async () => {
    if (!quote.poNumber) {
      alert('PO number is required')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/rfq/${id}/confirm-po`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poNumber: quote.poNumber,
          poValue: quote.poValue ? Number(quote.poValue) : undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? 'Failed to confirm PO')
      await refetch()
      router.push('/orders/planning')
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to confirm PO')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-amber-400">{rfq.rfqNumber}</h1>
          <p className="text-slate-300">{rfq.customer.name}</p>
          <p className="text-slate-400 text-sm">
            {rfq.productName} · {rfq.packType}
          </p>
        </div>
        <span className="px-3 py-1 rounded-full bg-slate-800 border border-slate-600 text-xs text-slate-200">
          {rfq.status}
        </span>
      </div>

      <section className="rounded-lg border border-slate-700 bg-slate-800/60 p-4">
        <h2 className="font-semibold text-slate-200 mb-2">Stage 1 — RFQ</h2>
        <p className="text-sm text-slate-400">
          Estimated volume:{' '}
          {rfq.estimatedVolume ? rfq.estimatedVolume.toLocaleString() : 'Not specified'}
        </p>
        <p className="text-xs text-slate-500 mt-2">
          Specs are stored in <span className="font-mono">rfq.feasibilityData</span>.
        </p>
      </section>

      <section className="rounded-lg border border-slate-700 bg-slate-800/60 p-4">
        <h2 className="font-semibold text-slate-200 mb-2">Stage 2 — Feasibility</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Board Spec</label>
            <input
              value={feas.boardSpec}
              onChange={(e) => setFeas((p) => ({ ...p, boardSpec: e.target.value }))}
              className="w-full px-3 py-2 rounded bg-slate-900 border border-slate-600 text-white"
              placeholder="e.g. FBB 300gsm + matte lamination"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Print Process</label>
            <input
              value={feas.printProcess}
              onChange={(e) => setFeas((p) => ({ ...p, printProcess: e.target.value }))}
              className="w-full px-3 py-2 rounded bg-slate-900 border border-slate-600 text-white"
              placeholder="e.g. Offset + Aqueous Varnish"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Estimated Cost / 1000</label>
            <input
              type="number"
              min={0}
              value={feas.estimatedCostPer1000}
              onChange={(e) => setFeas((p) => ({ ...p, estimatedCostPer1000: e.target.value }))}
              className="w-full px-3 py-2 rounded bg-slate-900 border border-slate-600 text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Tooling Cost</label>
            <input
              type="number"
              min={0}
              value={feas.toolingCost}
              onChange={(e) => setFeas((p) => ({ ...p, toolingCost: e.target.value }))}
              className="w-full px-3 py-2 rounded bg-slate-900 border border-slate-600 text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">MOQ</label>
            <input
              type="number"
              min={0}
              value={feas.moq}
              onChange={(e) => setFeas((p) => ({ ...p, moq: e.target.value }))}
              className="w-full px-3 py-2 rounded bg-slate-900 border border-slate-600 text-white"
            />
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <a
            href={`/api/rfq/${id}/feasibility-pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-300 hover:underline"
          >
            Generate Feasibility PDF
          </a>
          <button
            onClick={saveFeasibility}
            disabled={saving}
            className="px-3 py-2 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm"
          >
            {saving ? 'Saving…' : 'Save Feasibility'}
          </button>
        </div>
      </section>

      <section className="rounded-lg border border-slate-700 bg-slate-800/60 p-4">
        <h2 className="font-semibold text-slate-200 mb-2">Stage 3 — Quotation</h2>
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm text-slate-300">
            Quotation number: <span className="font-mono text-amber-300">{rfq.quotationNumber || '—'}</span>
          </p>
          <button
            type="button"
            onClick={generateQuotationNumber}
            className="text-xs text-amber-400 hover:underline"
          >
            Auto-generate QT number
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Quotation Number</label>
            <input
              value={quote.quotationNumber}
              onChange={(e) => setQuote((p) => ({ ...p, quotationNumber: e.target.value }))}
              className="w-full px-3 py-2 rounded bg-slate-900 border border-slate-600 text-white font-mono"
              placeholder="QT-YYYY-NNNN"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Unit Price</label>
            <input
              type="number"
              min={0}
              value={quote.unitPrice}
              onChange={(e) => setQuote((p) => ({ ...p, unitPrice: e.target.value }))}
              className="w-full px-3 py-2 rounded bg-slate-900 border border-slate-600 text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Tooling</label>
            <input
              type="number"
              min={0}
              value={quote.tooling}
              onChange={(e) => setQuote((p) => ({ ...p, tooling: e.target.value }))}
              className="w-full px-3 py-2 rounded bg-slate-900 border border-slate-600 text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Payment Terms</label>
            <input
              value={quote.paymentTerms}
              onChange={(e) => setQuote((p) => ({ ...p, paymentTerms: e.target.value }))}
              className="w-full px-3 py-2 rounded bg-slate-900 border border-slate-600 text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Validity</label>
            <input
              value={quote.validity}
              onChange={(e) => setQuote((p) => ({ ...p, validity: e.target.value }))}
              className="w-full px-3 py-2 rounded bg-slate-900 border border-slate-600 text-white"
              placeholder="e.g. 30 days"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs text-slate-400 mb-1">Notes</label>
            <textarea
              rows={2}
              value={quote.notes}
              onChange={(e) => setQuote((p) => ({ ...p, notes: e.target.value }))}
              className="w-full px-3 py-2 rounded bg-slate-900 border border-slate-600 text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Client Decision</label>
            <select
              value={quote.clientDecision}
              onChange={(e) => setQuote((p) => ({ ...p, clientDecision: e.target.value as any }))}
              className="w-full px-3 py-2 rounded bg-slate-900 border border-slate-600 text-white"
            >
              <option value="">—</option>
              <option value="approved">Client Approved</option>
              <option value="rejected">Client Rejected</option>
            </select>
          </div>
          {quote.clientDecision === 'rejected' && (
            <div>
              <label className="block text-xs text-slate-400 mb-1">Rejection Reason</label>
              <input
                value={quote.rejectReason}
                onChange={(e) => setQuote((p) => ({ ...p, rejectReason: e.target.value }))}
                className="w-full px-3 py-2 rounded bg-slate-900 border border-slate-600 text-white"
              />
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <a
            href={`/api/rfq/${id}/quotation-pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-300 hover:underline"
          >
            Generate Quotation PDF
          </a>
          <button
            onClick={saveQuotation}
            disabled={saving}
            className="px-3 py-2 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm"
          >
            {saving ? 'Saving…' : 'Save Quotation'}
          </button>
        </div>
      </section>

      <section className="rounded-lg border border-slate-700 bg-slate-800/60 p-4">
        <h2 className="font-semibold text-slate-200 mb-2">Stage 4 — PO & Job</h2>
        <p className="text-sm text-slate-400">PO number: {rfq.poNumber || 'Not received'}</p>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div>
            <label className="block text-xs text-slate-400 mb-1">PO Number</label>
            <input
              value={quote.poNumber}
              onChange={(e) => setQuote((p) => ({ ...p, poNumber: e.target.value }))}
              className="w-full px-3 py-2 rounded bg-slate-900 border border-slate-600 text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">PO Value</label>
            <input
              type="number"
              min={0}
              value={quote.poValue}
              onChange={(e) => setQuote((p) => ({ ...p, poValue: e.target.value }))}
              className="w-full px-3 py-2 rounded bg-slate-900 border border-slate-600 text-white"
            />
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <button
            type="button"
            onClick={() => router.push('/orders/planning')}
            className="text-sm text-amber-300 hover:underline"
          >
            Job ready for Planning. Go to Planning →
          </button>
          <button
            type="button"
            disabled={saving || !canConfirmPo}
            onClick={confirmPo}
            className="px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm"
          >
            Confirm PO (Push to Production)
          </button>
        </div>
      </section>
    </div>
  )
}

