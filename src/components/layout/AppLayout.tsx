'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useRef, useEffect, type ReactNode, type ElementType } from 'react'
import { ChevronDown, LogOut } from 'lucide-react'
import { Toaster } from '@/components/ui/Toaster'
import { cn } from '@/lib/cn'

/**
 * AppLayout — Top Navigation Shell (Next.js App Router)
 * ──────────────────────────────────────────────────────
 * Two-row top nav:
 *   Row 1 (header): Logo + app name on dark bg + user menu
 *   Row 2 (nav):    Horizontal nav items with active orange underline + dropdown support
 *
 * navItem shapes:
 *   { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, exact: true }
 *   { label: 'Orders', icon: ShoppingCart, children: [
 *       { label: 'New Order',  href: '/orders/new' },
 *       { label: 'Order List', href: '/orders' },
 *   ]}
 *
 * Adapted from the ERP design system package (react-router → next/navigation).
 */

export interface NavChildItem {
  label: string
  href: string
}

export interface NavItem {
  label: string
  href?: string
  icon?: ElementType
  exact?: boolean
  children?: NavChildItem[]
}

export interface AppUser {
  name?: string
  role?: string
}

// ── Dropdown nav group ────────────────────────────────────────────────────────
function NavDropdown({ item }: { item: NavItem }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  // Close on route change
  useEffect(() => { setOpen(false) }, [pathname])

  const isAnyChildActive = item.children?.some(c => pathname.startsWith(c.href)) ?? false

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          'flex items-center gap-1 px-3 py-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
          open || isAnyChildActive
            ? 'border-orange-500 text-orange-500'
            : 'border-transparent text-gray-600 hover:text-orange-500 hover:border-orange-300',
        )}
      >
        {item.icon && <item.icon size={14} className="shrink-0 mr-0.5" />}
        {item.label}
        <ChevronDown
          size={13}
          className={cn('ml-0.5 transition-transform duration-200', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-0 w-52 bg-white rounded-b-lg shadow-lg border border-t-0 border-gray-200 z-50 py-1">
          {item.children?.map(child => {
            const active = pathname === child.href || pathname.startsWith(child.href + '/')
            return (
              <Link
                key={child.href}
                href={child.href}
                onClick={() => setOpen(false)}
                className={cn(
                  'block px-4 py-2 text-sm transition-colors',
                  active
                    ? 'text-orange-500 bg-orange-50 font-medium'
                    : 'text-gray-700 hover:text-orange-500 hover:bg-orange-50',
                )}
              >
                {child.label}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── User dropdown (top-right of header) ──────────────────────────────────────
function UserMenu({ user, onLogout }: { user: AppUser; onLogout?: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
      >
        <div className="w-7 h-7 bg-orange-500 rounded-full flex items-center justify-center text-xs text-white font-bold shrink-0">
          {user?.name?.[0]?.toUpperCase() ?? 'U'}
        </div>
        <div className="hidden sm:block text-left">
          <p className="text-xs text-white font-medium truncate max-w-[120px] leading-none">
            {user?.name ?? 'User'}
          </p>
          <p className="text-xs text-gray-400 capitalize leading-none mt-0.5">
            {user?.role ?? 'member'}
          </p>
        </div>
        <ChevronDown
          size={13}
          className={cn('transition-transform duration-200', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 w-44 bg-white rounded-lg shadow-lg border border-gray-200 z-50 py-1">
          <div className="px-4 py-2.5 border-b border-gray-100">
            <p className="text-xs font-semibold text-gray-800 truncate">{user?.name ?? 'User'}</p>
            <p className="text-xs text-gray-500 capitalize mt-0.5">{user?.role ?? 'member'}</p>
          </div>
          <button
            onClick={() => { setOpen(false); onLogout?.() }}
            className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-600 hover:text-red-600 hover:bg-red-50 transition-colors"
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      )}
    </div>
  )
}

// ── Root layout ───────────────────────────────────────────────────────────────
interface AppLayoutProps {
  navItems?: NavItem[]
  settingsItems?: NavItem[]
  user?: AppUser
  onLogout?: () => void
  logoIcon?: ElementType
  appName?: string
  children: ReactNode
}

export function AppLayout({
  navItems      = [],
  settingsItems = [],
  user          = {},
  onLogout,
  logoIcon: LogoIcon,
  appName       = 'Colour Impressions',
  children,
}: AppLayoutProps) {
  const pathname = usePathname()
  const allNavItems = [...navItems, ...settingsItems]

  return (
    <div className="flex flex-col h-screen bg-ds-main overflow-hidden">

      {/* ── Row 1: Dark header bar ─────────────────────────────────────────── */}
      <header className="bg-gray-900 shrink-0 z-30">
        <div className="flex items-center justify-between px-5 h-11">

          {/* Logo + app name */}
          <div className="flex items-center gap-2.5">
            {LogoIcon && (
              <div className="w-7 h-7 bg-orange-500 rounded-md flex items-center justify-center shrink-0 shadow">
                <LogoIcon size={15} className="text-white" />
              </div>
            )}
            <span className="text-white font-semibold text-sm tracking-tight">{appName}</span>
          </div>

          {/* User avatar + dropdown */}
          <UserMenu user={user} onLogout={onLogout} />
        </div>
      </header>

      {/* ── Row 2: Horizontal nav bar ──────────────────────────────────────── */}
      <nav className="bg-white border-b border-gray-200 shrink-0 shadow-sm z-20">
        <div className="flex items-stretch px-3 overflow-x-auto">
          {allNavItems.map(item =>
            item.children ? (
              <NavDropdown key={item.label} item={item} />
            ) : (() => {
              const active = item.exact
                ? pathname === item.href
                : pathname === item.href || pathname.startsWith((item.href ?? '') + '/')
              return (
                <Link
                  key={item.href}
                  href={item.href ?? '#'}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                    active
                      ? 'border-orange-500 text-orange-500'
                      : 'border-transparent text-gray-600 hover:text-orange-500 hover:border-orange-300',
                  )}
                >
                  {item.icon && <item.icon size={14} className="shrink-0" />}
                  {item.label}
                </Link>
              )
            })()
          )}
        </div>
      </nav>

      {/* ── Scrollable page content ────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>

      {/* ── Global toast stack ────────────────────────────────────────────── */}
      <Toaster />
    </div>
  )
}

export default AppLayout
