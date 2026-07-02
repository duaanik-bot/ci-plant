// Two-row top navigation — the Pureflix IMS shell, now role-aware.
// Row 1: dark header (logo + user). Row 2: white nav with orange underline.
import { useState, useRef, useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Package, LogOut, ChevronDown } from 'lucide-react';
import { auth } from '../api.js';

const NAV = [
  { label: 'Dashboard', to: '/', end: true, roles: 'all' },
  { label: 'Orders', to: '/orders', roles: ['admin', 'planner', 'viewer'] },
  { label: 'Planning', to: '/planning', roles: ['admin', 'planner'] },
  { label: 'Artwork', to: '/artwork', roles: ['admin', 'planner', 'qc'] },
  { label: 'Production', to: '/production', roles: ['admin', 'planner', 'production', 'qc', 'viewer'] },
  { label: 'Inventory', to: '/inventory', roles: ['admin', 'planner', 'production', 'qc', 'viewer'] },
  { label: 'Procurement', to: '/procurement', roles: ['admin', 'planner', 'qc'] },
  { label: 'Dispatch', to: '/dispatch', roles: ['admin', 'planner', 'dispatch', 'viewer'] },
  { label: 'Reports', to: '/reports', roles: 'all' },
  { label: 'Masters', to: '/masters', roles: ['admin', 'planner'] },
];

export default function AppLayout() {
  const nav = useNavigate();
  const user = auth.user;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const h = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const items = NAV.filter(i => i.roles === 'all' || i.roles.includes(user?.role));
  const logout = () => { auth.clear(); nav('/login', { replace: true }); };

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
          <div className="relative" ref={menuRef}>
            <button onClick={() => setMenuOpen(o => !o)}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-semibold text-gray-300 hover:bg-white/10">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-500 text-[11px] font-bold text-white">
                {(user?.name || '?').slice(0, 1).toUpperCase()}
              </span>
              <span className="hidden sm:inline">{user?.name}</span>
              <span className="hidden rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] capitalize sm:inline">{user?.role}</span>
              <ChevronDown size={13} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 w-44 animate-fadeIn rounded-lg border border-gray-200 bg-white py-1 shadow-modal">
                <div className="border-b border-gray-100 px-3 py-2">
                  <div className="text-xs font-bold text-gray-900">{user?.name}</div>
                  <div className="text-[11px] text-gray-500">{user?.email}</div>
                </div>
                <button onClick={logout}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-red-600 hover:bg-red-50">
                  <LogOut size={13} /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Row 2 — nav bar with orange active underline */}
      <nav className="no-print sticky top-0 z-40 border-b border-gray-200 bg-white shadow-sm">
        <div className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4">
          {items.map(item => (
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
