/**
 * Pre-flight checks for hub / tooling API calls.
 * Block the request if artwork, job card, or set # is missing.
 */

export const HUB_TECHNICAL_DATA_MISSING_TOAST =
  'Technical Data Missing: Please re-select Artwork Code.'

export const HUB_DIE_PUSH_SPECS_MISSING_TOAST =
  'Enter set #, job card, AW code, actual sheet size, and number of UPS (or link artwork with those specs saved).'

export const HUB_EMBOSS_PUSH_SPECS_MISSING_TOAST =
  'Enter set #, job card, AW code, and actual sheet size (or link artwork) before pushing to Embossing Hub.'

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

export type DieHubClientPayloadInput = {
  artworkId?: string | null
  jobCardId?: string | null
  setNumber?: string | number | null
  awCode?: string | null
  actualSheetSize?: string | null
  ups?: string | number | null
}

/**
 * Die hub push: artwork row optional if AW + sheet + UPS are present (manual triage).
 * Job card and set # always required.
 */
export function validateDieHubPushPayload(
  payload: DieHubClientPayloadInput,
): HubPayloadResult {
  const artworkId = String(payload.artworkId ?? '').trim()
  const jobCardId = String(payload.jobCardId ?? '').trim()
  const setNumber = String(payload.setNumber ?? '').trim()
  const awCode = String(payload.awCode ?? '').trim()
  const sheet = String(payload.actualSheetSize ?? '').trim()
  const upsRaw = String(payload.ups ?? '').trim()
  const upsNum = upsRaw ? Number(upsRaw) : NaN
  const manualOk =
    !!awCode &&
    !!sheet &&
    Number.isFinite(upsNum) &&
    upsNum >= 1 &&
    Math.floor(upsNum) === upsNum

  const missing: string[] = []
  if (!jobCardId) missing.push('jobCardId')
  if (!setNumber) missing.push('setNumber')
  if (!artworkId && !manualOk) {
    if (!awCode) missing.push('awCode')
    if (!sheet) missing.push('actualSheetSize')
    if (!manualOk) missing.push('ups')
  }

  if (missing.length > 0) return { ok: false, missing }
  return { ok: true }
}

export type EmbossHubClientPayloadInput = {
  artworkId?: string | null
  jobCardId?: string | null
  setNumber?: string | number | null
  awCode?: string | null
  actualSheetSize?: string | null
}

/** Emboss hub: artwork optional if AW + sheet size present. UPS not required. */
export function validateEmbossHubPushPayload(
  payload: EmbossHubClientPayloadInput,
): HubPayloadResult {
  const artworkId = String(payload.artworkId ?? '').trim()
  const jobCardId = String(payload.jobCardId ?? '').trim()
  const setNumber = String(payload.setNumber ?? '').trim()
  const awCode = String(payload.awCode ?? '').trim()
  const sheet = String(payload.actualSheetSize ?? '').trim()
  const manualOk = !!awCode && !!sheet

  const missing: string[] = []
  if (!jobCardId) missing.push('jobCardId')
  if (!setNumber) missing.push('setNumber')
  if (!artworkId && !manualOk) {
    if (!awCode) missing.push('awCode')
    if (!sheet) missing.push('actualSheetSize')
  }

  if (missing.length > 0) return { ok: false, missing }
  return { ok: true }
}
