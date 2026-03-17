export const PAPER_TYPES = [
  'COLOUR WHITE',
  'COLOUR YELLOW',
  'COLOUR GB',
  'COLOUR WB',
  'COLOUR ART CARD',
  'COLOUR CROMO',
  'COLOUR METPET',
  'DARBI WB',
  'DARBI WHITE',
  'DARBI YELLOW',
  'DARBI GB',
  'DARBI ART CARD',
  'DARBI CROMO',
  'DARBI GUMSHEET',
  'FBB COATED',
  'FBB PLAIN',
  'CUP STOCK',
  'WB PLAIN',
  'GB PLAIN',
]

export const COATING_TYPES = [
  'None',
  'Aqueous Varnish',
  'Full UV',
  'Drip off',
  'Drip off + UV',
  'Chemical Coating',
]

export const EMBOSSING_TYPES = [
  'None',
  'Embossing',
  'Leafing',
  'Embossing + Leafing',
]

export const DYE_TYPES = [
  'BSO',
  'lockbottom',
  '4/lockbottom',
  '3/lockbottom',
  '2/lockbottom',
  'crashlock',
  'straight',
  'NEW',
]

export const INK_COLORS = ['CMYK', 'CMYKP', 'CMYKB', 'PANTONE', 'Color', 'Black only']

export const BOARD_GRADES = ['SBS', 'FBB', 'Duplex', 'Art Card', 'Kraft', 'Metpet', 'Cup Stock']

export const CARTON_CONSTRUCTIONS = [
  'Straight Tuck End',
  'Reverse Tuck End',
  'Lock Bottom',
  'Crash Lock',
  'Seal End',
  'Tuck Top Snap Lock',
  'Auto Bottom',
]

export const GLUE_TYPES = ['Hot Melt', 'Cold Glue', 'PVA', 'EVA', 'None']

export const LAMINATE_TYPES = ['BOPP Gloss', 'BOPP Matte', 'BOPP Soft Touch', 'PET', 'Nylon', 'None']

export const FOIL_TYPES = ['Hot Gold', 'Hot Silver', 'Cold Gold', 'Cold Silver', 'Holographic', 'None']

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

