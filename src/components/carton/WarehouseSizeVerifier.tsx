'use client'
import { useState } from 'react'
import { toast } from 'sonner'
import { computeVariance } from '@/lib/carton/variance'

type Spec = { l: number | null; w: number | null; h: number | null }

export function WarehouseSizeVerifier({
  cartonId,
  spec,
}: {
  cartonId: string
  spec: Spec
}) {
  const [phys, setPhys] = useState<{ l: string; w: string; h: string }>({
    l: '',
    w: '',
    h: '',
  })
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const physNum = {
    l: phys.l ? Number(phys.l) : null,
    w: phys.w ? Number(phys.w) : null,
    h: phys.h ? Number(phys.h) : null,
  }
  const v = computeVariance(spec, physNum, 2)

  const cellColor = (axisVar: number | null) => {
    if (axisVar == null) return 'bg-muted'
    const a = Math.abs(axisVar)
    if (a === 0) return 'bg-green-100 text-green-800'
    if (a <= 2) return 'bg-yellow-100 text-yellow-800'
    return 'bg-red-100 text-red-800'
  }

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/cartons/${cartonId}/warehouse-verify`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          physical_l: physNum.l,
          physical_w: physNum.w,
          physical_h: physNum.h,
          notes,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Save failed')
      toast.success(
        data.status === 'size_mismatch'
          ? `Saved — SIZE MISMATCH (max ${data.maxAbsVariance}mm)`
          : 'Saved — size within tolerance',
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const axes: ('l' | 'w' | 'h')[] = ['l', 'w', 'h']
  return (
    <div className="space-y-4">
      <table className="w-full text-sm bg-ds-card rounded shadow-ds-depth-sm">
        <thead>
          <tr className="bg-muted">
            <th className="p-2 text-left">Axis</th>
            <th className="p-2">Spec (mm)</th>
            <th className="p-2">Physical (mm)</th>
            <th className="p-2">Variance</th>
          </tr>
        </thead>
        <tbody>
          {axes.map((ax) => (
            <tr key={ax}>
              <td className="p-2 font-medium uppercase">{ax}</td>
              <td className="p-2 text-center">{spec[ax] ?? '—'}</td>
              <td className="p-2 text-center">
                <input
                  type="number"
                  className="w-24 bg-ds-elevated rounded px-2 py-1"
                  value={phys[ax]}
                  onChange={(e) =>
                    setPhys((p) => ({ ...p, [ax]: e.target.value }))
                  }
                />
              </td>
              <td className={`p-2 text-center ${cellColor(v.variance[ax])}`}>
                {v.variance[ax] == null ? '—' : `${v.variance[ax]}mm`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <textarea
        className="w-full bg-ds-elevated rounded p-2 text-sm"
        placeholder="Variance notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <button
        disabled={saving}
        onClick={save}
        className="px-4 py-2 rounded bg-primary text-primary-foreground disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save verification'}
      </button>
    </div>
  )
}
