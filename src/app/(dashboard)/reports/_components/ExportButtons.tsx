'use client'
import { useState } from 'react'
import { toast } from 'sonner'

export function ExportButtons({ reportId, query }: { reportId: string; query: string }) {
  const [busy, setBusy] = useState<'xlsx' | 'pdf' | null>(null)
  async function go(format: 'xlsx' | 'pdf') {
    setBusy(format)
    try {
      const res = await fetch(`/api/reports/${reportId}/export?format=${format}&${query}`)
      if (!res.ok) throw new Error(await res.text())
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${reportId}.${format}`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error(`Could not export ${format.toUpperCase()}`)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex gap-2">
      <button onClick={() => go('xlsx')} disabled={busy !== null}
              className="rounded-md border border-ds-border px-3 py-1.5 text-sm disabled:opacity-50">
        {busy === 'xlsx' ? 'Exporting…' : 'Excel'}
      </button>
      <button onClick={() => go('pdf')} disabled={busy !== null}
              className="rounded-md border border-ds-border px-3 py-1.5 text-sm disabled:opacity-50">
        {busy === 'pdf' ? 'Exporting…' : 'PDF'}
      </button>
    </div>
  )
}
