'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

export default function NewInstrumentPage() {
  const router = useRouter()
  const [instrumentName, setInstrumentName] = useState('')
  const [specification, setSpecification] = useState('')
  const [range, setRange] = useState('')
  const [frequency, setFrequency] = useState('')
  const [purpose, setPurpose] = useState('')
  const [lastCalibration, setLastCalibration] = useState('')
  const [calibrationDue, setCalibrationDue] = useState('')
  const [calibrationFreqDays, setCalibrationFreqDays] = useState('')
  const [certificateUrl, setCertificateUrl] = useState('')
  const [active, setActive] = useState(true)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFieldErrors({})
    setSubmitting(true)
    try {
      const res = await fetch('/api/masters/instruments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instrumentName: instrumentName.trim(),
          specification: specification.trim() || null,
          range: range.trim() || null,
          frequency: frequency.trim() || null,
          purpose: purpose.trim() || null,
          lastCalibration: lastCalibration || null,
          calibrationDue: calibrationDue || null,
          calibrationFreqDays: calibrationFreqDays ? Number(calibrationFreqDays) : null,
          certificateUrl: certificateUrl.trim() || null,
          active,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFieldErrors((data as { fields?: Record<string, string> }).fields || {})
        toast.error((data as { error?: string }).error || 'Failed')
        return
      }
      toast.success('Instrument created')
      router.push('/masters/instruments')
    } catch {
      toast.error('Failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-lg">
      <h2 className="mb-4 text-lg font-semibold text-foreground">New QC instrument</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm text-ds-ink-muted">Instrument name *</label>
          <input value={instrumentName} onChange={(e) => setInstrumentName(e.target.value)} className={`w-full rounded-lg border px-3 py-2 text-foreground ${fieldErrors.instrumentName ? 'border-red-500 bg-ds-elevated' : 'border-ds-line/60 bg-ds-elevated'}`} />
        </div>
        <div>
          <label className="mb-1 block text-sm text-ds-ink-muted">Specification</label>
          <input value={specification} onChange={(e) => setSpecification(e.target.value)} className="w-full rounded-lg border border-ds-line/60 bg-ds-elevated px-3 py-2 text-foreground" />
        </div>
        <div>
          <label className="mb-1 block text-sm text-ds-ink-muted">Range</label>
          <input value={range} onChange={(e) => setRange(e.target.value)} className="w-full rounded-lg border border-ds-line/60 bg-ds-elevated px-3 py-2 text-foreground" />
        </div>
        <div>
          <label className="mb-1 block text-sm text-ds-ink-muted">Frequency</label>
          <input value={frequency} onChange={(e) => setFrequency(e.target.value)} className="w-full rounded-lg border border-ds-line/60 bg-ds-elevated px-3 py-2 text-foreground" />
        </div>
        <div>
          <label className="mb-1 block text-sm text-ds-ink-muted">Purpose</label>
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} className="w-full rounded-lg border border-ds-line/60 bg-ds-elevated px-3 py-2 text-foreground" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm text-ds-ink-muted">Last calibration</label>
            <input type="date" value={lastCalibration} onChange={(e) => setLastCalibration(e.target.value)} className="w-full rounded-lg border border-ds-line/60 bg-ds-elevated px-3 py-2 text-foreground" />
          </div>
          <div>
            <label className="mb-1 block text-sm text-ds-ink-muted">Calibration due</label>
            <input type="date" value={calibrationDue} onChange={(e) => setCalibrationDue(e.target.value)} className="w-full rounded-lg border border-ds-line/60 bg-ds-elevated px-3 py-2 text-foreground" />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-sm text-ds-ink-muted">Calibration frequency (days)</label>
          <input type="number" min={0} value={calibrationFreqDays} onChange={(e) => setCalibrationFreqDays(e.target.value)} className="w-full rounded-lg border border-ds-line/60 bg-ds-elevated px-3 py-2 text-foreground" />
        </div>
        <div>
          <label className="mb-1 block text-sm text-ds-ink-muted">Certificate URL</label>
          <input value={certificateUrl} onChange={(e) => setCertificateUrl(e.target.value)} className="w-full rounded-lg border border-ds-line/60 bg-ds-elevated px-3 py-2 text-foreground" />
        </div>
        <label className="flex items-center gap-2 text-sm text-ds-ink-muted">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
        <div className="flex gap-2">
          <button type="submit" disabled={submitting} className="rounded-lg bg-ds-warning px-4 py-2 text-primary-foreground disabled:bg-ds-line/30">
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <Link href="/masters/instruments" className="rounded-lg bg-ds-elevated px-4 py-2 text-foreground hover:bg-ds-line/30">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
