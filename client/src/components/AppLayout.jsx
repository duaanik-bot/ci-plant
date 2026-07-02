// Two-row top navigation — the Pureflix IMS shell.
// Row 1: dark header (logo + company). Row 2: white nav with orange underline.
import { NavLink, Outlet } from 'react-router-dom';
import { Package } from 'lucide-react';

const NAV = [
  { label: 'Dashboard', to: '/' , end: true },
  { label: 'Orders', to: '/orders' },
  { label: 'Planning', to: '/planning' },
  { label: 'Artwork', to: '/artwork' },
  { label: 'Production', to: '/production' },
  { label: 'Inventory', to: '/inventory' },
  { label: 'Procurement', to: '/procurement' },
  { label: 'Dispatch', to: '/dispatch' },
  { label: 'Reports', to: '/reports' },
  { label: 'Masters', to: '/masters' },
];

export default function AppLayout() {
  return (
    <div className="min-h-screen">
      {/* Row 1 — dark header */}
      <header className="no-print bg-ink-900">
        <div className="mx-auto flex h-12 max-w-7xl items-center justify-between px-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500">
              <Package size={15} className="text-white" />
            </span>
            <span className="text-sm font-bold tracking-wide text-white">
              COLOUR IMPRESSIONS
              <span className="ml-2 hidden font-medium text-gray-400 sm:inline">Plant ERP</span>
            </span>
          </div>
          <span className="text-xs font-medium text-gray-400">
            {new Date().toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
          </span>
        </div>
      </header>

      {/* Row 2 — nav bar with orange active underline */}
      <nav className="no-print sticky top-0 z-40 border-b border-gray-200 bg-white shadow-sm">
        <div className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4">
          {NAV.map(item => (
            <NavLink key={item.to} to={item.to} end={item.end}
              className={({ isActive }) =>
                `whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-semibold transition-colors ${
                  isActive
                    ? 'border-brand-500 text-brand-600'
                    : 'border-transparent text-gray-500 hover:border-gray-200 hover:text-gray-800'
                }`}>
              {item.label}
            </NavLink>
          ))}
        </div>
      </nav>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
