'use client'

import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { CardSection } from '@/components/design-system/CardSection'
import { INDUSTRIAL_PRIORITY_EVENT } from '@/lib/industrial-priority-sync'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type MachineOpt = { id: string; machineCode: string; name: string }

type DrawerPayload = {
  id: string
  jobCardNumber: number
  status: string
  qaReleased?: boolean
  machineId: string | null
  customer: { id: string; name: string }
  poLine: {
    id: string
    cartonName: string
    cartonSize: string | null
    quantity: number
    coatingType: string | null
    embossingLeafing: string | null
    carton?: {
      coatingType: string | null
      laminateType: string | null
      foilType: string | null
    } | null
    po?: { poNumber: string }
  } | null
  postPressRouting?: Record<string, unknown> | null
  productionBible?: {
    sheetSizeLabel: string | null
    ups: number | null
    toolingKit: {
      plate: { code: string } | null
      die: { code: string } | null
      emboss: { code: string } | null
      shade: { shadeCode: string } | null
    }
  }
  boardMaterial?: {
    boardStatus: 'available' | 'out_of_stock'
    planningMaterialGateStatus: string
    materialShortage: boolean
    ledgerLink: { gsm: number; board: string } | null
  }
}

function statusChip(status: string): { label: string; cls: string } {
  if (status === 'qa_released' || status === 'closed') {
    return { label: 'Released', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' }
  }
  if (status === 'in_progress' || status === 'final_qc') {
    return { label: 'Ready', cls: 'border-amber-400/40 bg-amber-400/10 text-amber-300' }
  }
  return { label: 'Draft', cls: 'border-ds-line/50 bg-ds-main text-ds-ink-muted' }
}

function readinessMeta(ok: boolean | null): { label: string; dot: string; hint: string } {
  if (ok === true) return { label: 'Ready', dot: 'bg-emerald-500', hint: 'Board available' }
  if (ok === null) return { label: 'Waiting', dot: 'bg-amber-400', hint: 'Board in procurement' }
  return { label: 'Not Ready', dot: 'bg-rose-500', hint: 'Board missing' }
}

export function JobCardDrawer({
  data,
  onClose,
  onSave,
  onRelease,
}: {
  data: {
    product: string
    customer: string
    po: string
    qty: number | string
    size: string
    ups: number | string
    sheetSize: string
    boardReady: boolean
    boardWaiting: boolean
    boardType: string
    gsm: string
    plate: boolean
    die: boolean
    embossRequired: boolean
    emboss: boolean
    toolingReady: boolean
    machineId: string
    machineOptions: MachineOpt[]
    isReleased: boolean
    setMachineId: (v: string) => void
    setSheetSize: (v: string) => void
    statusLabel: string
  }
  onClose: () => void
  onSave: () => void
  onRelease: () => void
}) {
  const isValid = !!data.sheetSize && data.boardReady && data.toolingReady
  return (
    <div className="fixed right-0 top-0 h-full w-[38%] min-w-[420px] max-w-[640px] bg-[var(--bg-card)] border-l border-[var(--border)] shadow-xl flex flex-col z-[60] transition-transform duration-200">
      <div className="p-4 border-b border-[var(--border)]">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-ds-ink">{data.product}</h2>
            <p className="text-sm text-[var(--text-secondary)]">
              {data.customer} • {data.po}
            </p>
          </div>
          <span className="rounded border border-ds-line/60 px-2 py-0.5 text-[11px] text-ds-ink-faint">
            {data.statusLabel}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        <div>
          <h3 className="text-sm text-[var(--text-secondary)] mb-2">Job Summary</h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>Qty: {data.qty}</div>
            <div>Size: {data.size}</div>
            <div>UPS: {data.ups}</div>
            <div>
              Sheet Size:
              <input
                value={data.sheetSize || ''}
                onChange={(e) => data.setSheetSize(e.target.value)}
                disabled={data.isReleased}
                className="ml-2 px-2 py-1 border border-[var(--border)] rounded bg-ds-main text-ds-ink disabled:opacity-50"
              />
            </div>
          </div>
        </div>

        <div>
          <h3 className="text-sm text-[var(--text-secondary)] mb-2">Board Readiness</h3>
          <div className="text-sm mb-2 text-ds-ink-faint">
            {data.boardType} · {data.gsm}
          </div>
          <span
            className={`px-2 py-1 rounded text-xs ${
              data.boardReady
                ? 'bg-green-500/10 text-green-400'
                : data.boardWaiting
                  ? 'bg-yellow-500/10 text-yellow-400'
                  : 'bg-rose-500/10 text-rose-400'
            }`}
          >
            {data.boardReady ? 'Ready' : data.boardWaiting ? 'Waiting' : 'Not Ready'}
          </span>
        </div>

        <div>
          <h3 className="text-sm text-[var(--text-secondary)] mb-2">Tooling</h3>
          <div className="space-y-1 text-sm">
            <div>Plate: {data.plate ? 'Linked' : 'Missing'}</div>
            <div>Die: {data.die ? 'Linked' : 'Missing'}</div>
            {data.embossRequired && (
              <div>Emboss: {data.emboss ? 'Linked' : 'Missing'}</div>
            )}
          </div>
        </div>

        <div>
          <h3 className="text-sm text-[var(--text-secondary)] mb-2">Execution</h3>
          <select
            value={data.machineId}
            onChange={(e) => data.setMachineId(e.target.value)}
            disabled={data.isReleased}
            className="w-full px-3 py-2 border border-[var(--border)] rounded bg-ds-main text-ds-ink disabled:opacity-50"
          >
            <option value="">Select Machine</option>
            {data.machineOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.machineCode} · {m.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="p-4 border-t border-[var(--border)] flex justify-between">
        <button onClick={onClose} className="text-ds-ink-muted">
          Close
        </button>

        <div className="flex gap-2">
          <button onClick={onSave} disabled={data.isReleased} className="text-ds-ink disabled:opacity-40">
            Save
          </button>
          <button
            onClick={onRelease}
            disabled={!isValid || data.isReleased}
            className="bg-[var(--accent)] text-white px-4 py-2 rounded disabled:opacity-40"
          >
            Release
          </button>
        </div>
      </div>
    </div>
  )
}

export function JobCardHubAuditDrawer({
  jobCardId,
  jobCardNumber,
  onClose,
}: {
  jobCardId: string | null
  jobCardNumber: number | null
  onClose: () => void
}) {
  const [data, setData] = useState<DrawerPayload | null>(null)
  const [machines, setMachines] = useState<MachineOpt[]>([])
  const [loading, setLoading] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [releasing, setReleasing] = useState(false)
  const [machineId, setMachineId] = useState('')
  const [priority, setPriority] = useState<'normal' | 'urgent'>('normal')
  const [sequence, setSequence] = useState('Print → Die → Emboss → Pack')
  const [sheetSizeOverride, setSheetSizeOverride] = useState('')

  useEffect(() => {
    if (!jobCardId) {
      setData(null)
      setMachineId('')
      setPriority('normal')
      setSequence('Print → Die → Emboss → Pack')
      setSheetSizeOverride('')
      return
    }
    let cancelled = false
    setLoading(true)
    Promise.all([fetch(`/api/job-cards/${jobCardId}`), fetch('/api/machines')])
      .then(async ([detailRes, machinesRes]) => {
        const detail = (await detailRes.json().catch(() => ({}))) as DrawerPayload & { error?: string }
        const m = (await machinesRes.json().catch(() => [])) as MachineOpt[]
        if (cancelled) return
        if (!detailRes.ok || detail.error) {
          setData(null)
          toast.error(detail.error || 'Failed to load job card')
          return
        }
        setData(detail)
        setMachines(Array.isArray(m) ? m : [])
        setMachineId(detail.machineId ?? '')
        const setup =
          detail.postPressRouting && typeof detail.postPressRouting === 'object'
            ? ((detail.postPressRouting as Record<string, unknown>).executionSetup as
                | { priority?: string; sequence?: string; sheetSize?: string }
                | undefined)
            : undefined
        setPriority(setup?.priority === 'urgent' ? 'urgent' : 'normal')
        setSequence(
          typeof setup?.sequence === 'string' && setup.sequence.trim()
            ? setup.sequence
            : 'Print → Die → Emboss → Pack',
        )
        setSheetSizeOverride(typeof setup?.sheetSize === 'string' ? setup.sheetSize : '')
      })
      .catch(() => {
        if (!cancelled) toast.error('Failed to load drawer')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [jobCardId])

  const open = jobCardId != null
  const derivedSheet = data?.productionBible?.sheetSizeLabel ?? null
  const hasBaseSheet = !!derivedSheet && !derivedSheet.includes('—')
  const effectiveSheet = hasBaseSheet ? derivedSheet : sheetSizeOverride.trim() || null

  const tooling = data?.productionBible?.toolingKit
  const embossApplicable = !!(
    data?.poLine?.embossingLeafing &&
    String(data.poLine.embossingLeafing).trim().length > 0 &&
    String(data.poLine.embossingLeafing).toLowerCase() !== 'none'
  )
  const shadeApplicable = !!tooling?.shade

  const boardOk = data?.boardMaterial?.boardStatus === 'available'
  const boardWaiting = !boardOk && !!data?.boardMaterial && !data.boardMaterial.materialShortage
  const boardMeta = readinessMeta(boardOk ? true : boardWaiting ? null : false)

  const toolingProblems = useMemo(() => {
    const issues: string[] = []
    if (!tooling?.plate) issues.push('Plate missing')
    if (!tooling?.die) issues.push('Die missing')
    if (embossApplicable && !tooling?.emboss) issues.push('Emboss block missing')
    if (shadeApplicable && !tooling?.shade) issues.push('Shade card missing')
    return issues
  }, [embossApplicable, shadeApplicable, tooling?.die, tooling?.emboss, tooling?.plate, tooling?.shade])

  const validationErrors = useMemo(() => {
    const errors: string[] = []
    if (!effectiveSheet) errors.push('Sheet size is required')
    if (!boardOk) errors.push('Board is not ready')
    if (toolingProblems.length > 0) errors.push(...toolingProblems)
    return errors
  }, [boardOk, effectiveSheet, toolingProblems])

  const isReleased = data?.status === 'qa_released' || data?.status === 'closed'

  const save = async (release: boolean) => {
    if (!data?.id) return
    if (release && validationErrors.length > 0) {
      toast.error(validationErrors[0] ?? 'Validation failed')
      return
    }
    const busySetter = release ? setReleasing : setSavingDraft
    busySetter(true)
    try {
      const currentRouting =
        data.postPressRouting && typeof data.postPressRouting === 'object'
          ? (data.postPressRouting as Record<string, unknown>)
          : {}
      const executionSetup = {
        priority,
        sequence,
        ...(effectiveSheet ? { sheetSize: effectiveSheet } : {}),
      }
      const res = await fetch(`/api/job-cards/${data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machineId: machineId || null,
          ...(release ? { status: 'qa_released', qaReleased: true } : {}),
          postPressRouting: { ...currentRouting, executionSetup },
        }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error || 'Save failed')
      toast.success(release ? 'Released to production' : 'Draft saved')
      window.dispatchEvent(new Event(INDUSTRIAL_PRIORITY_EVENT))
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      busySetter(false)
    }
  }

  if (!open) return null

  if (loading && !data) {
    return (
      <div className="fixed right-0 top-0 h-full w-[38%] min-w-[420px] max-w-[640px] bg-[var(--bg-card)] border-l border-[var(--border)] shadow-xl z-[60] p-4 text-sm text-ds-ink-faint">
        Loading job card…
      </div>
    )
  }

  if (!data) return null

  const chip = statusChip(data.status)

  return (
    <JobCardDrawer
      data={{
        product: data.poLine?.cartonName ?? `Job Card ${jobCardNumber ?? '—'}`,
        customer: data.customer?.name ?? '—',
        po: `${data.poLine?.po?.poNumber ?? '—'} • ${data.poLine?.id ?? '—'}`,
        qty: data.poLine?.quantity ?? '—',
        size: data.poLine?.cartonSize ?? '—',
        ups: data.productionBible?.ups ?? '—',
        sheetSize: effectiveSheet ?? '',
        boardReady: !!boardOk,
        boardWaiting: !boardOk && !!boardWaiting,
        boardType: data.boardMaterial?.ledgerLink?.board ?? '—',
        gsm: data.boardMaterial?.ledgerLink?.gsm != null ? String(data.boardMaterial.ledgerLink.gsm) : '—',
        plate: !!tooling?.plate,
        die: !!tooling?.die,
        embossRequired: embossApplicable,
        emboss: !!tooling?.emboss,
        toolingReady: toolingProblems.length === 0,
        machineId,
        machineOptions: machines,
        isReleased,
        setMachineId,
        setSheetSize: setSheetSizeOverride,
        statusLabel: chip.label,
      }}
      onClose={onClose}
      onSave={() => void save(false)}
      onRelease={() => void save(true)}
    />
  )
}
