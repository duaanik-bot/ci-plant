import type { RegistryPayload } from '@/app/api/masters/registry/route'

// Mirrors the seeder day-one lists. Served only when the registry API
// fails so dropdowns never break.
export const FALLBACK_REGISTRY: RegistryPayload = {
  UNIT: {
    code: 'UNIT', label: 'Unit',
    values: [
      { code: 'NOS', label: 'Numbers', abbreviation: null, sortOrder: 10 },
      { code: 'KG', label: 'Kilogram', abbreviation: null, sortOrder: 20 },
      { code: 'SHT', label: 'Sheets', abbreviation: null, sortOrder: 30 },
      { code: 'BOX', label: 'Box', abbreviation: null, sortOrder: 40 },
      { code: 'GRS', label: 'Gross', abbreviation: null, sortOrder: 50 },
      { code: 'TON', label: 'Tonnes', abbreviation: null, sortOrder: 60 },
      { code: 'MTR', label: 'Metres', abbreviation: null, sortOrder: 70 },
      { code: 'LTR', label: 'Litres', abbreviation: null, sortOrder: 80 },
      { code: 'PKT', label: 'Packets', abbreviation: null, sortOrder: 90 },
    ],
  },
  BOARD_TYPE: {
    code: 'BOARD_TYPE', label: 'Board Type',
    values: [
      { code: 'FBB', label: 'FBB', abbreviation: null, sortOrder: 10 },
      { code: 'SBS', label: 'SBS', abbreviation: null, sortOrder: 20 },
      { code: 'DGB', label: 'Duplex GB', abbreviation: null, sortOrder: 30 },
      { code: 'DWB', label: 'Duplex WB', abbreviation: null, sortOrder: 40 },
      { code: 'KRFT', label: 'Kraft', abbreviation: null, sortOrder: 50 },
    ],
  },
  BOARD_COLOUR: {
    code: 'BOARD_COLOUR', label: 'Board Colour',
    values: [
      { code: 'WHT', label: 'White', abbreviation: null, sortOrder: 10 },
      { code: 'GRY', label: 'Grey-back', abbreviation: null, sortOrder: 20 },
      { code: 'KRF', label: 'Kraft brown', abbreviation: null, sortOrder: 30 },
    ],
  },
  COATING: { code: 'COATING', label: 'Coating', values: [] },
  FOIL: { code: 'FOIL', label: 'Foil', values: [] },
  EMBOSS: { code: 'EMBOSS', label: 'Emboss', values: [] },
  PASTING: { code: 'PASTING', label: 'Pasting', values: [] },
}
