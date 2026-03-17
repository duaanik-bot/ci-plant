'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

type SpecOverrides = { assignedDesignerId?: string; [k: string]: unknown } | null
type Row = {
  id: string
  cartonName: string
  quantity: number
  paperType: string | null
  coatingType: string | null
  embossingLeafing: string | null
  setNumber: string | null
  planningStatus: string
  jobCardNumber: number | null
  specOverrides: SpecOverrides
  po: {
    id: string
    poNumber: string
    status: string
    poDate: string
    customer: { id: string; name: string }
  }
  jobCard: {
    id: string
    jobCardNumber: number
    artworkApproved: boolean
    firstArticlePass: boolean
    finalQcPass: boolean
    qaReleased: boolean
    status: string
  } | null
  readiness: {
    hasSet: boolean
    hasJobCard: boolean
    artworkApproved: boolean
    firstArticlePass: boolean
    readyForProduction: boolean
  }
}

type Customer = { id: string; name: string }
type User = { id: string; name: string }

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-[11px] border ${
        ok
          ? 'bg-green-900/30 text-green-300 border-green-700'
          : 'bg-slate-900 text-slate-400 border-slate-700'
      }`}
    >
      {label}
    </span>
  )
}

export default function DesigningQueuePage() {
  const [rows, setRows] = useState<Row[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [customerId, setCustomerId] = useState('')

  useEffect(() => {
    async function load() {
      try {
        const [custRes, usersRes, linesRes] = await Promise.all([
          fetch('/api/masters/customers'),
          fetch('/api/users'),
          fetch(`/api/designing/po-lines?${customerId ? `customerId=${customerId}` : ''}`),
        ])
        const custJson = await custRes.json()
        const usersJson = await usersRes.json()
        const json = await linesRes.json()
        setCustomers(Array.isArray(custJson) ? custJson : [])
        setUsers(Array.isArray(usersJson) ? usersJson : [])
        setRows(Array.isArray(json) ? json : [])
      } catch {
        toast.error('Failed to load designing queue')
      } finally {
        setLoading(false)
      }
    }
    setLoading(true)
    load()
  }, [customerId])

  const userById = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u])), [users])

  const readyCount = useMemo(
    () => rows.filter((r) => r.readiness?.readyForProduction).length,
    [rows]
  )

  if (loading) return <div className="p-4 text-slate-400">Loading…</div>

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-amber-400">Designing Queue</h1>
          <p className="text-xs text-slate-500">
            Ready for production: <span className="text-amber-300 font-semibold">{readyCount}</span> /{' '}
            {rows.length}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/orders/planning"
            className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-200 text-sm"
          >
            Planning
          </Link>
          <Link
            href="/production/job-cards"
            className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-200 text-sm"
          >
            Job Cards
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-white min-w-[180px]"
        >
          <option value="">All customers</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <th className="px-4 py-2">PO</th>
              <th className="px-4 py-2">Customer</th>
              <th className="px-4 py-2">Carton</th>
              <th className="px-4 py-2">Qty</th>
              <th className="px-4 py-2">Set</th>
              <th className="px-4 py-2">Designer</th>
              <th className="px-4 py-2">Artwork</th>
              <th className="px-4 py-2">Checks</th>
              <th className="px-4 py-2">Links</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {rows.map((r) => {
              const designerId = r.specOverrides?.assignedDesignerId
              const designerName = designerId ? (userById[designerId]?.name ?? '—') : '—'
              return (
                <tr key={r.id} className="hover:bg-slate-800/60">
                  <td className="px-4 py-2 font-mono text-amber-300">{r.po.poNumber}</td>
                  <td className="px-4 py-2 text-slate-200">{r.po.customer.name}</td>
                  <td className="px-4 py-2 text-slate-200">{r.cartonName}</td>
                  <td className="px-4 py-2 text-slate-300">{r.quantity}</td>
                  <td className="px-4 py-2 text-slate-300">{r.setNumber ?? '—'}</td>
                  <td className="px-4 py-2 text-slate-300 text-xs">{designerName}</td>
                  <td className="px-4 py-2">
                    <Pill ok={r.readiness.artworkApproved} label={r.readiness.artworkApproved ? 'Approved' : 'Pending'} />
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      <Pill ok={r.readiness.hasSet} label="Set#" />
                      <Pill ok={r.readiness.hasJobCard} label="JC" />
                      <Pill ok={r.readiness.firstArticlePass} label="FA" />
                      <Pill ok={r.readiness.readyForProduction} label="Ready" />
                    </div>
                  </td>
                  <td className="px-4 py-2 space-x-2">
                    <Link
                      href={`/orders/designing/${r.id}`}
                      className="text-amber-400 hover:underline"
                    >
                      Open
                    </Link>
                    <a
                      href={`/api/designing/po-lines/${r.id}/job-spec-pdf`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-slate-400 hover:underline"
                    >
                      Spec PDF
                    </a>
                    <Link
                      href={`/orders/purchase-orders/${r.po.id}`}
                      className="text-slate-400 hover:underline"
                    >
                      PO
                    </Link>
                    {r.jobCard ? (
                      <Link
                        href={`/production/job-cards/${r.jobCard.id}`}
                        className="text-slate-300 hover:underline"
                      >
                        JC#{r.jobCard.jobCardNumber}
                      </Link>
                    ) : (
                      <Link
                        href={`/production/job-cards/new?poId=${r.po.id}&lineId=${r.id}`}
                        className="text-slate-300 hover:underline"
                      >
                        Create JC
                      </Link>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && (
        <p className="text-slate-500 text-center py-8 text-sm">No items in designing queue.</p>
      )}
    </div>
  )
}

