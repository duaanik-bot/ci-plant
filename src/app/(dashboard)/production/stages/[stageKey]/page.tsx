'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { toast } from 'sonner'
import { PRODUCTION_STAGES } from '@/lib/constants'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { IndustrialModuleShell, industrialTableClassName } from '@/components/industrial/IndustrialModuleShell'
import { IndustrialKpiTile } from '@/components/industrial/IndustrialKpiTile'
import { AgeTickerCell } from '@/components/industrial/AgeTickerCell'
import { INDUSTRIAL_PRIORITY_EVENT } from '@/lib/industrial-priority-sync'

type StageRecord = {
  id: string
  stageName: string
  status: string
  operator: string | null
  counter: number | null
  sheetSize: string | null
  completedAt: string | null
  createdAt: string
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
  productName: string | null
  updatedAt: string
  industrialPriority?: boolean
}

type Payload = {
  stageKey: string
  stageLabel: string
  jobCards: {
    stageRecord: StageRecord
    jobCard: JobCardSummary
    idleHours: number | null
  }[]
}

type SortKey =
  | 'jobCardNumber'
  | 'customer'
  | 'productName'
  | 'sheets'
  | 'stageStatus'
  | 'completedAt'

export default function ProductionStagePage() {
  const params = useParams()
  const stageKey = params.stageKey as string
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [sortBy, setSortBy] = useState<SortKey>('jobCardNumber')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const stageMeta = PRODUCTION_STAGES.find((s) => s.key === stageKey)

  const load = useCallback(async () => {
    if (!stageKey) return
    setLoading(true)
    try {
      const r = await fetch(`/api/production/stages/${stageKey}`)
      const json = (await r.json()) as Payload & { error?: string }
      if ((json as { error?: string }).error) throw new Error((json as { error: string }).error)
      setData(json)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [stageKey])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onPri = () => {
      void load()
    }
    window.addEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
    return () => window.removeEventListener(INDUSTRIAL_PRIORITY_EVENT, onPri)
  }, [load])

  const stageKpis = useMemo(() => {
    const rows = data?.jobCards ?? []
    const inProg = rows.filter((x) => x.stageRecord.status === 'in_progress').length
    const pending = rows.filter((x) => x.stageRecord.status === 'pending').length
    const done = rows.filter((x) => x.stageRecord.status === 'completed').length
    const pri = rows.filter((x) => x.jobCard.industrialPriority === true).length
    const idleHot = rows.filter(
      (x) => x.idleHours != null && x.idleHours > 2 && x.stageRecord.status !== 'completed',
    ).length
    return { inProg, pending, done, pri, idleHot, total: rows.length }
  }, [data?.jobCards])

  if (loading) {
    return (
      <IndustrialModuleShell title="Production stage" subtitle="Loading…">
        <p className="text-slate-500 text-sm">Loading…</p>
      </IndustrialModuleShell>
    )
  }

  if (!stageMeta && !data) {
    return (
      <IndustrialModuleShell title="Production stage" subtitle="">
        <p className="text-slate-400 text-sm">Unknown stage.</p>
        <Link href="/production/stages" className="text-amber-400 hover:underline mt-2 inline-block text-sm">
          ← All stages
        </Link>
      </IndustrialModuleShell>
    )
  }

  const label = data?.stageLabel ?? stageMeta?.label ?? stageKey
  const rawList = data?.jobCards ?? []

  const list = useMemo(() => {
    const arr = [...rawList]
    arr.sort((a, b) => {
      const pa = a.jobCard.industrialPriority === true ? 1 : 0
      const pb = b.jobCard.industrialPriority === true ? 1 : 0
      if (pa !== pb) return pb - pa
      let cmp = 0
      switch (sortBy) {
        case 'jobCardNumber':
          cmp = a.jobCard.jobCardNumber - b.jobCard.jobCardNumber
          break
        case 'customer':
          cmp = (a.jobCard.customer.name ?? '').localeCompare(b.jobCard.customer.name ?? '')
          break
        case 'productName':
          cmp = (a.jobCard.productName ?? '').localeCompare(b.jobCard.productName ?? '')
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
        className="px-4 py-2 cursor-pointer select-none hover:bg-slate-800/50 text-left"
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
    <IndustrialModuleShell
      title={label}
      subtitle={
        `${stageKpis.total} job card${stageKpis.total !== 1 ? 's' : ''} at this stage` +
        (['chemical_coating', 'lamination', 'spot_uv', 'leafing', 'embossing'].includes(stageKey)
          ? ' · Filtered by post-press routing'
          : '') +
        '. Age uses queue / idle time; pulse when idle >2h (pending uses time in stage; in progress uses last job-card activity).'
      }
      kpiRow={
        <>
          <IndustrialKpiTile label="Active" value={stageKpis.total} hint="Rows in list" />
          <IndustrialKpiTile label="In progress" value={stageKpis.inProg} hint="Running now" />
          <IndustrialKpiTile label="Pending" value={stageKpis.pending} hint="Awaiting start" />
          <IndustrialKpiTile
            label="Priority · Idle >2h"
            value={`${stageKpis.pri} · ${stageKpis.idleHot}`}
            hint="Starred PO / director · threshold"
            valueClassName={stageKpis.idleHot > 0 ? 'text-rose-300' : 'text-slate-100'}
          />
        </>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/production/stages"
          className="text-sm text-slate-400 hover:text-white"
        >
          ← All stages
        </Link>
        <Link
          href="/production/job-cards"
          className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 text-sm hover:bg-slate-900"
        >
          Job Cards
        </Link>
      </div>

      <div className={industrialTableClassName()}>
        <table className="w-full text-sm text-left border-collapse">
          <thead className="bg-slate-950/90 text-slate-400 border-b border-slate-800">
            <tr>
              <SortHeader columnKey="jobCardNumber">JC#</SortHeader>
              <SortHeader columnKey="customer">Customer</SortHeader>
              <SortHeader columnKey="productName">Product</SortHeader>
              <th className="px-4 py-2">Set / Batch</th>
              <SortHeader columnKey="sheets">Sheets</SortHeader>
              <SortHeader columnKey="stageStatus">Stage status</SortHeader>
              <th className="px-4 py-2">Age / idle</th>
              <th className="px-4 py-2">Operator</th>
              <SortHeader columnKey="completedAt">Completed</SortHeader>
              <th className="px-4 py-2">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {list.map(({ stageRecord, jobCard, idleHours }) => {
              const pri =
                jobCard.industrialPriority === true
                  ? 'shadow-[inset_0_0_0_1px_rgba(245,158,11,0.35)] bg-amber-950/15'
                  : ''
              return (
                <tr key={stageRecord.id} className={`hover:bg-slate-900/50 ${pri}`}>
                  <td className="px-4 py-2 font-mono text-amber-300">{jobCard.jobCardNumber}</td>
                  <td className="px-4 py-2 text-slate-200">{jobCard.customer.name}</td>
                  <td className="px-4 py-2 text-slate-300 max-w-[200px] truncate" title={jobCard.productName ?? ''}>
                    {jobCard.productName ?? '—'}
                  </td>
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
                  <td className="px-4 py-2 whitespace-nowrap">
                    {stageRecord.status === 'completed' ? (
                      <span className="text-slate-500 text-xs">—</span>
                    ) : (
                      <AgeTickerCell
                        referenceIso={stageRecord.createdAt}
                        mode="productionIdle2h"
                        idleHours={idleHours ?? undefined}
                      />
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-300">{stageRecord.operator ?? '—'}</td>
                  <td className="px-4 py-2 text-slate-400 text-xs">
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
              )
            })}
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
    </IndustrialModuleShell>
  )
}
