// App shell — modern SaaS sidebar. Dark ink rail with grouped, role-aware nav;
// light content pane with a slim top bar. Pureflix indigo accents throughout.
import { useState, useRef, useEffect } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  Package, LogOut, ChevronDown, LayoutDashboard, Radio, Route as RouteIcon,
  ShoppingCart, Truck, CalendarClock, Palette, ClipboardList, ShoppingBag,
  Warehouse, BarChart3, Settings2, Menu, X,
} from 'lucide-react';
import { auth } from '../api.js';

const NAV = [
  {
    group: 'Overview',
    items: [
      { label: 'Dashboard', to: '/', end: true, icon: LayoutDashboard, roles: 'all' },
      { label: 'Live Floor', to: '/floor', icon: Radio, roles: 'all' },
      { label: 'Track', to: '/track', icon: RouteIcon, roles: 'all' },
    ],
  },
  {
    group: 'Sales',
    items: [
      { label: 'Sales Orders', to: '/orders', icon: ShoppingCart, roles: ['admin', 'planner', 'viewer'] },
      { label: 'Dispatch', to: '/dispatch', icon: Truck, roles: ['admin', 'planner', 'dispatch', 'viewer'] },
    ],
  },
  {
    group: 'Production',
    items: [
      { label: 'Planning', to: '/planning', icon: CalendarClock, roles: ['admin', 'planner'] },
      { label: 'Artwork', to: '/artwork', icon: Palette, roles: ['admin', 'planner', 'qc'] },
      { label: 'Job Cards', to: '/production', icon: ClipboardList, roles: ['admin', 'planner', 'production', 'qc', 'viewer'] },
    ],
  },
  {
    group: 'Supply',
    items: [
      { label: 'Procurement', to: '/procurement', icon: ShoppingBag, roles: ['admin', 'planner', 'qc'] },
      { label: 'Warehouse', to: '/inventory', icon: Warehouse, roles: ['admin', 'planner', 'production', 'qc', 'viewer'] },
    ],
  },
  {
    group: 'Admin',
    items: [
      { label: 'Reports', to: '/reports', icon: BarChart3, roles: 'all' },
      { label: 'Masters', to: '/masters', icon: Settings2, roles: ['admin', 'planner'] },
    ],
  },
];

function NavItem({ item, onNavigate }) {
  return (
    <NavLink to={item.to} end={item.end} onClick={onNavigate}
      className={({ isActive }) =>
        `group flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium transition-colors ${
          isActive
            ? 'bg-brand-500/15 text-brand-200'
            : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
        }`}>
      {({ isActive }) => (
        <>
          <item.icon size={15} className={isActive ? 'text-brand-300' : 'text-slate-500 group-hover:text-slate-300'} />
          {item.label}
          {isActive && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-brand-400" />}
        </>
      )}
    </NavLink>
  );
}

export default function AppLayout() {
  const nav = useNavigate();
  const location = useLocation();
  const user = auth.user;
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const h = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  const groups = NAV.map(g => ({
    ...g,
    items: g.items.filter(i => i.roles === 'all' || i.roles.includes(user?.role)),
  })).filter(g => g.items.length > 0);

  const logout = () => { auth.clear(); nav('/login', { replace: true }); };

  const sidebar = (
    <div className="flex h-full flex-col bg-gradient-to-b from-ink-950 via-ink-900 to-ink-950">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 pb-5 pt-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 shadow-glow">
          <Package size={16} className="text-white" />
        </span>
        <div className="leading-tight">
          <div className="text-[13px] font-extrabold tracking-wide text-white">COLOUR IMPRESSIONS</div>
          <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">Plant ERP</div>
        </div>
      </div>

      {/* Nav groups */}
      <nav className="scrollbar-none flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {groups.map(g => (
          <div key={g.group}>
            <div className="mb-1.5 px-2.5 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-600">{g.group}</div>
            <div className="space-y-0.5">
              {g.items.map(i => <NavItem key={i.to} item={i} onNavigate={() => setMobileOpen(false)} />)}
            </div>
          </div>
        ))}
      </nav>

      {/* User */}
      <div className="border-t border-white/5 p-3" ref={menuRef}>
        <div className="relative">
          {menuOpen && (
            <div className="absolute bottom-full left-0 z-50 mb-2 w-full animate-fadeIn rounded-xl border border-slate-200 bg-white py-1 shadow-modal">
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
          <button onClick={() => setMenuOpen(o => !o)}
            className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-white/5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-700 text-xs font-bold text-white">
              {(user?.name || '?').slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold text-slate-200">{user?.name}</span>
              <span className="block text-[11px] capitalize text-slate-500">{user?.role}</span>
            </span>
            <ChevronDown size={13} className="text-slate-500" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="no-print fixed inset-y-0 left-0 z-40 hidden w-[232px] lg:block">{sidebar}</aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="no-print fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/60" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[248px] animate-slideUp">{sidebar}</aside>
        </div>
      )}

      {/* Content */}
      <div className="min-w-0 flex-1 lg:pl-[232px]">
        {/* Mobile top bar */}
        <div className="no-print sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white/80 px-4 py-2.5 backdrop-blur lg:hidden">
          <button onClick={() => setMobileOpen(o => !o)} className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100">
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          <span className="text-sm font-extrabold tracking-wide text-slate-900">COLOUR IMPRESSIONS</span>
        </div>
        <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
