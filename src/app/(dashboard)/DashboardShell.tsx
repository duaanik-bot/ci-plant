'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useSession, signOut } from 'next-auth/react'
import type { LucideIcon } from 'lucide-react'
import {
  Bell,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  ClipboardPaste,
  Droplets,
  FileText,
  Layers,
  LayoutGrid,
  LogOut,
  Menu,
  Printer,
  Scale,
  Scissors,
  Stamp,
  Truck,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import {
  CommandPaletteProvider,
  CommandPaletteTriggerIcon,
} from '@/components/command-palette/CommandPalette'
import { ThemeToggle } from '@/components/theme/ThemeToggle'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { AppLayout } from '@/components/design-system/AppLayout'
import {
  applyAccentPreset,
  applyHighContrast,
  getStoredAccentPreset,
  getStoredHighContrast,
} from '@/lib/accent-theme'
import { useUiDensity } from '@/lib/ui-density'
import { Toaster } from '@/components/ui/Toaster'
import { hasModuleAccess, type ModuleKey } from '@/lib/rbac'

type MegaNavItem = {
  label: string
  href: string
  description: string
  Icon: LucideIcon
  iconWrap: string
}
type SimpleNavItem = { label: string; href: string; description?: string; Icon?: LucideIcon }
type MenuItem = SimpleNavItem | MegaNavItem

const HREF_MODULE: Record<string, ModuleKey> = {
  '/director/command-center': 'reports',
  '/orders/purchase-orders': 'customer_po',
  '/orders/planning': 'planning',
  '/orders/designing': 'artwork_queue',
  '/production/job-cards': 'job_cards',
  '/production/print-planning': 'planning',
  '/production/cutting-queue': 'cutting',
  '/production/stages/printing': 'printing',
  '/production/stages/chemical_coating': 'inventory',
  '/production/stages/dye_cutting': 'inventory',
  '/production/stages/pasting': 'inventory',
  '/dispatch': 'dispatch',
  '/billing': 'dispatch',
  '/stores/short-excess': 'stores',
  '/inventory#paper-ledger': 'paper_warehouse',
  '/inventory/fg-warehouse': 'inventory',
  '/hub/plates': 'tooling_hub',
  '/hub/dies': 'tooling_hub',
  '/hub/blocks': 'tooling_hub',
  '/hub/shade-card-hub': 'tooling_hub',
  '/stores/issue': 'stores',
  '/stores/approve-excess': 'stores',
  '/qms/qc': 'quality',
  '/reports/dashboard': 'reports',
  '/reports/production': 'reports',
  '/reports/wastage': 'reports',
  '/masters': 'masters',
}

function BrandLogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={32}
      height={32}
      className={className}
      aria-hidden
    >
      <path fill="#FDBA74" d="M16 6 26 11.2 16 16.4 6 11.2 16 6z" />
      <path fill="#C2410C" d="m6 11.2 10 5.2v9.6L6 20.8v-9.6z" />
      <path fill="#F97316" d="m16 16.4 10-5.2v9.6l-10 5.2v-9.6z" />
    </svg>
  )
}

function userInitials(name: string | null): string {
  if (!name?.trim()) return '?'
  const parts = name.trim().split(/\s+/)
  const a = parts[0]?.[0] ?? ''
  const b = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : (parts[0]?.[1] ?? '')
  const s = (a + b).toUpperCase()
  return s || '?'
}

function formatRoleLabel(role: string | undefined): string {
  if (!role) return 'Member'
  return role
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function MegaNavLink({ item }: { item: MegaNavItem }) {
  const Icon = item.Icon
  return (
    <Link
      href={item.href}
      className="group flex items-center gap-3 rounded-ds-md border border-[var(--border)] bg-[var(--bg-card)] p-3 transition-all duration-150 hover:border-[var(--brand-primary)]/30 hover:bg-[var(--brand-bg-soft)] hover:shadow-ds-depth-sm"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-ds-sm bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] transition-colors group-hover:bg-[var(--brand-primary)]/18 [&>svg]:h-[18px] [&>svg]:w-[18px]">
        <Icon aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold leading-tight text-[var(--text-primary)] transition-colors group-hover:text-[var(--brand-primary)]">
          {item.label}
        </span>
        <span className="mt-0.5 block truncate text-[11px] leading-snug text-[var(--text-secondary)]">
          {item.description}
        </span>
      </span>
      <span className="shrink-0 text-[var(--brand-primary)]/0 transition-all duration-150 group-hover:text-[var(--brand-primary)]/70 group-hover:translate-x-0.5">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden><path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </span>
    </Link>
  )
}

