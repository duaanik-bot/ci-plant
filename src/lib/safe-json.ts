/** Avoid uncaught JSON errors in API routes and client bridges. */

export function safeJsonParse<T = unknown>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function safeJsonStringify(value: unknown, fallback = '{}'): string {
  try {
    return JSON.stringify(value)
  } catch {
    return fallback
  }
}

/** Use for list endpoints: error payloads like `{ error: '…' }` parse successfully but are not arrays. */
export function safeJsonParseArray<T>(raw: string, fallback: T[] = []): T[] {
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? (v as T[]) : fallback
  } catch {
    return fallback
  }
}
