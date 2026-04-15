/** Prevent duplicate Issue writes from rapid double-clicks (per user + tool). */

const WINDOW_MS = 5000
const recent = new Map<string, number>()

export function buildIssueDedupeKey(userId: string, toolType: string, toolId: string): string {
  return `${userId}:${toolType}:${toolId}:issue`
}

export function isDuplicateIssue(key: string, now = Date.now()): boolean {
  const t = recent.get(key)
  return t != null && now - t < WINDOW_MS
}

export function recordIssueSuccess(key: string, now = Date.now()): void {
  recent.set(key, now)
}

/** After receive (return to rack), allow a new Issue without the client-idempotency window blocking it. */
export function clearIssueDedupeKey(key: string): void {
  recent.delete(key)
}

export function __resetInventoryIssueIdempotencyForTests(): void {
  recent.clear()
}
