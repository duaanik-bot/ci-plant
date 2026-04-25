'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Menu, X } from 'lucide-react'
import { useSession } from 'next-auth/react'
import {
  CommandPaletteProvider,
  CommandPaletteTrigger,
  CommandPaletteTriggerIcon,
} from '@/components/command-palette/CommandPalette'
import { SidebarNav } from './SidebarNav'
import { ThemeToggle } from '@/components/theme/ThemeToggle'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { AppLayout } from '@/components/design-system/AppLayout'
import {
  applyAccentPreset,
  applyHighContrast,
  getStoredAccentPreset,
  getStoredHighContrast,
} from '@/lib/accent-theme'

export function DashboardShell({
  children,
}: {
  children: React.ReactNode
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const pathname = usePathname()
  const router = useRouter()
  const { data: session, status } = useSession()
  const userName = session?.user?.name ?? null
  const userRole = session?.user?.role as string | undefined
  const canSeeMasters = userRole === 'operations_head' || userRole === 'md'
  const hideGlobalCommandBar =
    pathname === '/orders/purchase-orders' ||
    pathname === '/orders/designing' ||
    pathname === '/orders/planning'

  useEffect(() => {
    setMobileMenuOpen(false)
  }, [pathname])

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login')
  }, [status, router])

  useEffect(() => {
    applyAccentPreset(getStoredAccentPreset())
    applyHighContrast(getStoredHighContrast())
  }, [])

  if (status === 'loading') {
    return (
      <AppLayout className="flex items-center justify-center text-sm text-ds-ink-muted">
        Loading workspace...
      </AppLayout>
    )
  }

  if (status === 'unauthenticated') {
    return (
      <AppLayout className="flex items-center justify-center text-sm text-ds-ink-muted">
        Redirecting to login...
      </AppLayout>
    )
  }

  return (
    <CommandPaletteProvider>
    <AppLayout className="flex">
      {/* Backdrop when mobile menu open */}
      {mobileMenuOpen && (
        <button
          type="button"
          aria-label="Close menu"
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar: on mobile fixed overlay when open; on desktop always visible */}
      <aside
        className={`
          flex flex-col w-64 border-r border-ds-line bg-ds-elevated/50 shrink-0
          fixed md:relative inset-y-0 left-0 z-50 md:z-auto
          ${mobileMenuOpen ? 'flex' : 'hidden md:flex'}
        `}
      >
        <div className="px-4 py-3 border-b border-ds-line flex items-center justify-between gap-2 shrink-0 flex-wrap">
          <Link href="/dashboard" className="flex flex-col min-w-0" onClick={() => setMobileMenuOpen(false)}>
            <span className="text-sm font-semibold tracking-wide text-ds-ink">
              COLOUR IMPRESSIONS
            </span>
            <span className="text-xs text-ds-ink-faint">
              Production Planning System
            </span>
          </Link>
          {hideGlobalCommandBar ? <ThemeToggle /> : null}
          <button
            type="button"
            className="md:hidden p-2 rounded-ds-sm text-ds-ink-muted transition hover:bg-ds-elevated hover:text-ds-ink"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="flex-1 px-3 py-3 space-y-3 text-sm overflow-y-auto flex flex-col">
          <SidebarNav
            canSeeMasters={canSeeMasters}
            userName={userName}
            userRole={userRole}
          />
        </nav>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        {/* Desktop: global command bar */}
        {!hideGlobalCommandBar ? (
          <header className="relative hidden md:flex border-b border-ds-line/80 px-4 py-2.5 shrink-0 items-center justify-center gap-4 bg-ds-elevated/30 backdrop-blur-sm">
            <CommandPaletteTrigger />
            <div className="absolute right-4 flex items-center gap-3">
              <ThemeToggle />
              <span className="text-xs text-ds-ink-faint truncate max-w-[200px]">
                {userName ? `${userName} · ${userRole ?? '—'}` : null}
              </span>
            </div>
          </header>
        ) : null}
        {/* Mobile header */}
        <header className="md:hidden border-b border-ds-line px-2 py-2 flex items-center justify-between shrink-0 gap-1">
          <Link href="/dashboard" className="text-sm pl-2 font-semibold text-ds-ink">
            Colour Impressions
          </Link>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            {hideGlobalCommandBar ? null : <CommandPaletteTriggerIcon />}
            <span className="text-[10px] text-ds-ink-faint truncate max-w-[88px]">
              {userName ?? ''}
            </span>
            <button
              type="button"
              onClick={() => setMobileMenuOpen((o) => !o)}
              className="p-2 rounded-ds-sm text-ds-ink-muted transition hover:bg-ds-elevated hover:text-ds-ink"
              aria-label="Toggle menu"
            >
              <Menu className="h-5 w-5" />
            </button>
          </div>
        </header>
        <main className="min-h-0 min-w-0 flex-1 overflow-auto bg-ds-main">
          <ErrorBoundary moduleName="Page">{children}</ErrorBoundary>
        </main>
      </div>
    </AppLayout>
    </CommandPaletteProvider>
  )
}
