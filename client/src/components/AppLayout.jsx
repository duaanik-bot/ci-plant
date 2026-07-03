// App shell — the Pureflix luminous rail, adapted for the plant.
// Light gradient sidebar with glow-pill active states; content pane sits on
// #FBFCFF behind a rounded seam. Role-aware grouped nav, mobile drawer.
import { useState, useRef, useEffect } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  Package, LogOut, LayoutDashboard, Radio, Route as RouteIcon,
  ShoppingCart, Truck, CalendarClock, Palette, ClipboardList, ShoppingBag,
  Warehouse, BarChart3, Settings2, Menu, X, Bell, AlertTriangle, CheckCircle2,
  ReceiptText, Wallet, Kanban, ChevronDown, LayoutGrid,
} from 'lucide-react';
import { api, auth } from '../api.js';
import { SECTION_META, SECTION_ORDER } from '../sections.js';

// Module sequence per Anik: Dashboard → Sales → Production → Live Floor
// (with Track alongside) → Supply → Admin.
const NAV = [
  {
    group: 'Overview',
    items: [
      { label: 'Dashboard', to: '/', end: true, icon: LayoutDashboard, roles: 'all' },
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
      { label: 'Print Planning', to: '/print-planning', icon: Kanban, roles: ['admin', 'planner', 'production'] },
      { label: 'Artwork', to: '/artwork', icon: Palette, roles: ['admin', 'planner', 'qc'] },
      { label: 'Job Cards', to: '/production', icon: ClipboardList, roles: ['admin', 'planner', 'production', 'qc', 'viewer'] },
    ],
  },
  {
    group: 'Plant Floor',
    items: [
      { label: 'Live Floor', floor: true, roles: 'all' },
      { label: 'Track', to: '/track', icon: RouteIcon, roles: 'all' },
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
        <div className="absolute bottom-12 right-0 w-[340px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-modal animate-scaleIn">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-bold text-slate-900">Notification Center</p>
            <p className="text-xs text-slate-400">Critical work, pending actions, today's completions</p>
          </div>
          <Group title="Critical" tone="bg-red-50 text-red-600" icon={AlertTriangle} items={critical} to="/planning" />
          <Group title="Action Needed" tone="bg-amber-50 text-amber-700" icon={AlertTriangle} items={action} to="/artwork" />
          <Group title="Completed" tone="bg-emerald-50 text-emerald-700" icon={CheckCircle2} items={completed} to="/dispatch" />
        </div>
      )}
      <button onClick={() => setOpen(o => !o)} title="Notifications"
        className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-lift hover:bg-slate-50">
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
        <Radio size={15} className={onFloor ? 'text-indigo-700' : 'text-slate-500'} />
        <span className="flex-1 truncate text-left">Live Floor</span>
        {total > 0 && !expanded && <span className="rounded-full bg-brand-100 px-1.5 text-[10px] font-bold text-brand-700">{total}</span>}
        <ChevronDown size={12} className={`text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="ml-4 mt-0.5 space-y-0.5 border-l border-slate-200/70 pl-2.5">
          <NavLink to="/floor" end
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-lg px-2.5 py-[5px] text-xs font-semibold transition-all ${isActive ? ACTIVE_PILL : IDLE_PILL}`}>
            <LayoutGrid size={13} className="text-slate-400" /> Overview
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
                    <m.icon size={13} className={isActive ? 'text-indigo-600' : 'text-slate-400'} />
                    <span className="flex-1 truncate">{m.label}</span>
                    {n > 0 && <span className="rounded-full bg-brand-100 px-1.5 text-[10px] font-bold tabular-nums text-brand-700">{n}</span>}
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
              {g.items.map(i => i.floor ? <FloorNav key="floor" /> : <NavItem key={i.to} item={i} />)}
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
          <NotificationBell />
        </div>
      </div>
    </div>
  );
}
