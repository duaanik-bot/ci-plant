'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  EnterpriseTableShell,
  enterpriseTheadClass,
  enterpriseTbodyClass,
  enterpriseTrClass,
  enterpriseThClass,
  enterpriseTdClass,
  enterpriseTdMonoClass,
  enterpriseTdMutedClass,
} from '@/components/ui/EnterpriseTableShell'

type Order = {
  id: string
  orderCode: string
  orderedAt: string
  orderType: string
  cartonName: string | null
  cartonSize: string | null
  dieType: string | null
  ups: number | null
  sheetSize: string | null
  vendorName: string
  expectedBy: string | null
  quotedCost: string | null
  priority: string
  status: string
}

export default function DieVendorOrdersPage() {
  const [rows, setRows] = useState<Order[]>([])
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    fetch('/api/die-vendor-orders')
      .then((r) => r.json())
      .then((data) => setRows(Array.isArray(data) ? data : []))
  }, [refresh])

  const today = Date.now()
  const withOverdue = useMemo(
    () =>
      rows.map((r) => {
        const overdueDays =
          r.expectedBy && r.status !== 'received'
            ? Math.max(0, Math.floor((today - new Date(r.expectedBy).getTime()) / (1000 * 60 * 60 * 24)))
            : 0
        return { ...r, overdueDays }
      }),
    [rows, today]
  )

  async function updateStatus(id: string, status: string) {
    await fetch(`/api/die-vendor-orders/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    setRefresh((x) => x + 1)
  }

  async function markReceived(id: string) {
    await fetch(`/api/die-vendor-orders/${id}/receive`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ condition: 'New', storageLocation: 'Die Rack A-1', compartment: 'Compartment 1' }),
    })
    setRefresh((x) => x + 1)
  }

  const selectCls =
    'min-h-[32px] min-w-[80px] rounded border border-neutral-200 bg-card px-1 py-0.5 text-xs text-neutral-900 dark:border-ds-line/50 dark:bg-ds-card dark:text-ds-ink'

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <h1 className="text-base font-semibold text-neutral-900 dark:text-ds-ink">Vendor Orders</h1>
      <EnterpriseTableShell>
        <table className="w-full min-w-[960px] border-collapse text-left text-sm text-neutral-900 dark:text-ds-ink">
          <thead className={enterpriseTheadClass}>
            <tr>
              <th className={enterpriseThClass}>Order</th>
              <th className={enterpriseThClass}>Date</th>
              <th className={enterpriseThClass}>Type</th>
              <th className={enterpriseThClass}>Carton</th>
              <th className={enterpriseThClass}>Die Spec</th>
              <th className={enterpriseThClass}>Vendor</th>
              <th className={enterpriseThClass}>Expected</th>
              <th className={enterpriseThClass}>Priority</th>
              <th className={enterpriseThClass}>Status</th>
              <th className={enterpriseThClass}>Action</th>
            </tr>
          </thead>
          <tbody className={enterpriseTbodyClass}>
            {withOverdue.map((o) => (
              <tr key={o.id} className={enterpriseTrClass}>
                <td className={`${enterpriseTdMonoClass} text-ds-warning dark:text-ds-warning`}>{o?.orderCode ?? '—'}</td>
                <td className={enterpriseTdMonoClass}>
                  {o?.orderedAt ? new Date(o.orderedAt).toLocaleDateString('en-IN') : '—'}
                </td>
                <td className={enterpriseTdMutedClass}>{o?.orderType ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>{o?.cartonName ?? '—'}</td>
                <td className={enterpriseTdMutedClass}>
                  {o?.dieType ?? '—'} · {o?.ups ?? '—'} up · {o?.sheetSize ?? '—'}
                </td>
                <td className={enterpriseTdClass}>{o?.vendorName ?? '—'}</td>
                <td className={enterpriseTdMonoClass}>
                  {o?.expectedBy ? new Date(o.expectedBy).toLocaleDateString('en-IN') : '—'}{' '}
                  {o.overdueDays > 0 ? (
                    <span className="text-rose-600 dark:text-rose-400">OVERDUE {o.overdueDays}d</span>
                  ) : null}
                </td>
                <td className={enterpriseTdClass}>{o?.priority ?? '—'}</td>
                <td className={enterpriseTdClass}>{o?.status ?? '—'}</td>
                <td className={enterpriseTdClass}>
                  <div className="flex flex-wrap items-center gap-2">
                    <select value={o.status} onChange={(e) => updateStatus(o.id, e.target.value)} className={selectCls}>
                      <option>ordered</option>
                      <option>confirmed</option>
                      <option>in_manufacturing</option>
                      <option>dispatched</option>
                      <option>received</option>
                      <option>cancelled</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => markReceived(o.id)}
                      className="text-sm text-emerald-600 hover:underline dark:text-emerald-400"
                    >
                      Receive
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </EnterpriseTableShell>
    </div>
  )
}
