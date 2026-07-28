// App shell — macOS Tahoe / Liquid Glass.
// Floating translucent sidebar over a desktop wash, systemBlue accent, role-aware grouped nav.
import { useState, useRef, useEffect } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  LogOut, LayoutDashboard, Radio, Route as RouteIcon,
  ShoppingCart, Truck, CalendarClock, Palette, ClipboardList, ShoppingBag,
  Warehouse, BarChart3, Settings2, Menu, X, Bell, AlertTriangle, CheckCircle2,
  ReceiptText, Wallet, Kanban, ChevronDown, ChevronRight, LayoutGrid, PackageCheck, PackagePlus,
  Wrench, NotebookPen, SwatchBook, ShieldAlert, Inbox,
} from 'lucide-react';
import { api, auth, fmt } from '../api.js';
import { useToast } from './ui.jsx';
import ChatDock from './Chat.jsx';
import { FLOOR_NAV } from '../sections.js';
import { canAccess, canAccessSection } from '../modules.js';

// Module sequence per Anik: Overview → Sales → Production → Live Floor → Supply → Admin.
// `module` keys line up with MODULES in modules.js — per-user access control.
const NAV = [
  {
    group: 'Overview',
    items: [
      { label: 'Dashboard', to: '/', end: true, icon: LayoutDashboard, roles: 'all', module: 'dashboard' },
      { label: 'Tracking', to: '/track', icon: RouteIcon, roles: 'all', module: 'track' },
      { label: 'Status Sheet', to: '/status-sheet', icon: ClipboardList, roles: 'all', module: 'status_sheet' },
    ],
  },
  {
    group: 'Sales',
    items: [
      { label: 'Sales Orders', to: '/orders', icon: ShoppingCart, roles: ['admin', 'planner', 'viewer'], module: 'orders' },
      { label: 'Dispatch & Invoice', to: '/dispatch-invoice', icon: Truck, roles: ['admin', 'planner', 'dispatch', 'viewer'], module: 'dispatch_invoice' },
      { label: 'Accounts', to: '/accounts', icon: Wallet, roles: ['admin', 'planner', 'viewer'], module: 'accounts' },
    ],
  },
  {
    group: 'Production',
    items: [
      { label: 'Planning', to: '/planning', icon: CalendarClock, roles: ['admin', 'planner'], module: 'planning' },
      { label: 'Artwork', to: '/artwork', icon: Palette, roles: ['admin', 'planner', 'qc'], module: 'artwork' },
      { label: 'Job Cards', to: '/production', icon: ClipboardList, roles: ['admin', 'planner', 'production', 'qc', 'viewer'], module: 'production' },
      { label: 'Print Planning', to: '/print-planning', icon: Kanban, roles: ['admin', 'planner', 'production'], module: 'print_planning' },
    ],
  },
  {
    group: 'Plant Floor',
    items: [
      { label: 'Live Floor', floor: true, roles: 'all', module: 'floor' },
      { label: 'Extra Sheets', to: '/extra-sheets', icon: PackagePlus, roles: ['admin', 'planner', 'production', 'viewer'], module: 'extra_sheets' },
      { label: 'Finished Goods & QC', to: '/finished-goods', icon: PackageCheck, roles: 'all', module: 'finished_goods' },
      { label: 'Logbook', to: '/logbook', icon: NotebookPen, roles: 'all', module: 'logbook' },
    ],
  },
  {
    group: 'Supply',
    items: [
      { label: 'Procurement', to: '/procurement', icon: ShoppingBag, roles: ['admin', 'planner', 'qc'], module: 'procurement' },
      { label: 'Warehouse', to: '/inventory', icon: Warehouse, roles: ['admin', 'planner', 'production', 'qc', 'viewer'], module: 'inventory' },
    ],
  },
  {
    group: 'Admin',
    items: [
      { label: 'Reports', to: '/reports', icon: BarChart3, roles: 'all', module: 'reports' },
      { label: 'Masters', to: '/masters', icon: Settings2, roles: ['admin', 'planner'], module: 'masters' },
    ],
  },
  {
    group: 'Tooling',
    items: [
      { label: 'Tooling Hub', to: '/tooling', icon: Wrench, roles: ['admin', 'planner', 'production', 'qc'], module: 'tooling' },
    ],
  },
  {
    group: 'Quality',
    items: [
      { label: 'Shade Cards', to: '/shade-cards', icon: SwatchBook, roles: ['admin', 'planner', 'production', 'qc'], module: 'shade_cards' },
    ],
  },
];

