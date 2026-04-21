/**
 * Predictive helpers for Planning: BPI, make-ready sheets, what-if priority copy.
 * Figures are planning estimates — tune constants with finance.
 */

const PLATE_MAKE_READY_INR = 14_000
const PER_COLOUR_PLATE_INR = 3_200
const SPECIAL_COATING_SURCHARGE_INR = 12_000
/** Assumed share of line revenue treated as contribution for short-run comparison */
const CONTRIBUTION_RATE = 0.2

export type BpiLabel = 'optimal' | 'loss-leader'

export type BatchProfitabilityResult = {
  label: BpiLabel
  setupCostInr: number
  grossMarginInr: number
  tooltip: string
}

/** Heuristic for UV / specialty finishes that add plate + sheet overhead. */
export function hasSpecialCoatingForPlanning(
  coatingType: string | null | undefined,
  otherCoating: string | null | undefined,
): boolean {
  const c = `${coatingType ?? ''} ${otherCoating ?? ''}`.toLowerCase()
  if (!c.trim()) return false
  return /uv|metpet|metal|foil|special|aqueous|soft.?touch|spot|varnish|laminate|thermal|blister|drip/i.test(
    c,
  )
}

/**
 * Est. setup = plates + make-ready (INR). Margin = contribution on line revenue.
 */
export function computeBatchProfitabilityIndex(args: {
  quantity: number
  ratePerUnitInr: number | null | undefined
  numberOfColours: number
  coatingType?: string | null
  otherCoating?: string | null
}): BatchProfitabilityResult | null {
  const rate = args.ratePerUnitInr
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return null

  const revenue = args.quantity * rate
  const grossMarginInr = Math.round(revenue * CONTRIBUTION_RATE)
  const colours = Math.max(1, Math.min(8, Math.floor(args.numberOfColours || 4)))
  const special = hasSpecialCoatingForPlanning(args.coatingType, args.otherCoating)
  const setupCostInr =
    PLATE_MAKE_READY_INR + colours * PER_COLOUR_PLATE_INR + (special ? SPECIAL_COATING_SURCHARGE_INR : 0)

  const label: BpiLabel =
    grossMarginInr > setupCostInr * 1.15 ? 'optimal' : setupCostInr > grossMarginInr ? 'loss-leader' : 'optimal'

  const tooltip = `Est. Setup Cost: ₹${setupCostInr.toLocaleString('en-IN')} | Margin: ₹${grossMarginInr.toLocaleString('en-IN')}. Recommend grouping with Mix-Set.`

  return { label, setupCostInr, grossMarginInr, tooltip }
}

export type MakeReadySheetsBreakdown = {
  totalSheets: number
  base: number
  colourComponent: number
  coatingComponent: number
  detail: string
}

const BASE_MAKE_READY = 50
const PER_COLOUR_SHEETS = 20
const SPECIAL_COATING_SHEETS = 30

export function computeMakeReadySheetsBreakdown(args: {
  numberOfColours: number
  hasSpecialCoating: boolean
}): MakeReadySheetsBreakdown {
  const colours = Math.max(1, Math.min(8, Math.floor(args.numberOfColours || 4)))
  const colourComponent = colours * PER_COLOUR_SHEETS
  const coatingComponent = args.hasSpecialCoating ? SPECIAL_COATING_SHEETS : 0
  const totalSheets = BASE_MAKE_READY + colourComponent + coatingComponent
  const detail = `${BASE_MAKE_READY} base + (${colours} colours × ${PER_COLOUR_SHEETS})${args.hasSpecialCoating ? ` + (${SPECIAL_COATING_SHEETS} special coating)` : ''}`
  return {
    totalSheets,
    base: BASE_MAKE_READY,
    colourComponent,
    coatingComponent,
    detail,
  }
}

export function formatWhatIfPriorityMessage(args: {
  linePoNumber: string
  currentPriorityLines: number
  bpi: BatchProfitabilityResult | null
}): string {
  const bpiHint = args.bpi
    ? args.bpi.label === 'loss-leader'
      ? 'Priority would increase shop attention; BPI still flags Loss-Leader — consider Mix-Set.'
      : 'Priority would increase sequencing weight; BPI looks healthy for batching.'
    : 'Priority would increase sequencing weight (add rate for BPI).'
  return `Simulated: Director priority for ${args.linePoNumber} would rank ahead of ~${Math.min(args.currentPriorityLines + 1, 12)} concurrent jobs. ${bpiHint}`
}
