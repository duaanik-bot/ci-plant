export type SpectroScanLogEntry = {
  scannedAt: string
  deltaE?: number
  note?: string
}

export function parseSpectroScanLog(raw: unknown): SpectroScanLogEntry[] {
  if (!Array.isArray(raw)) return []
  const out: SpectroScanLogEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const scannedAt = typeof o.scannedAt === 'string' ? o.scannedAt : null
    if (!scannedAt) continue
    const deltaE = typeof o.deltaE === 'number' && Number.isFinite(o.deltaE) ? o.deltaE : undefined
    const note = typeof o.note === 'string' ? o.note : undefined
    out.push({ scannedAt, ...(deltaE != null ? { deltaE } : {}), ...(note ? { note } : {}) })
  }
  return out.sort((a, b) => b.scannedAt.localeCompare(a.scannedAt))
}
