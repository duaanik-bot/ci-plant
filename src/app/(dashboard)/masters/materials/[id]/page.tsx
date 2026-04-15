'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { toast } from 'sonner'
import MaterialForm from '@/components/masters/MaterialForm'

type ApiMaterial = {
  id: string
  materialCode: string
  description: string
  unit: string
  boardType: string | null
  gsm: number | null
  sheetLength: number | null
  sheetWidth: number | null
  grainDirection: string | null
  caliperMicrons: number | null
  brightnessPct: number | null
  moisturePct: number | null
  hsnCode: string | null
  reorderPoint: number
  safetyStock: number
  storageLocation: string | null
  leadTimeDays: number
  supplierId: string | null
  weightedAvgCost: number
  active: boolean
  qtyAvailable: number
  supplier: { id: string; name: string } | null
}

export default function EditMaterialPage() {
  const params = useParams()
  const id = params.id as string
  const [data, setData] = useState<ApiMaterial | null>(null)

  useEffect(() => {
    fetch(`/api/masters/materials/${id}`)
      .then((r) => r.json())
      .then((m) => {
        if (m.error) throw new Error(m.error)
        setData(m)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [id])

  if (!data) return <div className="text-slate-400">Loading...</div>

  return (
    <MaterialForm
      mode="EDIT"
      initialData={{
        id: data.id,
        materialCode: data.materialCode,
        description: data.description,
        unit: data.unit,
        boardType: data.boardType ?? '',
        gsm: data.gsm != null ? String(data.gsm) : '',
        sheetLength: data.sheetLength != null ? String(data.sheetLength) : '',
        sheetWidth: data.sheetWidth != null ? String(data.sheetWidth) : '',
        grainDirection: data.grainDirection ?? '',
        caliperMicrons: data.caliperMicrons != null ? String(data.caliperMicrons) : '',
        brightnessPct: data.brightnessPct != null ? String(data.brightnessPct) : '',
        moisturePct: data.moisturePct != null ? String(data.moisturePct) : '',
        hsnCode: data.hsnCode ?? '',
        reorderPoint: String(data.reorderPoint),
        safetyStock: String(data.safetyStock),
        storageLocation: data.storageLocation ?? '',
        leadTimeDays: String(data.leadTimeDays),
        supplierId: data.supplierId ?? data.supplier?.id ?? '',
        weightedAvgCost: String(data.weightedAvgCost),
        active: data.active,
        qtyAvailable: data.qtyAvailable,
      }}
    />
  )
}
