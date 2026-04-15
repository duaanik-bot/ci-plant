'use client'

import { useCallback } from 'react'

type RetryOptions = {
  retries?: number
  delayMs?: number
}

async function withRetry<T>(action: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const retries = options?.retries ?? 3
  const delayMs = options?.delayMs ?? 400
  let last: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await action()
    } catch (e) {
      last = e
      if (attempt === retries) break
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)))
    }
  }
  throw last instanceof Error ? last : new Error('Request failed after retries')
}

export function useRetryableRequest() {
  const executeWithRetry = useCallback(
    async <T>(action: () => Promise<T>, options?: RetryOptions): Promise<T> => {
      return withRetry(action, options)
    },
    [],
  )

  return { executeWithRetry }
}
