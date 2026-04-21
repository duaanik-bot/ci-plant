'use client'

import { Toaster } from 'sonner'
import { useTheme } from 'next-themes'

export function AppToaster() {
  const { resolvedTheme } = useTheme()

  return (
    <Toaster
      position="top-center"
      richColors
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      toastOptions={{
        className: 'border border-border bg-card text-card-foreground shadow-sm',
      }}
    />
  )
}
