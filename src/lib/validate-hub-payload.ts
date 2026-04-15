/**
 * Pre-flight checks for hub / tooling API calls.
 * Block the request if artwork, job card, or set # is missing.
 */

export const HUB_TECHNICAL_DATA_MISSING_TOAST =
  'Technical Data Missing: Please re-select Artwork Code.'

export type HubPayloadInput = {
  artworkId?: string | null
  jobCardId?: string | null
  setNumber?: string | number | null
}

export type HubPayloadResult = { ok: true } | { ok: false; missing: string[] }

/** Returns whether all three fields are non-empty after trim. */
export function validatePayload(payload: HubPayloadInput): HubPayloadResult {
  const artworkId = String(payload.artworkId ?? '').trim()
  const jobCardId = String(payload.jobCardId ?? '').trim()
  const setNumber = String(payload.setNumber ?? '').trim()

  const missing: string[] = []
  if (!artworkId) missing.push('artworkId')
  if (!jobCardId) missing.push('jobCardId')
  if (!setNumber) missing.push('setNumber')

  if (missing.length > 0) return { ok: false, missing }
  return { ok: true }
}
