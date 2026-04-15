/** Default physical rack dimensions for Live Rack Status grid. */
export const RACK_ROWS = 6
export const RACK_COLS = 16

export function slotKey(row: number, col: number): string {
  return `${row}-${col}`
}

/** Parse `slot_number` stored as "row-col" (0-based). */
export function parseSlotNumber(slotNumber: string | null | undefined): { row: number; col: number } | null {
  if (!slotNumber?.trim()) return null
  const m = /^(\d+)\s*[-_]\s*(\d+)$/.exec(slotNumber.trim())
  if (!m) return null
  const row = Number(m[1])
  const col = Number(m[2])
  if (!Number.isFinite(row) || !Number.isFinite(col)) return null
  if (row < 0 || row >= RACK_ROWS || col < 0 || col >= RACK_COLS) return null
  return { row, col }
}
