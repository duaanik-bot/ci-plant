import {
  CUSTODY_AT_VENDOR,
  CUSTODY_HUB_CUSTODY_READY,
  CUSTODY_HUB_ENGRAVING_QUEUE,
  CUSTODY_HUB_TRIAGE,
  CUSTODY_IN_STOCK,
  CUSTODY_ON_FLOOR,
  CUSTODY_PREPARING_FOR_PRODUCTION,
} from '@/lib/inventory-hub-custody'
import { lineNeedsNewTooling, type PoLineScheduleInput } from '@/lib/po-delivery-schedule'
import { dieHubZoneLabelFromCustody } from '@/lib/tooling-hub-zones'

export type PoToolingSignal = 'green' | 'yellow' | 'red'

export type PoLineToolingInput = PoLineScheduleInput & {
  dieMasterId: string
}

export type DieStatusSnapshot = {
  custodyStatus: string
  condition: string
  dyeNumber: number
  location: string | null
  hubStatusFlag?: string | null
}

const GOOD = 'good'

function conditionIsGood(c: string | null | undefined): boolean {
  return (c ?? '').trim().toLowerCase() === GOOD
}

function hubFlagIsMaintenance(flag: string | null | undefined): boolean {
  const f = (flag ?? '').trim().toLowerCase()
  return f.includes('maintenance') || f.includes('poor')
}

/** Yellow: Outside vendor, maintenance / engraving, hub maintenance flag, or not Good on live rack. */
function isPendingCustody(
  status: string,
  conditionOk: boolean,
  hubStatusFlag: string | null | undefined,
): boolean {
  if (status === CUSTODY_AT_VENDOR) return true
  if (status === CUSTODY_HUB_ENGRAVING_QUEUE) return true
  if (hubFlagIsMaintenance(hubStatusFlag)) return true
  if (status === CUSTODY_HUB_TRIAGE) return true
  if (status === CUSTODY_PREPARING_FOR_PRODUCTION) return true
  if (status === CUSTODY_HUB_CUSTODY_READY) return true
  if (status === CUSTODY_ON_FLOOR) return true
  if (status === CUSTODY_IN_STOCK && !conditionOk) return true
  return false
}

export function classifyPoToolingSignal(
  line: PoLineToolingInput,
  die: DieStatusSnapshot | null | undefined,
): PoToolingSignal {
  if (lineNeedsNewTooling(line)) return 'red'
  const id = String(line.dieMasterId ?? '').trim()
  if (!id) return 'red'
  if (!die) return 'red'
  const ok = conditionIsGood(die.condition)
  if (die.custodyStatus === CUSTODY_IN_STOCK && ok) return 'green'
  if (isPendingCustody(die.custodyStatus, ok, die.hubStatusFlag)) return 'yellow'
  return 'yellow'
}

export function toolingSignalTooltip(
  signal: PoToolingSignal,
  die: DieStatusSnapshot | null | undefined,
): string {
  if (signal === 'red') {
    return die
      ? 'Die master linked but tooling is incomplete or product is new — verify die link and hub status.'
      : 'No die master / new product — link tooling in Product Master or Die Hub.'
  }
  const num = die?.dyeNumber != null ? `DYE-${die.dyeNumber}` : '—'
  const zone = die ? dieHubZoneLabelFromCustody(die.custodyStatus) : '—'
  const loc = die?.location?.trim() || ''
  const where = [zone, loc || null].filter(Boolean).join(' · ') || '—'
  return `${num} — ${where}`
}
