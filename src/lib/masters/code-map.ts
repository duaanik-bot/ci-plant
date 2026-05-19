// Stable machine code from any human label. Uppercase, snake-cased,
// punctuation stripped. Used by the migration backfill, the seeder,
// and the admin UI's auto-suggest.
export function normalizeCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

// Legacy free-text values currently stored in record fields
// (material.unit, billing line uom, rfq annualVolumeUnit) → unit codes.
export const LEGACY_UNIT_CODE: Record<string, string> = {
  sheets: 'SHT',
  sheet: 'SHT',
  Sheets: 'SHT',
  packets: 'PKT',
  pkt: 'PKT',
  kg: 'KG',
  Kg: 'KG',
  grs: 'GRS',
  gross: 'GRS',
  tonnes: 'TON',
  tonne: 'TON',
  metres: 'MTR',
  meter: 'MTR',
  litres: 'LTR',
  litre: 'LTR',
  pieces: 'NOS',
  piece: 'NOS',
  nos: 'NOS',
  Pcs: 'NOS',
  pcs: 'NOS',
  Box: 'BOX',
  box: 'BOX',
  Set: 'SET',
  set: 'SET',
  cartons: 'CTN',
  carton: 'CTN',
  labels: 'LBL',
  label: 'LBL',
}

export function legacyToCode(value: string): string {
  return LEGACY_UNIT_CODE[value] ?? LEGACY_UNIT_CODE[value.toLowerCase()] ?? normalizeCode(value)
}
