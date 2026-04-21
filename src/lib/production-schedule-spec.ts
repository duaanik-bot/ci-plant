import {
  awInProductionBatches,
  currentRunBatches,
  readPartialLedger,
  totalContractBatches,
} from '@/lib/aw-queue-spec'

export type ShiftIndex = 1 | 2 | 3

export function cellKey(machineId: string, shift: ShiftIndex): string {
  return `${machineId}::${shift}`
}

export function parseCellKey(k: string): { machineId: string; shift: ShiftIndex } | null {
  const parts = k.split('::')
  if (parts.length !== 2) return null
  const shift = Number(parts[1])
  if (shift !== 1 && shift !== 2 && shift !== 3) return null
  return { machineId: parts[0], shift: shift as ShiftIndex }
}

export type ProdScheduleSlot = {
  machineId: string
  shift: ShiftIndex
  order: number
}

export type ScheduleHandshake = {
  operatorUserId?: string | null
  targetOeePct?: number | null
  pmWindows?: { start: string; end: string }[]
}

export function readProdScheduleSlot(
  spec: Record<string, unknown> | null | undefined,
): ProdScheduleSlot | null {
  const raw = spec?.prodScheduleSlot
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const machineId = typeof o.machineId === 'string' ? o.machineId.trim() : ''
  const shift = Number(o.shift)
  const order = Number(o.order)
  if (!machineId) return null
  if (shift !== 1 && shift !== 2 && shift !== 3) return null
  if (!Number.isFinite(order) || order < 0) return null
  return { machineId, shift: shift as ShiftIndex, order: Math.floor(order) }
}

export function readScheduleHandshake(
  spec: Record<string, unknown> | null | undefined,
): ScheduleHandshake {
  const raw = spec?.scheduleHandshake
  if (!raw || typeof raw !== 'object') return {}
  const o = raw as Record<string, unknown>
  const operatorUserId =
    typeof o.operatorUserId === 'string' ? o.operatorUserId : o.operatorUserId === null ? null : undefined
  const targetOeePct =
    typeof o.targetOeePct === 'number' && Number.isFinite(o.targetOeePct) ? o.targetOeePct : undefined
  const pmWindows = Array.isArray(o.pmWindows)
    ? o.pmWindows.filter(
        (w): w is { start: string; end: string } =>
          w != null &&
          typeof w === 'object' &&
          typeof (w as { start?: unknown }).start === 'string' &&
          typeof (w as { end?: unknown }).end === 'string',
      )
    : undefined
  return { operatorUserId, targetOeePct, pmWindows }
}

export type BatchSegmentUi = {
  batchId: string
  status: 'done' | 'active' | 'pending'
  completedAtMelbourne?: string | null
}

/**
 * Discrete batch segments for the segmented bar (PO contract batches + AW ledger).
 */
export function batchSegmentsForScheduleBar(
  spec: Record<string, unknown> | null | undefined,
  poNumber: string,
): BatchSegmentUi[] {
  const total = totalContractBatches(spec)
  const done = currentRunBatches(spec)
  const inProg = awInProductionBatches(spec)
  const ledger = readPartialLedger(spec)

  if (total <= 0) {
    return [{ batchId: 'BATCH-—', status: 'pending' }]
  }

  const segments: BatchSegmentUi[] = []
  for (let i = 1; i <= total; i++) {
    const batchId = `B-${poNumber}-${String(i).padStart(2, '0')}`
    let status: BatchSegmentUi['status'] = 'pending'
    if (i <= done) status = 'done'
    else if (i === done + 1 && inProg > 0) status = 'active'
    else status = 'pending'

    let completedAtMelbourne: string | null | undefined
    if (status === 'done') {
      const entry = ledger.find((e) => e.batchCount >= i) ?? ledger[ledger.length - 1]
      if (entry?.at) {
        completedAtMelbourne = formatMelbourneTimestamp(entry.at)
      }
    }
    if (status === 'active') {
      const entry = ledger[ledger.length - 1]
      if (entry?.at) completedAtMelbourne = formatMelbourneTimestamp(entry.at)
    }

    segments.push({ batchId, status, completedAtMelbourne })
  }
  return segments
}

export function formatMelbourneTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Melbourne',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d)
  } catch {
    return iso
  }
}

/** Gap between planned and actual sheet counts; alert when relative gap > threshold (default 15%). */
export function sheetGapExceedsThreshold(args: {
  plannedSheets: number
  actualSheets: number
  thresholdPct?: number
}): boolean {
  const { plannedSheets, actualSheets, thresholdPct = 15 } = args
  if (!Number.isFinite(plannedSheets) || plannedSheets <= 0) return false
  const gap = Math.abs(plannedSheets - actualSheets) / plannedSheets
  return gap * 100 > thresholdPct
}

export function liveActualSheets(args: {
  sheetsIssued: number | null | undefined
  stageCounters: number[]
}): number {
  const issued = args.sheetsIssued ?? 0
  const maxStage = args.stageCounters.length ? Math.max(...args.stageCounters) : 0
  return Math.max(issued, maxStage)
}
