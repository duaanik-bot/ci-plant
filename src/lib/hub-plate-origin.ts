/** Stored on each colour row in `plate_store.colours` JSON. */
export type PlateColourFirstOrigin = 'inhouse_ctp' | 'outside_vendor' | 'legacy_unknown'

export type HubCustodySource = 'ctp' | 'vendor' | 'rack'

export const PLATE_FIRST_ORIGIN_OPTIONS: {
  value: PlateColourFirstOrigin
  label: string
}[] = [
  { value: 'inhouse_ctp', label: 'In-House CTP' },
  { value: 'outside_vendor', label: 'Outside Vendor' },
  { value: 'legacy_unknown', label: 'Legacy / Unknown' },
]

export function defaultFirstOriginFromCustody(source: HubCustodySource): PlateColourFirstOrigin {
  if (source === 'ctp') return 'inhouse_ctp'
  if (source === 'vendor') return 'outside_vendor'
  return 'legacy_unknown'
}
