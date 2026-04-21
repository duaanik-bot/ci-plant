/**
 * Central packaging terminology for Planning, AW Queue, PO lines, and inventory alignment.
 * All dropdowns should use these lists; extend here — not ad-hoc free text in production UIs.
 */

export const MASTER_BOARD_GRADES = [
  'FBB (Folding Box Board)',
  'SBS (Solid Bleached Sulphate)',
  'Duplex Board (Grey Back)',
  'White Back Board',
  'MetPET Board',
  'Kraft Board',
] as const

export const MASTER_COATINGS_AND_VARNISHES = [
  'None',
  'Aqueous Varnish (Gloss)',
  'Aqueous Varnish (Matte)',
  'Thermal Lamination (Gloss)',
  'Thermal Lamination (Matte)',
  'Spot UV',
  'Full UV Coating',
  'Drip-Off Coating',
  'Blister Coating',
] as const

export const MASTER_EMBOSSING_AND_LEAFING = [
  'None',
  'Blind Embossing',
  'Debossing',
  'Braille Embossing',
  'Gold Foil Stamping',
  'Silver Foil Stamping',
  'Holographic Foil',
] as const

export const MASTER_CARTON_STRUCTURAL_STYLES = [
  'Reverse Tuck End (RTE)',
  'Straight Tuck End (STE)',
  'Crash Lock Bottom (CLB)',
  'Snap Lock / 1-2-3 Bottom',
  'Sleeve & Tray',
  'Window Patching',
] as const

/** New / unspecified die — kept for tooling workflow, not a structural style. */
export const DYE_TYPE_NEW = 'NEW' as const

export const DYE_TYPES_WITH_NEW = [...MASTER_CARTON_STRUCTURAL_STYLES, DYE_TYPE_NEW] as const

/** Foils as a narrow pick when a separate column is still used (QC / legacy). */
export const MASTER_FOIL_STAMPS = [
  'None',
  'Gold Foil Stamping',
  'Silver Foil Stamping',
  'Holographic Foil',
] as const

export type MasterBoardGrade = (typeof MASTER_BOARD_GRADES)[number]
export type MasterCoating = (typeof MASTER_COATINGS_AND_VARNISHES)[number]
export type MasterEmbossing = (typeof MASTER_EMBOSSING_AND_LEAFING)[number]
export type MasterCartonStyle = (typeof MASTER_CARTON_STRUCTURAL_STYLES)[number]

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

function buildLookup(map: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>()
  for (const [k, v] of Object.entries(map)) {
    m.set(norm(k), v)
  }
  return m
}

/** Legacy free-text → canonical master string (best effort). */
const LEGACY_BOARD = buildLookup({
  'colour white': 'FBB (Folding Box Board)',
  'colour gb': 'Duplex Board (Grey Back)',
  'colour wb': 'White Back Board',
  'colour yellow': 'FBB (Folding Box Board)',
  'colour art card': 'FBB (Folding Box Board)',
  'colour cromo': 'FBB (Folding Box Board)',
  'colour metpet': 'MetPET Board',
  'darbi wb': 'White Back Board',
  'darbi white': 'FBB (Folding Box Board)',
  'darbi yellow': 'FBB (Folding Box Board)',
  'darbi gb': 'Duplex Board (Grey Back)',
  'darbi art card': 'FBB (Folding Box Board)',
  'darbi cromo': 'FBB (Folding Box Board)',
  'darbi gumsheet': 'Kraft Board',
  'fbb coated': 'FBB (Folding Box Board)',
  'fbb plain': 'FBB (Folding Box Board)',
  'cup stock': 'FBB (Folding Box Board)',
  'wb plain': 'White Back Board',
  'gb plain': 'Duplex Board (Grey Back)',
  sbs: 'SBS (Solid Bleached Sulphate)',
  fbb: 'FBB (Folding Box Board)',
  duplex: 'Duplex Board (Grey Back)',
  'art card': 'FBB (Folding Box Board)',
  kraft: 'Kraft Board',
  metpet: 'MetPET Board',
  'metpet board': 'MetPET Board',
  saffire: 'SBS (Solid Bleached Sulphate)',
  'wb duplex': 'White Back Board',
  'gb duples': 'Duplex Board (Grey Back)',
  cfbb: 'FBB (Folding Box Board)',
  artcard: 'FBB (Folding Box Board)',
  maplitho: 'FBB (Folding Box Board)',
})

