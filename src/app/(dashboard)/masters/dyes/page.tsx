'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  EnterpriseTableShell,
  enterpriseTableClass,
  enterpriseTheadClass,
  enterpriseTbodyClass,
  enterpriseTrClass,
  enterpriseThClass,
  enterpriseTdClass,
  enterpriseTdMonoClass,
  enterpriseTdMutedClass,
} from '@/components/ui/EnterpriseTableShell'

type DyeRow = {
  id: string
  dyeNumber: number
  dyeType: string
  ups: number
  sheetSize: string
  cartonSize: string
  location: string | null
  impressionCount: number
  conditionRating: string | null
  active: boolean
}

export default function DyeMasterPage() {
  const [rows, setRows] = useState<DyeRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch('/api/masters/dyes')
      .then((r) => r.json())
      .then((data) => setRows(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load dyes'))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    if (!search) return rows
    const q = search.toLowerCase()
    return rows.filter(
      (d) =>
        String(d?.dyeNumber ?? '').includes(q) ||
        (d?.dyeType ?? '').toLowerCase().includes(q) ||
        (d?.cartonSize ?? '').toLowerCase().includes(q)
    )
  }, [rows, search])

  if (loading) {
    return <div className="text-sm text-ds-ink-faint dark:text-ds-ink-muted">Loading dyes…</div>
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-ds-ink">Dye Master</h2>
        <Link href="/masters/dyes/new" className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90">
          Add dye
        </Link>
      </div>

      <div className="mb-3 flex gap-3 text-sm">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by dye no, type, size…"
          className="min-h-[40px] min-w-[80px] flex-1 rounded-lg border border-border bg-card px-3 py-1.5 text-card-foreground"
        />
      </div>

      <EnterpriseTableShell>
        <table className={enterpriseTableClass}>
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>Dye No.</th>
              <th className={enterpriseThClass}>Type</th>
              <th className={enterpriseThClass}>UPS</th>
              <th className={enterpriseThClass}>Sheet Size</th>
              <th className={enterpriseThClass}>Carton Size</th>
              <th className={enterpriseThClass}>Impressions</th>
              <th className={enterpriseThClass}>Condition</th>
              <th className={enterpriseThClass}>Action</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {filtered.map((d) => (
              <tr key={d.id} className={enterpriseTrClass}>
                <td className={enterpriseTdMonoClass}>{d?.dyeNumber ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{d?.dyeType ?? '—'}</td>
                <td className={enterpriseTdMonoClass}>{d?.ups ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{d?.sheetSize ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{d?.cartonSize ?? '—'}</td>
                <td className={enterpriseTdMonoClass}>{(d?.impressionCount ?? 0).toLocaleString()}</td>
                <td className={enterpriseTdMutedClass}>{d?.conditionRating ?? 'Good'}</td>
                <td className={enterpriseTdClass}>
                  <Link href={`/masters/dyes/${d?.id ?? ''}`} className="text-blue-600 hover:underline dark:text-blue-400">
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </EnterpriseTableShell>
      {filtered.length === 0 && <p className="mt-4 text-sm text-ds-ink-faint dark:text-ds-ink-muted">No dyes found.</p>}
    </div>
  )
}
