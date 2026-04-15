'use client'

import { useCallback } from 'react'
import { withRetry } from '@ci/request-utils'

type RetryOptions = {
  retries?: number
  delayMs?: number
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
