// App shell — macOS Tahoe / Liquid Glass.
// Floating translucent sidebar over a desktop wash, systemBlue accent, role-aware grouped nav.
import { useState, useRef, useEffect } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  Package, LogOut, LayoutDashboard, Radio, Route as RouteIcon,
  ShoppingCart, Truck, CalendarClock, Palette, ClipboardList, ShoppingBag,
  Warehouse, BarChart3, Settings2, Menu, X, Bell, AlertTriangle, CheckCircle2,
  ReceiptText, Wallet, Kanban, ChevronDown, LayoutGrid, PackageCheck,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import { api, auth } from '../api.js';
import { SECTION_META, SECTION_ORDER } from '../sections.js';

// Module sequence per Anik: Overview → Sales → Production → Live Floor → Supply → Admin.
const NAV = [
  {
    group: 'Overview',
    items: [
      { label: 'Dashboard', to: '/', end: true, icon: LayoutDashboard, roles: 'all' },
      { label: 'Tracking', to: '/track', icon: RouteIcon, roles: 'all' },
    ],
  },
  {
    group: 'Sales',
    items: [
      { label: 'Sales Orders', to: '/orders', icon: ShoppingCart, roles: ['admin', 'planner', 'viewer'] },
      { label: 'Invoices', to: '/invoices', icon: ReceiptText, roles: ['admin', 'planner', 'viewer'] },
      { label: 'Accounts', to: '/accounts', icon: Wallet, roles: ['admin', 'planner', 'viewer'] },
      { label: 'Dispatch', to: '/dispatch', icon: Truck, roles: ['admin', 'planner', 'dispatch', 'viewer'] },
    ],
  },
  {
    group: 'Production',
    items: [
      { label: 'Planning', to: '/planning', icon: CalendarClock, roles: ['admin', 'planner'] },
      { label: 'Artwork', to: '/artwork', icon: Palette, roles: ['admin', 'planner', 'qc'] },
      { label: 'Job Cards', to: '/production', icon: ClipboardList, roles: ['admin', 'planner', 'production', 'qc', 'viewer'] },
      { label: 'Print Planning', to: '/print-planning', icon: Kanban, roles: ['admin', 'planner', 'production'] },
    ],
  },
  {
    group: 'Plant Floor',
    items: [
      { label: 'Live Floor', floor: true, roles: 'all' },
      { label: 'Finished Goods', to: '/finished-goods', icon: PackageCheck, roles: 'all' },
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
  'bg-white/90 text-[#007AFF] ' +
  'shadow-[0_8px_22px_rgba(0,122,255,0.16),inset_0_1px_0_rgba(255,255,255,0.95)] ring-1 ring-white/80';
const IDLE_PILL =
  'text-[#515154] hover:bg-white/55 hover:text-[#1D1D1F] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.85)]';

// Pureflix Notification Center — critical / action needed / completed today.
function NotificationBell() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [d, setD] = useState(null);
  const ref = useRef(null);

  const load = () => api.get('/dashboard').then(setD).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => { clearInterval(t); document.removeEventListener('mousedown', h); };
  }, []);

  const critical = (d?.alerts || []).filter(a => a.type === 'shortage');
  const action = (d?.alerts || []).filter(a => a.type !== 'shortage');
  const completed = d?.closed_today?.jobs > 0
    ? [{ text: `${d.closed_today.jobs} job${d.closed_today.jobs > 1 ? 's' : ''} closed today — ${d.closed_today.cartons.toLocaleString('en-IN')} cartons to FG` }]
    : [];

  const Group = ({ title, tone, icon: Icon, items, to }) => (
    <div className="border-b border-slate-100 p-3 last:border-b-0">
      <div className="mb-1.5 flex items-center gap-2">
        <span className={`flex h-6 w-6 items-center justify-center rounded-lg ${tone}`}><Icon size={13} /></span>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      </div>
      {items.length ? items.slice(0, 5).map((a, i) => (
        <button key={i} onClick={() => { nav(to); setOpen(false); }}
          className="block w-full rounded-lg px-2 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50">
          {a.text}
        </button>
      )) : <p className="px-2 py-1.5 text-xs text-slate-400">Nothing pending.</p>}
    </div>
  );

  return (
    <div className="no-print fixed bottom-4 right-4 z-40" ref={ref}>
      {open && (
        <div className="glass absolute bottom-12 right-0 w-[340px] overflow-hidden rounded-[22px] shadow-modal animate-scaleIn">
          <div className="border-b border-[#1D1D1F]/[0.06] px-4 py-3">
            <p className="text-sm font-bold text-[#1D1D1F]">Notification Center</p>
            <p className="text-xs text-[#86868B]">Critical work, pending actions, today's completions</p>
          </div>
          <Group title="Critical" tone="bg-red-50 text-red-600" icon={AlertTriangle} items={critical} to="/planning" />
          <Group title="Action Needed" tone="bg-amber-50 text-amber-700" icon={AlertTriangle} items={action} to="/artwork" />
          <Group title="Completed" tone="bg-emerald-50 text-emerald-700" icon={CheckCircle2} items={completed} to="/dispatch" />
        </div>
      )}
      <button onClick={() => setOpen(o => !o)} title="Notifications"
        className="glass relative flex h-10 w-10 items-center justify-center rounded-full text-[#515154] transition-all duration-200 ease-apple hover:bg-white/85 hover:text-[#007AFF]">
        <Bell size={17} />
        {critical.length > 0 && <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white" />}
      </button>
    </div>
  );
}

// Live Floor — expandable module: overview board + one page per section,
// with a live badge showing active work (running / held / queued) at each.
function FloorNav() {
  const location = useLocation();
  const onFloor = location.pathname.startsWith('/floor');
  const [open, setOpen] = useState(() => localStorage.getItem('ci_floor_nav') !== '0');
  const [counts, setCounts] = useState({});

  useEffect(() => {
    let live = true;
    const load = () => api.get('/floor').then(secs => {
      if (!live) return;
      setCounts(Object.fromEntries(secs.map(s =>
        [s.section, s.running.length + (s.held || []).length + s.queued.length])));
    }).catch(() => {});
    load();
    const t = setInterval(load, 45000);
    return () => { live = false; clearInterval(t); };
  }, []);

  const toggle = () => setOpen(o => { localStorage.setItem('ci_floor_nav', o ? '0' : '1'); return !o; });
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const expanded = open || onFloor;

  return (
    <div>
      <button onClick={toggle}
        className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-semibold transition-all ${onFloor && !expanded ? ACTIVE_PILL : IDLE_PILL}`}>
        <Radio size={15} className={onFloor ? 'text-[#007AFF]' : 'text-[#8E8E93]'} />
        <span className="flex-1 truncate text-left">Live Floor</span>
        {total > 0 && !expanded && <span className="rounded-full bg-[#E1EFFF] px-1.5 text-[10px] font-bold text-[#007AFF]">{total}</span>}
        <ChevronDown size={12} className={`text-[#8E8E93] transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="ml-4 mt-0.5 space-y-0.5 border-l border-[#1D1D1F]/[0.08] pl-2.5">
          <NavLink to="/floor" end
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-lg px-2.5 py-[5px] text-xs font-semibold transition-all ${isActive ? ACTIVE_PILL : IDLE_PILL}`}>
            <LayoutGrid size={13} className="text-[#8E8E93]" /> Overview
          </NavLink>
          {SECTION_ORDER.map(key => {
            const m = SECTION_META[key];
            const n = counts[key] || 0;
            return (
              <NavLink key={key} to={`/floor/${key}`}
                className={({ isActive }) =>
                  `flex items-center gap-2 rounded-lg px-2.5 py-[5px] text-xs font-semibold transition-all ${isActive ? ACTIVE_PILL : IDLE_PILL}`}>
                {({ isActive }) => (
                  <>
                    <m.icon size={13} className={isActive ? 'text-[#007AFF]' : 'text-[#8E8E93]'} />
                    <span className="flex-1 truncate">{m.label}</span>
                    {n > 0 && <span className="rounded-full bg-[#E1EFFF] px-1.5 text-[10px] font-bold tabular-nums text-[#007AFF]">{n}</span>}
                  </>
                )}
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NavItem({ item }) {
  return (
    <NavLink to={item.to} end={item.end}
      className={({ isActive }) =>
        `flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-semibold transition-all ${isActive ? ACTIVE_PILL : IDLE_PILL}`}>
      {({ isActive }) => (
        <>
          <item.icon size={15} className={`shrink-0 ${isActive ? 'text-[#007AFF]' : 'text-[#8E8E93]'}`} />
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
  // Desktop sidebar open/close — persisted like a macOS window state.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('ci_sidebar_collapsed') === '1');
  const toggleSidebar = () => setCollapsed(c => { localStorage.setItem('ci_sidebar_collapsed', c ? '0' : '1'); return !c; });
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
    <div className="glass flex h-full flex-col rounded-[26px]">
      {/* Wordmark */}
      <div className="px-4 pb-4 pt-6">
        <div className="flex items-center gap-2 px-1">
          <button onClick={toggleSidebar} title="Hide sidebar"
            className="order-last ml-auto hidden h-6 w-6 shrink-0 items-center justify-center rounded-full text-[#86868B] transition-colors duration-150 hover:bg-white/70 hover:text-[#1D1D1F] lg:flex">
            <PanelLeftClose size={14} />
          </button>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-b from-[#2E95FF] to-[#007AFF] shadow-[0_8px_18px_rgba(0,122,255,0.30),inset_0_1px_0_rgba(255,255,255,0.4)]">
            <Package size={17} className="text-white" />
          </span>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[14px] font-bold tracking-[-0.01em] text-[#1D1D1F]">
              Colour<span className="text-[#007AFF]"> Impressions</span>
            </div>
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#86868B]">Plant ERP</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="scrollbar-none flex-1 space-y-4 overflow-y-auto px-3 pb-4">
        {groups.map(g => (
          <div key={g.group}>
            <div className="mb-1 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-[#86868B]">{g.group}</div>
            <div className="space-y-0.5">
              {g.items.map(i => i.floor ? <FloorNav key="floor" /> : <NavItem key={i.to} item={i} />)}
            </div>
          </div>
        ))}
      </nav>

      {/* User */}
      <div className="border-t border-[#1D1D1F]/[0.06] bg-white/40 px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] rounded-b-[26px]" ref={menuRef}>
        <div className="relative">
          {menuOpen && (
            <div className="glass absolute bottom-full left-0 z-50 mb-2 w-full animate-scaleIn rounded-2xl py-1">
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
            className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors duration-150 hover:bg-white/60">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-[#2E95FF] to-[#007AFF] text-xs font-bold text-white shadow-[0_8px_18px_rgba(0,122,255,0.28),inset_0_1px_0_rgba(255,255,255,0.4)]">
              {(user?.name || '?').slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold text-[#1D1D1F]">{user?.name}</span>
              <span className="block text-[11px] capitalize text-[#86868B]">{user?.role}</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar — floating glass rail, slides away when collapsed */}
      <aside className={`no-print fixed inset-y-0 left-0 z-40 hidden w-[264px] py-3 pl-3 transition-transform duration-300 ease-apple lg:block ${collapsed ? 'pointer-events-none -translate-x-[276px]' : 'translate-x-0'}`}>
        {sidebar}
      </aside>

      {/* Reopen button — appears when the sidebar is hidden */}
      {collapsed && (
        <button onClick={toggleSidebar} title="Show sidebar"
          className="no-print glass fixed left-3 top-3 z-40 hidden h-10 w-10 animate-fadeIn items-center justify-center rounded-full text-[#515154] transition-colors duration-150 hover:text-[#007AFF] lg:flex">
          <PanelLeftOpen size={17} />
        </button>
      )}

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="no-print fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-[#1D1D1F]/30 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[264px] animate-slideUp py-3 pl-3">{sidebar}</aside>
        </div>
      )}

      {/* Content pane — transparent so the desktop wash shows through */}
      <div className={`min-w-0 flex-1 transition-[margin] duration-300 ease-apple ${collapsed ? 'lg:ml-0' : 'lg:ml-[264px]'}`}>
        {/* Mobile top bar */}
        <div className="no-print glass sticky top-0 z-30 flex items-center gap-3 rounded-none border-x-0 border-t-0 px-4 py-2.5 lg:hidden">
          <button onClick={() => setMobileOpen(o => !o)} className="rounded-lg p-1.5 text-[#1D1D1F] transition-colors hover:bg-white/70">
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          <span className="text-sm font-bold tracking-[-0.01em] text-[#1D1D1F]">Colour<span className="text-[#007AFF]"> Impressions</span></span>
        </div>
        <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
        <NotificationBell />
      </div>
    </div>
  );
}
