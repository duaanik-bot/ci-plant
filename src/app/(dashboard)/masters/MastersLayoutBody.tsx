'use client'

import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Boxes,
  Building2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Cpu,
  Droplets,
  Package,
  Truck,
  UserCog,
  Users,
} from 'lucide-react'
import { ErrorBoundary } from '@/components/ErrorBoundary'

type MasterItem = {
  label: string
  href: string
  icon: React.ComponentType<{ className?: string }>
}

type MasterGroup = {
  key: string
  label: string
  items: MasterItem[]
}

const GROUPS: MasterGroup[] = [
  {
    key: 'business',
    label: 'Business',
    items: [
      { label: 'Customers', href: '/masters/customers', icon: Users },
      { label: 'Suppliers', href: '/masters/suppliers', icon: Truck },
    ],
  },
  {
    key: 'product-system',
    label: 'Product System',
    items: [
      { label: 'Cartons', href: '/masters/cartons', icon: Package },
      { label: 'Materials', href: '/masters/materials', icon: Boxes },
      { label: 'MiniMasters', href: '/masters/minimasters', icon: Droplets },
    ],
  },
  {
    key: 'operations',
    label: 'Operations',
    items: [
      { label: 'Machines', href: '/masters/machines', icon: Cpu },
      { label: 'QC Instruments', href: '/masters/instruments', icon: ClipboardCheck },
    ],
  },
  {
    key: 'organization',
    label: 'Organization',
    items: [
      { label: 'Users', href: '/masters/users', icon: UserCog },
      { label: 'Employees', href: '/masters/employees', icon: Users },
      { label: 'Departments', href: '/masters/departments', icon: Building2 },
    ],
  },
]

function pathIsActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function MastersLayoutBody({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const [openGroup, setOpenGroup] = useState<string>('business')
  const [search, setSearch] = useState('')

  const activeGroupKey = useMemo(() => {
    for (const g of GROUPS) {
      if (g.items.some((item) => pathIsActive(pathname, item.href))) return g.key
    }
    return 'business'
  }, [pathname])

  useEffect(() => {
    setOpenGroup(activeGroupKey)
  }, [activeGroupKey])

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return GROUPS
    return GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((item) => item.label.toLowerCase().includes(q)),
    })).filter((g) => g.items.length > 0)
  }, [search])

  return (
    <ErrorBoundary moduleName="Masters">
      <div className="grid gap-4 md:grid-cols-[260px_1fr]">
        <aside className="h-fit rounded-lg border border-ds-line/60 bg-card p-2">
          <div className="mb-2 px-1">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search masters..."
              className="ds-input h-9 w-full text-sm"
              aria-label="Search masters modules"
            />
          </div>

          <nav className="space-y-1" aria-label="Masters sections">
            {filteredGroups.map((group) => {
              const isOpen = openGroup === group.key
              const hasActiveItem = group.items.some((item) => pathIsActive(pathname, item.href))

              return (
                <section
                  key={group.key}
                  className={`rounded-md border ${
                    hasActiveItem
                      ? 'border-ds-brand/35 bg-ds-brand/5'
                      : 'border-ds-line/50 bg-transparent'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setOpenGroup((curr) => (curr === group.key ? '' : group.key))}
                    className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm font-medium text-ds-ink hover:bg-ds-elevated/40"
                    aria-expanded={isOpen}
                  >
                    <span>{group.label}</span>
                    {isOpen ? <ChevronDown className="h-4 w-4 text-ds-ink-faint" /> : <ChevronRight className="h-4 w-4 text-ds-ink-faint" />}
                  </button>

                  {isOpen ? (
                    <div className="space-y-0.5 px-1 pb-1">
                      {group.items.map((item) => {
                        const active = pathIsActive(pathname, item.href)
                        const Icon = item.icon
                        return (
                          <Link
                            key={item.href}
                            href={item.href}
                            className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors ${
                              active
                                ? 'bg-ds-brand/15 text-ds-ink ring-1 ring-ds-brand/30'
                                : 'text-ds-ink-muted hover:bg-ds-elevated/40 hover:text-ds-ink'
                            }`}
                          >
                            <Icon className="h-4 w-4 shrink-0" />
                            <span>{item.label}</span>
                          </Link>
                        )
                      })}
                    </div>
                  ) : null}
                </section>
              )
            })}

            {filteredGroups.length === 0 ? (
              <p className="px-2 py-2 text-xs text-ds-ink-faint">No matching modules.</p>
            ) : null}
          </nav>
        </aside>

        <div className="min-w-0">{children}</div>
      </div>
    </ErrorBoundary>
  )
}
