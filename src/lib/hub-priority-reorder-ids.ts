/**
 * Pure "swap engine" for hub column ordering. `orderedIds` is top-to-bottom (index 0 = highest priority).
 */
export function computeReorderedIds(
  orderedIds: string[],
  targetId: string,
  action: 'top' | 'up' | 'down' | 'bottom',
):
  | { ok: true; ids: string[] }
  | { ok: false; reason: 'not_found' | 'boundary' } {
  const idx = orderedIds.indexOf(targetId)
  if (idx < 0) return { ok: false, reason: 'not_found' }
  if (action === 'up' && idx === 0) return { ok: false, reason: 'boundary' }
  if (action === 'down' && idx === orderedIds.length - 1) return { ok: false, reason: 'boundary' }

  const next = [...orderedIds]
  if (action === 'top') {
    return { ok: true, ids: [targetId, ...next.filter((i) => i !== targetId)] }
  }
  if (action === 'bottom') {
    return { ok: true, ids: [...next.filter((i) => i !== targetId), targetId] }
  }
  if (action === 'up') {
    const t = next[idx - 1]!
    next[idx - 1] = next[idx]!
    next[idx] = t
    return { ok: true, ids: next }
  }
  {
    const t = next[idx + 1]!
    next[idx + 1] = next[idx]!
    next[idx] = t
    return { ok: true, ids: next }
  }
}
