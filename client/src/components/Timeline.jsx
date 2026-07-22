// Universal Timeline — one flow for the entire ERP.
// A floating History button lives on every page (mounted in AppLayout). It
// opens a right-hand glass drawer that reads the audit ledger for any custom
// day / range / financial year, auto-scoped to the module you are on — and on
// /floor/<section> pre-filtered to that station. Scope, station, range and
// search can all be changed inside the drawer, so any slice of plant history
// is reachable from anywhere.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import {
  History, X, Search, Loader2, Inbox, ShoppingCart, ClipboardList, Truck,
  ReceiptText, Wallet, ShoppingBag, Warehouse, PackageCheck, PackagePlus,
  Layers, Settings2, Box, UserRound, Factory, CalendarDays, Wrench,
} from 'lucide-react';
import { api, auth, fmt } from '../api.js';
import { MODULES, canAccess, moduleForPath } from '../modules.js';
import { SECTION_META, SECTION_ORDER } from '../sections.js';
import { Select } from './ui.jsx';

// Icon + tint per audit entity — same colour language as the rest of the app.
const ENTITY_META = {
  order: { icon: ShoppingCart, tint: 'bg-sky-50 text-sky-600' },
  order_line: { icon: ShoppingCart, tint: 'bg-sky-50 text-sky-600' },
  job_card: { icon: ClipboardList, tint: 'bg-amber-50 text-amber-700' },
  job_stage: { icon: Factory, tint: 'bg-violet-50 text-violet-600' },
  dispatch: { icon: Truck, tint: 'bg-[#1D1D1F]/[0.06] text-[#1D1D1F]' },
  invoice: { icon: ReceiptText, tint: 'bg-indigo-50 text-indigo-600' },
  payment: { icon: Wallet, tint: 'bg-emerald-50 text-emerald-700' },
  requisition: { icon: ShoppingBag, tint: 'bg-orange-50 text-orange-600' },
  purchase_order: { icon: ShoppingBag, tint: 'bg-orange-50 text-orange-700' },
  grn: { icon: PackageCheck, tint: 'bg-teal-50 text-teal-600' },
  inventory: { icon: Warehouse, tint: 'bg-cyan-50 text-cyan-700' },
  fg_lot: { icon: PackageCheck, tint: 'bg-emerald-50 text-emerald-600' },
  gang_run: { icon: Layers, tint: 'bg-fuchsia-50 text-fuchsia-600' },
  extra_sheet: { icon: PackagePlus, tint: 'bg-rose-50 text-rose-600' },
  machine: { icon: Settings2, tint: 'bg-slate-100 text-slate-600' },
  tool: { icon: Wrench, tint: 'bg-amber-50 text-amber-600' },
  product: { icon: Box, tint: 'bg-blue-50 text-blue-600' },
  user: { icon: UserRound, tint: 'bg-gray-100 text-gray-600' },
};
const entityMeta = e =>
  ENTITY_META[e] || { icon: Settings2, tint: 'bg-slate-100 text-slate-600' };

