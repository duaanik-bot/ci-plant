'use client'

import { useState, useEffect, useMemo } from 'react'
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

type Material = {
  id: string
  materialCode: string
  description: string
  unit: string
  qtyAvailable: number
  qtyReserved: number
  reorderPoint: number
  safetyStock: number
  boardType: string | null
  gsm: number | null
  supplier: { id: string; name: string } | null
  active: boolean
}

function stockHealth(available: number, reorder: number, safety: number): 'green' | 'yellow' | 'red' {
  if (available <= safety) return 'red'
  if (available <= reorder) return 'yellow'
  return 'green'
}

const DOT: Record<string, string> = {
  green: 'bg-green-500',
  yellow: 'bg-amber-500',
  red: 'bg-red-500',
}

const cellWrap = `${enterpriseTdBase} whitespace-normal break-words align-top`

export default function MastersMaterialsPage() {
  const [list, setList] = useState<Material[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch('/api/masters/materials')
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    if (!search.trim()) return list
    const q = search.toLowerCase().trim()
    return list.filter((m) => {
      const haystack = [
        m.materialCode,
        m.description,
        m.boardType ?? '',
        m.gsm != null ? String(m.gsm) : '',
        m.unit,
        String(m.qtyAvailable),
        String(m.qtyReserved),
        m.supplier?.name ?? '',
        m.active ? 'active' : 'inactive',
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [list, search])

  if (loading) {
    return <div className="text-sm text-slate-600 dark:text-slate-400">Loading...</div>
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">Board / Paper Master</h2>
        <Link href="/masters/materials/new" className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90">
          Add material
        </Link>
      </div>

      <div className="mb-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search code, description, board type, GSM, supplier..."
          className="min-h-[40px] w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-card-foreground"
        />
      </div>

      <EnterpriseTableShell>
        <table className="w-full min-w-[1100px] table-fixed border-collapse text-left text-sm text-slate-900 dark:text-slate-50">
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>Stock</th>
              <th className={enterpriseThClass}>Code</th>
              <th className={enterpriseThClass}>Description</th>
              <th className={enterpriseThClass}>Board Type</th>
              <th className={enterpriseThClass}>GSM</th>
              <th className={enterpriseThClass}>Unit</th>
              <th className={enterpriseThClass}>Available</th>
              <th className={enterpriseThClass}>Reserved</th>
              <th className={enterpriseThClass}>Supplier</th>
              <th className={enterpriseThClass}>Status</th>
              <th className={enterpriseThClass}>Action</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {filtered.map((m) => {
              const h = stockHealth(m.qtyAvailable, m.reorderPoint, m.safetyStock)
              return (
                <tr key={m.id} className={enterpriseTrClass}>
                  <td className={`${cellWrap} w-10`}>
                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[h]}`} title={h} />
                  </td>
                  <td className={`${cellWrap} font-designing-queue`}>{m?.materialCode ?? '—'}</td>
                  <td className={cellWrap}>{m?.description ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{m?.boardType ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{m?.gsm ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{m?.unit ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{m?.qtyAvailable ?? '—'}</td>
                  <td className={enterpriseTdMonoClass}>{m?.qtyReserved ?? '—'}</td>
                  <td className={enterpriseTdMutedClass}>{m?.supplier?.name ?? '—'}</td>
                  <td className={cellWrap}>
                    <span className={m?.active ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                      {m?.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className={cellWrap}>
                    <Link href={`/masters/materials/${m?.id ?? ''}`} className="text-blue-600 hover:underline dark:text-blue-400">
                      Edit
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </EnterpriseTableShell>
      {filtered.length === 0 && (
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">No materials match your search.</p>
      )}
    </div>
  )
}
