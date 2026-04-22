'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  EnterpriseTableShell,
  enterpriseTheadClass,
  enterpriseTbodyClass,
  enterpriseTrClass,
  enterpriseThClass,
  enterpriseTdBase,
  enterpriseTdMonoClass,
  enterpriseTdMutedClass,
} from '@/components/ui/EnterpriseTableShell'

type CartonRow = {
  id: string
  cartonName: string
  customerId: string
  customer: { id: string; name: string }
  gsm: number | null
  boardGrade: string | null
  paperType: string | null
  finishedLength: number | null
  finishedWidth: number | null
  finishedHeight: number | null
  rate: number | null
  active: boolean
}

const cellWrap = `${enterpriseTdBase} whitespace-normal break-words`

export default function CartonMasterPage() {
  const [rows, setRows] = useState<CartonRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    async function load() {
      try {
        const cartonsRes = await fetch('/api/masters/cartons')
        const cartonsJson = await cartonsRes.json()
        setRows(Array.isArray(cartonsJson) ? cartonsJson : [])
      } catch {
        toast.error('Failed to load cartons')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const filtered = useMemo(() => {
    return rows.filter((c) => {
      if (search) {
        const q = search.toLowerCase()
        const size = `${c.finishedLength ?? ''}x${c.finishedWidth ?? ''}x${c.finishedHeight ?? ''}`.toLowerCase()
        const haystack = [
          c.cartonName,
          c.customer?.name || '',
          c.boardGrade || '',
          c.paperType || '',
          String(c.gsm ?? ''),
          size,
          c.active ? 'active' : 'inactive',
          c.rate != null ? String(c.rate) : '',
        ]
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [rows, search])

  if (loading) {
    return <div className="text-sm text-ds-ink-faint dark:text-ds-ink-muted">Loading cartons…</div>
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-ds-ink">Carton Master</h2>
        <Link href="/masters/cartons/new" className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90">
          Add carton
        </Link>
      </div>

      <div className="mb-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search clients, board grades, GSM, size, carton..."
          className="min-h-[40px] w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-card-foreground"
        />
      </div>

      <EnterpriseTableShell>
        <table className="w-full min-w-[960px] table-fixed border-collapse text-left text-sm text-neutral-900 dark:text-ds-ink">
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>Carton</th>
              <th className={enterpriseThClass}>Client</th>
              <th className={enterpriseThClass}>L×W×H</th>
              <th className={enterpriseThClass}>GSM</th>
              <th className={enterpriseThClass}>Board</th>
              <th className={enterpriseThClass}>Coating</th>
              <th className={enterpriseThClass}>Rate</th>
              <th className={enterpriseThClass}>Status</th>
              <th className={enterpriseThClass}>Action</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {filtered.map((c) => (
              <tr key={c.id} className={enterpriseTrClass}>
                <td className={`${cellWrap} font-designing-queue`}>{c?.cartonName ?? '—'}</td>
                <td className={cellWrap}>{c?.customer?.name ?? '—'}</td>
                <td className={enterpriseTdMonoClass}>
                  {c?.finishedLength ?? '—'}×{c?.finishedWidth ?? '—'}×{c?.finishedHeight ?? '—'}
                </td>
                <td className={enterpriseTdMonoClass}>{c?.gsm ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{c?.boardGrade ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{c?.paperType ?? '—'}</td>
                <td className={enterpriseTdMonoClass}>{c?.rate != null ? `₹${c.rate.toFixed(2)}` : '—'}</td>
                <td className={cellWrap}>
                  <span className={c?.active ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                    {c?.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className={cellWrap}>
                  <Link href={`/masters/cartons/${c?.id ?? ''}`} className="text-blue-600 hover:underline dark:text-blue-400">
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </EnterpriseTableShell>
      {filtered.length === 0 && (
        <p className="mt-4 text-sm text-ds-ink-faint dark:text-ds-ink-muted">No cartons match your search.</p>
      )}
    </div>
  )
}
