'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { toast } from 'sonner'
import { PRODUCTION_STAGES } from '@/lib/constants'
import { ChevronDown, ChevronUp } from 'lucide-react'

type StageRecord = {
  id: string
  stageName: string
  status: string
  operator: string | null
  counter: number | null
  sheetSize: string | null
  completedAt: string | null
}

type JobCardSummary = {
  id: string
  jobCardNumber: number
  setNumber: string | null
  batchNumber: string | null
  requiredSheets: number
  totalSheets: number
  status: string
  customer: { id: string; name: string }
}

type Payload = {
  stageKey: string
  stageLabel: string
  jobCards: { stageRecord: StageRecord; jobCard: JobCardSummary }[]
}

type SortKey = 'jobCardNumber' | 'customer' | 'sheets' | 'stageStatus' | 'completedAt'

export default function ProductionStagePage() {
  const params = useParams()
  const stageKey = params.stageKey as string
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [sortBy, setSortBy] = useState<SortKey>('jobCardNumber')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const stageMeta = PRODUCTION_STAGES.find((s) => s.key === stageKey)

  useEffect(() => {
    if (!stageKey) return
    fetch(`/api/production/stages/${stageKey}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.error) throw new Error(json.error)
        setData(json)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [stageKey])

  if (loading) return <div className="p-4 text-slate-400">Loading…</div>
  if (!stageMeta && !data) {
    return (
      <div className="p-4">
        <p className="text-slate-400">Unknown stage.</p>
        <Link href="/production/stages" className="text-amber-400 hover:underline mt-2 inline-block">
          ← All stages
        </Link>
      </div>
    )
  }

  const label = data?.stageLabel ?? stageMeta?.label ?? stageKey
  const rawList = data?.jobCards ?? []

  const list = useMemo(() => {
    const arr = [...rawList]
    arr.sort((a, b) => {
      let cmp = 0
      switch (sortBy) {
        case 'jobCardNumber':
          cmp = a.jobCard.jobCardNumber - b.jobCard.jobCardNumber
          break
        case 'customer':
          cmp = (a.jobCard.customer.name ?? '').localeCompare(b.jobCard.customer.name ?? '')
          break
        case 'sheets':
          cmp = a.jobCard.requiredSheets - b.jobCard.requiredSheets
          break
        case 'stageStatus':
          cmp = (a.stageRecord.status ?? '').localeCompare(b.stageRecord.status ?? '')
          break
        case 'completedAt': {
          const ta = a.stageRecord.completedAt ? new Date(a.stageRecord.completedAt).getTime() : 0
          const tb = b.stageRecord.completedAt ? new Date(b.stageRecord.completedAt).getTime() : 0
          cmp = ta - tb
          break
        }
        default:
          return 0
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [rawList, sortBy, sortDir])

  function toggleSort(key: SortKey) {
    setSortBy(key)
    setSortDir((d) => (sortBy === key ? (d === 'asc' ? 'desc' : 'asc') : 'asc'))
  }

  function SortHeader({
    columnKey,
    children,
  }: {
    columnKey: SortKey
    children: React.ReactNode
  }) {
    const active = sortBy === columnKey
    return (
      <th
        className="px-4 py-2 cursor-pointer select-none hover:bg-slate-700/50"
        onClick={() => toggleSort(columnKey)}
      >
        <span className="flex items-center gap-1">
          {children}
          {active ? (sortDir === 'asc' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />) : null}
        </span>
      </th>
    )
  }

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Link
            href="/production/stages"
            className="text-sm text-slate-400 hover:text-white mb-1 inline-block"
          >
            ← All stages
          </Link>
          <h1 className="text-xl font-bold text-amber-400">{label}</h1>
          <p className="text-sm text-slate-500">
            {list.length} job card{list.length !== 1 ? 's' : ''} at this stage
            {['chemical_coating', 'lamination', 'spot_uv', 'leafing', 'embossing'].includes(stageKey) && (
              <span className="text-slate-500"> (only jobs with this stage in post-press routing)</span>
            )}
          </p>
        </div>
        <Link
          href="/production/job-cards"
          className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm"
        >
          Job Cards
        </Link>
      </div>

      <div className="rounded-lg border border-slate-700 overflow-hidden">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-800 text-slate-300">
            <tr>
              <SortHeader columnKey="jobCardNumber">JC#</SortHeader>
              <SortHeader columnKey="customer">Customer</SortHeader>
              <th className="px-4 py-2">Set / Batch</th>
              <SortHeader columnKey="sheets">Sheets</SortHeader>
              <SortHeader columnKey="stageStatus">Stage status</SortHeader>
              <th className="px-4 py-2">Operator</th>
              <SortHeader columnKey="completedAt">Completed</SortHeader>
              <th className="px-4 py-2">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {list.map(({ stageRecord, jobCard }) => (
              <tr key={stageRecord.id} className="hover:bg-slate-800/60">
                <td className="px-4 py-2 font-mono text-amber-300">{jobCard.jobCardNumber}</td>
                <td className="px-4 py-2 text-slate-200">{jobCard.customer.name}</td>
                <td className="px-4 py-2 text-slate-300">
                  {jobCard.setNumber ?? '—'} / {jobCard.batchNumber ?? '—'}
                </td>
                <td className="px-4 py-2 text-slate-300">
                  {jobCard.requiredSheets} / {jobCard.totalSheets}
                </td>
                <td className="px-4 py-2">
                  <span
                    className={`px-2 py-0.5 rounded text-xs border ${
                      stageRecord.status === 'completed'
                        ? 'bg-green-900/40 text-green-300 border-green-600'
                        : stageRecord.status === 'in_progress'
                        ? 'bg-blue-900/40 text-blue-300 border-blue-600'
                        : 'bg-slate-800 text-slate-400 border-slate-600'
                    }`}
                  >
                    {stageRecord.status}
                  </span>
                </td>
                <td className="px-4 py-2 text-slate-300">{stageRecord.operator ?? '—'}</td>
                <td className="px-4 py-2 text-slate-400">
                  {stageRecord.completedAt
                    ? new Date(stageRecord.completedAt).toLocaleString()
                    : '—'}
                </td>
                <td className="px-4 py-2">
                  <Link
                    href={`/production/job-cards/${jobCard.id}`}
                    className="text-amber-400 hover:underline"
                  >
                    Open JC
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {stageKey === 'dye_cutting' && list.some((x) => x.stageRecord.status === 'completed') ? (
        <div className="rounded-xl border border-amber-700 bg-amber-950/30 p-4">
          <p className="text-amber-200 font-medium">⚠ DIE RETURN REQUIRED</p>
          <p className="text-xs text-amber-300 mt-1">
            Die Cutting completed jobs should return dies immediately with run impressions and condition.
          </p>
          <p className="text-xs text-slate-300 mt-2">
            Open the job card, use the Die panel, then click <span className="font-semibold">Confirm Return</span>.
          </p>
        </div>
      ) : null}

      {stageKey === 'embossing' && list.some((x) => x.stageRecord.status === 'completed') ? (
        <div className="rounded-xl border border-amber-700 bg-amber-950/30 p-4">
          <p className="text-amber-200 font-medium">⚠ EMBOSS BLOCK RETURN REQUIRED</p>
          <p className="text-xs text-amber-300 mt-1">
            Embossing completed jobs should return blocks immediately with impressions and condition.
          </p>
          <p className="text-xs text-slate-300 mt-2">
            Open the job card and complete block return from the Emboss Block panel.
          </p>
        </div>
      ) : null}

      {list.length === 0 && (
        <p className="text-slate-500 text-center py-8 text-sm">
          No job cards at this stage. Create job cards and advance them from the Job Card detail.
        </p>
      )}
    </div>
  )
}