function BlockNavLink({
  item,
  onNavigate,
}: {
  item: MenuItem
  onNavigate?: (href: string) => void
}) {
  const Icon = 'Icon' in item && item.Icon ? item.Icon : Stamp
  const description = 'description' in item ? (item.description ?? '') : ''
  return (
    <button
      type="button"
      onClick={() => (onNavigate ? onNavigate(item.href) : undefined)}
      className="group relative w-full overflow-hidden rounded-ds-md border border-[var(--border)] bg-[var(--bg-card)] p-3 text-left transition-all duration-150 hover:border-[var(--brand-primary)]/30 hover:bg-[var(--brand-bg-soft)] hover:shadow-ds-depth-sm"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-ds-sm bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] transition-colors group-hover:bg-[var(--brand-primary)]/18">
          <Icon className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold leading-tight text-[var(--text-primary)] transition-colors group-hover:text-[var(--brand-primary)]">
            {item.label}
          </span>
          <span className="mt-0.5 block truncate text-[11px] leading-snug text-[var(--text-secondary)]">
            {description || 'Open module'}
          </span>
        </span>
        <span className="shrink-0 text-[var(--brand-primary)]/0 transition-all duration-150 group-hover:text-[var(--brand-primary)]/70 group-hover:translate-x-0.5">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden><path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </span>
      </div>
    </button>
  )
}

function isMegaNavItem(item: MenuItem): item is MegaNavItem {
  return 'description' in item && 'Icon' in item && 'iconWrap' in item
}

