/** Versioned, locked product spec snapshot carried on a PO line. */
export interface SpecPackV1 {
  v: 1
  source: {
    cartonId: string | null
    cartonName: string
    /** ISO-8601 UTC */
    snapshotAt: string
  }
  board: {
    boardGrade: string | null; gsm: number | null; paperType: string | null
    caliperMicrons: number | null; plyCount: number | null
  }
  dimensions: {
    finishedL: number | null; finishedW: number | null; finishedH: number | null
    blankL: number | null; blankW: number | null; dimensionTol: number | null
  }
  sheet: { sheetSizeL: number | null; sheetSizeW: number | null; ups: number | null }
  print: {
    printingType: string | null; numberOfColours: number | null
    backPrint: string | null; artworkCode: string | null
  }
  finishing: {
    coatingType: string | null; laminateType: string | null; foilType: string | null
    embossingLeafing: string | null; spotUv: boolean; braille: boolean
  }
  tooling: { dieMasterId: string | null; pastingStyle: string | null }
  linkage: { shadeCardId: string | null }
  pharma: { drugSchedule: string | null; scheduleMRequired: boolean }
}

export type Decimalish = { toString(): string }

/** Structural input — accepts a Prisma Carton row (Decimal columns included). */
export interface CartonForPack {
  id?: string | null
  cartonName: string
  boardGrade?: string | null
  gsm?: number | null
  paperType?: string | null
  caliperMicrons?: number | null
  plyCount?: number | null
  finishedLength?: Decimalish | number | null
  finishedWidth?: Decimalish | number | null
  finishedHeight?: Decimalish | number | null
  blankLength?: Decimalish | number | null
  blankWidth?: Decimalish | number | null
  dimensionTol?: Decimalish | number | null
  sheetSizeL?: Decimalish | number | null
  sheetSizeW?: Decimalish | number | null
  ups?: number | null
  printingType?: string | null
  numberOfColours?: number | null
  backPrint?: string | null
  artworkCode?: string | null
  coatingType?: string | null
  laminateType?: string | null
  foilType?: string | null
  embossingLeafing?: string | null
  drugSchedule?: string | null
  scheduleMRequired?: boolean | null
  dieMasterId?: string | null
  pastingStyle?: string | null
  shadeCardId?: string | null
  specialInstructions?: string | null
}

function num(v: Decimalish | number | null | undefined): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v.toString())
  return Number.isFinite(n) ? n : null
}

function str(v: string | null | undefined): string | null {
  if (v == null) return null
  const t = String(v).trim()
  return t ? t : null
}

function parseFinishingFlags(raw: string | null | undefined): {
  spotUv: boolean; braille: boolean
} {
  if (!raw) return { spotUv: false, braille: false }
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    return { spotUv: !!o.spotUvEnabled, braille: !!o.brailleEnabled }
  } catch {
    return { spotUv: false, braille: false }
  }
}

/** Pure: Carton row → frozen v1 spec pack. Never throws. */
export function buildCartonSpecPack(c: CartonForPack): SpecPackV1 {
  const flags = parseFinishingFlags(c.specialInstructions)
  return {
    v: 1,
    source: {
      cartonId: c.id ?? null,
      cartonName: c.cartonName,
      snapshotAt: new Date().toISOString(),
    },
    board: {
      boardGrade: str(c.boardGrade),
      gsm: num(c.gsm),
      paperType: str(c.paperType),
      caliperMicrons: num(c.caliperMicrons),
      plyCount: num(c.plyCount),
    },
    dimensions: {
      finishedL: num(c.finishedLength),
      finishedW: num(c.finishedWidth),
      finishedH: num(c.finishedHeight),
      blankL: num(c.blankLength),
      blankW: num(c.blankWidth),
      dimensionTol: num(c.dimensionTol),
    },
    sheet: {
      sheetSizeL: num(c.sheetSizeL),
      sheetSizeW: num(c.sheetSizeW),
      ups: num(c.ups),
    },
    print: {
      printingType: str(c.printingType),
      numberOfColours: num(c.numberOfColours),
      backPrint: str(c.backPrint),
      artworkCode: str(c.artworkCode),
    },
    finishing: {
      coatingType: str(c.coatingType),
      laminateType: str(c.laminateType),
      foilType: str(c.foilType),
      embossingLeafing: str(c.embossingLeafing),
      spotUv: flags.spotUv,
      braille: flags.braille,
    },
    tooling: {
      dieMasterId: c.dieMasterId ?? null,
      pastingStyle: str(c.pastingStyle),
    },
    linkage: { shadeCardId: c.shadeCardId ?? null },
    pharma: {
      drugSchedule: str(c.drugSchedule),
      scheduleMRequired: !!c.scheduleMRequired,
    },
  }
}
