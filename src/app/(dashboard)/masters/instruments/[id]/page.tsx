'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

type Instrument = {
  id: string
  instrumentName: string
  specification: string | null
  range: string | null
  frequency: string | null
  purpose: string | null
  lastCalibration: string | null
  calibrationDue: string | null
  calibrationFreqDays: number
  certificateUrl: string | null
  active: boolean
}

export default function EditInstrumentPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const [inst, setInst] = useState<Instrument | null>(null)
  const [instrumentName, setInstrumentName] = useState('')
  const [specification, setSpecification] = useState('')
  const [range, setRange] = useState('')
  const [frequency, setFrequency] = useState('')
  const [purpose, setPurpose] = useState('')
  const [lastCalibration, setLastCalibration] = useState('')
  const [calibrationDue, setCalibrationDue] = useState('')
  const [calibrationFreqDays, setCalibrationFreqDays] = useState('365')
  const [certificateUrl, setCertificateUrl] = useState('')
  const [active, setActive] = useState(true)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    fetch('/api/masters/instruments')
      .then((r) => r.json())
      .then((data: Instrument[]) => {
        const i = Array.isArray(data) ? data.find((x) => x.id === id) : null
        if (i) {
          setInst(i)
          setInstrumentName(i.instrumentName)
          setSpecification(i.specification ?? '')
          setRange(i.range ?? '')
          setFrequency(i.frequency ?? '')
          setPurpose(i.purpose ?? '')
          setLastCalibration(i.lastCalibration ?? '')
          setCalibrationDue(i.calibrationDue ?? '')
          setCalibrationFreqDays(String(i.calibrationFreqDays ?? 365))
          setCertificateUrl(i.certificateUrl ?? '')
          setActive(i.active)
        }
      })
      .catch(() => toast.error('Failed to load'))
      .finally(() => setLoading(false))
  }, [id])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFieldErrors({})
    setSubmitting(true)
    try {
      const res = await fetch(`/api/masters/instruments/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instrumentName: instrumentName.trim(),
          specification: specification.trim() || null,
          range: range.trim() || null,
          frequency: frequency.trim() || null,
          purpose: purpose.trim() || null,
          lastCalibration: lastCalibration || null,
          calibrationDue: calibrationDue || null,
          calibrationFreqDays: Number(calibrationFreqDays) || 365,
          certificateUrl: certificateUrl.trim() || null,
          active,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFieldErrors(data.fields || {})
        toast.error(data.error || 'Failed')
        return
      }
      toast.success('Instrument updated')
      router.push('/masters/instruments')
    } catch {
      toast.error('Failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="text-ds-ink-muted">Loading…</div>
  if (!inst) return <div className="text-red-400">Instrument not found</div>

  return (
    <div className="max-w-lg">
      <h2 className="text-lg font-semibold text-foreground mb-4">Edit instrument</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Instrument name</label>
          <input
            value={instrumentName}
            onChange={(e) => setInstrumentName(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground"
          />
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Specification</label>
          <input
            value={specification}
            onChange={(e) => setSpecification(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground"
          />
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Range</label>
          <input
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground"
          />
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Frequency</label>
          <input
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground"
          />
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Purpose</label>
          <input
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-ds-ink-muted mb-1">Last calibration</label>
            <input
              type="date"
              value={lastCalibration}
              onChange={(e) => setLastCalibration(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground"
            />
          </div>
          <div>
            <label className="block text-sm text-ds-ink-muted mb-1">Calibration due</label>
            <input
              type="date"
              value={calibrationDue}
              onChange={(e) => setCalibrationDue(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Calibration frequency (days)</label>
          <input
            type="number"
            min={1}
            value={calibrationFreqDays}
            onChange={(e) => setCalibrationFreqDays(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground"
          />
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Certificate URL</label>
          <input
            value={certificateUrl}
            onChange={(e) => setCertificateUrl(e.target.value)}
            placeholder="https://..."
            className="w-full px-3 py-2 rounded-lg bg-ds-elevated border border-ds-line/60 text-foreground"
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="active"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="rounded border-ds-line/60"
          />
          <label htmlFor="active" className="text-sm text-ds-ink-muted">Active</label>
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 rounded-lg bg-ds-warning hover:bg-ds-warning disabled:bg-ds-line/30 text-primary-foreground"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <Link href="/masters/instruments" className="px-4 py-2 rounded-lg bg-ds-elevated hover:bg-ds-line/30 text-foreground">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
