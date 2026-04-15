/**
 * In-process duplicate suppression for tooling hub dispatch (same payload within 5s).
 * For multi-instance deployments, add a shared store or DB unique constraint.
 */

const WINDOW_MS = 5000
const lastSuccessAt = new Map<string, number>()

export function buildDispatchDedupeKey(
  userId: string,
  parts: {
    toolType: string
    jobCardId: string
    artworkId: string
    setNumber: string
    source: string
  },
): string {
  return `${userId}:${parts.toolType}:${parts.jobCardId}:${parts.artworkId}:${parts.setNumber}:${parts.source}`
}

/** True if the same key was successfully recorded within WINDOW_MS. */
export function isRecentDuplicateDispatch(key: string, now = Date.now()): boolean {
  const t = lastSuccessAt.get(key)
  return t != null && now - t < WINDOW_MS
}

/** Call only after a successful dispatch write. */
export function recordDispatchSuccess(key: string, now = Date.now()): void {
  lastSuccessAt.set(key, now)
}

/** Test helper: clear in-memory map. */
export function __resetDispatchIdempotencyForTests(): void {
  lastSuccessAt.clear()
}
