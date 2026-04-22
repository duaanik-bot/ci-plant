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
    pathname === '/orders/purchase-orders' || pathname === '/orders/designing'

  useEffect(() => {
    setMobileMenuOpen(false)
  }, [pathname])

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login')
  }, [status, router])

  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-400 flex items-center justify-center text-sm">
        Loading workspace...
      </div>
    )
  }

  if (status === 'unauthenticated') {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-400 flex items-center justify-center text-sm">
        Redirecting to login...
      </div>
    )
  }

  return (
    <CommandPaletteProvider>
    <div className="min-h-screen bg-slate-900 text-white flex">
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
          flex flex-col w-64 border-r border-slate-800 bg-slate-950/60 shrink-0
          fixed md:relative inset-y-0 left-0 z-50 md:z-auto
          ${mobileMenuOpen ? 'flex' : 'hidden md:flex'}
        `}
      >
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-2 shrink-0 flex-wrap">
          <Link href="/dashboard" className="flex flex-col min-w-0" onClick={() => setMobileMenuOpen(false)}>
            <span className="text-sm font-semibold tracking-wide text-amber-400">
              COLOUR IMPRESSIONS
            </span>
            <span className="text-xs text-slate-500">
              Production Planning System
            </span>
          </Link>
          {hideGlobalCommandBar ? <ThemeToggle /> : null}
          <button
            type="button"
            className="md:hidden p-2 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white"
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
          <header className="relative hidden md:flex border-b border-slate-800/90 px-4 py-2.5 shrink-0 items-center justify-center gap-4 bg-slate-950/40 backdrop-blur-sm">
            <CommandPaletteTrigger />
            <div className="absolute right-4 flex items-center gap-3">
              <ThemeToggle />
              <span className="text-xs text-slate-500 truncate max-w-[200px]">
                {userName ? `${userName} · ${userRole ?? '—'}` : null}
              </span>
            </div>
          </header>
        ) : null}
        {/* Mobile header */}
        <header className="md:hidden border-b border-slate-800 px-2 py-2 flex items-center justify-between shrink-0 gap-1">
          <Link href="/dashboard" className="font-semibold text-amber-400 text-sm pl-2">
            Colour Impressions
          </Link>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            {hideGlobalCommandBar ? null : <CommandPaletteTriggerIcon />}
            <span className="text-[10px] text-slate-500 truncate max-w-[88px]">
              {userName ?? ''}
            </span>
            <button
              type="button"
              onClick={() => setMobileMenuOpen((o) => !o)}
              className="p-2 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white"
              aria-label="Toggle menu"
            >
              <Menu className="h-5 w-5" />
            </button>
          </div>
        </header>
        <main className="min-h-screen bg-slate-900 flex-1">
          <ErrorBoundary moduleName="Page">{children}</ErrorBoundary>
        </main>
      </div>
    </div>
    </CommandPaletteProvider>
  )
}
