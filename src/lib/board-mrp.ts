/**
 * Board / paper MRP — ERP board engine (industrial convention).
 *
 * Let base sheets = Order Qty / UPS. With wastage % allowance:
 *   Total Sheets = ceil(base × (1 + wastage/100))
 * (Equivalent to applying wastage% on net sheets before rounding up.)
 *
 * Weight (kg) = (Sheet L_mm × Sheet W_mm × GSM × Total Sheets) / 10^9
 */

export type BoardMrpInputs = {
  sheetLengthMm: number
  sheetWidthMm: number
  gsm: number
  ups: number
  customerQty: number
  wastagePct: number
}

export type BoardMrpResult = {
  netSheets: number
  sheetsWithWastage: number
  sheetAreaSqM: number
  weightKg: number
}

export function calculateBoardSheetsAndWeightErp(input: {
  orderQty: number
  ups: number
  wastagePct: number
  lengthMm: number
  widthMm: number
  gsm: number
}): { totalSheets: number; weightKg: number; baseSheets: number } {
  const ups = Math.max(1, Math.floor(input.ups) || 1)
  const baseSheets = input.orderQty / ups
  const wPct = Math.max(0, input.wastagePct)
  const totalSheets = Math.ceil(baseSheets * (1 + wPct / 100))
  const l = Math.max(0, input.lengthMm)
  const wd = Math.max(0, input.widthMm)
  const gsm = Math.max(0, input.gsm)
  const weightKg = (l * wd * gsm * totalSheets) / 1_000_000_000
  return { totalSheets, weightKg, baseSheets }
}

export function calculateBoardRequirement(input: BoardMrpInputs): BoardMrpResult {
  const ups = Math.max(1, Math.floor(input.ups) || 1)
  const gsm = Math.max(1, input.gsm)
  const l = Math.max(0.001, input.sheetLengthMm / 1000)
  const w = Math.max(0.001, input.sheetWidthMm / 1000)
  const sheetAreaSqM = l * w
  const { totalSheets, weightKg, baseSheets } = calculateBoardSheetsAndWeightErp({
    orderQty: input.customerQty,
    ups: input.ups,
    wastagePct: input.wastagePct,
    lengthMm: input.sheetLengthMm,
    widthMm: input.sheetWidthMm,
    gsm,
  })
  const netSheets = Math.ceil(baseSheets)
  return { netSheets, sheetsWithWastage: totalSheets, sheetAreaSqM, weightKg }
}

/**
 * Parse die / master sheet size: values > 200 on max axis treated as mm, else inches → mm.
 */
export function parseSheetSizeToMm(raw: string | null | undefined): { lMm: number; wMm: number } | null {
  if (!raw?.trim()) return null
  const normalized = raw.replace(/x/gi, '×').trim()
  const parts = normalized.split('×').map((s) => parseFloat(s.trim()))
  if (parts.length < 2 || !parts.every((n) => Number.isFinite(n) && n > 0)) return null
  const [a, b] = parts
  const maxDim = Math.max(a, b)
  const inchToMm = 25.4
  const asMm = maxDim > 200 ? 1 : inchToMm
  return { lMm: a * asMm, wMm: b * asMm }
}

export function kgToMetricTons(kg: number): number {
  return kg / 1000
}
