'use client'

import { SessionProvider } from 'next-auth/react'
import { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from 'next-themes'
import { MastersProvider } from '@/components/masters/MastersProvider'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 120000,
      gcTime: 600000,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      retry: 1,
    },
  },
})

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} themes={['light', 'dark']} disableTransitionOnChange>
      <SessionProvider refetchOnWindowFocus={false} refetchWhenOffline={false}>
        <QueryClientProvider client={queryClient}>
          <MastersProvider>{children}</MastersProvider>
        </QueryClientProvider>
      </SessionProvider>
    </ThemeProvider>
  )
}
