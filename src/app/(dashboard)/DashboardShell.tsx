'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import {
  CommandPaletteProvider,
  CommandPaletteTrigger,
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

export function DashboardShell({
  children,
}: {
  children: React.ReactNode
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const pathname = usePathname()
  const router = useRouter()
  const { data: session, status } = useSession()
  const userName = session?.user?.name ?? null
  const userRole = session?.user?.role as string | undefined
  const canSeeMasters = userRole === 'operations_head' || userRole === 'md'
  const navRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setOpenMenu(null)
  }, [pathname])

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login')
  }, [status, router])

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

  const menus = useMemo(
    () =>
      [
        { key: 'director', label: 'Director Command Centre', href: '/director/command-center' },
        {
          key: 'orders',
          label: 'Orders',
          items: [
            { label: 'Customer POs', href: '/orders/purchase-orders' },
            { label: 'Planning', href: '/orders/planning' },
            { label: 'Artwork Queue', href: '/orders/designing' },
            { label: 'Job Cards', href: '/production/job-cards' },
          ],
        },
        {
          key: 'tooling',
          label: 'Tooling',
          items: [
            { label: 'Plates', href: '/hub/plates' },
            { label: 'Dies', href: '/hub/dies' },
            { label: 'Embossing Blocks', href: '/hub/blocks' },
            { label: 'Shade Cards', href: '/hub/shade-card-hub' },
          ],
        },
        {
          key: 'production',
          label: 'Production',
          items: [
            { label: 'Print Planning', href: '/production/print-planning' },
            { label: 'Coating Planning', href: '/production/machine-flow?stage=coating' },
            { label: 'Die Planning', href: '/production/machine-flow?stage=die' },
            { label: 'Pasting Planning', href: '/production/machine-flow?stage=pasting' },
          ],
        },
        {
          key: 'live',
          label: 'Live',
          items: [
            { label: 'Cutting', href: '/production/cutting-queue' },
            { label: 'Printing', href: '/production/stages/printing' },
            { label: 'Coating', href: '/production/stages/coating' },
            { label: 'Die', href: '/production/stages/dye-cutting' },
            { label: 'Pasting', href: '/production/stages/pasting' },
            { label: 'Billing', href: '/billing' },
            { label: 'Short & Excess', href: '/stores/approve-excess' },
          ],
        },
        {
          key: 'procurement',
          label: 'Procurement',
          items: [
            { label: 'Purchase Requests', href: '/inventory/purchase-requisitions' },
            { label: 'GRN', href: '/inventory/grn' },
          ],
        },
        {
          key: 'inventory',
          label: 'Inventory',
          items: [
            { label: 'Paper Warehouse', href: '/inventory#paper-ledger' },
            { label: 'FG Warehouse', href: '/inventory#fg-ledger' },
          ],
        },
        {
          key: 'stores',
          label: 'Stores',
          items: [
            { label: 'Issue Sheets', href: '/stores/issue' },
            { label: 'Approve Excess', href: '/stores/approve-excess' },
          ],
        },
        { key: 'quality', label: 'Quality', items: [{ label: 'Quality Control', href: '/qms/qc' }] },
        {
          key: 'reports',
          label: 'Reports',
          items: [
            { label: 'MD Dashboard', href: '/reports/dashboard' },
            { label: 'Production Summary', href: '/reports/production' },
            { label: 'Wastage Report', href: '/reports/wastage' },
          ],
        },
        {
          key: 'masters',
          label: 'Masters',
          hidden: !canSeeMasters,
          items: [
            { label: 'Customers', href: '/masters/customers' },
            { label: 'Suppliers', href: '/masters/suppliers' },
            { label: 'Cartons', href: '/masters/cartons' },
            { label: 'Materials', href: '/masters/materials' },
            { label: 'Machines', href: '/masters/machines' },
            { label: 'Users', href: '/masters/users' },
            { label: 'Department', href: '/masters/departments' },
            { label: 'Employee', href: '/masters/employees' },
            { label: 'QC Instrument', href: '/masters/instruments' },
          ],
        },
      ].filter((m) => !('hidden' in m && m.hidden)),
    [canSeeMasters],
  )

  const isActiveMenu = (menu: (typeof menus)[number]) => {
    if ('href' in menu) return pathname === menu.href || pathname.startsWith(menu.href + '/')
    return menu.items.some((it) => pathname === it.href || pathname.startsWith(it.href.split('?')[0] + '/'))
  }

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
      <AppLayout className="flex flex-col">
        <header
          ref={navRef}
          className="sticky top-0 z-50 h-14 border-b border-ds-line bg-white dark:bg-ds-main"
        >
          <div className="mx-auto flex h-full w-full items-center gap-4 px-4">
            <Link href="/dashboard" className="shrink-0 text-sm font-semibold tracking-wide text-ds-ink">
              Colour Impressions
            </Link>
            <nav className="min-w-0 flex-1">
              <ul className="flex items-center gap-1 overflow-x-auto whitespace-nowrap">
                {menus.map((menu) => (
                  <li
                    key={menu.key}
                    className="relative"
                    onMouseEnter={() => {
                      if (!('href' in menu)) setOpenMenu(menu.key)
                    }}
                  >
                    {'href' in menu ? (
                      <Link
                        href={menu.href}
                        className={`rounded-ds-sm px-3 py-2 text-sm transition-colors ${
                          isActiveMenu(menu) ? 'bg-ds-brand text-white' : 'text-ds-ink hover:bg-ds-main'
                        }`}
                      >
                        {menu.label}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setOpenMenu((prev) => (prev === menu.key ? null : menu.key))}
                        className={`rounded-ds-sm px-3 py-2 text-sm transition-colors ${
                          isActiveMenu(menu) ? 'bg-ds-brand text-white' : 'text-ds-ink hover:bg-ds-main'
                        }`}
                      >
                        {menu.label}
                      </button>
                    )}
                    {'items' in menu && openMenu === menu.key ? (
                      <div
                        className="absolute left-0 top-[calc(100%+2px)] w-[720px] max-w-[92vw] rounded-ds-md border border-ds-line bg-ds-card p-4 shadow-sm"
                        onMouseLeave={() => setOpenMenu(null)}
                      >
                        <div className="grid grid-cols-3 gap-2">
                          {menu.items.map((item) => (
                            <Link
                              key={item.href}
                              href={item.href}
                              className="rounded-ds-sm px-3 py-2 text-sm text-ds-ink transition hover:bg-ds-main"
                            >
                              {item.label}
                            </Link>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </nav>
            <div className="flex shrink-0 items-center gap-2">
              <div className="hidden sm:block min-w-[220px]">
                <CommandPaletteTrigger />
              </div>
              <ThemeToggle />
              <span className="max-w-[220px] truncate text-xs text-ds-ink-faint">
                {userName ? `${userName} · ${userRole ?? '—'}` : 'User'}
              </span>
            </div>
          </div>
        </header>
        <main className="min-h-0 min-w-0 flex-1 overflow-auto bg-ds-main">
          <ErrorBoundary moduleName="Page">{children}</ErrorBoundary>
        </main>
      </AppLayout>
    </CommandPaletteProvider>
  )
}