export function DashboardShell({
  children,
}: {
  children: React.ReactNode
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [sessionStuck, setSessionStuck] = useState(false)
  const pathname = usePathname()
  const router = useRouter()
  const { data: session, status } = useSession()
  const userName = session?.user?.name ?? null
  const userRole = session?.user?.role as string | undefined
  const userImage = (session?.user as { image?: string | null } | undefined)?.image ?? null
  const allowHref = (href: string) => {
    const mod = HREF_MODULE[href]
    return !mod || hasModuleAccess(userRole, mod)
  }
  const navRef = useRef<HTMLDivElement | null>(null)
  const [uiDensity, setUiDensity] = useUiDensity()

  useEffect(() => {
    setOpenMenu(null)
    setMobileOpen(false)
  }, [pathname])

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login')
  }, [status, router])

  useEffect(() => {
    if (status !== 'loading') {
      setSessionStuck(false)
      return
    }
    const t = setTimeout(() => setSessionStuck(true), 6000)
    return () => clearTimeout(t)
  }, [status])

  useEffect(() => {
    applyAccentPreset(getStoredAccentPreset())
    applyHighContrast(getStoredHighContrast())
  }, [])

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!navRef.current) return
      if (openMenu && !navRef.current.contains(e.target as Node)) setOpenMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [openMenu])

  const menus = useMemo(() => {
    const allMenus = [
      {
        key: 'director',
        label: 'Director Command Centre',
        href: '/director/command-center',
      },
      {
        key: 'orders',
        label: 'Orders',
        items: [
          { label: 'Customer POs', href: '/orders/purchase-orders' },
          { label: 'Planning', href: '/orders/planning', description: 'Plan print jobs and scheduling' },
          { label: 'Artwork Queue', href: '/orders/designing', description: 'Artwork readiness and job prep' },
          { label: 'Job Cards', href: '/production/job-cards', description: 'Create and track job cards' },
        ],
      },
      {
        key: 'tooling',
        label: 'Tooling Hub',
        items: [
          { label: 'Plates', href: '/hub/plates', description: 'CTP and plate workflow', Icon: Printer },
          { label: 'Dies', href: '/hub/dies', description: 'Die readiness and issuance', Icon: Scissors },
          { label: 'Embossing Blocks', href: '/hub/blocks', description: 'Emboss block tracking', Icon: Layers },
          { label: 'Shade Cards', href: '/hub/shade-card-hub', description: 'Shade approvals and control', Icon: Droplets },
        ],
      },
      {
        key: 'production',
        label: 'Print Planning',
        items: [
          {
            label: 'Print Planning',
            href: '/production/print-planning',
            description: 'Plan and schedule print jobs',
            Icon: ClipboardPaste,
            iconWrap: 'bg-[var(--bg-muted)] text-[var(--brand-primary)]',
          },
        ],
      },
      {
        key: 'live',
        label: 'Live Production',
        items: [
          {
            label: 'Cutting',
            href: '/production/cutting-queue',
            description: 'Cutting queue and floor sequence',
            Icon: LayoutGrid,
            iconWrap: 'bg-[var(--bg-muted)] text-[var(--brand-primary)]',
          },
          {
            label: 'Printing',
            href: '/production/stages/printing',
            description: 'Press floor — ink on sheet',
            Icon: Printer,
            iconWrap: 'bg-[var(--bg-muted)] text-[var(--brand-primary)]',
          },
          {
            label: 'Coating',
            href: '/production/stages/chemical_coating',
            description: 'Coating line execution',
            Icon: Layers,
            iconWrap: 'bg-[var(--bg-muted)] text-[var(--brand-primary)]',
          },
          {
            label: 'Die',
            href: '/production/stages/dye_cutting',
            description: 'Die cutting & blanking',
            Icon: Scissors,
            iconWrap: 'bg-[var(--bg-muted)] text-[var(--brand-primary)]',
          },
          {
            label: 'Pasting',
            href: '/production/stages/pasting',
            description: 'Folder-gluer and pasting',
            Icon: ClipboardCheck,
            iconWrap: 'bg-[var(--bg-muted)] text-[var(--brand-primary)]',
          },
          {
            label: 'Dispatch',
            href: '/dispatch',
            description: 'FG movement and dispatches',
            Icon: Truck,
            iconWrap: 'bg-[var(--bg-muted)] text-[var(--brand-primary)]',
          },
          {
            label: 'Billing',
            href: '/billing',
            description: 'Invoicing and billing desk',
            Icon: FileText,
            iconWrap: 'bg-[var(--bg-muted)] text-[var(--brand-primary)]',
          },
          {
            label: 'Short & Excess',
            href: '/stores/short-excess',
            description: 'Reconcile shorts and warehouse excess',
            Icon: Scale,
            iconWrap: 'bg-[var(--bg-muted)] text-[var(--brand-primary)]',
          },
        ],
      },
      {
        key: 'inventory',
        label: 'Inventory',
        items: [
          { label: 'Paper Warehouse', href: '/inventory#paper-ledger', description: 'Raw paper/board stock only' },
          { label: 'FG Warehouse', href: '/inventory/fg-warehouse', description: 'Finished goods stock ledger' },
        ],
      },
      {
        key: 'stores',
        label: 'Stores',
        items: [
          { label: 'Issue Sheets', href: '/stores/issue', description: 'Material issue and consumption' },
          { label: 'Approve Excess', href: '/stores/approve-excess', description: 'Short and excess approvals' },
        ],
      },
      { key: 'quality', label: 'Quality', items: [{ label: 'Quality Control', href: '/qms/qc', description: 'QC checks and logs', Icon: ClipboardCheck }] },
      {
        key: 'reports',
        label: 'Reports',
        items: [
          { label: 'MD Dashboard', href: '/reports/oee', description: 'OEE and executive production view', Icon: LayoutGrid },
          { label: 'Production Summary', href: '/reports/yield', description: 'Output, yield and run summary', Icon: FileText },
          { label: 'Wastage Report', href: '/reports/wastage', description: 'Wastage trends and losses', Icon: Scale },
        ],
      },
      {
        key: 'masters',
        label: 'Masters',
        href: '/masters',
      },
    ]

    type AllMenu = (typeof allMenus)[number]
    const filtered: AllMenu[] = []
    for (const menu of allMenus) {
      if ('items' in menu) {
        const filteredItems = menu.items.filter((item) => allowHref(item.href))
        if (filteredItems.length > 0) {
          filtered.push({ ...menu, items: filteredItems } as typeof menu)
        }
      } else {
        if (allowHref(menu.href)) {
          filtered.push(menu)
        }
      }
    }
    return filtered
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userRole])

  const isActiveMenu = (menu: (typeof menus)[number]) => {
    if (!('href' in menu)) {
      if (menu.key === 'production') {
        return pathname === '/production/print-planning' || pathname.startsWith('/production/print-planning/')
      }
      if (menu.key === 'live') {
        if (pathname.startsWith('/stores/')) return false
        return (
          pathname === '/production/cutting-queue' ||
          pathname.startsWith('/production/cutting-queue/') ||
          pathname.startsWith('/production/stages/') ||
          pathname === '/dispatch' ||
          pathname.startsWith('/dispatch/') ||
          pathname === '/billing' ||
          pathname.startsWith('/billing/')
        )
      }
      if (menu.key === 'stores') {
        return pathname.startsWith('/stores/')
      }
    }
    if ('href' in menu)
      return pathname === menu.href || pathname.startsWith(menu.href + '/')
    return menu.items.some((it) => pathname === it.href || pathname.startsWith(it.href.split('?')[0] + '/'))
  }

  if (status === 'loading') {
    return (
      <AppLayout className="flex items-center justify-center text-sm text-ds-ink-muted">
        {sessionStuck ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <p>Workspace is taking longer than expected to load.</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-ds-sm border border-[var(--border)] bg-[var(--bg-card)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-muted)]"
            >
              Reload
            </button>
          </div>
        ) : (
          'Loading workspace...'
        )}
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
    <ErrorBoundary moduleName="Dashboard">
    <CommandPaletteProvider>
      <AppLayout className="flex flex-col">
        <header
          ref={navRef}
          className="fixed inset-x-0 top-0 z-[1000] bg-[var(--bg-main)] font-sans shadow-[0_4px_24px_-6px_rgba(15,23,42,0.08),0_0_0_1px_rgba(37,99,235,0.06)] dark:shadow-[0_4px_28px_-4px_rgba(0,0,0,0.45)]"
        >
          {/* Row 1 — brand, utilities (dark bar, Pureflix top-nav) */}
          <div className="bg-gray-900 border-b border-gray-800">
            <div className="mx-auto flex h-14 max-w-[1920px] items-center gap-3 px-4 sm:gap-4 sm:px-5">
              <Link
                href="/orders/purchase-orders"
                className="inline-flex min-w-0 shrink-0 items-center gap-2.5 rounded-ds-sm outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
              >
                <BrandLogoMark className="h-8 w-8 shrink-0 drop-shadow-sm" />
                <span className="hidden truncate text-[15px] font-semibold leading-tight text-white sm:inline">
                  Colour Impressions
                </span>
                <ChevronDown
                  className="hidden h-4 w-4 shrink-0 text-gray-400 opacity-80 sm:block"
                  aria-hidden
                />
              </Link>
              <div className="ml-auto hidden max-w-[540px] flex-1 items-center justify-end gap-3 lg:flex">
                <button
                  type="button"
                  aria-label="Notifications"
                  className="relative grid h-10 w-10 place-items-center rounded-ds-sm border border-transparent text-gray-300 transition hover:bg-white/10 hover:text-white"
                >
                  <Bell className="h-4 w-4" />
                  <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--error)]" />
                </button>
              </div>
              <div className="flex items-center justify-end gap-0.5 sm:gap-1">
                <div className="flex md:hidden">
                  <CommandPaletteTriggerIcon />
                </div>
                <ThemeToggle />
                <div className="hidden rounded-ds-sm border border-white/15 bg-white/5 p-0.5 xl:inline-flex">
                  <button
                    type="button"
                    onClick={() => setUiDensity('dense')}
                    className={`rounded-ds-sm px-2 py-1 text-xs transition-colors ${
                      uiDensity === 'dense' ? 'bg-[var(--brand-primary)] text-white' : 'text-gray-300 hover:text-white'
                    }`}
                  >
                    Dense
                  </button>
                  <button
                    type="button"
                    onClick={() => setUiDensity('comfortable')}
                    className={`rounded-ds-sm px-2 py-1 text-xs transition-colors ${
                      uiDensity === 'comfortable' ? 'bg-[var(--brand-primary)] text-white' : 'text-gray-300 hover:text-white'
                    }`}
                  >
                    Comfortable
                  </button>
                </div>
                <div className="hidden items-center gap-2 pl-1 sm:flex">
                  <div className="hidden h-10 w-10 shrink-0 overflow-hidden rounded-full border border-white/20 bg-[var(--brand-primary)] sm:flex sm:items-center sm:justify-center">
                    {userImage ? (
                      <img
                        src={userImage}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-xs font-semibold text-white">
                        {userInitials(userName)}
                      </span>
                    )}
                  </div>
                  <div className="hidden min-w-0 flex-col md:flex">
                    <span className="truncate text-sm font-medium leading-tight text-white">
                      {userName ?? 'User'}
                    </span>
                    <span className="truncate text-xs text-gray-400">
                      {formatRoleLabel(userRole)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void signOut({ callbackUrl: '/login' })}
                    className="ml-1 inline-flex items-center gap-1.5 rounded-ds-sm border border-white/15 px-2.5 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
                    aria-label="Sign out"
                    title="Sign out"
                  >
                    <LogOut className="h-4 w-4" />
                    <span className="hidden lg:inline">Sign out</span>
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setMobileOpen((v) => !v)}
                  className="rounded-ds-sm p-2 text-gray-200 transition-colors duration-150 hover:bg-white/10 lg:hidden"
                  aria-label="Toggle navigation"
                >
                  {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
          {/* Row 2 — primary nav */}
          <div className="hidden border-b border-[var(--border)] lg:block">
            <nav className="mx-auto max-w-[1920px] px-4 sm:px-5">
              <ul className="flex h-12 items-center gap-0.5 whitespace-nowrap">
                {menus.map((menu) => {
                  const menuOpen = !('href' in menu) && openMenu === menu.key
                  const navHighlighted = 'href' in menu ? isActiveMenu(menu) : isActiveMenu(menu) || menuOpen
                  const isProductionMega = menu.key === 'production'
                  return (
                    <li
                      key={menu.key}
                      className="relative shrink-0"
                    >
                      {'href' in menu ? (
                        <Link
                          href={menu.href}
                          className={clsx(
                            'relative inline-flex items-center gap-1 rounded-ds-sm py-2.5 px-3 text-sm font-medium transition-colors duration-150',
                            navHighlighted
                              ? 'text-[var(--brand-primary)] after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-[var(--brand-primary)]'
                              : 'text-[var(--text-primary)] hover:bg-[var(--bg-muted)]',
                          )}
                        >
                          {menu.label}
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setOpenMenu((prev) => (prev === menu.key ? null : menu.key))}
                          className={clsx(
                            'relative inline-flex items-center gap-1 rounded-ds-sm py-2.5 pl-3 pr-2 text-sm font-medium transition-colors duration-150',
                            navHighlighted
                              ? isProductionMega
                                ? 'bg-[var(--brand-bg-soft)] text-[var(--brand-primary)]'
                                : 'text-[var(--brand-primary)] after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-[var(--brand-primary)]'
                              : 'text-[var(--text-primary)] hover:bg-[var(--bg-muted)]',
                          )}
                        >
                          {menu.label}
                          {menuOpen ? (
                            <ChevronUp className="h-3.5 w-3.5 shrink-0 opacity-80" aria-hidden />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-80" aria-hidden />
                          )}
                        </button>
                      )}
                      {'items' in menu && openMenu === menu.key ? (
                        <div className="absolute left-0 top-full z-[70] pt-1 transition-all duration-150 ease-out">
                          <div className={clsx(
                            'rounded-ds-md border border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-[0_16px_48px_rgba(0,0,0,0.12),0_0_0_1px_rgba(37,99,235,0.08)] dark:shadow-[0_16px_48px_rgba(0,0,0,0.4)]',
                            menu.key === 'live' || menu.key === 'production' || menu.key === 'masters'
                              ? 'w-[780px] max-w-[calc(100vw-2rem)]'
                              : 'w-[520px] max-w-[calc(100vw-2rem)]',
                          )}>
                            {menu.key === 'live' ? (
                              <p className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--brand-primary)]/70">
                                Production Execution
                              </p>
                            ) : null}
                            <div
                              className={clsx(
                                'grid gap-1.5',
                                menu.items.length >= 6 ? 'grid-cols-3' : menu.items.length >= 3 ? 'grid-cols-2' : 'grid-cols-1',
                              )}
                            >
                              {menu.items.map((item) =>
                                isMegaNavItem(item) ? (
                                  <div
                                    key={item.href}
                                  >
                                    <BlockNavLink
                                      item={item}
                                      onNavigate={(href) => {
                                        setOpenMenu(null)
                                        router.push(href)
                                      }}
                                    />
                                  </div>
                                ) : (
                                  <div
                                    key={item.href}
                                  >
                                    <BlockNavLink
                                      item={item}
                                      onNavigate={(href) => {
                                        setOpenMenu(null)
                                        router.push(href)
                                      }}
                                    />
                                  </div>
                                ),
                              )}
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </nav>
          </div>
        </header>
        {mobileOpen ? (
          <div className="fixed inset-x-0 top-14 z-[999] border-b border-[var(--border)] bg-[var(--bg-main)] px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.1)] dark:shadow-[0_12px_40px_rgba(0,0,0,0.35)] lg:hidden">
            <div className="space-y-1">
              {menus.map((menu) =>
                'href' in menu ? (
                  <Link
                    key={menu.key}
                    href={menu.href}
                    className={`block rounded-ds-sm py-[6px] px-[10px] text-sm font-medium transition-colors duration-150 ${
                      isActiveMenu(menu)
                        ? 'bg-[var(--brand-bg-soft)] text-[var(--brand-primary)]'
                        : 'text-[var(--text-primary)] hover:bg-[var(--bg-muted)]'
                    }`}
                  >
                    {menu.label}
                  </Link>
                ) : (
                  <div
                    key={menu.key}
                    className="rounded-ds-md border border-[var(--border)] bg-[var(--bg-card)] p-3"
                  >
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                      {menu.label}
                    </p>
                    {menu.items.map((item) =>
                      isMegaNavItem(item) ? (
                        <MegaNavLink
                          key={item.href}
                          item={{
                            label: item.label,
                            href: item.href,
                            description: item.description ?? '',
                            Icon: item.Icon,
                            iconWrap: item.iconWrap ?? 'bg-[var(--bg-muted)] text-[var(--brand-primary)]',
                          }}
                        />
                      ) : (
                        <button
                          key={item.href}
                          type="button"
                          onClick={() => {
                            setMobileOpen(false)
                            router.push(item.href)
                          }}
                          className="flex h-9 items-center rounded-ds-sm px-2 py-[6px] text-sm text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--brand-bg-soft)] hover:text-[var(--brand-primary)]"
                        >
                          {item.label}
                        </button>
                      ),
                    )}
                  </div>
                ),
              )}
              <div className="mt-2 border-t border-[var(--border)] pt-2">
                <div className="px-[10px] pb-1">
                  <p className="truncate text-sm font-medium text-[var(--text-primary)]">{userName ?? 'User'}</p>
                  <p className="truncate text-xs text-[var(--text-secondary)]">{formatRoleLabel(userRole)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setMobileOpen(false)
                    void signOut({ callbackUrl: '/login' })
                  }}
                  className="flex w-full items-center gap-2 rounded-ds-sm py-[6px] px-[10px] text-sm font-medium text-[var(--text-primary)] transition-colors duration-150 hover:bg-[var(--bg-muted)]"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </div>
            </div>
          </div>
        ) : null}
        <main className="min-h-0 min-w-0 flex-1 overflow-auto bg-ds-main pt-14 lg:pt-[104px]">
          <ErrorBoundary moduleName="Page">{children}</ErrorBoundary>
        </main>
        <Toaster />
      </AppLayout>
    </CommandPaletteProvider>
    </ErrorBoundary>
  )
}
