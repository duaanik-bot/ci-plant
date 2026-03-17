'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'

type Issue = {
  id: string
  jobNumber: string
  productName: string
  materialCode: string
  materialDescription: string
  unit: string
  qtyApproved: number
  qtyAlreadyIssued: number
  qtyRequested: number
  reasonCode: string | null
  reasonDetail: string | null
  approvedAt: string | null
  rejectedAt: string | null
}

const TIER_NAMES: Record<number, string> = {
  1: 'Tier 1 — Shift Supervisor',
  2: 'Tier 2 — Production Manager',
  3: 'Tier 3 — Operations Head',
  4: 'Tier 4 — MD',
}

export default function ApproveExcessPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const [issue, setIssue] = useState<Issue | null>(null)
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState<'approve' | 'reject' | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  useEffect(() => {
    fetch(`/api/sheet-issues/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error)
        setIssue(data)
      })
      .catch(() => setIssue(null))
      .finally(() => setLoading(false))
  }, [id])

  const handleApprove = async () => {
    setAction('approve')
    try {
      const res = await fetch(`/api/sheet-issues/${id}/approve`, { method: 'PUT' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || data.message || 'Failed')
      router.push('/stores/issue')
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed')
    } finally {
      setAction(null)
    }
  }

  const handleReject = async () => {
    if (!rejectReason.trim()) {
      alert('Enter rejection reason')
      return
    }
    setAction('reject')
    try {
      const res = await fetch(`/api/sheet-issues/${id}/reject`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rejectionReason: rejectReason }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      router.push('/stores/issue')
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed')
    } finally {
      setAction(null)
    }
  }

  if (loading) return <div className="p-4 text-slate-400">Loading…</div>
  if (!issue) return <div className="p-4 text-red-400">Request not found.</div>
  if (issue.approvedAt) return <div className="p-4 text-green-400">Already approved.</div>
  if (issue.rejectedAt) return <div className="p-4 text-red-400">Already rejected.</div>

  const excessPct = issue.qtyApproved > 0 ? (issue.qtyRequested / issue.qtyApproved) * 100 : 0

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 max-w-lg mx-auto">
      <h1 className="text-xl font-bold text-amber-400 mb-4">Approve Excess Sheets</h1>

      <div className="rounded-lg border border-slate-600 bg-slate-800/50 p-4 space-y-3 mb-6">
        <p><span className="text-slate-400">Job:</span> {issue.jobNumber} — {issue.productName}</p>
        <p><span className="text-slate-400">Material:</span> {issue.materialCode} {issue.materialDescription}</p>
        <p><span className="text-slate-400">Approved qty:</span> {issue.qtyApproved.toLocaleString()} {issue.unit}</p>
        <p><span className="text-slate-400">Already issued:</span> {issue.qtyAlreadyIssued.toLocaleString()}</p>
        <p><span className="text-slate-400">Requested extra:</span> {issue.qtyRequested.toLocaleString()} {issue.unit}</p>
        {issue.reasonCode && (
          <p><span className="text-slate-400">Reason:</span> {issue.reasonCode}{issue.reasonDetail ? ` — ${issue.reasonDetail}` : ''}</p>
        )}
        <p className="text-amber-400 text-sm">Excess: {excessPct.toFixed(1)}% over approved</p>
      </div>

      <p className="text-slate-400 text-sm mb-4">Your approval tier will be recorded. If above your limit, use &quot;Escalate to next level&quot;.</p>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={handleApprove}
          disabled={!!action}
          className="w-full py-3 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-bold text-lg"
        >
          {action === 'approve' ? '…' : 'APPROVE'}
        </button>
        <button
          type="button"
          className="w-full py-2 rounded-lg border border-amber-600 text-amber-400 text-sm"
        >
          Escalate to next level
        </button>
        <div>
          <input
            type="text"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Rejection reason"
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-white mb-2"
          />
          <button
            type="button"
            onClick={handleReject}
            disabled={!!action || !rejectReason.trim()}
            className="w-full py-2 rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white font-medium"
          >
            {action === 'reject' ? '…' : 'REJECT'}
          </button>
        </div>
      </div>

      <Link href="/stores/issue" className="mt-6 inline-block text-slate-400 hover:text-white text-sm">
        ← Back to Issue
      </Link>
    </div>
  )
}
