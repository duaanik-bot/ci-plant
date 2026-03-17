'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  COATING_TYPES,
  EMBOSSING_TYPES,
  PAPER_TYPES,
} from '@/lib/constants'

type LineItem = {
  id?: string
  cartonId?: string | null
  cartonName: string
  cartonSize?: string | null
  quantity: number
  rate: number | null
  gsm?: number | null
  gstPct: number
  coatingType?: string | null
  embossingLeafing?: string | null
  paperType?: string | null
  remarks?: string | null
  planningStatus?: string
}

type PurchaseOrder = {
  id: string
  poNumber: string
  poDate: string
  customer: { id: string; name: string }
  status: string
  remarks: string | null
  lineItems: LineItem[]
}

export default function PurchaseOrderDetailPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string

  const [po, setPo] = useState<PurchaseOrder | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch(`/api/purchase-orders/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data || data.error) throw new Error(data.error || 'Failed to load PO')
        setPo(data)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [id])

  const updateField = <K extends keyof PurchaseOrder>(key: K, value: PurchaseOrder[K]) => {
    setPo((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  const updateLine = (idx: number, patch: Partial<LineItem>) => {
    setPo((prev) =>
      prev
        ? {
            ...prev,
            lineItems: prev.lineItems.map((li, i) => (i === idx ? { ...li, ...patch } : li)),
          }
        : prev
    )
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!po) return
    setSaving(true)
    try {
      const res = await fetch(`/api/purchase-orders/${po.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: po.status,
          remarks: po.remarks,
          lineItems: po.lineItems.map((li) => ({
            ...li,
            quantity: li.quantity,
            rate: li.rate ?? undefined,
            gsm: li.gsm ?? undefined,
            gstPct: li.gstPct,
          })),
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to save')
      toast.success('PO updated')
      router.push('/orders/purchase-orders')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (!po) return <div className="p-4 text-slate-400">Loading…</div>

  return (
    <form onSubmit={handleSave} className="p-4 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-amber-400">{po.poNumber}</h1>
          <p className="text-sm text-slate-400">
            {po.customer.name} · {new Date(po.poDate).toLocaleDateString()}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <select
            value={po.status}
            onChange={(e) => updateField('status', e.target.value as any)}
            className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-600 text-xs text-white"
          >
            <option value="draft">Draft</option>
            <option value="confirmed">Confirmed</option>
            <option value="closed">Closed</option>
          </select>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 text-xs md:text-sm space-y-3">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-slate-200 font-semibold text-sm">Line items</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[800px]">
            <thead className="bg-slate-800 text-slate-300">
              <tr>
                <th className="px-2 py-1">Carton</th>
                <th className="px-2 py-1">Size</th>
                <th className="px-2 py-1">Qty</th>
                <th className="px-2 py-1">Rate</th>
                <th className="px-2 py-1">GSM</th>
                <th className="px-2 py-1">Coating</th>
                <th className="px-2 py-1">Emboss/Leaf</th>
                <th className="px-2 py-1">Paper</th>
                <th className="px-2 py-1">GST%</th>
                <th className="px-2 py-1">Remarks</th>
              </tr>
            </thead>
            <tbody>
              {po.lineItems.map((li, idx) => (
                <tr key={li.id ?? idx} className="border-t border-slate-800">
                  <td className="px-2 py-1 align-top">
                    <input
                      type="text"
                      value={li.cartonName}
                      onChange={(e) => updateLine(idx, { cartonName: e.target.value })}
                      className="w-40 px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white"
                    />
                  </td>
                  <td className="px-2 py-1 align-top">
                    <input
                      type="text"
                      value={li.cartonSize ?? ''}
                      onChange={(e) => updateLine(idx, { cartonSize: e.target.value })}
                      className="w-28 px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white"
                    />
                  </td>
                  <td className="px-2 py-1 align-top">
                    <input
                      type="number"
                      value={li.quantity}
                      onChange={(e) =>
                        updateLine(idx, { quantity: Number(e.target.value) || li.quantity })
                      }
                      className="w-20 px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white"
                    />
                  </td>
                  <td className="px-2 py-1 align-top">
                    <input
                      type="number"
                      value={li.rate ?? ''}
                      onChange={(e) =>
                        updateLine(idx, {
                          rate: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      className="w-20 px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white"
                    />
                  </td>
                  <td className="px-2 py-1 align-top">
                    <input
                      type="number"
                      value={li.gsm ?? ''}
                      onChange={(e) =>
                        updateLine(idx, {
                          gsm: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      className="w-20 px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white"
                    />
                  </td>
                  <td className="px-2 py-1 align-top">
                    <select
                      value={li.coatingType ?? ''}
                      onChange={(e) => updateLine(idx, { coatingType: e.target.value || null })}
                      className="w-32 px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white"
                    >
                      <option value="">None</option>
                      {COATING_TYPES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1 align-top">
                    <select
                      value={li.embossingLeafing ?? ''}
                      onChange={(e) =>
                        updateLine(idx, { embossingLeafing: e.target.value || null })
                      }
                      className="w-32 px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white"
                    >
                      <option value="">None</option>
                      {EMBOSSING_TYPES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1 align-top">
                    <select
                      value={li.paperType ?? ''}
                      onChange={(e) => updateLine(idx, { paperType: e.target.value || null })}
                      className="w-32 px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white"
                    >
                      <option value="">Select…</option>
                      {PAPER_TYPES.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1 align-top">
                    <input
                      type="number"
                      value={li.gstPct}
                      onChange={(e) =>
                        updateLine(idx, { gstPct: Number(e.target.value) || li.gstPct })
                      }
                      className="w-16 px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white"
                    />
                  </td>
                  <td className="px-2 py-1 align-top">
                    <input
                      type="text"
                      value={li.remarks ?? ''}
                      onChange={(e) => updateLine(idx, { remarks: e.target.value || null })}
                      className="w-40 px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push('/orders/purchase-orders')}
          className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm"
        >
          Close
        </button>
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  )
}