// Active item — a solid systemBlue capsule (the macOS/iPadOS selected-sidebar
// language): white label, gloss top line, dark under-lip and a blue ambient
// glow so the pill sits proud of the rail. Unmissable at a glance.
const ACTIVE_PILL =
  'bg-gradient-to-b from-[#2E95FF] to-[#0071F0] text-white ' +
  'shadow-[0_8px_20px_rgba(0,122,255,0.38),inset_0_1px_0_rgba(255,255,255,0.45),inset_0_-1px_0_rgba(0,83,173,0.35)]';
// Hover — a Liquid Glass highlight: translucent white lozenge, full-perimeter
// rim light + bright top specular line, and a soft lift shadow, so hovering a
// tab feels like a piece of glass rising under the cursor.
const IDLE_PILL =
  'text-[#515154] hover:bg-white/55 hover:text-[#1D1D1F] hover:backdrop-blur-md hover:ring-1 hover:ring-white/60 ' +
  'hover:shadow-[0_5px_14px_-5px_rgba(29,29,31,0.16),inset_0_1px_0_rgba(255,255,255,1),inset_0_-1px_1px_rgba(66,88,120,0.06)]';

// Pureflix Notification Center — personal inbox + approval desk + the
// dashboard's critical / action needed / completed today.
function NotificationBell() {
  const nav = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [d, setD] = useState(null);
  const [inbox, setInbox] = useState({ unread: 0, rows: [] });          // my notifications
  const [pend, setPend] = useState({ can_xs: false, can_mgt: false, xs: [], mgt: [] }); // live approvals waiting on ME
  const [deciding, setDeciding] = useState(null); // approval id with a decide call in flight
  const ref = useRef(null);

  const load = () => api.get('/dashboard').then(setD).catch(() => {});
  const loadPersonal = () => Promise.all([
    api.get('/notifications').then(setInbox).catch(() => {}),
    api.get('/approvals/pending').then(setPend).catch(() => {}),
  ]);
  useEffect(() => {
    load(); loadPersonal();
    const t = setInterval(load, 60000);
    const p = setInterval(loadPersonal, 30000);
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => { clearInterval(t); clearInterval(p); document.removeEventListener('mousedown', h); };
  }, []);

  const openNotification = n => {
    api.post('/notifications/read', { ids: [n.id] }).then(loadPersonal).catch(() => {});
    setOpen(false);
    // A chat ping opens the messenger dock, not a route — the dock listens.
    if (n.kind === 'chat') {
      window.dispatchEvent(new CustomEvent('ci-chat-open', { detail: { conversationId: n.ref_id } }));
      return;
    }
    if (n.link) nav(n.link);
  };
  const markAllRead = () => api.post('/notifications/read', { all: true }).then(loadPersonal).catch(() => {});
  const decideMgt = async (a, action) => {
    setDeciding(a.id);
    try {
      await api.post(`/approvals/${a.id}/${action}`);
      toast.success(`${a.ar_number} ${action === 'approve' ? 'approved' : 'rejected'}`);
      await loadPersonal();
    } catch { /* central toast already showed the error */ } finally { setDeciding(null); }
  };

  const critical = (d?.alerts || []).filter(a => a.type === 'shortage');
  const action = (d?.alerts || []).filter(a => a.type !== 'shortage');
  const completed = d?.closed_today?.jobs > 0
    ? [{ text: `${d.closed_today.jobs} job${d.closed_today.jobs > 1 ? 's' : ''} closed today — ${d.closed_today.cartons.toLocaleString('en-IN')} cartons to FG` }]
    : [];
  const approvalsCount = pend.xs.length + pend.mgt.length;
  const attention = inbox.unread + approvalsCount;

  const Group = ({ title, tone, icon: Icon, items, to }) => (
    <div className="border-b border-slate-100 p-3 last:border-b-0">
      <div className="mb-1.5 flex items-center gap-2">
        <span className={`flex h-6 w-6 items-center justify-center rounded-lg ${tone}`}><Icon size={13} /></span>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      </div>
      {items.length ? items.slice(0, 5).map((a, i) => (
        // An alert can carry its own destination (e.g. extra sheet requests →
        // /extra-sheets); the group target is the fallback.
        <button key={i} onClick={() => { nav(a.to || to); setOpen(false); }}
          className="block w-full rounded-lg px-2 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50">
          {a.text}
        </button>
      )) : <p className="px-2 py-1.5 text-xs text-slate-400">Nothing pending.</p>}
    </div>
  );

  return (
    <div className="no-print fixed bottom-4 right-4 z-40" ref={ref}>
      {open && (
        <div className="glass absolute bottom-12 right-0 w-[380px] origin-bottom-right overflow-hidden rounded-[22px] shadow-modal animate-liquidPop">
          <div className="flex items-center justify-between border-b border-[#1D1D1F]/[0.06] px-4 py-3">
            <div>
              <p className="text-sm font-bold text-[#1D1D1F]">Notification Center</p>
              <p className="text-xs text-[#86868B]">Approvals, your messages, plant alerts</p>
            </div>
            {inbox.unread > 0 && (
              <button onClick={markAllRead} className="rounded-lg px-2 py-1 text-[11px] font-semibold text-[#007AFF] hover:bg-white/70">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[70vh] overflow-y-auto">

            {/* Approval desk — LIVE pending requests waiting on this login, not
                stored notifications, so it can never show a stale ask. */}
            {approvalsCount > 0 && (
              <div className="border-b border-slate-100 p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-amber-50 text-amber-700"><ShieldAlert size={13} /></span>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Approvals — waiting on you</p>
                  <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-bold text-amber-700">{approvalsCount}</span>
                </div>
                {pend.xs.map(x => (
                  <button key={`xs-${x.id}`} onClick={() => { nav('/extra-sheets'); setOpen(false); }}
                    className="block w-full rounded-xl border border-amber-100 bg-amber-50/50 px-2.5 py-2 text-left text-xs text-slate-700 hover:bg-amber-50 [&+&]:mt-1.5">
                    <span className="font-bold text-slate-900">{x.xs_number}</span> — {fmt.num(x.qty)} parent sheets for {x.jc_number} at {fmt.stage(x.stage)}
                    <span className="mt-0.5 block text-[11px] text-slate-500">{x.reason} · {x.requested_by} · {fmt.dt(x.requested_at)}</span>
                    <span className="mt-0.5 block text-[11px] font-semibold text-amber-700">Tap to review &amp; approve on Extra Sheets</span>
                  </button>
                ))}
                {pend.mgt.map(a => (
                  <div key={`mgt-${a.id}`} className="rounded-xl border border-amber-100 bg-amber-50/50 px-2.5 py-2 text-xs text-slate-700 [&+&]:mt-1.5 mt-1.5 first:mt-0">
                    <button onClick={() => { nav('/planning'); setOpen(false); }} className="block w-full text-left">
                      <span className="font-bold text-slate-900">{a.ar_number}</span> — {a.product_name}
                      <span className="mt-0.5 block text-[11px] text-slate-500">PO {a.po_number || '—'} · {a.customer_name} · qty {fmt.num(a.line_qty)}</span>
                      <span className="mt-0.5 block text-[11px] italic text-slate-600">“{a.note}” — {a.requested_by}</span>
                    </button>
                    <div className="mt-1.5 flex gap-1.5">
                      <button disabled={deciding === a.id} onClick={() => decideMgt(a, 'approve')}
                        className="flex-1 rounded-lg bg-emerald-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-emerald-700 disabled:opacity-50">
                        Approve
                      </button>
                      <button disabled={deciding === a.id} onClick={() => decideMgt(a, 'reject')}
                        className="flex-1 rounded-lg bg-red-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-red-700 disabled:opacity-50">
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Personal inbox — targeted messages (requests raised, decisions
                taken). Click marks read and follows the deep link. */}
            <div className="border-b border-slate-100 p-3">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-[#E1EFFF] text-[#007AFF]"><Inbox size={13} /></span>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">For you</p>
                {inbox.unread > 0 && <span className="rounded-full bg-[#E1EFFF] px-1.5 text-[10px] font-bold text-[#007AFF]">{inbox.unread} new</span>}
              </div>
              {inbox.rows.length ? inbox.rows.slice(0, 8).map(n => (
                <button key={n.id} onClick={() => openNotification(n)}
                  className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-slate-50">
                  <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${n.read_at ? 'bg-slate-200' : 'bg-[#007AFF]'}`} />
                  <span className="min-w-0">
                    <span className={`block ${n.read_at ? 'text-slate-500' : 'font-semibold text-slate-800'}`}>{n.title}</span>
                    {n.body && <span className="block whitespace-pre-line text-[11px] text-slate-500">{n.body}</span>}
                    <span className="block text-[10px] text-slate-400">{fmt.dt(n.created_at)}</span>
                  </span>
                </button>
              )) : <p className="px-2 py-1.5 text-xs text-slate-400">Nothing for you yet.</p>}
            </div>

            <Group title="Critical" tone="bg-red-50 text-red-600" icon={AlertTriangle} items={critical} to="/planning" />
            <Group title="Action Needed" tone="bg-amber-50 text-amber-700" icon={AlertTriangle} items={action} to="/artwork" />
            <Group title="Completed" tone="bg-emerald-50 text-emerald-700" icon={CheckCircle2} items={completed} to="/dispatch-invoice" />
          </div>
        </div>
      )}
      <button onClick={() => setOpen(o => !o)} title="Notifications"
        className="glass relative flex h-10 w-10 items-center justify-center rounded-full text-[#515154] transition-all duration-200 ease-apple hover:bg-white/85 hover:text-[#007AFF]">
        <Bell size={17} />
        {/* Personal attention count (unread + approvals waiting) beats the
            plain critical dot — approvals are amber, the rest systemBlue. */}
        {attention > 0 ? (
          <span className={`absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold text-white ring-2 ring-white ${approvalsCount > 0 ? 'bg-amber-500' : 'bg-[#007AFF]'}`}>
            {attention > 99 ? '99+' : attention}
          </span>
        ) : critical.length > 0 && <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white" />}
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
        <Radio size={15} className={onFloor && !expanded ? 'text-white' : onFloor ? 'text-[#007AFF]' : 'text-[#8E8E93]'} />
        <span className="flex-1 truncate text-left">Live Floor</span>
        {total > 0 && !expanded && <span className={`rounded-full px-1.5 text-[10px] font-bold ${onFloor ? 'bg-white/25 text-white' : 'bg-[#E1EFFF] text-[#007AFF]'}`}>{total}</span>}
        <ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''} ${onFloor && !expanded ? 'text-white/70' : 'text-[#8E8E93]'}`} />
      </button>
      {expanded && (
        <div className="ml-4 mt-0.5 space-y-0.5 border-l border-[#1D1D1F]/[0.08] pl-2.5">
          <NavLink to="/floor" end
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-lg px-2.5 py-[5px] text-xs font-semibold transition-all ${isActive ? ACTIVE_PILL : IDLE_PILL}`}>
            {({ isActive }) => (
              <><LayoutGrid size={13} className={isActive ? 'text-white' : 'text-[#8E8E93]'} /> Overview</>
            )}
          </NavLink>
          {FLOOR_NAV
            // Station-scoped logins only list the stations they're dedicated to;
            // admins / unrestricted see every station (canAccessSection = true).
            .filter(m => m.countKeys.some(k => canAccessSection(auth.user, k)))
            .map(m => {
            const n = m.countKeys.reduce((s, k) => s + (counts[k] || 0), 0);
            return (
              <NavLink key={m.key} to={m.path} end={m.key === 'sort_paste'}
                className={({ isActive }) =>
                  `flex items-center gap-2 rounded-lg px-2.5 py-[5px] text-xs font-semibold transition-all ${isActive ? ACTIVE_PILL : IDLE_PILL}`}>
                {({ isActive }) => (
                  <>
                    <m.icon size={13} className={isActive ? 'text-white' : 'text-[#8E8E93]'} />
                    <span className="flex-1 truncate">{m.label}</span>
                    {n > 0 && <span className={`rounded-full px-1.5 text-[10px] font-bold tabular-nums ${isActive ? 'bg-white/25 text-white' : 'bg-[#E1EFFF] text-[#007AFF]'}`}>{n}</span>}
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
        `flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-semibold transition-all duration-300 ease-spring active:scale-[0.97] ${isActive ? ACTIVE_PILL : IDLE_PILL}`}>
      {({ isActive }) => (
        <>
          <item.icon size={15} className={`shrink-0 ${isActive ? 'text-white' : 'text-[#8E8E93]'}`} />
          <span className="truncate">{item.label}</span>
        </>
      )}
    </NavLink>
  );
}

export default function AppLayout() {
  const nav = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState(auth.user);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // Desktop sidebar open/close — persisted like a macOS window state.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('ci_sidebar_collapsed') === '1');
  const toggleSidebar = () => setCollapsed(c => { localStorage.setItem('ci_sidebar_collapsed', c ? '0' : '1'); return !c; });
  const menuRef = useRef(null);
  // First-paint entrance for the rail: one unified liquid pop for the whole
  // panel (nav labels ride along in place — no per-row cascade). The class is
  // dropped the moment the animation ends so its filled transform can never
  // fight the collapse transform below; a rail that loads collapsed skips it.
  const [entered, setEntered] = useState(collapsed);
  useEffect(() => {
    if (entered) return;
    const t = setTimeout(() => setEntered(true), 700);
    return () => clearTimeout(t);
  }, [entered]);

  useEffect(() => {
    const h = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  // Refresh the signed-in user on load — module-access changes made in
  // Masters → Users apply on the next page load, no re-login needed.
  useEffect(() => {
    api.get('/auth/me').then(u => {
      auth.set({ token: auth.token, user: u });
      setUser(u);
    }).catch(() => {});
  }, []);

  const groups = NAV.map(g => ({
    ...g,
    items: g.items.filter(i => {
      // An explicit per-user module grant is authoritative: if an admin hand-
      // picked this module in Masters → Users, show it regardless of the item's
      // default role list. (The `roles` gate is only the fallback for logins
      // with unrestricted module access — the original role-based behaviour.)
      const explicitlyGranted = i.module != null
        && Array.isArray(user?.modules) && user.modules.includes(i.module);
      if (explicitlyGranted) return true;
      return (i.roles === 'all' || i.roles.includes(user?.role))
        && (i.module == null || canAccess(user, i.module));
    }),
  })).filter(g => g.items.length > 0);

  const logout = () => { auth.clear(); nav('/login', { replace: true }); };

  const sidebar = (
    <div className="glass flex h-full flex-col rounded-[26px]">
      {/* Wordmark — click the name to slide the sidebar away */}
      <div className="px-4 pb-4 pt-6">
        <button onClick={toggleSidebar} title="Hide sidebar"
          className="group flex w-full items-center px-1 text-left outline-none">
          <span className="min-w-0 truncate text-[22px] font-bold leading-tight tracking-[-0.02em] text-[#1D1D1F]">
            Colour<span className="text-[#007AFF]"> Impressions</span>
          </span>
        </button>
      </div>

      {/* Nav — rows are painted in place, no per-row entrance. The pop lives on
          the rail as a whole (desktop aside / mobile drawer below), so the menu
          arrives as one piece of glass instead of cascading in line by line. */}
      <nav className="scrollbar-none flex-1 space-y-4 overflow-y-auto px-3 pb-4">
        {groups.map(g => (
          <div key={g.group}>
            <div className="mb-1 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-[#86868B]">{g.group}</div>
            <div className="space-y-0.5">
              {g.items.map(i => (
                <div key={i.floor ? 'floor' : i.to}>
                  {i.floor ? <FloorNav /> : <NavItem item={i} />}
                </div>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* User */}
      <div className="border-t border-[#1D1D1F]/[0.06] bg-white/40 px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] rounded-b-[26px]" ref={menuRef}>
        <div className="relative">
          {menuOpen && (
            <div className="glass absolute bottom-full left-0 z-50 mb-2 w-full origin-bottom animate-liquidPop rounded-2xl py-1">
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
      {/* Hidden state is pop-dominant: shrunk to 0.6 at the left edge (origin-left)
          with only enough translate to clear the viewport — so revealing reads as
          the rail inflating out of the edge with a spring settle, not sliding in. */}
      <aside className={`no-print fixed inset-y-0 left-0 z-40 hidden w-[264px] origin-left py-3 pl-3 transition-[transform,opacity] duration-[560ms] ease-spring lg:block ${entered ? '' : 'animate-liquidIn'} ${collapsed ? 'pointer-events-none -translate-x-[230px] scale-[0.6] opacity-0' : 'translate-x-0 scale-100 opacity-100'}`}>
        {/* Backdrop behind the glass — the desktop rail has no page content
            underneath it, so we float achromatic light blooms for the Liquid
            Glass to lens and refract. No hue: just soft white highlights and one
            cool-grey shade for depth, so the frost reads as clear glass catching
            light rather than a coloured panel. */}
        <div aria-hidden className="pointer-events-none absolute inset-y-3 left-3 right-0 -z-10 overflow-hidden rounded-[26px]">
          <div className="absolute -left-12 -top-8 h-56 w-60 rounded-full bg-white/55 blur-3xl" />
          <div className="absolute -right-16 top-[24%] h-52 w-56 rounded-full bg-white/45 blur-3xl" />
          <div className="absolute -left-6 top-[52%] h-48 w-56 rounded-full bg-white/40 blur-3xl" />
          <div className="absolute -bottom-14 -right-8 h-56 w-64 rounded-full bg-[#8A93A3]/[0.16] blur-3xl" />
          <div className="absolute -bottom-8 -left-4 h-44 w-52 rounded-full bg-white/35 blur-3xl" />
        </div>
        {sidebar}
      </aside>

      {/* Reopen tab — a centered arrow on the left edge when the sidebar is hidden */}
      {collapsed && (
        <button onClick={toggleSidebar} title="Show sidebar" aria-label="Show sidebar"
          className="no-print glass fixed left-0 top-1/2 z-40 hidden h-14 w-6 -translate-y-1/2 animate-fadeIn items-center justify-center rounded-l-none rounded-r-2xl text-[#515154] transition-colors duration-150 hover:text-[#007AFF] lg:flex">
          <ChevronRight size={18} />
        </button>
      )}

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="no-print fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-[#1D1D1F]/30 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[264px] origin-left animate-liquidIn py-3 pl-3">{sidebar}</aside>
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
        {/* Full-width workspace — tables use the whole pane; when the sidebar
            is hidden the content flows edge to edge (soft cap only on ultrawide). */}
        <main className="mx-auto w-full max-w-[1880px] px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
        <NotificationBell />
        <ChatDock />
      </div>
    </div>
  );
}
