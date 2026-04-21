import { addMonths, differenceInDays } from 'date-fns'
import { isEmbossingRequired } from '@/lib/emboss-conditions'

export type InterlockKey = 'pl' | 'di' | 'eb' | 'sc'

/** Planning queue 5-icon strip: AW · PA · DI · EB · SC */
export type ReadinessFiveKey = 'aw' | 'pa' | 'di' | 'eb' | 'sc'

export type ReadinessFiveState = 'ready' | 'blocked' | 'neutral'

export type ReadinessFiveSegment = {
  key: ReadinessFiveKey
  abbr: string
  state: ReadinessFiveState
  title: string
  /** User-facing blocker name for tooltips, e.g. "Artwork QA" */
  blockerName: string
}

export type InterlockSegment = {
  key: InterlockKey
  label: string
  ok: boolean
  na?: boolean
  hint?: string
}

export type MaterialGateStatus = 'unknown' | 'available' | 'ordered' | 'shortage'

export type MaterialGate = {
  status: MaterialGateStatus
  requiredSheets: number | null
  netAvailable: number | null
  procurementStatus: string
}

const ORDERED_PROC_STATUSES = new Set(['on_order', 'dispatched', 'paper_ordered'])

type InvRow = {
  materialCode: string
  description: string | null
  qtyAvailable: unknown
  qtyReserved: unknown
}

export function netBoardStockForQueue(inv: InvRow[], boardType: string, gsm: number): number {
  const gsmStr = String(gsm)
  const tokens = boardType
    .toLowerCase()
    .split(/[\s/,-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2)

  return inv.reduce((sum, row) => {
    const hay = `${row.materialCode} ${row.description ?? ''}`.toLowerCase()
    if (!hay.includes(gsmStr)) return sum
    const boardHit =
      tokens.length === 0 ? hay.length > 0 : tokens.some((t) => hay.includes(t.toLowerCase()))
    if (!boardHit) return sum
    const qa = Number(row.qtyAvailable)
    return sum + (Number.isFinite(qa) ? qa : 0)
  }, 0)
}

export function computeMaterialGate(args: {
  materialQueue: { totalSheets: number; boardType: string; gsm: number } | null
  materialProcurementStatus: string
  inventoryRows: InvRow[]
}): MaterialGate {
  const proc = (args.materialProcurementStatus ?? '').trim().toLowerCase()
  if (!args.materialQueue) {
    return {
      status: 'unknown',
      requiredSheets: null,
      netAvailable: null,
      procurementStatus: proc,
    }
  }
  const required = args.materialQueue.totalSheets
  const net = netBoardStockForQueue(
    args.inventoryRows,
    args.materialQueue.boardType,
    args.materialQueue.gsm,
  )
  if (net >= required) {
    return { status: 'available', requiredSheets: required, netAvailable: net, procurementStatus: proc }
  }
  if (ORDERED_PROC_STATUSES.has(proc)) {
    return { status: 'ordered', requiredSheets: required, netAvailable: net, procurementStatus: proc }
  }
  return { status: 'shortage', requiredSheets: required, netAvailable: net, procurementStatus: proc }
}

export function computeToolingInterlock(args: {
  platesStatus: string
  dieStatus: string
  embossingLeafing: string | null | undefined
  embossStatus: string
  shadeCardId: string | null | undefined
  shadeCard: {
    custodyStatus: string
    mfgDate: Date | null
    approvalDate: Date | null
    createdAt: Date
    isActive: boolean
  } | null
}): { segments: InterlockSegment[]; allReady: boolean } {
  const plOk = args.platesStatus === 'available'
  const diOk = args.dieStatus === 'good'
  const embossReq = isEmbossingRequired(args.embossingLeafing)
  const ebOk = !embossReq || args.embossStatus === 'ready'

  let scOk = true
  let scNa = false
  let scHint: string | undefined

  if (!args.shadeCardId) {
    scNa = true
    scHint = 'N/A'
  } else if (!args.shadeCard) {
    scOk = false
    scHint = 'Missing card'
  } else if (!args.shadeCard.isActive) {
    scOk = false
    scHint = 'Inactive'
  } else {
    const inStock = args.shadeCard.custodyStatus.trim().toLowerCase() === 'in_stock'
    const ref = args.shadeCard.mfgDate ?? args.shadeCard.approvalDate ?? args.shadeCard.createdAt
    const ageMonths = monthsBetweenStart(ref, new Date())
    if (!inStock) {
      scOk = false
      scHint = args.shadeCard.custodyStatus
    } else if (ageMonths >= 12) {
      scOk = false
      scHint = `${ageMonths} mo`
    } else {
      scHint = 'OK'
    }
  }

  const segments: InterlockSegment[] = [
    {
      key: 'pl',
      label: 'PL',
      ok: plOk,
      hint: plOk ? 'Plates ready' : 'Plates',
    },
    {
      key: 'di',
      label: 'DI',
      ok: diOk,
      hint: diOk ? 'Die ready' : 'Die',
    },
    {
      key: 'eb',
      label: 'EB',
      ok: ebOk,
      na: !embossReq,
      hint: !embossReq ? 'N/A' : ebOk ? 'Block ready' : 'Block',
    },
    {
      key: 'sc',
      label: 'SC',
      ok: scOk || scNa,
      na: scNa,
      hint: scHint,
    },
  ]

  const allReady = segments.every((s) => s.ok)
  return { segments, allReady }
}

function monthsBetweenStart(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), 1)
  const b = new Date(to.getFullYear(), to.getMonth(), 1)
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())
}

