'use client'

import type { ReactNode } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'

export function MastersLayoutBody({ children }: { children: ReactNode }) {
  return <ErrorBoundary moduleName="Masters">{children}</ErrorBoundary>
}
