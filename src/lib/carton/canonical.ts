/**
 * Maps real plant vocabulary (from the Carton Master Bible Excel) onto the
 * app's canonical dropdown vocabularies in src/lib/master-enums.ts, so the
 * imported data renders in Board Grade / Coating Spec / Printing Type selects
 * (and stays consistent across Planning / PO / AW Queue).
 *
 * Unknown values are preserved verbatim (data is never lost); null passes
 * through.
 */

/**
 * Maps Bible board terms (Saffire/FBB/Duplex/FBB coated) AND legacy
 * paper-type labels (SBS / GD2 Grey Back / Art Card / Kraft) onto the
 * canonical MASTER_BOARD_GRADES. Substring/keyword based so variants like
 * "DARBI ART CARD" or "COLOUR WHITE BACK" still resolve. Unknown values are
 * preserved verbatim; null passes through.
 */
export function canonicalBoardGrade(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null
  const v = String(raw).trim()
  if (!v) return null
  const u = v.toUpperCase().replace(/\s+/g, ' ')
  if (u.includes('FBB')) return 'FBB'
  if (u.includes('SAFFIRE') || u.includes('SBS')) return 'Saffire'
  if (u.includes('ART CARD')) return 'FBB'
  if (u.includes('WHITE BACK') || u === 'WB') return 'Duplex WB'
  if (u.includes('GREY BACK') || u.includes('GD2') || u.includes('DUPLEX'))
    return 'Duplex GB'
  if (u.includes('KRAFT')) return 'Kraft Board'
  if (u.includes('METPET') || u.includes('MET PET')) return 'MetPET Board'
  return v
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
