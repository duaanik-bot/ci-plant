// App shell — macOS Tahoe / Liquid Glass.
// Floating translucent sidebar over a desktop wash, systemBlue accent, role-aware grouped nav.
import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import TopBar, { CountButton, countOf, plural, rung } from './TopBar.jsx';
import {
  LayoutDashboard, Radio, Route as RouteIcon,
  ShoppingCart, Truck, CalendarClock, Palette, ClipboardList, ShoppingBag,
  Warehouse, BarChart3, Settings2, Menu, X, Bell, AlertTriangle, CheckCircle2,
  ReceiptText, Wallet, Kanban, ChevronDown, ChevronRight, LayoutGrid, PackageCheck, PackagePlus, Scale, Scissors,
  Wrench, NotebookPen, SwatchBook, ShieldAlert, Inbox,
} from 'lucide-react';
import { api, auth, fmt } from '../api.js';
import { useToast } from './ui.jsx';
import ChatDock from './Chat.jsx';
import { FLOOR_NAV } from '../sections.js';
import { canAccess, canAccessSection } from '../modules.js';
import { useTier } from '../lib/tier.js';

// Module sequence per Anik: Overview → Sales → Production → Live Floor → Supply → Admin,
// where Supply carries the chain to its end — Procurement, Warehouse, Dispatch, Accounts.
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
      { label: 'Finished Goods & QC', to: '/finished-goods', icon: PackageCheck, roles: 'all', module: 'finished_goods' },
      { label: 'Extra Sheets', to: '/extra-sheets', icon: PackagePlus, roles: ['admin', 'planner', 'production', 'viewer'], module: 'extra_sheets' },
      // The two count registers, together. Neither station interrupts anyone
      // when the figure disagrees with the paperwork — cutting takes a reason
      // inline and carries on, Sort & Paste absorbs an over-count silently — so
      // these lists are the only place either surfaces, and a register nobody
      // can find is the same as no register. Cutting Variances existed in
      // MODULES from the day it shipped but sat in no NAV group, reachable only
      // by typing the URL.
      { label: 'Cutting Variances', to: '/cutting-variances', icon: Scissors, roles: ['admin', 'planner', 'production'], module: 'cutting_variances' },
      { label: 'Count Discrepancies', to: '/stage-discrepancies', icon: Scale, roles: ['admin', 'planner', 'production'], module: 'stage_discrepancies' },
    ],
  },
  {
    // Buy it, hold it, ship it, bill it — Supply runs the whole material chain
    // to its end. Dispatch and Accounts close that chain, so they sit after
    // Warehouse rather than up in Sales, which is now the order book alone.
    group: 'Supply',
    items: [
      { label: 'Procurement', to: '/procurement', icon: ShoppingBag, roles: ['admin', 'planner', 'qc'], module: 'procurement' },
      { label: 'Warehouse', to: '/inventory', icon: Warehouse, roles: ['admin', 'planner', 'production', 'qc', 'viewer'], module: 'inventory' },
      { label: 'Dispatch & Invoice', to: '/dispatch-invoice', icon: Truck, roles: ['admin', 'planner', 'dispatch', 'viewer'], module: 'dispatch_invoice' },
      { label: 'Accounts', to: '/accounts', icon: Wallet, roles: ['admin', 'planner', 'viewer'], module: 'accounts' },
    ],
  },
  {
    // Masters, then Reports, then the Logbook last — the register you consult
    // rather than work in, so it sits at the tail of the rail on every device
    // instead of interrupting the floor run.
    group: 'Admin',
    items: [
      { label: 'Masters', to: '/masters', icon: Settings2, roles: ['admin', 'planner'], module: 'masters' },
      { label: 'Reports', to: '/reports', icon: BarChart3, roles: 'all', module: 'reports' },
      { label: 'Logbook', to: '/logbook', icon: NotebookPen, roles: 'all', module: 'logbook' },
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

// Notification Center — personal inbox + approval desk + the
// dashboard's critical / action needed / completed today.
function NotificationBell() {
  // Portalled to <body>, and that is load bearing rather than tidiness. The
  // trigger now lives inside the top bar, and the top bar is a `glass` element —
  // a backdrop-filtered ancestor becomes the backdrop ROOT for everything inside
  // it, so a frosted panel rendered in there has only the 52px header strip to
  // sample and comes out fully transparent over the page. Escaping the header
  // gives the glass the actual page to blur again.
  const nav = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [d, setD] = useState(null);
  const [inbox, setInbox] = useState({ unread: 0, rows: [] });          // my notifications
  const [pend, setPend] = useState({ can_xs: false, can_mgt: false, xs: [], mgt: [] }); // live approvals waiting on ME
  const [deciding, setDeciding] = useState(null); // approval id with a decide call in flight
  const ref = useRef(null);      // the trigger, in the header
  const popRef = useRef(null);   // the panel, portalled to <body>

  const load = () => api.get('/dashboard').then(setD).catch(() => {});
  const loadPersonal = () => Promise.all([
    api.get('/notifications').then(setInbox).catch(() => {}),
    api.get('/approvals/pending').then(setPend).catch(() => {}),
  ]);
  useEffect(() => {
    load(); loadPersonal();
    const t = setInterval(load, 60000);
    const p = setInterval(loadPersonal, 30000);
    // The panel is not a DOM descendant of the trigger any more, so an outside
    // click has to miss BOTH or opening the panel would instantly close it.
    const h = e => {
      if (ref.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', h);
    // The `g n` chord. The bar cannot call in — the centres are passed to it as
    // children — so it broadcasts, the same idiom `ci-chat-open` already uses.
    const openMe = () => { setOpen(true); loadPersonal(); };
    window.addEventListener('ci-notifications-open', openMe);
    return () => {
      clearInterval(t); clearInterval(p);
      document.removeEventListener('mousedown', h);
      window.removeEventListener('ci-notifications-open', openMe);
    };
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
    <div className="no-print relative shrink-0" ref={ref}>
      {open && createPortal(
        <div ref={popRef} className="glass fixed right-3 top-[var(--ci-pop-top)] z-[60] w-[min(380px,calc(100vw-1.5rem))] origin-top-right overflow-hidden rounded-[22px] shadow-modal animate-liquidPop">
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
        </div>, document.body)}
      {/* The counted control in the header. What it counts is unchanged — unread
          pings PLUS approvals waiting on this login — so the number the plant
          already reads does not quietly change meaning by moving. Amber still
          means an approval is waiting; the icon becomes a shield so the state
          survives without colour. */}
      <CountButton
        icon={approvalsCount > 0 ? ShieldAlert : Bell}
        label="Notifications"
        count={countOf(attention)}
        tone={rung({ mentioned: false, waiting: approvalsCount })}
        title={[
          approvalsCount > 0 ? `${plural(approvalsCount, 'approval')} waiting on you` : null,
          inbox.unread > 0 ? plural(inbox.unread, 'unread notification') : null,
          critical.length > 0 ? plural(critical.length, 'critical plant alert') : null,
        ].filter(Boolean).join(' · ') || 'Nothing waiting on you'}
        onClick={() => setOpen(o => !o)}
      />
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

// ─── Touch tiers only below — nothing here renders on a desktop ──────────────

// The Live Floor total for the phone/tablet badges — the same 45s poll FloorNav
// runs inside the desktop rail, extracted because those tiers don't mount it.
function useFloorTotal(enabled) {
  const [total, setTotal] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => api.get('/floor').then(secs => {
      if (!live) return;
      setTotal(secs.reduce((s, x) => s + x.running.length + (x.held || []).length + x.queued.length, 0));
    }).catch(() => {});
    load();
    const t = setInterval(load, 45000);
    return () => { live = false; clearInterval(t); };
  }, [enabled]);
  return total;
}

// The four destinations a thumb reaches first. Filtered against what this login
// is actually granted; whatever is left of the plant lives behind More.
const PHONE_SLOTS = ['/', '/floor', '/orders', '/inventory'];
// A 74px slot fits one short word. The module keeps its full name everywhere
// else; the bar speaks in thumb-width labels.
const SHORT_LABEL = {
  '/': 'Home', '/orders': 'Orders', '/inventory': 'Warehouse', '/track': 'Track',
  '/status-sheet': 'Status', '/dispatch-invoice': 'Dispatch', '/accounts': 'Accounts',
  '/planning': 'Planning', '/artwork': 'Artwork', '/production': 'Jobs',
  '/print-planning': 'Presses', '/extra-sheets': 'Extras', '/finished-goods': 'FG & QC',
  '/logbook': 'Logbook', '/procurement': 'Procure', '/reports': 'Reports',
  '/masters': 'Masters', '/tooling': 'Tooling', '/shade-cards': 'Shades',
};

// Phone bottom tab bar — the app's primary navigation on a handset. 64px of
// glass pinned to the bottom edge, padded by the home-bar inset, five slots:
// four modules and More. Rendered only in the phone tree, so the desktop DOM
// never carries it.
function PhoneNav({ groups, floorTotal, onMore }) {
  const flat = groups.flatMap(g => g.items);
  const byTo = Object.fromEntries(flat.filter(i => i.to).map(i => [i.to, i]));
  const floorItem = flat.find(i => i.floor);
  const slots = [];
  for (const to of PHONE_SLOTS) {
    if (slots.length === 4) break;
    if (to === '/floor') { if (floorItem) slots.push({ label: 'Floor', to: '/floor', icon: Radio, badge: floorTotal }); }
    else if (byTo[to]) slots.push({ ...byTo[to], label: SHORT_LABEL[to] || byTo[to].label });
  }
  // A login granted fewer than four of the defaults still gets a full bar.
  for (const i of flat) {
    if (slots.length === 4) break;
    if (i.to && !slots.some(s => s.to === i.to)) slots.push({ ...i, label: SHORT_LABEL[i.to] || i.label });
  }
  return (
    // Flush to the screen's bottom edge — no floating gap. `.ci-dock` is a
    // purpose-built material: `.glass-emboss` presses a shade into its lower
    // lip, which over a bar this tall (row + home-indicator zone) painted a
    // grey band across the bottom — the dock is one uniform tone from rim to
    // screen edge, so the safe-area reads as the same slab. The row is 56px
    // (the iOS tab-bar register), pills 48px — still past the 44pt floor.
    <nav className="no-print fixed inset-x-0 bottom-0 z-40">
      {/* Content dissolves into the dock instead of hard-stopping on its rim —
          the same trick the header scrim plays, mirrored. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-8 h-8 backdrop-blur-[3px]"
        style={{
          maskImage: 'linear-gradient(0deg,#000 0%,transparent 100%)',
          WebkitMaskImage: 'linear-gradient(0deg,#000 0%,transparent 100%)',
        }}
      />
      <div
        className="ci-dock grid grid-cols-5 items-stretch rounded-t-[22px] px-1"
        style={{ height: 'calc(3.5rem + var(--sab))', paddingBottom: 'var(--sab)' }}>
        {slots.map(s => (
          <NavLink key={s.to} to={s.to} end={s.to === '/'}
            className={({ isActive }) =>
              `mx-0.5 my-1 flex flex-col items-center justify-center gap-1 rounded-2xl text-[10px] font-bold transition-all duration-200 ease-apple active:scale-95 ${isActive ? ACTIVE_PILL : 'text-[#515154]'}`}>
            {({ isActive }) => (
              <>
                {/* The badge hugs the icon's shoulder the way every phone-OS
                    badge does — anchored to the glyph, not parked in the
                    slot's far corner where it reads as a stray chip. */}
                <span className="relative">
                  <s.icon size={20} className={isActive ? 'text-white' : 'text-[#6E6E73]'} />
                  {s.badge > 0 && (
                    <span className={`absolute -right-3 -top-1.5 flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-[5px] text-[9px] font-bold leading-none tabular-nums shadow-[0_1px_2px_rgba(29,29,31,0.18)] ${isActive ? 'bg-white text-[#007AFF]' : 'bg-[#007AFF] text-white'}`}>
                      {s.badge > 99 ? '99+' : s.badge}
                    </span>
                  )}
                </span>
                <span className="max-w-full truncate px-1 leading-none">{s.label}</span>
              </>
            )}
          </NavLink>
        ))}
        <button type="button" onClick={onMore}
          className="mx-0.5 my-1 flex flex-col items-center justify-center gap-1 rounded-2xl text-[10px] font-bold text-[#515154] transition-all duration-200 ease-apple active:scale-95">
          <LayoutGrid size={20} className="text-[#6E6E73]" />
          <span className="leading-none">More</span>
        </button>
      </div>
    </nav>
  );
}

