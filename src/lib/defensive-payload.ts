/**
 * Defensive guards before API calls — avoids empty bodies and silent JSON failures.
 */

import { safeJsonStringify } from '@/lib/safe-json'

const EMPTY_MSG = 'Refusing empty payload for API request'

/** If payload is null/undefined or has no own keys, logs and returns false. */
export function assertNonEmptyPayload(
  payload: unknown,
  context: string,
): payload is Record<string, unknown> {
  if (payload == null || typeof payload !== 'object') {
    console.error(`[defensive-payload] ${context}: ${EMPTY_MSG} (not an object)`)
    return false
  }
  if (Object.keys(payload as object).length === 0) {
    console.error(`[defensive-payload] ${context}: ${EMPTY_MSG}`)
    return false
  }
  return true
}

/** JSON.stringify with try/catch; logs on failure. Prefer this for outbound hub calls. */
export function stringifyPayload(payload: unknown, context: string): string | null {
  try {
    return safeJsonStringify(payload)
  } catch (e) {
    console.error(`[defensive-payload] ${context}: JSON.stringify failed`, e)
    return null
  }
}
