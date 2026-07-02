// App shell — the Pureflix luminous rail, adapted for the plant.
// Light gradient sidebar with glow-pill active states; content pane sits on
// #FBFCFF behind a rounded seam. Role-aware grouped nav, mobile drawer.
import { useState, useRef, useEffect } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  Package, LogOut, LayoutDashboard, Radio, Route as RouteIcon,
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

const ACTIVE_PILL =
  'bg-gradient-to-br from-white via-blue-50 to-indigo-100 text-indigo-800 ' +
  'shadow-[0_12px_26px_rgba(79,70,229,0.16),inset_0_1px_0_rgba(255,255,255,0.98),inset_0_-1px_0_rgba(79,70,229,0.10)] ring-1 ring-white/90';
const IDLE_PILL =
  'text-slate-600 hover:bg-white/75 hover:text-indigo-800 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.85)]';

function NavItem({ item }) {
  return (
    <NavLink to={item.to} end={item.end}
      className={({ isActive }) =>
        `flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-semibold transition-all ${isActive ? ACTIVE_PILL : IDLE_PILL}`}>
      {({ isActive }) => (
        <>
          <item.icon size={15} className={`shrink-0 ${isActive ? 'text-indigo-700' : 'text-slate-500'}`} />
          <span className="truncate">{item.label}</span>
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
    <div className="flex h-full flex-col rounded-r-[28px] border-r border-white/80
      bg-[linear-gradient(155deg,#F9FBFF_0%,#EEF5FF_36%,#F6F0FF_68%,#FFF8EA_100%)]
      shadow-[18px_0_45px_rgba(79,70,229,0.12),inset_-1px_0_0_rgba(255,255,255,0.85),inset_0_1px_0_rgba(255,255,255,0.9)]">
      {/* Wordmark */}
      <div className="px-4 pb-4 pt-7">
        <div className="flex items-center gap-2.5 px-1">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 shadow-[0_8px_18px_rgba(79,70,229,0.25)]">
            <Package size={17} className="text-white" />
          </span>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[15px] font-black tracking-tight text-slate-950">
              Colour<span className="text-indigo-700"> Impressions</span><span className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-indigo-700 align-middle" />
            </div>
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400">Plant ERP</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="scrollbar-none flex-1 space-y-4 overflow-y-auto px-3 pb-4">
        {groups.map(g => (
          <div key={g.group}>
            <div className="mb-1 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">{g.group}</div>
            <div className="space-y-0.5">
              {g.items.map(i => <NavItem key={i.to} item={i} />)}
            </div>
          </div>
        ))}
      </nav>

      {/* User */}
      <div className="border-t border-white/70 bg-white/45 px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]" ref={menuRef}>
        <div className="relative">
          {menuOpen && (
            <div className="absolute bottom-full left-0 z-50 mb-2 w-full animate-fadeIn rounded-xl border border-slate-200 bg-white py-1 shadow-modal">
              <div className="border-b border-slate-100 px-3 py-2">
                <div className="text-xs font-bold text-slate-900">{user?.name}</div>
                <div className="text-[11px] text-slate-500">{user?.email}</div>
              </div>
              <button onClick={logout}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-red-600 hover:bg-red-50">
                <LogOut size={13} /> Sign out
              </button>
            </div>
          )}
          <button onClick={() => setMenuOpen(o => !o)}
            className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-white/80">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-indigo-600 text-xs font-bold text-white shadow-[0_8px_18px_rgba(79,70,229,0.25)]">
              {(user?.name || '?').slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold text-slate-900">{user?.name}</span>
              <span className="block text-[11px] capitalize text-slate-500">{user?.role}</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-[#F8FAFC]">
      {/* Desktop sidebar */}
      <aside className="no-print fixed inset-y-0 left-0 z-40 hidden w-[236px] lg:block">{sidebar}</aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="no-print fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-950/45 backdrop-blur-[2px]" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[256px] animate-slideUp">{sidebar}</aside>
        </div>
      )}

      {/* Content pane */}
      <div className="min-w-0 flex-1 lg:ml-[236px] lg:pl-4">
        <div className="min-h-screen bg-[#FBFCFF] lg:rounded-l-[28px] lg:border-l lg:border-white/80
          lg:shadow-[-18px_0_38px_rgba(79,70,229,0.08),inset_1px_0_0_rgba(255,255,255,0.95)]">
          {/* Mobile top bar */}
          <div className="no-print sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200/70 bg-[#FBFCFF]/95 px-4 py-2.5 backdrop-blur lg:hidden">
            <button onClick={() => setMobileOpen(o => !o)} className="rounded-lg p-1.5 text-slate-700 hover:bg-slate-100">
              {mobileOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
            <span className="text-sm font-black tracking-tight text-slate-950">Colour<span className="text-indigo-700"> Impressions</span></span>
          </div>
          <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
