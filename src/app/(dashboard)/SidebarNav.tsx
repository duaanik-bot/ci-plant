'use client'

import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
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
  Tablet,
  Gauge,
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
} from 'lucide-react'

const STORAGE_KEY = 'ci-plant-sidebar-sections'

const defaultOpen: Record<string, boolean> = {
  dashboard: true,
  orders: true,
  design: true,
  tools: true,
  planning: true,
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
    return { ...defaultOpen, ...parsed }
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

type NavLink = { href: string; label: string; icon: React.ComponentType<{ className?: string }>; external?: boolean }
type NavSection = {
  key: string
  title: string
  subtitle?: string
  borderColor: string
  links: NavLink[]
  show?: boolean
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
    ? 'flex items-center gap-2 px-2 py-1.5 rounded-md bg-blue-600 text-white'
    : 'flex items-center gap-2 px-2 py-1.5 rounded-md text-slate-300 hover:bg-slate-700 hover:text-white'
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
  canSeeMasters,
  userName,
  userRole,
}: {
  canSeeMasters: boolean
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
      borderColor: 'border-l-cyan-500',
      links: [
        { href: '/rfq', label: 'RFQ Pipeline', icon: FileText },
        { href: '/orders/purchase-orders', label: 'Customer POs', icon: ShoppingCart },
        { href: '/orders/procurement', label: 'Procurement Workbench', icon: PackageCheck },
      ],
    },
    {
      key: 'design',
      title: '🎨 ARTWORK QUEUE',
      borderColor: 'border-l-amber-500',
      links: [{ href: '/orders/designing', label: 'Artwork Queue', icon: Image }],
    },
    {
      key: 'tools',
      title: '🔧 TOOLING HUB',
      subtitle: 'Plates, dies, blocks, and shade cards',
      borderColor: 'border-l-emerald-500',
      links: [
        { href: '/hub/plates', label: 'Plates', icon: Layers },
        { href: '/hub/dies', label: 'Dies', icon: Droplets },
        { href: '/hub/blocks', label: 'Embossing blocks', icon: Package },
        { href: '/hub/shade_cards', label: 'Shade cards', icon: Palette },
      ],
    },
    {
      key: 'planning',
      title: '📅 PLANNING',
      borderColor: 'border-l-orange-500',
      links: [
        { href: '/orders/planning', label: 'Planning Queue', icon: CalendarCheck },
        { href: '/production/job-cards', label: 'Job Cards', icon: FileStack },
        { href: '/production/stages', label: 'Production Planning', icon: Cpu },
      ],
    },
    {
      key: 'production',
      title: '🏭 PRODUCTION',
      borderColor: 'border-l-rose-500',
      links: [
        { href: '/production/stages', label: 'Live Production', icon: Factory },
        { href: '/workflow', label: 'Job Tracking', icon: RefreshCw },
        { href: '/shopfloor', label: 'Shop Floor Tablet', icon: Tablet },
        { href: '/oee', label: 'OEE Live', icon: Gauge },
      ],
    },
    {
      key: 'inventory',
      title: '📦 INVENTORY',
      borderColor: 'border-l-teal-500',
      links: [
        { href: '/inventory', label: 'Raw Materials', icon: Warehouse },
        { href: '/inventory/flow', label: 'Inventory Flow', icon: RefreshCw },
        { href: '/inventory/purchase-requisitions', label: 'Purchase Requests', icon: FileStack },
        { href: '/inventory/grn', label: 'GRN', icon: Download },
      ],
    },
    {
      key: 'stores',
      title: '🏪 STORES',
      borderColor: 'border-l-orange-500',
      links: [
        { href: '/stores/issue', label: 'Issue Sheets', icon: PackageCheck },
        { href: '/stores/approve-excess', label: 'Approve Excess', icon: CheckSquare },
      ],
    },
    {
      key: 'quality',
      title: '✅ QUALITY',
      borderColor: 'border-l-lime-500',
      links: [
        { href: '/qms/qc', label: 'QC Records', icon: ClipboardCheck },
        { href: '/qms/ncr', label: 'NCR / CAPA', icon: AlertTriangle },
      ],
    },
    {
      key: 'dispatch',
      title: '🚚 DISPATCH',
      borderColor: 'border-l-indigo-500',
      links: [
        { href: '/dispatch', label: 'Dispatch Planning', icon: Truck },
        { href: '/dispatch/tracking', label: 'Deliveries', icon: MapPin },
        { href: '/billing', label: 'Invoices', icon: Receipt },
      ],
    },
    {
      key: 'reports',
      title: '📈 REPORTS',
      borderColor: 'border-l-purple-500',
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
      links: [
        { href: '/masters/customers', label: 'Customers', icon: Users },
        { href: '/masters/suppliers', label: 'Suppliers', icon: Truck },
        { href: '/masters/cartons', label: 'Cartons', icon: Package },
        { href: '/masters/materials', label: 'Materials', icon: Package },
        { href: '/masters/machines', label: 'Machines', icon: Cpu },
        { href: '/masters/users', label: 'Users', icon: UserCog },
        { href: '/masters/instruments', label: 'QC Instruments', icon: FlaskConical },
      ],
      show: canSeeMasters,
    },
  ]

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/'
    return pathname === href || pathname.startsWith(href + '/')
  }

  return (
    <>
      {sections.map((section) => {
        if (section.show === false) return null
        const isOpen = hydrated ? open[section.key] !== false : true
        return (
          <div
            key={section.key}
            className={`border-l-4 ${section.borderColor} pl-2 pr-1 py-1`}
          >
            <button
              type="button"
              onClick={() => toggle(section.key)}
              className="w-full flex items-center justify-between text-left uppercase text-xs tracking-wider text-slate-400 hover:text-slate-200 py-1.5 px-1 rounded"
            >
              <span>{section.title}</span>
              {isOpen ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              )}
            </button>
            {section.subtitle && (
              <p className="text-[10px] text-slate-500 px-1 mb-1 mt-0">{section.subtitle}</p>
            )}
            {isOpen && (
              <div className="space-y-0.5">
                {section.links.map((link) => (
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
      <div className="mt-auto pt-4 border-t border-slate-800 px-2">
        <p className="font-medium text-slate-200 text-xs truncate">
          {userName ?? 'User'} <span className="text-slate-500">· {userRole ?? '—'}</span>
        </p>
        <Link
          href="/api/auth/signout"
          className="inline-block mt-1.5 text-xs text-slate-400 hover:text-amber-400"
        >
          Logout
        </Link>
      </div>
    </>
  )
}
