import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * Root chrome for app pages: dark canvas + default text.
 * The dashboard uses `DashboardShell` for header/sidebar; this is the main content wrapper token.
 */
export function AppLayout({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('min-h-screen bg-ds-main text-ds-ink antialiased', className)}>{children}</div>
}