const LEGACY_COATING = buildLookup({
  none: 'None',
  'aqueous varnish': 'Aqueous Varnish (Gloss)',
  'full uv': 'Full UV Coating',
  'full uv coating': 'Full UV Coating',
  'drip off': 'Drip-Off Coating',
  'drip off + uv': 'Drip-Off Coating',
  'chemical coating': 'Blister Coating',
  'spot uv': 'Spot UV',
})

const LEGACY_EMBOSS = buildLookup({
  none: 'None',
  embossing: 'Blind Embossing',
  leafing: 'Gold Foil Stamping',
  'embossing + leafing': 'Blind Embossing',
  'hot gold': 'Gold Foil Stamping',
  'hot silver': 'Silver Foil Stamping',
  cold: 'Gold Foil Stamping',
  holographic: 'Holographic Foil',
})

const LEGACY_CARTON_STYLE = buildLookup({
  bso: 'Straight Tuck End (STE)',
  lockbottom: 'Crash Lock Bottom (CLB)',
  '4/lockbottom': 'Crash Lock Bottom (CLB)',
  '3/lockbottom': 'Crash Lock Bottom (CLB)',
  '2/lockbottom': 'Crash Lock Bottom (CLB)',
  crashlock: 'Crash Lock Bottom (CLB)',
  straight: 'Straight Tuck End (STE)',
  'reverse tuck': 'Reverse Tuck End (RTE)',
  rte: 'Reverse Tuck End (RTE)',
  ste: 'Straight Tuck End (STE)',
  clb: 'Crash Lock Bottom (CLB)',
})

export function normalizeToMasterBoard(raw: string | null | undefined): string | null {
  if (raw == null || !String(raw).trim()) return null
  const t = norm(raw)
  if ((MASTER_BOARD_GRADES as readonly string[]).includes(raw.trim())) return raw.trim()
  return LEGACY_BOARD.get(t) ?? null
}

export function normalizeToMasterCoating(raw: string | null | undefined): string | null {
  if (raw == null || !String(raw).trim()) return null
  const trimmed = raw.trim()
  if ((MASTER_COATINGS_AND_VARNISHES as readonly string[]).includes(trimmed)) return trimmed
  return LEGACY_COATING.get(norm(raw)) ?? null
}

export function normalizeToMasterEmbossing(raw: string | null | undefined): string | null {
  if (raw == null || !String(raw).trim()) return null
  const trimmed = raw.trim()
  if ((MASTER_EMBOSSING_AND_LEAFING as readonly string[]).includes(trimmed)) return trimmed
  return LEGACY_EMBOSS.get(norm(raw)) ?? null
}

export function normalizeToMasterCartonStyle(raw: string | null | undefined): string | null {
  if (raw == null || !String(raw).trim()) return null
  const trimmed = raw.trim()
  if (trimmed === DYE_TYPE_NEW) return DYE_TYPE_NEW
  if ((MASTER_CARTON_STRUCTURAL_STYLES as readonly string[]).includes(trimmed)) return trimmed
  return LEGACY_CARTON_STYLE.get(norm(raw)) ?? null
}

/** If value is not in master list, return it as a single extra option (read legacy rows until edited). */
export function withLegacyOption<T extends string>(
  masterList: readonly T[],
  value: string | null | undefined,
): T[] | string[] {
  const v = value?.trim()
  if (!v) return [...masterList] as T[]
  const inMaster = (masterList as readonly string[]).includes(v)
  if (inMaster) return [...masterList] as T[]
  return [...masterList, v] as string[]
}
