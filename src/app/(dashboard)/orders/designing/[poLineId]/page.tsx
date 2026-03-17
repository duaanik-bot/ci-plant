'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { toast } from 'sonner'

type SpecOverrides = { assignedDesignerId?: string; [k: string]: unknown } | null
type DesigningDetail = {
  line: {
    id: string
    cartonName: string
    cartonSize: string | null
    quantity: number
    rate: unknown
    gsm: number | null
    paperType: string | null
    coatingType: string | null
    embossingLeafing: string | null
    remarks: string | null
    setNumber: string | null
    planningStatus: string
    jobCardNumber: number | null
    poId: string
    specOverrides: SpecOverrides
    po: {
      poNumber: string
      status: string
      poDate: string
      customer: { id: string; name: string }
    }
  }
  jobCard: {
    id: string
    jobCardNumber: number
    status: string
    assignedOperator: string | null
    batchNumber: string | null
    requiredSheets: number
    wastageSheets: number
    totalSheets: number
    artworkApproved: boolean
    firstArticlePass: boolean
    finalQcPass: boolean
    qaReleased: boolean
  } | null
  checks: Record<string, boolean>
  links: {
    po: string
    planning: string
    jobCard: string | null
    createJobCard: string
  }
}
type User = { id: string; name: string }

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-slate-300">{label}</span>
      <span className={ok ? 'text-green-400' : 'text-slate-500'}>
        {ok ? 'OK' : 'Missing'}
      </span>
    </div>
  )
}

export default function DesigningDetailPage() {
  const params = useParams()
  const poLineId = params.poLineId as string
  const [data, setData] = useState<DesigningDetail | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [savingDesigner, setSavingDesigner] = useState(false)

  useEffect(() => {
    fetch(`/api/designing/po-lines/${poLineId}`)
      .then((r) => r.json())
      .then((json) => {
        if (!json || json.error) throw new Error(json.error || 'Failed to load')
        setData(json)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [poLineId])

  useEffect(() => {
    fetch('/api/users')
      .then((r) => r.json())
      .then((list) => setUsers(Array.isArray(list) ? list : []))
      .catch(() => {})
  }, [])

  const saveDesigner = async (assignedDesignerId: string | undefined) => {
    if (!data) return
    setSavingDesigner(true)
    try {
      const specOverrides = { ...(data.line.specOverrides || {}), assignedDesignerId: assignedDesignerId || undefined }
      const res = await fetch(`/api/planning/po-lines/${poLineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specOverrides }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Save failed')
      setData((prev) =>
        prev
          ? {
              ...prev,
              line: { ...prev.line, specOverrides: specOverrides as SpecOverrides },
            }
          : null,
      )
      toast.success('Designer updated')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSavingDesigner(false)
    }
  }

  if (!data) return <div className="p-4 text-slate-400">Loading…</div>

  const { line, jobCard, checks, links } = data
  const designerId = line.specOverrides?.assignedDesignerId ?? ''

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-amber-400">Designing — {line.cartonName}</h1>
          <p className="text-sm text-slate-400">
            {line.po.customer.name} · {line.po.poNumber} · Qty {line.quantity}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/orders/designing"
            className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-200 text-sm"
          >
            Back
          </Link>
          <a
            href={`/api/designing/po-lines/${poLineId}/job-spec-pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm"
          >
            Job Spec PDF
          </a>
          <Link
            href={links.po}
            className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-200 text-sm"
          >
            Open PO
          </Link>
          <Link
            href={links.planning}
            className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-200 text-sm"
          >
            Planning
          </Link>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="rounded-xl bg-slate-900 border border-slate-700 p-4 space-y-2">
          <h2 className="text-sm font-semibold text-slate-200">Spec snapshot</h2>
          <div className="text-sm text-slate-300 space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-500">Set #</span>
              <span>{line.setNumber ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Paper</span>
              <span>{line.paperType ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Coating</span>
              <span>{line.coatingType ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Emboss/Leaf</span>
              <span>{line.embossingLeafing ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">GSM</span>
              <span>{line.gsm ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Planning status</span>
              <span>{line.planningStatus}</span>
            </div>
          </div>
        </div>

        <div className="rounded-xl bg-slate-900 border border-slate-700 p-4 space-y-2">
          <h2 className="text-sm font-semibold text-slate-200">Designer &amp; artwork</h2>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-300 text-sm">Assigned designer</span>
              <select
                value={designerId}
                onChange={(e) => saveDesigner(e.target.value || undefined)}
                disabled={savingDesigner}
                className="px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white text-sm min-w-[160px]"
              >
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
            <Check ok={!!checks.artworkApproved} label="Artwork approved" />
          </div>
        </div>
        <div className="rounded-xl bg-slate-900 border border-slate-700 p-4 space-y-2">
          <h2 className="text-sm font-semibold text-slate-200">Readiness checks</h2>
          <div className="space-y-2">
            <Check ok={!!checks.poConfirmed} label="PO is confirmed" />
            <Check ok={!!checks.hasSetNumber} label="Set number assigned" />
            <Check ok={!!checks.hasJobCard} label="Job card created" />
            <Check ok={!!checks.firstArticlePass} label="First article pass" />
          </div>
        </div>
      </div>

      <div className="rounded-xl bg-slate-900 border border-slate-700 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-200">Links</h2>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-sm">
          {links.jobCard ? (
            <Link
              href={links.jobCard}
              className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white"
            >
              Open Job Card
            </Link>
          ) : (
            <Link
              href={links.createJobCard}
              className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white"
            >
              Create Job Card
            </Link>
          )}
          <Link
            href="/production/machine-flow"
            className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-200"
          >
            Machine Flow
          </Link>
        </div>
      </div>

      {jobCard && (
        <div className="rounded-xl bg-slate-900 border border-slate-700 p-4">
          <h2 className="text-sm font-semibold text-slate-200 mb-2">Job card summary</h2>
          <div className="grid md:grid-cols-4 gap-3 text-sm text-slate-300">
            <div className="rounded-lg border border-slate-800 bg-slate-800/40 p-3">
              <p className="text-slate-500 text-xs">JC#</p>
              <p className="font-mono text-amber-300">{jobCard.jobCardNumber}</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-800/40 p-3">
              <p className="text-slate-500 text-xs">Sheets</p>
              <p>
                {jobCard.requiredSheets}+{jobCard.wastageSheets}={jobCard.totalSheets}
              </p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-800/40 p-3">
              <p className="text-slate-500 text-xs">Batch</p>
              <p>{jobCard.batchNumber ?? '—'}</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-800/40 p-3">
              <p className="text-slate-500 text-xs">Status</p>
              <p>{jobCard.status}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

