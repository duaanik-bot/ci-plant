'use client'

import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { hasModuleAccess, type ModuleKey } from '@/lib/rbac'
import {
  LayoutDashboard,
  FileText,
  ShoppingCart,
  CalendarCheck,
  Image,
  ClipboardCheck,
  AlertTriangle,
  Factory,
  Layers,
  Warehouse,
  RefreshCw,
  FileStack,
  Receipt,
  MapPin,
  Users,
  Truck,
  Package,
  Droplets,
  Cpu,
  UserCog,
  BarChart3,
  Crosshair,
  Flame,
  FileSpreadsheet,
  PackageCheck,
  CheckSquare,
  Download,
  FlaskConical,
  Palette,
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  Scissors,
} from 'lucide-react'

const STORAGE_KEY = 'ci-plant-sidebar-sections'

const defaultOpen: Record<string, boolean> = {
  dashboard: true,
  orders: true,
  design: true,
  tools: true,
  execution: true,
  production: true,
  inventory: true,
  stores: true,
  quality: true,
  dispatch: true,
  reports: true,
  masters: true,
}

function loadStored(): Record<string, boolean> {
  if (typeof window === 'undefined') return { ...defaultOpen }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...defaultOpen }
    const parsed = JSON.parse(raw) as Record<string, boolean>
    const merged = { ...defaultOpen, ...parsed }
    if (parsed.planning !== undefined && parsed.execution === undefined) {
      merged.execution = parsed.planning
    }
    return merged
  } catch {
    return { ...defaultOpen }
  }
}

function saveStored(state: Record<string, boolean>) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {}
}

type NavLink = { href: string; label: string; icon: React.ComponentType<{ className?: string }>; external?: boolean; module?: ModuleKey }
type NavSection = {
  key: string
  title: string
  subtitle?: string
  borderColor: string
  links: NavLink[]
  show?: boolean
  module?: ModuleKey
}

function NavItem({
  href,
  label,
  icon: Icon,
  isActive,
  external,
}: {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  isActive: boolean
  external?: boolean
}) {
  const router = useRouter()
  const className = isActive
    ? 'flex items-center gap-2 px-2 py-1.5 rounded-ds-sm bg-ds-brand text-white shadow-sm'
    : 'flex items-center gap-2 px-2 py-1.5 rounded-ds-sm text-ds-ink-muted transition duration-200 hover:bg-ds-elevated/80 hover:text-ds-ink'
  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span>{label}</span>
      </a>
    )
  }
  return (
    <Link
      href={href}
      prefetch={false}
      onMouseEnter={() => router.prefetch(href)}
      onFocus={() => router.prefetch(href)}
      className={className}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span>{label}</span>
    </Link>
  )
}

