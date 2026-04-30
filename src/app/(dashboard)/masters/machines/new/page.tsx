'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

export default function NewMachinePage() {
  const router = useRouter()
  const [machineCode, setMachineCode] = useState('')
  const [name, setName] = useState('')
  const [make, setMake] = useState('')
  const [specification, setSpecification] = useState('')
  const [capacityPerShift, setCapacityPerShift] = useState('')
  const [stdWastePct, setStdWastePct] = useState('')
  const [status, setStatus] = useState('active')
  const [lastPmDate, setLastPmDate] = useState('')
  const [nextPmDue, setNextPmDue] = useState('')
  const [notes, setNotes] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFieldErrors({})
    setSubmitting(true)
    try {
      const res = await fetch('/api/masters/machines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machineCode: machineCode.trim(),
          name: name.trim(),
          make: make.trim() || null,
          specification: specification.trim() || null,
          capacityPerShift: Number(capacityPerShift),
          stdWastePct: Number(stdWastePct),
          status,
          lastPmDate: lastPmDate || null,
          nextPmDue: nextPmDue || null,
          notes: notes.trim() || null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFieldErrors((data as { fields?: Record<string, string> }).fields || {})
        toast.error((data as { error?: string }).error || 'Failed')
        return
      }
      toast.success('Machine created')
      router.push('/masters/machines')
    } catch {
      toast.error('Failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-lg">
      <h2 className="mb-4 text-lg font-semibold text-foreground">New machine</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm text-ds-ink-muted">Machine code *</label>
          <input value={machineCode} onChange={(e) => setMachineCode(e.target.value)} className={`w-full rounded-lg border px-3 py-2 text-foreground ${fieldErrors.machineCode ? 'border-red-500 bg-ds-elevated' : 'border-ds-line/60 bg-ds-elevated'}`} />
          {fieldErrors.machineCode && <p className="mt-1 text-sm text-red-400">{fieldErrors.machineCode}</p>}
        </div>
        <div>
          <label className="mb-1 block text-sm text-ds-ink-muted">Name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={`w-full rounded-lg border px-3 py-2 text-foreground ${fieldErrors.name ? 'border-red-500 bg-ds-elevated' : 'border-ds-line/60 bg-ds-elevated'}`} />
        </div>
        <div>
          <label className="mb-1 block text-sm text-ds-ink-muted">Make / model</label>
          <input value={make} onChange={(e) => setMake(e.target.value)} className="w-full rounded-lg border border-ds-line/60 bg-ds-elevated px-3 py-2 text-foreground" />
        </div>
        <div>
          <label className="mb-1 block text-sm text-ds-ink-muted">Specification</label>
          <input value={specification} onChange={(e) => setSpecification(e.target.value)} className="w-full rounded-lg border border-ds-line/60 bg-ds-elevated px-3 py-2 text-foreground" />
        </div>
        <div>
          <label className="mb-1 block text-sm text-ds-ink-muted">Capacity per shift *</label>
          <input type="number" min={1} value={capacityPerShift} onChange={(e) => setCapacityPerShift(e.target.value)} className={`w-full rounded-lg border px-3 py-2 text-foreground ${fieldErrors.capacityPerShift ? 'border-red-500 bg-ds-elevated' : 'border-ds-line/60 bg-ds-elevated'}`} />
        </div>
        <div>
          <label className="mb-1 block text-sm text-ds-ink-muted">Standard waste % *</label>
          <input type="number" min={0} step="0.1" value={stdWastePct} onChange={(e) => setStdWastePct(e.target.value)} className={`w-full rounded-lg border px-3 py-2 text-foreground ${fieldErrors.stdWastePct ? 'border-red-500 bg-ds-elevated' : 'border-ds-line/60 bg-ds-elevated'}`} />
        </div>
        <div>
          <label className="mb-1 block text-sm text-ds-ink-muted">Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full rounded-lg border border-ds-line/60 bg-ds-elevated px-3 py-2 text-foreground">
            <option value="active">Active</option>
            <option value="under_maintenance">Under maintenance</option>
            <option value="retired">Retired</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm text-ds-ink-muted">Last PM date</label>
            <input type="date" value={lastPmDate} onChange={(e) => setLastPmDate(e.target.value)} className="w-full rounded-lg border border-ds-line/60 bg-ds-elevated px-3 py-2 text-foreground" />
          </div>
          <div>
            <label className="mb-1 block text-sm text-ds-ink-muted">Next PM due</label>
            <input type="date" value={nextPmDue} onChange={(e) => setNextPmDue(e.target.value)} className="w-full rounded-lg border border-ds-line/60 bg-ds-elevated px-3 py-2 text-foreground" />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-sm text-ds-ink-muted">Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full rounded-lg border border-ds-line/60 bg-ds-elevated px-3 py-2 text-foreground" />
        </div>
        <div className="flex gap-2">
          <button type="submit" disabled={submitting} className="rounded-lg bg-ds-warning px-4 py-2 text-primary-foreground disabled:bg-ds-line/30">
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <Link href="/masters/machines" className="rounded-lg bg-ds-elevated px-4 py-2 text-foreground hover:bg-ds-line/30">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
