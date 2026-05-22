'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { toast } from '@/store/toastStore'
import { Sparkles } from 'lucide-react'
import CartonForm, { type CartonFormData } from '@/components/masters/CartonForm'

type ApiCarton = CartonFormData & {
  id: string
  customer?: { id: string; name: string }
  sheetSizeL?: number | string | null
  sheetSizeW?: number | string | null
  ups?: number | null
  source?: string | null
}

export default function CartonEditPage() {
  const params = useParams()
  const id = params.id as string
  const [data, setData] = useState<ApiCarton | null>(null)
  const [markingReviewed, setMarkingReviewed] = useState(false)

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

  async function handleMarkReviewed() {
    setMarkingReviewed(true)
    try {
      const res = await fetch(`/api/masters/cartons/${id}/mark-reviewed`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as { error?: string }).error || 'Failed to mark reviewed')
      setData((prev) => (prev ? { ...prev, source: null } : prev))
      toast.success('Marked as reviewed')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to mark reviewed')
    } finally {
      setMarkingReviewed(false)
    }
  }

  return (
    <>
      {data.source === 'po_import_ai' && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-ds-md border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-sm text-violet-900 dark:text-violet-200">
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles className="size-4 shrink-0" />
            <span className="min-w-0">
              This carton was auto-created from a PO PDF import. Verify the fields below, then mark it as reviewed.
            </span>
          </div>
          <button
            type="button"
            onClick={() => void handleMarkReviewed()}
            disabled={markingReviewed}
            className="shrink-0 rounded-ds-md border border-violet-500/50 bg-violet-500/20 px-3 py-1 text-xs font-medium text-violet-900 hover:bg-violet-500/30 disabled:opacity-60 dark:text-violet-100"
          >
            {markingReviewed ? 'Marking…' : 'Mark as reviewed'}
          </button>
        </div>
      )}
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
        hsnCode: (data as { hsnCode?: string | null }).hsnCode ?? '',
        remarks: data.remarks ?? '',
        printingType: data.printingType ?? '',
        coatingType: data.coatingType ?? '',
        numberOfColours: data.numberOfColours != null ? String(data.numberOfColours) : '',
        sheetLengthMm: data.sheetSizeL != null ? String(data.sheetSizeL) : '',
        sheetWidthMm: data.sheetSizeW != null ? String(data.sheetSizeW) : '',
        ups: data.ups != null ? String(data.ups) : '',
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
    </>
  )
}
