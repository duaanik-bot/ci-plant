'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

type Machine = {
  id: string
  machineCode: string
  name: string
  make: string | null
  specification: string | null
  capacityPerShift: number
  stdWastePct: number
  status: string
  lastPmDate: string | null
  nextPmDue: string | null
  notes: string | null
}

export default function EditMachinePage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const [machine, setMachine] = useState<Machine | null>(null)
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
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [loggingMaintenance, setLoggingMaintenance] = useState(false)

  useEffect(() => {
    fetch(`/api/masters/machines/${id}`)
      .then((r) => r.json())
      .then((m: Machine | { error?: string }) => {
        if (m && 'id' in m) {
          setMachine(m)
          setName(m.name)
          setMake(m.make ?? '')
          setSpecification(m.specification ?? '')
          setCapacityPerShift(String(m.capacityPerShift))
          setStdWastePct(String(m.stdWastePct))
          setStatus(m.status)
          setLastPmDate(m.lastPmDate ?? '')
          setNextPmDue(m.nextPmDue ?? '')
          setNotes((m as { notes?: string | null }).notes ?? '')
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
      const res = await fetch(`/api/masters/machines/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
      const data = await res.json()
      if (!res.ok) {
        setFieldErrors(data.fields || {})
        toast.error(data.error || 'Failed')
        return
      }
      toast.success('Machine updated')
      router.push('/masters/machines')
    } catch {
      toast.error('Failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function logMaintenance() {
    const today = new Date().toISOString().slice(0, 10)
    const next = new Date()
    next.setMonth(next.getMonth() + 1)
    const nextDue = next.toISOString().slice(0, 10)
    const entry = `Maintenance logged ${today}`
    setLoggingMaintenance(true)
    try {
      const res = await fetch(`/api/masters/machines/${id}/maintenance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastPmDate: today, nextPmDue: nextDue, notes: entry }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error((data as { error?: string }).error || 'Failed to log maintenance')
        return
      }
      setLastPmDate(today)
      setNextPmDue(nextDue)
      if (typeof (data as { notes?: string }).notes === 'string') {
        setNotes((data as { notes: string }).notes)
      } else {
        setNotes((prev) => (prev ? `${prev}\n${entry}` : entry))
      }
      toast.success('Maintenance logged')
    } catch {
      toast.error('Failed to log maintenance')
    } finally {
      setLoggingMaintenance(false)
    }
  }

  if (loading) return <div className="text-ds-ink-muted">Loading…</div>
  if (!machine) return <div className="text-[var(--error)]">Machine not found</div>

  return (
    <div className="max-w-lg">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-foreground">Edit {machine.machineCode}</h2>
        <button
          type="button"
          onClick={() => void logMaintenance()}
          disabled={loggingMaintenance}
          className="px-3 py-1.5 rounded-ds-md bg-ds-elevated hover:bg-ds-line/30 text-foreground text-sm disabled:opacity-50"
        >
          {loggingMaintenance ? 'Logging…' : 'Log maintenance'}
        </button>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated border border-ds-line/60 text-foreground"
          />
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Make / model</label>
          <input
            value={make}
            onChange={(e) => setMake(e.target.value)}
            className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated border border-ds-line/60 text-foreground"
          />
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Specification</label>
          <input
            value={specification}
            onChange={(e) => setSpecification(e.target.value)}
            className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated border border-ds-line/60 text-foreground"
          />
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Capacity per shift</label>
          <input
            type="number"
            min={1}
            value={capacityPerShift}
            onChange={(e) => setCapacityPerShift(e.target.value)}
            className={`w-full px-3 py-2 rounded-ds-md bg-ds-elevated border text-foreground ${
              fieldErrors.capacityPerShift ? 'border-[var(--error)]' : 'border-ds-line/60'
            }`}
          />
          {fieldErrors.capacityPerShift && <p className="mt-1 text-sm text-[var(--error)]">{fieldErrors.capacityPerShift}</p>}
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Standard waste %</label>
          <input
            type="number"
            min={0}
            step="0.1"
            value={stdWastePct}
            onChange={(e) => setStdWastePct(e.target.value)}
            className={`w-full px-3 py-2 rounded-ds-md bg-ds-elevated border text-foreground ${
              fieldErrors.stdWastePct ? 'border-[var(--error)]' : 'border-ds-line/60'
            }`}
          />
          {fieldErrors.stdWastePct && <p className="mt-1 text-sm text-[var(--error)]">{fieldErrors.stdWastePct}</p>}
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated border border-ds-line/60 text-foreground"
          >
            <option value="active">Active</option>
            <option value="under_maintenance">Under maintenance</option>
            <option value="retired">Retired</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-ds-ink-muted mb-1">Last PM date</label>
            <input
              type="date"
              value={lastPmDate}
              onChange={(e) => setLastPmDate(e.target.value)}
              className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated border border-ds-line/60 text-foreground"
            />
          </div>
          <div>
            <label className="block text-sm text-ds-ink-muted mb-1">Next PM due</label>
            <input
              type="date"
              value={nextPmDue}
              onChange={(e) => setNextPmDue(e.target.value)}
              className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated border border-ds-line/60 text-foreground"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm text-ds-ink-muted mb-1">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 rounded-ds-md bg-ds-elevated border border-ds-line/60 text-foreground"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 rounded-ds-md bg-ds-warning hover:bg-ds-warning disabled:bg-ds-line/30 text-primary-foreground"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <Link href="/masters/machines" className="px-4 py-2 rounded-ds-md bg-ds-elevated hover:bg-ds-line/30 text-foreground">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