function shadeCardInStockNormalized(status: string): boolean {
  const s = status.trim().toLowerCase().replace(/-/g, '_')
  return s === 'in_stock' || s === 'in stock'
}

/**
 * 5-point readiness cluster for planning UI + job-card gate.
 * - AW: QA OK = artwork gates 2/2 (AW queue sign-off).
 * - Plates / prepress: must be `available` for job-card eligibility (gate only; see allGreen).
 * - PA: board net stock ≥ MRP required sheets.
 * - DI / EB: asset status Ready (`good` / `ready` in spec).
 * - SC: in stock & card age &lt; 12 months.
 */
export function computeFivePointReadiness(args: {
  artworkLocksCompleted: number
  platesStatus: string
  materialGate: MaterialGate
  dieStatus: string
  embossingLeafing: string | null | undefined
  embossStatus: string
  shadeCardId: string | null | undefined
  shadeCard: {
    custodyStatus: string
    mfgDate: Date | null
    approvalDate: Date | null
    createdAt: Date
    isActive: boolean
  } | null
}): { segments: ReadinessFiveSegment[]; allGreen: boolean } {
  const locks = args.artworkLocksCompleted
  let awState: ReadinessFiveState
  let awTitle: string
  if (locks >= 2) {
    awState = 'ready'
    awTitle = 'QA OK · artwork 2/2'
  } else {
    awState = 'blocked'
    awTitle = `QA pending · artwork ${locks}/2`
  }

  const mg = args.materialGate
  let paState: ReadinessFiveState
  let paTitle: string
  if (mg.requiredSheets == null || mg.netAvailable == null) {
    paState = 'neutral'
    paTitle = 'Paper / board — MRP not linked'
  } else if (mg.netAvailable >= mg.requiredSheets) {
    paState = 'ready'
    paTitle = `Stock available · Net ${mg.netAvailable} ≥ Req ${mg.requiredSheets}`
  } else if (mg.status === 'ordered') {
    paState = 'blocked'
    paTitle = `On order — Net ${mg.netAvailable} < Req ${mg.requiredSheets}`
  } else {
    paState = 'blocked'
    paTitle = `Shortage — Net ${mg.netAvailable} < Req ${mg.requiredSheets}`
  }

  const diOk = args.dieStatus === 'good'
  const embossReq = isEmbossingRequired(args.embossingLeafing)
  const ebOk = !embossReq || args.embossStatus === 'ready'

  let scState: ReadinessFiveState
  let scTitle: string
  if (!args.shadeCardId) {
    scState = 'ready'
    scTitle = 'Shade card N/A'
  } else if (!args.shadeCard) {
    scState = 'blocked'
    scTitle = 'Shade card missing'
  } else if (!args.shadeCard.isActive) {
    scState = 'blocked'
    scTitle = 'Shade card inactive'
  } else {
    const inStock = shadeCardInStockNormalized(args.shadeCard.custodyStatus)
    const ref = args.shadeCard.mfgDate ?? args.shadeCard.approvalDate ?? args.shadeCard.createdAt
    const ageMonths = monthsBetweenStart(ref, new Date())
    if (!inStock) {
      scState = 'blocked'
      scTitle = `Shade card not in stock · ${args.shadeCard.custodyStatus}`
    } else if (ageMonths >= 12) {
      scState = 'blocked'
      const expiry = addMonths(ref, 12)
      const daysPast = Math.max(0, differenceInDays(new Date(), expiry))
      scTitle =
        daysPast > 0
          ? `Shade card expired ${daysPast} day(s) past 12‑month validity`
          : `Shade card aged ${ageMonths} mo (max 12)`
    } else {
      scState = 'ready'
      scTitle = 'Shade card in stock · age < 12 mo'
    }
  }

  const segments: ReadinessFiveSegment[] = [
    {
      key: 'aw',
      abbr: 'AW',
      state: awState,
      title: awTitle,
      blockerName: 'Artwork QA',
    },
    {
      key: 'pa',
      abbr: 'PA',
      state: paState,
      title: paTitle,
      blockerName: 'Paper / board',
    },
    {
      key: 'di',
      abbr: 'DI',
      state: diOk ? 'ready' : 'blocked',
      title: diOk
        ? 'Die asset ready (hub)'
        : `Die asset not ready — status: ${args.dieStatus}`,
      blockerName: 'Die',
    },
    {
      key: 'eb',
      abbr: 'EB',
      state: !embossReq ? 'neutral' : ebOk ? 'ready' : 'blocked',
      title: !embossReq
        ? 'Emboss N/A'
        : ebOk
          ? 'Emboss block ready'
          : `Emboss block not ready — status: ${args.embossStatus}`,
      blockerName: 'Emboss block',
    },
    {
      key: 'sc',
      abbr: 'SC',
      state: scState,
      title: scTitle,
      blockerName: 'Shade card',
    },
  ]

  /** EB may be neutral (emboss N/A). PA neutral = gate closed. Plates must be available for JC. */
  const fiveMet = segments.every(
    (s) => s.state === 'ready' || (s.state === 'neutral' && s.key === 'eb'),
  )
  const platesOk = args.platesStatus === 'available'
  const allGreen = fiveMet && platesOk
  return { segments, allGreen }
}

