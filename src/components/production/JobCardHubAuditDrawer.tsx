'use client'

import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { CardSection } from '@/components/design-system/CardSection'
import { Button } from '@/components/design-system/Button'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'
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
    return { label: 'Released', cls: 'border-[var(--success)]/40 bg-[var(--success-bg)]/10 text-[var(--success)]' }
  }
  if (status === 'in_progress' || status === 'final_qc') {
    return { label: 'Ready', cls: 'border-[var(--warning)]/40 bg-[var(--warning-bg)]/10 text-[var(--warning)]' }
  }
  return { label: 'Draft', cls: 'border-ds-line/50 bg-ds-main text-ds-ink-muted' }
}

function readinessMeta(ok: boolean | null): { label: string; dot: string; hint: string } {
  if (ok === true) return { label: 'Ready', dot: 'bg-[var(--success-bg)]', hint: 'Board available' }
  if (ok === null) return { label: 'Waiting', dot: 'bg-[var(--warning-bg)]', hint: 'Board in procurement' }
  return { label: 'Not Ready', dot: 'bg-[var(--error-bg)]', hint: 'Board missing' }
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
          | { error?: string }
          | null
        const m = (await machinesRes.json().catch(() => [])) as MachineOpt[]
        if (cancelled) return
        if (!detailRes.ok || !rawDetail || typeof rawDetail !== 'object' || 'error' in rawDetail) {
          setData(null)
          toast.error((rawDetail && typeof rawDetail === 'object' && 'error' in rawDetail && rawDetail.error) || 'Failed to load job card')
          return
        }
        const detail = rawDetail as DrawerPayload
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

  const chip = data ? statusChip(data.status) : { label: '—', cls: '' }
  const isValid = !!effectiveSheet && !!boardOk && toolingProblems.length === 0

  return (
    <GlobalPopoutModal
      isOpen={open}
      onClose={onClose}
      title={data?.poLine?.cartonName ?? `Job Card ${jobCardNumber ?? '—'}`}
      metadata={
        data ? (
          <span className="text-xs text-ds-ink-faint">
            {data.customer?.name ?? '—'} · {data.poLine?.po?.poNumber ?? '—'}
            <span className={clsx('ml-2 rounded border px-1.5 py-0.5 text-[10px]', chip.cls)}>
              {chip.label}
            </span>
          </span>
        ) : undefined
      }
      mode="form"
      size="md"
      zIndexClass="z-[60]"
      footer={
        data ? (
          <div className="flex w-full items-center justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Close</Button>
            <Button
              variant="secondary"
              onClick={() => void save(false)}
              disabled={isReleased || savingDraft}
            >
              {savingDraft ? 'Saving…' : 'Save Draft'}
            </Button>
            <Button
              onClick={() => void save(true)}
              disabled={!isValid || isReleased || releasing}
            >
              {releasing ? 'Releasing…' : 'Release to Production'}
            </Button>
          </div>
        ) : undefined
      }
    >
      {loading && !data ? (
        <p className="text-sm text-ds-ink-faint">Loading job card…</p>
      ) : data ? (
        <div className="space-y-4">
          <CardSection title="Job Summary">
            <p className="mb-2 text-xs text-ds-ink-faint">Read-only job details with editable sheet size if missing.</p>
            <div className="grid grid-cols-2 gap-3 text-xs text-ds-ink">
              <div><span className="text-ds-ink-faint">Qty</span><div className="mt-0.5">{data.poLine?.quantity ?? '—'}</div></div>
              <div><span className="text-ds-ink-faint">Size</span><div className="mt-0.5">{data.poLine?.cartonSize ?? '—'}</div></div>
              <div><span className="text-ds-ink-faint">UPS</span><div className="mt-0.5">{data.productionBible?.ups ?? '—'}</div></div>
              <div>
                <label className="text-ds-ink-faint">Sheet size</label>
                <input
                  value={effectiveSheet ?? ''}
                  onChange={(e) => setSheetSizeOverride(e.target.value)}
                  disabled={isReleased || hasBaseSheet}
                  placeholder="L x W mm"
                  className="mt-0.5 w-full rounded border border-ds-line bg-ds-main px-2 py-1 text-xs text-ds-ink disabled:opacity-50"
                />
              </div>
            </div>
          </CardSection>

          <CardSection title="Board Readiness">
            <div className="mb-2 text-xs text-ds-ink-faint">
              {data.boardMaterial?.ledgerLink?.board ?? '—'} · {data.boardMaterial?.ledgerLink?.gsm != null ? String(data.boardMaterial.ledgerLink.gsm) : '—'}
            </div>
            <span className={`rounded px-2 py-1 text-xs ${boardOk ? 'bg-[var(--success-bg)]/10 text-[var(--success)]' : boardWaiting ? 'bg-ds-warning/10 text-ds-warning' : 'bg-[var(--error-bg)]/10 text-[var(--error)]'}`}>
              {boardOk ? 'Ready' : boardWaiting ? 'Waiting' : 'Not Ready'}
            </span>
          </CardSection>

          <CardSection title="Tooling Status">
            <div className="space-y-1.5 text-xs text-ds-ink">
              <div>Plate: {tooling?.plate ? 'Linked' : 'Missing'}</div>
              <div>Die: {tooling?.die ? 'Linked' : 'Missing'}</div>
              {embossApplicable ? <div>Emboss: {tooling?.emboss ? 'Linked' : 'Missing'}</div> : null}
              {shadeApplicable ? <div>Shade: {tooling?.shade ? 'Linked' : 'Missing'}</div> : null}
            </div>
          </CardSection>

          <CardSection title="Execution Setup">
            <select
              value={machineId}
              onChange={(e) => setMachineId(e.target.value)}
              disabled={isReleased}
              className="w-full rounded border border-ds-line bg-ds-main px-3 py-2 text-sm text-ds-ink disabled:opacity-50"
            >
              <option value="">Select Machine</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.machineCode} · {m.name}
                </option>
              ))}
            </select>
          </CardSection>
        </div>
      ) : null}
    </GlobalPopoutModal>
  )
}
