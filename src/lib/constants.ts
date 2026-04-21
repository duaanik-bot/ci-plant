import {
  DYE_TYPE_NEW,
  DYE_TYPES_WITH_NEW,
  MASTER_BOARD_GRADES,
  MASTER_CARTON_STRUCTURAL_STYLES,
  MASTER_COATINGS_AND_VARNISHES,
  MASTER_EMBOSSING_AND_LEAFING,
  MASTER_FOIL_STAMPS,
} from '@/lib/master-enums'

export type { MasterBoardGrade, MasterCoating, MasterEmbossing, MasterCartonStyle } from '@/lib/master-enums'

/** @deprecated Import from `@/lib/master-enums` — folding carton board grades (aligned with inventory / gang-print). */
export const PAPER_TYPES = [...MASTER_BOARD_GRADES]

/** @deprecated Import from `@/lib/master-enums` — same canonical set as `PAPER_TYPES`. */
export const BOARD_GRADES = [...MASTER_BOARD_GRADES]

export const COATING_TYPES = [...MASTER_COATINGS_AND_VARNISHES]

export const EMBOSSING_TYPES = [...MASTER_EMBOSSING_AND_LEAFING]

/** Die / structural style + `NEW` for tooling workflow. */
export const DYE_TYPES = [...DYE_TYPES_WITH_NEW]

export {
  DYE_TYPE_NEW,
  MASTER_BOARD_GRADES,
  MASTER_CARTON_STRUCTURAL_STYLES,
  MASTER_COATINGS_AND_VARNISHES,
  MASTER_EMBOSSING_AND_LEAFING,
}

export const INK_COLORS = ['CMYK', 'CMYKP', 'CMYKB', 'PANTONE', 'Color', 'Black only']

export const PRINTING_TYPES = [
  'Offset',
  'Digital',
  'Flexo',
  'Screen',
  'Gravure',
]

/** @deprecated Prefer Product Master `pastingStyle` (Lock Bottom, BSO, Special). */
export const PASTING_TYPES = ['Lock Bottom', 'BSO', 'Special']

/** @deprecated Use `MASTER_CARTON_STRUCTURAL_STYLES` for new work; kept for legacy labels. */
export const CARTON_CONSTRUCTIONS = ['Lock Bottom', 'BSO', 'Special']

export const GLUE_TYPES = ['Hot Melt', 'Cold Glue', 'PVA', 'EVA', 'None']

export const LAMINATE_TYPES = ['BOPP Gloss', 'BOPP Matte', 'BOPP Soft Touch', 'PET', 'Nylon', 'None']

/** Narrow foil picks — prefer `MASTER_EMBOSSING_AND_LEAFING` on PO lines when consolidating. */
export const FOIL_TYPES = [...MASTER_FOIL_STAMPS]

export const DRUG_SCHEDULES = [
  'Schedule H',
  'Schedule H1',
  'Schedule X',
  'Schedule G',
  'OTC',
  'Export',
  'N/A',
]

export const BARCODE_TYPES = ['EAN-13', 'ITF-14', 'QR', 'Datamatrix', 'Code128', 'None']

export const AQL_LEVELS = ['0.65', '1.0', '1.5', '2.5', '4.0']

// 10 production stages: 1–8 + Sorting (9) + Pasting (10). Stages 3–7 are conditional (post-press routing).
export const PRODUCTION_STAGES = [
  { key: 'cutting', label: 'Cutting', stageNo: 1 },
  { key: 'printing', label: 'Printing', stageNo: 2 },
  { key: 'chemical_coating', label: 'Chemical Coating', stageNo: 3 },
  { key: 'lamination', label: 'Lamination', stageNo: 4 },
  { key: 'spot_uv', label: 'Spot UV', stageNo: 5 },
  { key: 'leafing', label: 'Leafing/Foiling', stageNo: 6 },
  { key: 'embossing', label: 'Embossing', stageNo: 7 },
  { key: 'dye_cutting', label: 'Dye Cutting', stageNo: 8 },
  { key: 'sorting', label: 'Sorting', stageNo: 9 },
  { key: 'pasting', label: 'Pasting', stageNo: 10 },
]

// Sorting stage rejection reasons (NCR / wastage)
export const SORTING_REJECTION_REASONS = [
  'Misprint',
  'Die-cut error',
  'Lamination defect',
  'Foil misregister',
  'Crease break',
  'Surface damage',
  'Other',
] as const

export const QC_INSTRUMENTS = [
  'SpectroDesitometer',
  'Digital Micrometer',
  'GSM Tester',
  'Gloss Meter',
  'Bursting Strength Tester',
  'Vernier Caliper',
  'Magnifying Glass 10×',
  'Microscope 50×',
  'Pantone Shade Book',
  'Crease & Bend Tester',
  'Digital Scale',
  'Blue Wash Solution',
]

export const GSM_CALIPER_MAP: Record<number, number> = {
  250: 280,
  270: 300,
  300: 340,
  320: 360,
  350: 390,
  380: 420,
  400: 450,
}