export function firstFivePointBlockerName(
  segments: ReadinessFiveSegment[],
  platesStatus?: string,
): string | null {
  const ps = platesStatus != null ? String(platesStatus) : null
  if (ps != null && ps !== '' && ps !== 'available') {
    return 'Plates / prepress'
  }
  const order: ReadinessFiveKey[] = ['aw', 'pa', 'di', 'eb', 'sc']
  for (const k of order) {
    const s = segments.find((x) => x.key === k)
    if (!s) continue
    if (s.state === 'ready') continue
    if (s.state === 'neutral' && s.key === 'eb') continue
    return s.blockerName
  }
  return null
}

export function suggestMachineId(
  machines: { id: string; machineCode: string }[],
  numberOfColours: number | null | undefined,
): string | null {
  if (!machines.length) return null
  const n = numberOfColours ?? 4
  if (n >= 6) {
    const m = machines.find((x) => /02|03/.test(x.machineCode))
    if (m) return m.id
  }
  return machines[0]?.id ?? null
}

export function estimateDurationHours(requiredSheets: number | null, machineStdWastePct: number | null): number {
  const base = requiredSheets && requiredSheets > 0 ? requiredSheets : 1000
  const eff = 3500 * (1 + (machineStdWastePct ?? 5) / 100)
  return Math.max(0.25, Math.round((base / eff) * 8 * 10) / 10)
}
