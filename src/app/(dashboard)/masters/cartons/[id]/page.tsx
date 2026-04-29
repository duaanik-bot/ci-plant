'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { toast } from 'sonner'
import CartonForm, { type CartonFormData } from '@/components/masters/CartonForm'

type ApiCarton = CartonFormData & {
  id: string
  customer?: { id: string; name: string }
}

export default function CartonEditPage() {
  const params = useParams()
  const id = params.id as string
  const [data, setData] = useState<ApiCarton | null>(null)

  useEffect(() => {
    fetch(`/api/masters/cartons/${id}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.error) throw new Error(json.error)
        setData(json)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load'))
  }, [id])

  if (!data) return <div className="text-ds-ink-muted">Loading...</div>

  return (
    <CartonForm
      mode="EDIT"
      initialData={{
        id: data.id,
        cartonName: data.cartonName,
        customerId: data.customerId,
        customerName: data.customer?.name ? data.customer.name.toUpperCase() : '',
        artworkCode: (data as any).artworkCode ?? '',
        boardGrade: data.boardGrade ?? '',
        gsm: data.gsm != null ? String(data.gsm) : '',
        rate: data.rate != null ? String(data.rate) : '',
        gstPct: String((data as any).gstPct ?? 5),
        remarks: data.remarks ?? '',
        printingType: data.printingType ?? '',
        coatingType: data.coatingType ?? '',
        numberOfColours: (data as { numberOfColours?: number | null }).numberOfColours != null ? String((data as { numberOfColours?: number | null }).numberOfColours) : '',
        sheetLengthMm: (data as { blankLength?: number | null }).blankLength != null ? String((data as { blankLength?: number | null }).blankLength) : '',
        sheetWidthMm: (data as { blankWidth?: number | null }).blankWidth != null ? String((data as { blankWidth?: number | null }).blankWidth) : '',
        ups: (data as { ups?: number | null }).ups != null ? String((data as { ups?: number | null }).ups) : '',
        pastingStyle: data.pastingStyle ?? '',
        finishedLength: data.finishedLength != null ? String(data.finishedLength) : '',
        finishedWidth: data.finishedWidth != null ? String(data.finishedWidth) : '',
        finishedHeight: data.finishedHeight != null ? String(data.finishedHeight) : '',
        specialInstructions: (data as any).specialInstructions ?? '',
        dieMasterId: (data as { dieMasterId?: string }).dieMasterId ?? '',
        shadeCardId: (data as { shadeCardId?: string }).shadeCardId ?? '',
        active: data.active,
      }}
    />
  )
}