export function SidebarNav({
  userName,
  userRole,
}: {
  userName: string | null
  userRole: string | undefined
}) {
  const pathname = usePathname()
  const [open, setOpen] = useState<Record<string, boolean>>(defaultOpen)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setOpen(loadStored())
    setHydrated(true)
  }, [])

  const toggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      saveStored(next)
      return next
    })
  }, [])

  const linkVisible = (l: NavLink) => !l.module || hasModuleAccess(userRole, l.module)

  const sections: NavSection[] = [
    {
      key: 'dashboard',
      title: '📊 DASHBOARD',
      borderColor: 'border-l-blue-500',
      links: [
        { href: '/', label: 'Dashboard', icon: LayoutDashboard },
        { href: '/director/command-center', label: 'Director Command Center', icon: Crosshair },
      ],
    },
    {
      key: 'orders',
      title: '📋 ORDERS',
      borderColor: 'border-l-blue-500',
      links: [
        { href: '/rfq', label: 'RFQ Pipeline', icon: FileText, module: 'customer_po' },
        { href: '/orders/purchase-orders', label: 'Customer POs', icon: ShoppingCart, module: 'customer_po' },
        { href: '/orders/planning', label: 'Planning', icon: CalendarCheck, module: 'planning' },
        { href: '/orders/designing', label: 'Artwork Queue', icon: Image, module: 'artwork_queue' },
        { href: '/production/job-cards', label: 'Job Cards', icon: FileStack, module: 'job_cards' },
      ],
    },
    {
      key: 'tools',
      title: '🔧 TOOLING HUB',
      subtitle: 'Plates, dies, blocks, and shade cards',
      borderColor: 'border-l-emerald-500',
      module: 'tooling_hub',
      links: [
        { href: '/hub/plates', label: 'Plates', icon: Layers },
        { href: '/hub/dies', label: 'Dies', icon: Droplets },
        { href: '/hub/blocks', label: 'Embossing blocks', icon: Package },
        { href: '/hub/shade-card-hub', label: 'Shade Card Hub', icon: Palette },
      ],
    },
    {
      key: 'execution',
      title: '🏭 PRODUCTION EXECUTION',
      borderColor: 'border-l-orange-500',
      module: 'planning',
      links: [
        { href: '/production/print-planning', label: 'Print Planning', icon: LayoutGrid },
      ],
    },
    {
      key: 'production',
      title: '🏭 PRODUCTION',
      borderColor: 'border-l-rose-500',
      links: [
        { href: '/production/stages', label: 'Live Production', icon: Factory, module: 'cutting' },
        { href: '/production/cutting-queue', label: 'Cutting queue', icon: Scissors, module: 'cutting' },
      ],
    },
    {
      key: 'inventory',
      title: '📦 INVENTORY',
      borderColor: 'border-l-teal-500',
      links: [
        { href: '/inventory', label: 'Raw Materials', icon: Warehouse, module: 'paper_warehouse' },
        { href: '/inventory/flow', label: 'Inventory Flow', icon: RefreshCw, module: 'inventory' },
      ],
    },
    {
      key: 'stores',
      title: '🏪 STORES',
      borderColor: 'border-l-ds-warning/90',
      module: 'stores',
      links: [
        { href: '/stores/issue', label: 'Issue Sheets', icon: PackageCheck },
        { href: '/stores/approve-excess', label: 'Approve Excess', icon: CheckSquare },
      ],
    },
    {
      key: 'quality',
      title: '✅ QUALITY',
      borderColor: 'border-l-lime-500',
      module: 'quality',
      links: [
        { href: '/qms/qc', label: 'QC Records', icon: ClipboardCheck },
        { href: '/qms/ncr', label: 'NCR / CAPA', icon: AlertTriangle },
      ],
    },
    {
      key: 'dispatch',
      title: '🚚 DISPATCH',
      borderColor: 'border-l-indigo-500',
      module: 'dispatch',
      links: [
        { href: '/dispatch', label: 'Dispatch Planning', icon: Truck },
        { href: '/dispatch/tracking', label: 'Deliveries', icon: MapPin },
        { href: '/billing', label: 'Invoices', icon: Receipt },
        { href: '/short-excess', label: 'Short & Excess', icon: AlertTriangle },
      ],
    },
    {
      key: 'reports',
      title: '📈 REPORTS',
      borderColor: 'border-l-purple-500',
      module: 'reports',
      links: [
        { href: '/reports/dashboard', label: 'MD Dashboard', icon: BarChart3 },
        { href: '/reports/production', label: 'Production Summary', icon: BarChart3 },
        { href: '/reports/wastage', label: 'Wastage Report', icon: Flame },
        { href: '/reports/schedule-m', label: 'Schedule M', icon: FileSpreadsheet },
      ],
    },
    {
      key: 'masters',
      title: '⚙️ MASTERS',
      borderColor: 'border-l-violet-500',
      module: 'masters',
      links: [
        { href: '/masters/customers', label: 'Customers', icon: Users },
        { href: '/masters/suppliers', label: 'Suppliers', icon: Truck },
        { href: '/masters/cartons', label: 'Cartons', icon: Package },
        { href: '/masters/materials', label: 'Materials', icon: Package },
        { href: '/masters/machines', label: 'Machines', icon: Cpu },
        { href: '/masters/users', label: 'Users', icon: UserCog },
        { href: '/masters/instruments', label: 'QC Instruments', icon: FlaskConical },
        { href: '/masters/minimasters', label: 'MiniMasters', icon: Palette },
      ],
    },
  ]

  const isActive = (href: string) => {
    const pathOnly = href.split('?')[0] || href
    if (pathOnly === '/') return pathname === '/'
    return pathname === pathOnly || pathname.startsWith(pathOnly + '/')
  }

  return (
    <>
      {sections.map((section) => {
        if (section.show === false) return null
        const links = section.links.filter(linkVisible)
        if (links.length === 0) return null
        if (section.module && !hasModuleAccess(userRole, section.module)) return null
        const isOpen = hydrated ? open[section.key] !== false : true
        return (
          <div
            key={section.key}
            className={`border-l-4 ${section.borderColor} pl-2 pr-1 py-1`}
          >
            <button
              type="button"
              onClick={() => toggle(section.key)}
            className="w-full flex items-center justify-between rounded-ds-sm px-1 py-1.5 text-left text-xs font-medium uppercase tracking-wider text-ds-ink-faint transition hover:text-ds-ink"
            >
              <span>{section.title}</span>
              {isOpen ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              )}
            </button>
            {section.subtitle && (
              <p className="mb-1 mt-0 px-1 text-xs text-ds-ink-faint">{section.subtitle}</p>
            )}
            {isOpen && (
              <div className="space-y-0.5">
                {links.map((link) => (
                  <NavItem
                    key={link.href}
                    href={link.href}
                    label={link.label}
                    icon={link.icon}
                    isActive={isActive(link.href)}
                    external={link.external}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
      <div className="mt-auto border-t border-ds-line/40 px-2 pt-4">
        <p className="truncate text-xs font-medium text-ds-ink">
          {userName ?? 'User'} <span className="text-ds-ink-faint">· {userRole ?? '—'}</span>
        </p>
        <Link
          href="/api/auth/signout"
          className="mt-1.5 inline-block text-xs text-ds-ink-muted transition hover:text-ds-brand"
        >
          Logout
        </Link>
      </div>
    </>
  )
}
