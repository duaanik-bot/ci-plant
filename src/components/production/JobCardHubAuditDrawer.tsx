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
    <div className="fixed right-0 top-0 z-[60] flex h-full w-[min(100%,clamp(420px,38vw,640px))] flex-col border-l border-ds-line bg-ds-card shadow-xl transition-transform duration-150">
      <div className="border-b border-ds-line px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-ds-ink">{data.product}</h2>
            <p className="truncate text-xs text-ds-ink-faint">{data.customer} · {data.po}</p>
          </div>
          <span className="rounded border border-ds-line/60 px-2 py-0.5 text-xs text-ds-ink-faint">{data.statusLabel}</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <CardSection
          title="Job Summary"
          subtitle="Read-only job details with editable sheet size if missing."
        >
          <div className="grid grid-cols-2 gap-3 text-xs text-ds-ink">
            <div><span className="text-ds-ink-faint">Qty</span><div className="mt-0.5">{data.qty}</div></div>
            <div><span className="text-ds-ink-faint">Size</span><div className="mt-0.5">{data.size}</div></div>
            <div><span className="text-ds-ink-faint">UPS</span><div className="mt-0.5">{data.ups}</div></div>
            <div>
              <label className="text-ds-ink-faint">Sheet size</label>
              <input
                value={data.sheetSize || ''}
                onChange={(e) => data.setSheetSize(e.target.value)}
                disabled={data.isReleased}
                placeholder="L x W mm"
                className="mt-0.5 w-full rounded border border-ds-line bg-ds-main px-2 py-1 text-xs text-ds-ink disabled:opacity-50"
              />
            </div>
          </div>
        </CardSection>

        <CardSection title="Board Readiness">
          <div className="mb-2 text-xs text-ds-ink-faint">{data.boardType} · {data.gsm}</div>
          <span className={`rounded px-2 py-1 text-xs ${data.boardReady ? 'bg-emerald-500/10 text-emerald-300' : data.boardWaiting ? 'bg-ds-warning/10 text-ds-warning' : 'bg-rose-500/10 text-rose-300'}`}>
            {data.boardReady ? 'Ready' : data.boardWaiting ? 'Waiting' : 'Not Ready'}
          </span>
        </CardSection>

        <CardSection title="Tooling Status">
          <div className="space-y-1.5 text-xs text-ds-ink">
            <div>Plate: {data.plate ? 'Linked' : 'Missing'}</div>
            <div>Die: {data.die ? 'Linked' : 'Missing'}</div>
            {data.embossRequired ? <div>Emboss: {data.emboss ? 'Linked' : 'Missing'}</div> : null}
          </div>
        </CardSection>

        <CardSection title="Execution Setup">
          <select
            value={data.machineId}
            onChange={(e) => data.setMachineId(e.target.value)}
            disabled={data.isReleased}
            className="w-full rounded border border-ds-line bg-ds-main px-3 py-2 text-sm text-ds-ink disabled:opacity-50"
          >
            <option value="">Select Machine</option>
            {data.machineOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.machineCode} · {m.name}
              </option>
            ))}
          </select>
        </CardSection>
      </div>

      <div className="flex items-center justify-between border-t border-ds-line px-4 py-3">
        <button onClick={onClose} className="text-sm text-ds-ink-muted">
          Close
        </button>
        <div className="flex gap-2">
          <button onClick={onSave} disabled={data.isReleased} className="rounded border border-ds-line px-3 py-1.5 text-sm text-ds-ink disabled:opacity-40">
            Save Draft
          </button>
          <button
            onClick={onRelease}
            disabled={!isValid || data.isReleased}
            className="rounded bg-ds-brand px-4 py-1.5 text-sm text-white disabled:opacity-40"
          >
            Release to Production
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
        const rawDetail = (await detailRes.json().catch(() => ({}))) as
          | (DrawerPayload & { error?: string })
          | null
        const detail =
          rawDetail && typeof rawDetail === 'object'
            ? rawDetail
            : ({ error: 'Failed to load job card' } as { error: string })
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
