/** Client-side hub search: carton, AW code, job id (requirement / plate set), client name. */

export function normalizeHubSearchQuery(raw: string): string {
  return raw.trim().toLowerCase()
}

export function isHubSearchActive(q: string): boolean {
  return normalizeHubSearchQuery(q).length > 0
}

type SearchFields = {
  cartonName?: string | null
  artworkCode?: string | null
  /** Requirement code, job id, plate set code, etc. */
  jobId?: string | null
  clientName?: string | null
}

function haystack(parts: SearchFields): string {
  return [
    parts.cartonName,
    parts.artworkCode,
    parts.jobId,
    parts.clientName,
  ]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase())
    .join(' ')
}

/** Returns true if query is empty (show all) or every token appears somewhere in the fields. */
export function matchesHubPlateQuery(query: string, fields: SearchFields): boolean {
  const q = normalizeHubSearchQuery(query)
  if (!q) return true
  const h = haystack(fields)
  const tokens = q.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  return tokens.every((t) => h.includes(t))
}