// Every granted module, full-screen — what the sidebar is to a desktop, the
// More sheet is to a phone. Rows are 48px so a thumb never mis-hits.
function MoreSheet({ open, onClose, groups, floorTotal, user }) {
  if (!open) return null;
  return createPortal(
    <div className="no-print fixed inset-0 z-[80] flex flex-col animate-fadeIn">
      <div className="absolute inset-0 bg-[#1D1D1F]/35 backdrop-blur-md" onClick={onClose} />
      <div className="glass relative mx-2 mb-2 mt-auto flex max-h-[88dvh] flex-col overflow-hidden rounded-[26px] animate-slideUp"
        style={{ paddingBottom: 'var(--sab)' }}>
        <div className="mx-auto mt-2.5 h-1 w-9 shrink-0 rounded-full bg-[#1D1D1F]/[0.14]" />
        <div className="flex items-center justify-between px-5 pb-2 pt-3">
          <div>
            <p className="text-[17px] font-bold tracking-[-0.02em] text-[#1D1D1F]">All modules</p>
            {user?.name && <p className="text-xs text-[#86868B]">{user.name}</p>}
          </div>
          <button onClick={onClose} aria-label="Close"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[#1D1D1F]/[0.05] text-[#86868B]">
            <X size={17} />
          </button>
        </div>
        <div className="overflow-y-auto overscroll-contain px-3 pb-3">
          {groups.map(g => (
            <div key={g.group} className="mb-2">
              <div className="mb-1 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-[#86868B]">{g.group}</div>
              <div className="space-y-0.5">
                {g.items.map(i => i.floor ? (
                  <NavLink key="floor" to="/floor" onClick={onClose}
                    className={({ isActive }) =>
                      `flex min-h-[48px] items-center gap-3 rounded-2xl px-3 text-[15px] font-semibold ${isActive ? ACTIVE_PILL : 'text-[#1D1D1F] active:bg-white/60'}`}>
                    {({ isActive }) => (
                      <>
                        <Radio size={18} className={isActive ? 'text-white' : 'text-[#8E8E93]'} />
                        <span className="flex-1">Live Floor</span>
                        {floorTotal > 0 && <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${isActive ? 'bg-white/25 text-white' : 'bg-[#E1EFFF] text-[#007AFF]'}`}>{floorTotal}</span>}
                      </>
                    )}
                  </NavLink>
                ) : (
                  <NavLink key={i.to} to={i.to} end={i.end} onClick={onClose}
                    className={({ isActive }) =>
                      `flex min-h-[48px] items-center gap-3 rounded-2xl px-3 text-[15px] font-semibold ${isActive ? ACTIVE_PILL : 'text-[#1D1D1F] active:bg-white/60'}`}>
                    {({ isActive }) => (
                      <>
                        <i.icon size={18} className={isActive ? 'text-white' : 'text-[#8E8E93]'} />
                        <span className="flex-1">{i.label}</span>
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>, document.body);
}

// Tablet icon rail — 76px, always on screen. Every granted module is one tap;
// the full grouped drawer (with the Live Floor section list) opens from the
// header's handle for anything that needs reading rather than recognising.
function TabletRail({ groups, floorTotal }) {
  const flat = groups.flatMap(g => g.items);
  return (
    <aside className="no-print fixed inset-y-0 left-0 z-40 w-[76px] py-3 pl-2"
      style={{ paddingLeft: 'max(0.5rem, var(--sal))' }}>
      <div className="glass flex h-full flex-col items-stretch gap-0.5 overflow-y-auto overscroll-contain rounded-[22px] px-1.5 py-2 scrollbar-none">
        {flat.map(i => {
          const isFloor = !!i.floor;
          const to = isFloor ? '/floor' : i.to;
          const Icon = isFloor ? Radio : i.icon;
          const label = isFloor ? 'Floor' : (SHORT_LABEL[i.to] || i.label);
          return (
            <NavLink key={to} to={to} end={i.end}
              className={({ isActive }) =>
                `relative flex min-h-[52px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 text-[9px] font-bold transition-all duration-200 ease-apple active:scale-95 ${isActive ? ACTIVE_PILL : 'text-[#515154]'}`}>
              {({ isActive }) => (
                <>
                  <Icon size={19} className={isActive ? 'text-white' : 'text-[#6E6E73]'} />
                  <span className="max-w-full truncate leading-tight">{label}</span>
                  {isFloor && floorTotal > 0 && (
                    <span className={`absolute right-0.5 top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-bold tabular-nums ${isActive ? 'bg-white/30 text-white' : 'bg-[#E1EFFF] text-[#007AFF]'}`}>
                      {floorTotal > 99 ? '99+' : floorTotal}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </aside>
  );
}

export default function AppLayout() {
  const nav = useNavigate();
  const location = useLocation();
  const tier = useTier();
  const [user, setUser] = useState(auth.user);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // Poll the floor total only where the desktop rail (which polls it itself)
  // is not mounted — one clock per shell, never two.
  const floorTotal = useFloorTotal(tier !== 'desktop');
  useEffect(() => { setMoreOpen(false); }, [location.pathname]);
  // Desktop sidebar open/close — persisted like a macOS window state.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('ci_sidebar_collapsed') === '1');
  const toggleSidebar = () => setCollapsed(c => { localStorage.setItem('ci_sidebar_collapsed', c ? '0' : '1'); return !c; });
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

  // ── Phone — bottom tab bar, no side rail, content padded past the bar ──────
  if (tier === 'phone') {
    return (
      <div className="flex min-h-screen">
        <div className="min-w-0 flex-1">
          <TopBar
            touchShell
            dock
            collapsed={false}
            onToggleSidebar={() => setMoreOpen(true)}
            user={user}
            onSignOut={logout}
            actions={<><ChatDock /><NotificationBell /></>}
          />
          <main className="w-full px-3 pt-4"
            style={{ paddingBottom: 'calc(84px + var(--sab))', paddingLeft: 'max(0.75rem, var(--sal))', paddingRight: 'max(0.75rem, var(--sar))' }}>
            <Outlet />
          </main>
          <PhoneNav groups={groups} floorTotal={floorTotal} onMore={() => setMoreOpen(true)} />
          <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} groups={groups} floorTotal={floorTotal} user={user} />
        </div>
      </div>
    );
  }

  // ── Tablet (portrait or landscape) — 76px icon rail + drawer from the header
  if (tier === 'tabp' || tier === 'tabl') {
    return (
      <div className="flex min-h-screen">
        <TabletRail groups={groups} floorTotal={floorTotal} />
        {mobileOpen && (
          <div className="no-print fixed inset-0 z-50">
            <div className="absolute inset-0 bg-[#1D1D1F]/30 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
            <aside className="absolute inset-y-0 left-0 w-[264px] origin-left animate-liquidIn py-3 pl-3">
              <div className="glass flex h-full flex-col rounded-[26px]">
                <div className="px-4 pb-4 pt-6">
                  <span className="block min-w-0 truncate px-1 text-[22px] font-bold leading-tight tracking-[-0.02em] text-[#1D1D1F]">
                    Colour<span className="text-[#007AFF]"> Impressions</span>
                  </span>
                </div>
                <nav className="scrollbar-none flex-1 space-y-4 overflow-y-auto overscroll-contain px-3 pb-4">
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
              </div>
            </aside>
          </div>
        )}
        <div className="min-w-0 flex-1 pl-[84px]" style={{ paddingRight: 'max(0px, var(--sar))' }}>
          <TopBar
            touchShell
            collapsed={false}
            onToggleSidebar={() => setMobileOpen(o => !o)}
            user={user}
            onSignOut={logout}
            actions={<><ChatDock /><NotificationBell /></>}
          />
          <main className="mx-auto w-full max-w-[1880px] px-3 py-5 sm:px-4">
            <Outlet />
          </main>
        </div>
      </div>
    );
  }

  // ── Desktop — the tree below is the pre-tier original, byte for byte ───────
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
        {/* One header at every width — it replaced the mobile-only bar rather
            than joining it, so there is a single place the plant looks for the
            two communication centres. Both mount INTO it as `actions`, which is
            what takes them off the floor of the screen and gives them names and
            counts. */}
        <TopBar
          collapsed={collapsed}
          onToggleSidebar={() => {
            // The same handle means two different things by width: the desktop
            // rail is a persistent window, the phone's is a drawer.
            if (window.matchMedia('(min-width: 1024px)').matches) toggleSidebar();
            else setMobileOpen(o => !o);
          }}
          user={user}
          onSignOut={logout}
          actions={<><ChatDock /><NotificationBell /></>}
        />
        {/* Full-width workspace — tables use the whole pane; when the sidebar
            is hidden the content flows edge to edge (soft cap only on ultrawide). */}
        {/* lg gutter was 32px a side — 64px of the widest screens spent on air
            while wide boards scrolled sideways. 20px still separates the panel
            from the rail. */}
        <main className="mx-auto w-full max-w-[1880px] px-3 py-6 sm:px-4 lg:px-5">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
