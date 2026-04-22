'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

type PR = {
  id: string
  materialId: string
  qtyRequired: number
  estimatedValue: number
  triggerReason: string
  status: string
  raisedBy: string
  raisedAt: string
  approvedBy: string | null
  approvedAt: string | null
  poReference: string | null
  expectedDelivery: string | null
  material: { materialCode: string; description: string; unit: string }
}

export default function PurchaseRequisitionsPage() {
  const [list, setList] = useState<PR[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [approving, setApproving] = useState<string | null>(null)
  const [convertId, setConvertId] = useState<string | null>(null)
  const [poRef, setPoRef] = useState('')

  const fetchList = () => {
    const url = filter ? `/api/purchase-requisitions?status=${encodeURIComponent(filter)}` : '/api/purchase-requisitions'
    fetch(url)
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    setLoading(true)
    fetchList()
  }, [filter])

  const handleApprove = async (id: string) => {
    setApproving(id)
    try {
      const res = await fetch(`/api/purchase-requisitions/${id}/approve`, { method: 'PUT' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      fetchList()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed')
    } finally {
      setApproving(null)
    }
  }

  const handleConvert = async (id: string) => {
    if (!poRef.trim()) return
    setApproving(id)
    try {
      const res = await fetch(`/api/purchase-requisitions/${id}/convert-to-po`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poReference: poRef.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      setConvertId(null)
      setPoRef('')
      fetchList()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed')
    } finally {
      setApproving(null)
    }
  }

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      pending: 'bg-ds-warning/12 text-ds-warning border-ds-warning',
      approved: 'bg-green-900/50 text-green-300 border-green-600',
      converted_to_po: 'bg-blue-900/50 text-blue-300 border-blue-600',
      rejected: 'bg-red-900/50 text-red-300 border-red-600',
    }
    const cls = map[status] || 'bg-ds-elevated text-ds-ink-muted'
    return <span className={`px-2 py-0.5 rounded text-xs border ${cls}`}>{status}</span>
  }

  if (loading) return <div className="p-4 text-ds-ink-muted">Loading…</div>

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-ds-warning">Purchase Requisitions</h1>
        <Link href="/inventory" className="text-ds-ink-muted hover:text-foreground text-sm">
          ← Stock States
        </Link>
      </div>

      <div className="mb-4 flex gap-2">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground text-sm"
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="converted_to_po">Converted to PO</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ds-elevated text-left">
            <tr>
              <th className="px-4 py-2">Material</th>
              <th className="px-4 py-2">Qty</th>
              <th className="px-4 py-2">Est. Value</th>
              <th className="px-4 py-2">Reason</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Raised</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ds-line/40">
            {list.map((pr) => (
              <tr key={pr.id} className="hover:bg-ds-elevated/50">
                <td className="px-4 py-2">
                  <span className="font-mono">{pr.material.materialCode}</span>
                  <span className="text-ds-ink-muted ml-1">{pr.material.description}</span>
                </td>
                <td className="px-4 py-2">
                  {Number(pr.qtyRequired).toLocaleString()} {pr.material.unit}
                </td>
                <td className="px-4 py-2">₹{Number(pr.estimatedValue).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                <td className="px-4 py-2 text-ds-ink-muted max-w-xs truncate">{pr.triggerReason}</td>
                <td className="px-4 py-2">{statusBadge(pr.status)}</td>
                <td className="px-4 py-2 text-ds-ink-muted">
                  {new Date(pr.raisedAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-2">
                  {pr.status === 'pending' && (
                    <button
                      onClick={() => handleApprove(pr.id)}
                      disabled={!!approving}
                      className="px-2 py-1 rounded bg-green-700 hover:bg-green-600 text-primary-foreground text-xs disabled:opacity-50"
                    >
                      {approving === pr.id ? '…' : 'Approve'}
                    </button>
                  )}
                  {pr.status === 'approved' && (
                    <>
                      {convertId === pr.id ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            value={poRef}
                            onChange={(e) => setPoRef(e.target.value)}
                            placeholder="PO ref"
                            className="w-28 px-2 py-1 rounded bg-ds-elevated border border-ds-line/60 text-foreground text-xs"
                          />
                          <button
                            onClick={() => handleConvert(pr.id)}
                            disabled={!!approving || !poRef.trim()}
                            className="px-2 py-1 rounded bg-blue-700 hover:bg-blue-600 text-primary-foreground text-xs disabled:opacity-50"
                          >
                            Convert
                          </button>
                          <button
                            onClick={() => { setConvertId(null); setPoRef('') }}
                            className="text-ds-ink-muted text-xs"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConvertId(pr.id)}
                          className="px-2 py-1 rounded bg-blue-700 hover:bg-blue-600 text-primary-foreground text-xs"
                        >
                          Convert to PO
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && (
        <p className="p-4 text-ds-ink-faint text-center">No purchase requisitions found.</p>
      )}
    </div>
  )
}
