/**
 * Maps real plant vocabulary (from the Carton Master Bible Excel) onto the
 * app's canonical dropdown vocabularies in src/lib/master-enums.ts, so the
 * imported data renders in Board Grade / Coating Spec / Printing Type selects
 * (and stays consistent across Planning / PO / AW Queue).
 *
 * Unknown values are preserved verbatim (data is never lost); null passes
 * through.
 */

const BOARD_GRADE_MAP: Record<string, string> = {
  FBB: 'FBB (Folding Box Board)',
  'FBB COATED': 'FBB (Folding Box Board)',
  SAFFIRE: 'SBS (Solid Bleached Sulphate)',
  DUPLEX: 'Duplex Board (Grey Back)',
}

export function canonicalBoardGrade(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null
  const v = String(raw).trim()
  if (!v) return null
  return BOARD_GRADE_MAP[v.toUpperCase()] ?? v
}

const COATING_MAP: Record<string, string> = {
  'AQUEOUS VARNISH': 'Aqueous Varnish (Gloss)',
  'MATT VARNISH': 'Aqueous Varnish (Matte)',
  'FULL UV': 'Full UV Coating',
  'DRIP OFF': 'Drip-Off Coating',
  'DRIP OFF + UV': 'Drip-Off Coating',
  'DRIP OFF + METALLIC': 'Drip-Off Coating',
  PLAIN: 'None',
  'GLOSS LAMINATION': 'Thermal Lamination (Gloss)',
  'MATT LAMINATION': 'Thermal Lamination (Matte)',
}

export function canonicalCoating(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null
  const v = String(raw).trim()
  if (!v) return null
  return COATING_MAP[v.toUpperCase().replace(/\s+/g, ' ')] ?? v
}

export function canonicalPrintingType(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null
  const v = String(raw).trim()
  if (!v) return null
  if (v.toUpperCase().includes('METALLIC')) return 'Metallic'
  // COLOUR / DARBI / PURE FLIX are firm/category labels (kept in `category`);
  // the cartons themselves are offset-printed.
  return 'Offset'
}