// ── Date helpers (plant thinks in IST; presets computed on the local clock) ──
const iso = d => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'fy', label: 'This FY' },
];
export function presetRange(key) {
  const now = new Date();
  const t = iso(now);
  const back = days => { const d = new Date(); d.setDate(d.getDate() - days); return iso(d); };
  switch (key) {
    case 'today': return { from: t, to: t };
    case 'yesterday': { const y = back(1); return { from: y, to: y }; }
    case '7d': return { from: back(6), to: t };
    case '30d': return { from: back(29), to: t };
    case 'month': return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: t };
    case 'last_month': return {
      from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: iso(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
    case 'fy': { // Indian financial year — 1 April to 31 March
      const start = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
      return { from: `${start}-04-01`, to: t };
    }
    default: return { from: back(6), to: t };
  }
}

// status:planned→ready → "Status: planned → ready"; workflow:a→b likewise.
const prettyAction = a => {
  const s = String(a || '').replace(/_/g, ' ').replace(/:/g, ': ').replace(/→/g, ' → ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const dateInputCls =
  'h-9 w-full rounded-xl border border-[#1D1D1F]/[0.10] bg-white/75 px-2.5 text-xs font-medium text-[#1D1D1F] ' +
  'shadow-[inset_0_1px_2px_rgba(29,29,31,0.04)] outline-none transition duration-200 ease-apple ' +
  'hover:bg-white/90 focus:border-[#0A84FF] focus:bg-white focus:ring-[3px] focus:ring-[#0A84FF]/20';

const PAGE = 80;

export default function Timeline() {
  const location = useLocation();
  const [open, setOpen] = useState(false);

  // Range — restored from the last session; preset 'custom' keeps raw dates.
  const [range, setRange] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('ci_timeline_range'));
      if (saved?.preset === 'custom' && saved.from && saved.to) return saved;
      if (saved?.preset) return { preset: saved.preset, ...presetRange(saved.preset) };
    } catch { /* fall through */ }
    return { preset: '7d', ...presetRange('7d') };
  });
  const [scope, setScope] = useState('all');
  const [section, setSection] = useState('');
  const [qInput, setQInput] = useState('');
  const [search, setSearch] = useState('');
  const [events, setEvents] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  // Opening the drawer scopes it to wherever the user is standing.
  const openDrawer = () => {
    const mod = moduleForPath(location.pathname);
    const secMatch = location.pathname.match(/^\/floor\/([a-z_]+)/);
    setScope(mod && mod !== 'dashboard' && mod !== 'reports' ? mod : 'all');
    setSection(secMatch && SECTION_META[secMatch[1]] ? secMatch[1] : '');
    setOpen(true);
  };

  // The sidebar "Timeline" entry (and any other trigger) opens the drawer
  // through this event, so the button isn't the only way in.
  useEffect(() => {
    const h = () => openDrawer();
    window.addEventListener('ci:open-timeline', h);
    return () => window.removeEventListener('ci:open-timeline', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  useEffect(() => {
    localStorage.setItem('ci_timeline_range', JSON.stringify(range));
  }, [range]);

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => setSearch(qInput.trim()), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const buildUrl = offset => {
    const p = new URLSearchParams({ from: range.from, to: range.to, scope, limit: String(PAGE) });
    if (section) p.set('section', section);
    if (search) p.set('q', search);
    if (offset) p.set('offset', String(offset));
    return `/timeline?${p.toString()}`;
  };

  // Fresh load on open / any filter change.
  useEffect(() => {
    if (!open) return;
    const seq = ++seqRef.current;
    setLoading(true);
    api.get(buildUrl(0)).then(d => {
      if (seq !== seqRef.current) return;
      setEvents(d.events);
      setHasMore(d.has_more);
    }).catch(() => {}).finally(() => { if (seq === seqRef.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, range.from, range.to, scope, section, search]);

  const loadMore = () => {
    const seq = ++seqRef.current;
    setLoading(true);
    api.get(buildUrl(events.length)).then(d => {
      if (seq !== seqRef.current) return;
      setEvents(ev => [...ev, ...d.events]);
      setHasMore(d.has_more);
    }).catch(() => {}).finally(() => { if (seq === seqRef.current) setLoading(false); });
  };

  useEffect(() => {
    if (!open) return;
    const h = e => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open]);

  // Day grouping — newest day first (server already sorts events desc).
  const days = useMemo(() => {
    const out = [];
    let cur = null;
    for (const e of events) {
      const d = new Date(e.ts);
      const key = iso(d);
      if (!cur || cur.key !== key) {
        cur = {
          key,
          label: d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }),
          items: [],
        };
        out.push(cur);
      }
      cur.items.push(e);
    }
    return out;
  }, [events]);

  const scopeOptions = [
    { value: 'all', label: 'Entire plant' },
    ...MODULES
      .filter(m => !['dashboard', 'reports'].includes(m.key) && canAccess(auth.user, m.key))
      .map(m => ({ value: m.key, label: m.label })),
  ];
  const sectionOptions = [
    { value: '', label: 'All stations' },
    ...SECTION_ORDER.map(k => ({ value: k, label: SECTION_META[k].label })),
  ];
  // Station drill-down only makes sense where stage events can appear.
  const showSection = ['all', 'floor', 'production', 'track', 'extra_sheets'].includes(scope);

  const applyPreset = key => setRange({ preset: key, ...presetRange(key) });
  const setCustom = patch => setRange(r => {
    const next = { ...r, ...patch, preset: 'custom' };
    // Keep the range sane — from must not pass to.
    if (next.from && next.to && next.from > next.to) {
      if (patch.from) next.to = next.from; else next.from = next.to;
    }
    return next;
  });

  return (
    <>
      {/* Floating trigger — stacked above the notification bell on every page */}
      <button onClick={openDrawer} title="Timeline"
        className="no-print glass fixed bottom-16 right-4 z-40 flex h-10 w-10 items-center justify-center rounded-full text-[#515154] transition-all duration-200 ease-apple hover:bg-white/85 hover:text-[#007AFF]">
        <History size={17} />
      </button>

      {open && createPortal(
        <div className="no-print fixed inset-0 z-[70]">
          <div className="absolute inset-0 bg-[#1D1D1F]/25 backdrop-blur-[3px] animate-fadeIn" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 right-0 w-full max-w-[460px] p-3">
            <div className="glass flex h-full flex-col overflow-hidden rounded-[26px] animate-scaleIn">

              {/* Header */}
              <div className="flex items-center gap-2.5 border-b border-[#1D1D1F]/[0.06] bg-white/40 px-4 py-3.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#E1EFFF] text-[#0064D2]"><History size={15} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold tracking-[-0.01em] text-[#1D1D1F]">Timeline</p>
                  <p className="truncate text-[11px] text-[#86868B]">
                    {fmt.date(range.from)}{range.from !== range.to ? ` — ${fmt.date(range.to)}` : ''}
                    {' · '}{scopeOptions.find(o => o.value === scope)?.label || 'Entire plant'}
                    {section ? ` · ${SECTION_META[section]?.label}` : ''}
                  </p>
                </div>
                <button onClick={() => setOpen(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-[#1D1D1F]/[0.05] text-[#86868B] transition-colors hover:bg-[#1D1D1F]/[0.10] hover:text-[#1D1D1F]">
                  <X size={15} />
                </button>
              </div>

              {/* Controls */}
              <div className="space-y-2.5 border-b border-[#1D1D1F]/[0.06] bg-white/25 px-4 py-3">
                <div className="flex flex-wrap gap-1">
                  {PRESETS.map(p => (
                    <button key={p.key} onClick={() => applyPreset(p.key)}
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all duration-200 ease-apple ${
                        range.preset === p.key
                          ? 'bg-white text-[#007AFF] shadow-[0_2px_8px_rgba(0,122,255,0.16),inset_0_1px_0_rgba(255,255,255,0.95)] ring-1 ring-white/80'
                          : 'text-[#515154] hover:bg-white/55 hover:text-[#1D1D1F]'
                      }`}>
                      {p.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <CalendarDays size={14} className="shrink-0 text-[#86868B]" />
                  <input type="date" className={dateInputCls} value={range.from} max={range.to}
                    onChange={e => e.target.value && setCustom({ from: e.target.value })} />
                  <span className="text-xs text-[#86868B]">to</span>
                  <input type="date" className={dateInputCls} value={range.to} min={range.from}
                    onChange={e => e.target.value && setCustom({ to: e.target.value })} />
                </div>
                <div className={`grid gap-2 ${showSection ? 'grid-cols-2' : 'grid-cols-1'}`}>
                  <Select options={scopeOptions} value={scope} placeholder="Scope"
                    onChange={e => { setScope(e.target.value || 'all'); }} />
                  {showSection && (
                    <Select options={sectionOptions} value={section} placeholder="All stations"
                      onChange={e => setSection(e.target.value)} />
                  )}
                </div>
                <div className="relative">
                  <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input value={qInput} onChange={e => setQInput(e.target.value)}
                    placeholder="Search actions, notes, people…"
                    className="h-9 w-full rounded-full border border-[#1D1D1F]/[0.10] bg-white/75 pl-8 pr-3 text-xs font-medium text-[#1D1D1F] shadow-[inset_0_1px_2px_rgba(29,29,31,0.04)] outline-none transition duration-200 ease-apple hover:bg-white/90 focus:border-[#0A84FF] focus:bg-white focus:ring-[3px] focus:ring-[#0A84FF]/20" />
                </div>
              </div>

              {/* Feed */}
              <div className="flex-1 overflow-y-auto">
                {loading && events.length === 0 && (
                  <div className="flex items-center justify-center gap-2 py-14 text-sm text-[#86868B]">
                    <Loader2 size={16} className="animate-spin" /> Loading history…
                  </div>
                )}
                {!loading && events.length === 0 && (
                  <div className="py-14 text-center text-sm text-[#86868B]">
                    <Inbox className="mx-auto mb-2 text-[#C7C7CC]" size={22} />
                    Nothing happened in this window.
                  </div>
                )}
                {days.map(day => (
                  <div key={day.key}>
                    <div className="sticky top-0 z-10 border-b border-[#1D1D1F]/[0.04] bg-white/75 px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#86868B] backdrop-blur-md">
                      {day.label}
                      <span className="ml-1.5 rounded-full bg-[#1D1D1F]/[0.06] px-1.5 text-[9px] tabular-nums">{day.items.length}</span>
                    </div>
                    {day.items.map(e => {
                      const m = entityMeta(e.entity);
                      return (
                        <div key={e.id} className="flex gap-2.5 border-b border-[#1D1D1F]/[0.03] px-4 py-2.5 transition-colors hover:bg-white/55">
                          <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${m.tint}`}>
                            <m.icon size={13} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                              <p className="truncate text-xs font-bold text-[#1D1D1F]">
                                {e.label || `${fmt.title(e.entity)}${e.entity_id ? ` #${e.entity_id}` : ''}`}
                              </p>
                              <span className="shrink-0 text-[10px] tabular-nums text-[#86868B]">
                                {new Date(e.ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>
                            <p className="text-[11px] font-medium text-[#515154]">
                              {prettyAction(e.action)}
                              {e.section && SECTION_META[e.section] && (
                                <span className={`ml-1.5 inline-flex rounded-full px-1.5 py-px text-[9px] font-bold ${SECTION_META[e.section].tint}`}>
                                  {SECTION_META[e.section].label}
                                </span>
                              )}
                            </p>
                            {e.detail && <p className="mt-0.5 break-words text-[11px] leading-snug text-[#86868B]">{e.detail}</p>}
                            {e.user_name && <p className="mt-0.5 text-[10px] text-[#AEAEB2]">by {e.user_name}</p>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
                {hasMore && (
                  <div className="p-3 text-center">
                    <button onClick={loadMore} disabled={loading}
                      className="rounded-full border border-white/75 bg-white/65 px-4 py-1.5 text-xs font-semibold text-[#1D1D1F] shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-all hover:bg-white/90 hover:text-[#007AFF] disabled:opacity-50">
                      {loading ? 'Loading…' : 'Load earlier events'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>,
        document.body,
      )}
    </>
  );
}
