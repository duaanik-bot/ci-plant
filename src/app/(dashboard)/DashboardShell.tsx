'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Menu, X } from 'lucide-react'
import { SidebarNav } from './SidebarNav'

export function DashboardShell({
  children,
  canSeeMasters,
  userName,
  userRole,
}: {
  children: React.ReactNode
  canSeeMasters: boolean
  userName: string | null
  userRole: string | undefined
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  return (
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
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between shrink-0">
          <Link href="/" className="flex flex-col" onClick={() => setMobileMenuOpen(false)}>
            <span className="text-sm font-semibold tracking-wide text-amber-400">
              COLOUR IMPRESSIONS
            </span>
            <span className="text-xs text-slate-500">Plant System</span>
          </Link>
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
        {/* Mobile header */}
        <header className="md:hidden border-b border-slate-800 px-4 py-2 flex items-center justify-between shrink-0">
          <Link href="/" className="font-semibold text-amber-400">
            CI Plant
          </Link>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 truncate max-w-[120px]">
              {userName} · {userRole}
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
        <main className="min-h-screen bg-slate-900 flex-1">{children}</main>
      </div>
    </div>
  )
}
