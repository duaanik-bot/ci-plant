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

  if (loading) return <div className="p-4 text-ds-ink-muted">Loading…</div>
  if (!issue) return <div className="p-4 text-red-400">Request not found.</div>
  if (issue.approvedAt) return <div className="p-4 text-green-400">Already approved.</div>
  if (issue.rejectedAt) return <div className="p-4 text-red-400">Already rejected.</div>

  const excessPct = issue.qtyApproved > 0 ? (issue.qtyRequested / issue.qtyApproved) * 100 : 0

  return (
    <div className="min-h-screen bg-ds-card text-foreground p-4 max-w-lg mx-auto">
      <h1 className="text-xl font-bold text-ds-warning mb-4">Approve Excess Sheets</h1>

      <div className="rounded-lg border border-ds-line/60 bg-ds-elevated/50 p-4 space-y-3 mb-6">
        <p><span className="text-ds-ink-muted">Job:</span> {issue.jobNumber} — {issue.productName}</p>
        <p><span className="text-ds-ink-muted">Material:</span> {issue.materialCode} {issue.materialDescription}</p>
        <p><span className="text-ds-ink-muted">Approved qty:</span> {issue.qtyApproved.toLocaleString()} {issue.unit}</p>
        <p><span className="text-ds-ink-muted">Already issued:</span> {issue.qtyAlreadyIssued.toLocaleString()}</p>
        <p><span className="text-ds-ink-muted">Requested extra:</span> {issue.qtyRequested.toLocaleString()} {issue.unit}</p>
        {issue.reasonCode && (
          <p><span className="text-ds-ink-muted">Reason:</span> {issue.reasonCode}{issue.reasonDetail ? ` — ${issue.reasonDetail}` : ''}</p>
        )}
        <p className="text-ds-warning text-sm">Excess: {excessPct.toFixed(1)}% over approved</p>
      </div>

      <p className="text-ds-ink-muted text-sm mb-4">Your approval tier will be recorded. If above your limit, use &quot;Escalate to next level&quot;.</p>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={handleApprove}
          disabled={!!action}
          className="w-full py-3 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 text-primary-foreground font-bold text-lg"
        >
          {action === 'approve' ? '…' : 'APPROVE'}
        </button>
        <button
          type="button"
          className="w-full py-2 rounded-lg border border-ds-warning text-ds-warning text-sm"
        >
          Escalate to next level
        </button>
        <div>
          <input
            type="text"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Rejection reason"
            className="w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground mb-2"
          />
          <button
            type="button"
            onClick={handleReject}
            disabled={!!action || !rejectReason.trim()}
            className="w-full py-2 rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-50 text-foreground font-medium"
          >
            {action === 'reject' ? '…' : 'REJECT'}
          </button>
        </div>
      </div>

      <Link href="/stores/issue" className="mt-6 inline-block text-ds-ink-muted hover:text-foreground text-sm">
        ← Back to Issue
      </Link>
    </div>
  )
}
