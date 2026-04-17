import type { Carton, Customer, Dye } from '@prisma/client'
import { masterDieTypeLabel } from '@/lib/master-die-type'
import { formatDimsLwhFromDb, parseCartonSizeToDims, formatDimsLwhFromParsed } from '@/lib/die-hub-dimensions'

export type CartonWithCustomerDye = Carton & {
  customer: Customer
  dye: Dye | null
  dieMaster: Dye | null
}

function dec(value: { toString(): string } | null | undefined): number | null {
  if (value == null) return null
  const n = Number(value.toString())
  return Number.isFinite(n) ? n : null
}

function toolingDimsLabel(die: Dye | null): string {
  if (!die) return ''
  const formatted =
    formatDimsLwhFromDb({
      dimLengthMm: die.dimLengthMm,
      dimWidthMm: die.dimWidthMm,
      dimHeightMm: die.dimHeightMm,
    }) ??
    (parseCartonSizeToDims(die.cartonSize)
      ? formatDimsLwhFromParsed(parseCartonSizeToDims(die.cartonSize)!)
      : null)
  return formatted?.trim() || ''
}

/** API shape for Carton Master detail (GET/PUT response). */
export function serializeCarton(row: CartonWithCustomerDye) {
  const dm = row.dieMaster
  const masterLabel = dm
    ? masterDieTypeLabel({ dyeType: dm.dyeType, pastingType: dm.pastingType })
    : ''
  return {
    id: row.id,
    cartonName: row.cartonName,
    customerId: row.customerId,
    customer: { id: row.customer.id, name: row.customer.name },
    productType: row.productType,
    category: row.category,
    rate: dec(row.rate),
    gstPct: row.gstPct,
    active: row.active,
    remarks: row.remarks ?? '',
    printingType: row.printingType ?? '',
    pastingType: row.cartonConstruct ?? '',
    boardGrade: row.boardGrade,
    gsm: row.gsm,
    caliperMicrons: row.caliperMicrons,
    paperType: row.paperType,
    plyCount: row.plyCount,
    finishedLength: dec(row.finishedLength),
    finishedWidth: dec(row.finishedWidth),
    finishedHeight: dec(row.finishedHeight),
    blankLength: dec(row.blankLength),
    blankWidth: dec(row.blankWidth),
    backPrint: row.backPrint,
    artworkCode: row.artworkCode,
    coatingType: row.coatingType,
    foilType: row.foilType,
    embossingLeafing: row.embossingLeafing,
    cartonConstruct: row.cartonConstruct,
    glueType: row.glueType,
    dyeId: row.dyeId,
    dieMasterId: row.dieMasterId,
    masterDieType: masterLabel,
    toolingDimsLabel: toolingDimsLabel(dm),
    drugSchedule: row.drugSchedule,
    regulatoryText: row.regulatoryText,
    specialInstructions: row.specialInstructions ?? '',
    dieMaster:
      dm != null
        ? {
            id: dm.id,
            dyeNumber: dm.dyeNumber,
            dyeType: dm.dyeType,
            pastingType: dm.pastingType,
            masterTypeLabel: masterDieTypeLabel({
              dyeType: dm.dyeType,
              pastingType: dm.pastingType,
            }),
            dimensionsLwh: toolingDimsLabel(dm) || null,
          }
        : null,
    dye: row.dyeId && row.dye
      ? {
          id: row.dye.id,
          dyeNumber: row.dye.dyeNumber,
          sheetSize: row.dye.sheetSize,
          condition: row.dye.condition,
          conditionRating: row.dye.conditionRating,
        }
      : null,
  }
}
