// Master 360 — the drill-down modal behind every Product / Machine / Material
// row in Masters. One centered glass panel with the record's whole story:
//   · timeline selection (same presets + custom range as the universal Timeline)
//   · KPI strip for the window
//   · Ledger — ERP movement register with a running balance
//   · Invoices / COA (products) — movement against each invoice, COA per line
//   · Purchases (materials) — PO lines + GRNs
//   · Register (machines) — the logbook (auto runs + manual entries)
//   · Logs — every operational event that touched this record anywhere
//   · Audit — the master record's own change trail
// Every tab exports to branded PDF / Excel through the standard ExportMenu.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import {
  X, CalendarDays, Loader2, Inbox, BookOpenText, ReceiptText, BadgeCheck,
  ScrollText, ShieldCheck, ShoppingBag, Box, Settings2, Layers, ClipboardList, MapPin,
  Pencil,
} from 'lucide-react';
import { api, auth, fmt } from '../api.js';
import { ExportMenu, SubTabs } from './ui.jsx';
import { presetRange } from './Timeline.jsx';
import ProductMasterEditor from './ProductMasterEditor.jsx';
import { canOpenProductHistory } from '../lib/productHistoryAccess.js';

const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'month', label: 'This month' },
  { key: 'fy', label: 'This FY' },
];

const KIND_META = {
  products: { icon: Box, tint: 'bg-blue-50 text-blue-600', label: 'Product' },
  materials: { icon: Layers, tint: 'bg-cyan-50 text-cyan-700', label: 'Board' },
  machines: { icon: Settings2, tint: 'bg-slate-100 text-slate-600', label: 'Machine' },
};

const LEDGER_TYPE_META = {
  fg_receipt: { label: 'Production receipt', cls: 'bg-emerald-50 text-emerald-700' },
  dispatch: { label: 'Dispatch', cls: 'bg-sky-50 text-sky-700' },
  adjustment: { label: 'Adjustment', cls: 'bg-slate-100 text-slate-600' },
  wastage: { label: 'Process scrap', cls: 'bg-amber-50 text-amber-700' },
  wastage_reversal: { label: 'Scrap reversal', cls: 'bg-amber-50 text-amber-700' },
  grn: { label: 'GRN receipt', cls: 'bg-emerald-50 text-emerald-700' },
  qc_release: { label: 'QC release', cls: 'bg-teal-50 text-teal-700' },
  qc_reject: { label: 'QC reject', cls: 'bg-red-50 text-red-600' },
  consumption: { label: 'Consumption', cls: 'bg-sky-50 text-sky-700' },
};
const typeMeta = t => LEDGER_TYPE_META[t] || { label: fmt.title(t), cls: 'bg-slate-100 text-slate-600' };

const prettyAction = a => {
  const s = String(a || '').replace(/_/g, ' ').replace(/:/g, ': ').replace(/→/g, ' → ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const dt = s => (s ? new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const present = v => v != null && String(v).trim() !== '';
const yn = v => (+v ? 'Yes' : 'No');

// Sheet counts, printed the way the RM row prints them. Board quantities are
// DOUBLE PRECISION and the Demand tab's Frozen and Shortfall are both derived
// by subtraction, so they arrive carrying float noise — fmt.num alone would put
// "3,000.0000000001" beside a row reading 3,000. A sheet is a whole thing.
const sheets = n => fmt.num(Math.round(+n || 0));

// "Where did this happen" — a shop-floor stage (+ machine) for production
// events, otherwise the owning module/register.
const stationText = st => {
  if (!st) return '';
  if (st.stage) return fmt.stage(st.stage) + (st.machine ? ` · ${st.machine}` : '');
  return st.label || '';
};

const dateInputCls =
  'h-8 w-full rounded-xl border border-[#1D1D1F]/[0.10] bg-white/75 px-2.5 text-xs font-medium text-[#1D1D1F] ' +
  'shadow-[inset_0_1px_2px_rgba(29,29,31,0.04)] outline-none transition duration-200 ease-apple ' +
  'hover:bg-white/90 focus:border-[#0A84FF] focus:bg-white focus:ring-[3px] focus:ring-[#0A84FF]/20';

// Small stat chip for the KPI strip. `highlight` gives a leading tile a blue
// emphasis box (used for pending orders); `warn` is the amber attention style.
function Stat({ label, value, accent = 'text-[#1D1D1F]', warn, highlight }) {
  const box = highlight ? 'border-[#0A84FF]/30 bg-[#0A84FF]/[0.07]'
    : warn ? 'border-amber-200 bg-amber-50/70' : 'border-white/70 bg-white/60';
  const val = highlight ? 'text-[#0A84FF]' : warn ? 'text-amber-700' : accent;
  const lab = highlight ? 'text-[#0A84FF]/70' : 'text-[#86868B]';
  return (
    <div className={`rounded-2xl border px-3 py-2 ${box}`}>
      <p className={`text-sm font-bold tabular-nums tracking-[-0.01em] ${val}`}>{value}</p>
      <p className={`text-[10px] font-semibold uppercase tracking-wider ${lab}`}>{label}</p>
    </div>
  );
}

function ProductBrief({ record }) {
  if (!record) return null;
  const codeRows = [
    ['Internal', record.code || record.internal_carton_code],
    ['Artwork', record.party_artwork_code],
    ['Party item', record.party_item_code],
    ['Output', record.output_number],
    ['Shade card', record.shade_card_number],
  ].filter(([, v]) => present(v));
  const specs = [
    ['Board', record.board_material_name || record.board_grade],
    ['GSM', record.gsm],
    ['Size', record.size],
    ['Child', record.child_l && record.child_w ? `${record.child_l} x ${record.child_w}` : null],
    ['Parent', record.parent_l && record.parent_w ? `${record.parent_l} x ${record.parent_w}` : null],
    ['Ups', record.ups],
    ['Colours', present(record.colors) ? `${record.colors}${record.colour_type ? ` ${record.colour_type}` : ''}` : null],
    ['Print', record.print_process],
    ['Coating', record.coating && record.coating !== 'none' ? fmt.title(record.coating) : null],
    ['Special', record.special && record.special !== 'none' ? fmt.title(record.special) : null],
    ['Pasting', record.pasting_type],
    ['Emboss', record.emboss ? yn(record.emboss) : null],
    ['Leafing', record.leafing ? [yn(record.leafing), record.leafing_colour].filter(Boolean).join(' · ') : null],
    ['Die', record.die_number],
    ['Block', record.block_number],
    ['Type', record.product_type],
    ['GST', record.effective_gst != null ? `${record.effective_gst}%` : null],
    ['Rate', record.rate != null ? fmt.inr(record.rate) : null],
    ['MRP', record.mrp != null ? fmt.inr(record.mrp) : null],
  ].filter(([, v]) => present(v));
  if (!codeRows.length && !specs.length) return null;
  return (
    <div className="border-b border-[#1D1D1F]/[0.06] bg-white/30 px-4 py-2">
      {codeRows.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {codeRows.map(([label, value]) => (
            <span key={label} className="inline-flex min-w-0 items-center gap-1 rounded-md bg-white/70 px-2 py-1 text-[10px] font-semibold text-[#515154] ring-1 ring-[#1D1D1F]/[0.07]">
              <span className="shrink-0 text-[#86868B]">{label}</span>
              <span className="min-w-0 truncate font-mono text-[#1D1D1F]">{value}</span>
            </span>
          ))}
        </div>
      )}
      {specs.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#515154]">
          {specs.map(([label, value]) => (
            <span key={label} className="min-w-0">
              <span className="font-semibold text-[#86868B]">{label}</span>{' '}
              <span className="font-medium text-[#1D1D1F]">{value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Minimal drawer table — sticky header, dense rows, tabular numerals.
function Sheet({ cols, rows, empty }) {
  if (!rows.length) {
    return (
      <div className="py-12 text-center text-sm text-[#86868B]">
        <Inbox className="mx-auto mb-2 text-[#C7C7CC]" size={22} />{empty}
      </div>
    );
  }
  return (
    <table className="w-full text-left text-xs">
      <thead className="sticky top-0 z-10 bg-white/85 backdrop-blur-md">
        <tr>
          {cols.map(c => (
            <th key={c.key} className={`px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-[#86868B] ${c.align === 'right' ? 'text-right' : ''}`}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r0, i) => (
          <tr key={r0.id ?? i} className={`border-t border-[#1D1D1F]/[0.04] align-top ${i % 2 ? 'bg-[#5B6B8C]/[0.045]' : ''}`}>
            {cols.map(c => (
              <td key={c.key} className={`px-3 py-2 ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${c.cellClass || ''}`}>
                {c.render ? c.render(r0) : r0[c.key] ?? '—'}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Audit / logs feed — same visual language as the universal Timeline.
function Feed({ events, empty }) {
  if (!events.length) {
    return (
      <div className="py-12 text-center text-sm text-[#86868B]">
        <Inbox className="mx-auto mb-2 text-[#C7C7CC]" size={22} />{empty}
      </div>
    );
  }
  return events.map(e => {
    const station = stationText(e.station);
    return (
      <div key={e.id} className="border-b border-[#1D1D1F]/[0.04] px-4 py-2.5 transition-colors hover:bg-white/55">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-xs font-bold text-[#1D1D1F]">
            {e.label || `${fmt.title(e.entity)}${e.entity_id ? ` #${e.entity_id}` : ''}`}
          </p>
          <span className="shrink-0 text-[10px] tabular-nums text-[#86868B]">{dt(e.ts)}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-[11px] font-medium text-[#515154]">{prettyAction(e.action)}</p>
          {station && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#5B6B8C]/10 px-2 py-0.5 text-[10px] font-semibold text-[#5B6B8C]">
              <MapPin size={10} className="shrink-0" />{station}
            </span>
          )}
        </div>
        {e.detail && <p className="mt-0.5 break-words text-[11px] leading-snug text-[#86868B]">{e.detail}</p>}
        {e.user_name && <p className="mt-0.5 text-[10px] text-[#AEAEB2]">by {e.user_name}</p>}
      </div>
    );
  });
}

// `actions` is an optional node dropped into the drawer header beside Export.
// Warehouse uses it to put Adjust Stock where the material's full history is,
// which is what let the per-row Adjust button leave the stock list.
export default function MasterHistory({ kind, record, onClose, actions }) {
  const location = useLocation();
  const meta = KIND_META[kind];
  const [range, setRange] = useState({ preset: 'fy', ...presetRange('fy') });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  // Frozen-board breakdown — materials only, not windowed by date (it's
  // a live snapshot of open order lines, same as the aggregate on the RM
  // Stock table), so it gets its own fetch alongside the master-history one.
  const [demand, setDemand] = useState(null);
  const [demandLoading, setDemandLoading] = useState(false);
  // Products open on the Order book so pending orders are the first thing you see.
  const [tab, setTab] = useState(kind === 'products' ? 'orders' : 'ledger');
  const [editingProduct, setEditingProduct] = useState(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const seqRef = useRef(0);
  const demandSeqRef = useRef(0);

  useEffect(() => {
    if (!record) return;
    const seq = ++seqRef.current;
    setLoading(true);
    api.get(`/master-history/${kind}/${record.id}?from=${range.from}&to=${range.to}`)
      .then(d => { if (seq === seqRef.current) setData(d); })
      .catch(() => {})
      .finally(() => { if (seq === seqRef.current) setLoading(false); });
  }, [kind, record?.id, range.from, range.to, refreshVersion]);

  useEffect(() => {
    if (!record || kind !== 'materials') { setDemand(null); return; }
    const seq = ++demandSeqRef.current;
    setDemandLoading(true);
    api.get(`/inventory/demand/${record.id}`)
      .then(d => { if (seq === demandSeqRef.current) setDemand(d); })
      .catch(() => {})
      .finally(() => { if (seq === demandSeqRef.current) setDemandLoading(false); });
  }, [kind, record?.id]);

  useEffect(() => {
    const h = e => e.key === 'Escape' && !editingProduct && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, editingProduct]);

  const applyPreset = key => setRange({ preset: key, ...presetRange(key) });
  const setCustom = patch => setRange(r0 => {
    const next = { ...r0, ...patch, preset: 'custom' };
    if (next.from && next.to && next.from > next.to) {
      if (patch.from) next.to = next.from; else next.from = next.to;
    }
    return next;
  });

  const s = data?.summary || {};
  const ledger = data?.ledger || data?.register || [];
  const orders = data?.orders || [];
  const invoices = data?.invoices || [];
  const coas = data?.coas || [];
  const purchases = data?.purchases || [];
  const grns = data?.grns || [];
  const logs = data?.logs || [];
  const auditRows = data?.audit || [];
  const demandLines = demand?.lines || [];
  const shownRecord = data?.record || record;
  const canEditProduct = kind === 'products'
    && canOpenProductHistory(location.pathname)
    && ['admin', 'planner'].includes(auth.user?.role);

  const views = useMemo(() => [
    ...(kind === 'products' ? [{ key: 'orders', label: 'Orders', icon: ClipboardList, count: orders.length }] : []),
    { key: 'ledger', label: kind === 'machines' ? 'Register' : 'Ledger', icon: BookOpenText, count: ledger.length },
    ...(kind === 'products' ? [
      { key: 'invoices', label: 'Invoices', icon: ReceiptText, count: invoices.length },
      { key: 'coa', label: 'COA', icon: BadgeCheck, count: coas.length },
    ] : []),
    ...(kind === 'materials' ? [
      { key: 'demand', label: 'Demand', icon: ClipboardList, count: demandLines.length },
      { key: 'purchases', label: 'Purchases', icon: ShoppingBag, count: purchases.length + grns.length },
    ] : []),
    { key: 'logs', label: 'Logs', icon: ScrollText, count: logs.length },
    { key: 'audit', label: 'Audit', icon: ShieldCheck, count: auditRows.length },
  ], [kind, orders.length, ledger.length, invoices.length, coas.length, purchases.length, grns.length, logs.length, auditRows.length, demandLines.length]);

  // Ledger columns per kind. `counts:false` rows (process scrap on products)
  // carry the balance forward unchanged — shown muted so the register reads
  // like a hand-kept stock book.
  const ledgerCols = kind === 'machines' ? [
    { key: 'ts', label: 'Date', render: r0 => <span className="whitespace-nowrap text-[#515154]">{dt(r0.ts)}</span> },
    { key: 'entry_type', label: 'Type', render: r0 => (
      <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${
        r0.entry_type === 'production' ? 'bg-emerald-50 text-emerald-700'
        : r0.entry_type === 'breakdown' ? 'bg-red-50 text-red-600'
        : r0.entry_type === 'maintenance' ? 'bg-amber-50 text-amber-700'
        : 'bg-slate-100 text-slate-600'}`}>{fmt.title(r0.entry_type)}</span>) },
    { key: 'description', label: 'Particulars', cellClass: 'min-w-[140px]', render: r0 => (
      <span>
        <span className="font-semibold text-[#1D1D1F]">{r0.description}</span>
        {r0.ref && <span className="ml-1.5 font-mono text-[10px] text-[#86868B]">{r0.ref}</span>}
        {r0.stage && <span className="ml-1.5 text-[10px] capitalize text-[#86868B]">{fmt.stage(r0.stage)}</span>}
        {r0.remarks && <span className="mt-0.5 block text-[10px] text-[#86868B]">{r0.remarks}</span>}
      </span>) },
    { key: 'operator', label: 'Operator', render: r0 => r0.operator || <span className="text-gray-300">—</span> },
    { key: 'out', label: 'Qty', align: 'right', render: r0 => r0.out != null ? <span className="font-semibold">{fmt.num(r0.out)}</span> : <span className="text-gray-300">—</span> },
    { key: 'scrap', label: 'Scrap', align: 'right', render: r0 => r0.scrap ? <span className="font-semibold text-amber-700">{fmt.num(r0.scrap)}</span> : <span className="text-gray-300">—</span> },
  ] : [
    { key: 'ts', label: 'Date', render: r0 => <span className="whitespace-nowrap text-[#515154]">{dt(r0.ts)}</span> },
    { key: 'type', label: 'Type', render: r0 => (
      <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${typeMeta(r0.type).cls}`}>
        {typeMeta(r0.type).label}</span>) },
    { key: 'note', label: 'Particulars', cellClass: 'min-w-[130px]', render: r0 => (
      <span>
        {r0.label && <span className="block font-semibold text-[#1D1D1F]">{r0.label}</span>}
        {r0.batch_no && <span className="block font-mono text-[10px] text-[#86868B]">Batch {r0.batch_no}</span>}
        {r0.note && <span className="block text-[10px] text-[#86868B]">{r0.note}</span>}
        {!r0.label && !r0.note && !r0.batch_no && <span className="text-gray-300">—</span>}
      </span>) },
    { key: 'in', label: 'In', align: 'right', render: r0 => r0.in != null ? <span className="font-semibold text-emerald-700">{fmt.num(r0.in)}</span> : <span className="text-gray-300">—</span> },
    { key: 'out', label: 'Out', align: 'right', render: r0 => r0.out != null ? <span className={`font-semibold ${r0.counts ? 'text-red-600' : 'text-amber-600'}`}>{fmt.num(r0.out)}</span> : <span className="text-gray-300">—</span> },
    { key: 'balance', label: 'Balance', align: 'right', render: r0 => <span className={`font-bold ${r0.counts ? 'text-[#1D1D1F]' : 'text-[#AEAEB2]'}`}>{fmt.num(r0.balance)}</span> },
  ];

  const ORDER_STATUS_CLS = {
    pending: 'bg-slate-100 text-slate-600', planned: 'bg-indigo-50 text-indigo-600',
    ready: 'bg-violet-50 text-violet-600', in_production: 'bg-amber-50 text-amber-700',
    produced: 'bg-teal-50 text-teal-700', dispatched: 'bg-emerald-50 text-emerald-700',
    cancelled: 'bg-red-50 text-red-600',
  };
  const orderCols = [
    { key: 'po_number', label: 'PO', render: r0 => (
      <span>
        <span className="block font-mono text-[11px] font-bold text-[#1D1D1F]">{r0.po_number}</span>
        <span className="block text-[10px] text-[#86868B]">{fmt.date(r0.po_date)}</span>
      </span>) },
    { key: 'delivery_date', label: 'Delivery', render: r0 => r0.delivery_date
      ? <span className="text-[11px] text-[#515154]">{fmt.date(r0.delivery_date)}</span>
      : <span className="text-gray-300">—</span> },
    { key: 'qty', label: 'Ordered', align: 'right', render: r0 => <span className="font-semibold">{fmt.num(r0.qty)}</span> },
    { key: 'dispatched_qty', label: 'Dispatched', align: 'right', render: r0 => <span className="text-sky-700">{fmt.num(r0.dispatched_qty)}</span> },
    // Pending is what the CUSTOMER is still owed, so FG reserved against the
    // line does not reduce it — those cartons have not shipped. It does reduce
    // what has to be MADE, and saying so here is the difference between "we owe
    // 5,000" and "we owe 5,000 and 2,000 of it is already sitting in the store".
    { key: 'pending_qty', label: 'Pending', align: 'right',
      export: r0 => +r0.pending_qty || 0,
      render: r0 => +r0.pending_qty > 0 ? (
        <div className="leading-tight">
          <span className="font-bold text-amber-700">{fmt.num(r0.pending_qty)}</span>
          {+r0.fg_consumed_qty > 0 && (
            <div className="whitespace-nowrap text-[10px] font-semibold text-violet-600"
              title={`${fmt.num(r0.fg_consumed_qty)} already covered from finished-goods stock — only ${fmt.num(r0.to_make_qty)} still has to be made`}>
              {fmt.num(r0.fg_consumed_qty)} from FG · make {fmt.num(r0.to_make_qty)}
            </div>
          )}
        </div>
      ) : <span className="font-semibold text-emerald-700">0</span> },
    { key: 'status', label: 'Status', render: r0 => (
      <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${ORDER_STATUS_CLS[r0.status] || 'bg-slate-100 text-slate-600'}`}>
        {fmt.title(r0.status)}</span>) },
  ];

  const invoiceCols = [
    { key: 'invoice_number', label: 'Invoice', render: r0 => (
      <span>
        <span className="block font-mono text-[11px] font-bold text-[#1D1D1F]">{r0.invoice_number}</span>
        <span className="block text-[10px] text-[#86868B]">{fmt.date(r0.invoice_date)}</span>
      </span>) },
    { key: 'challan_number', label: 'Challan', render: r0 => (
      <span>
        <span className="block font-mono text-[11px] text-[#515154]">{r0.challan_number}</span>
        <span className="block text-[10px] text-[#86868B]">{fmt.date(r0.dispatched_at)}</span>
      </span>) },
    { key: 'qty', label: 'Qty', align: 'right', render: r0 => <span className="font-semibold">{fmt.num(r0.qty)}</span> },
    { key: 'rate', label: 'Rate', align: 'right', render: r0 => `₹${r0.rate}` },
    { key: 'amount', label: 'Amount', align: 'right', render: r0 => <span className="font-semibold">{fmt.inr(r0.amount)}</span> },
    { key: 'status', label: 'Status', render: r0 => (
      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${
        r0.status === 'paid' ? 'bg-emerald-50 text-emerald-700'
        : r0.status === 'cancelled' ? 'bg-red-50 text-red-600' : 'bg-sky-50 text-sky-700'}`}>{fmt.title(r0.status)}</span>) },
    { key: 'coa_number', label: 'COA', render: r0 => r0.coa_number ? (
      <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ${
        r0.coa_status === 'issued' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}
        title={r0.coa_status === 'issued' ? 'COA issued' : 'COA draft'}>{r0.coa_number}</span>
    ) : <span className="inline-block rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-600">No COA</span> },
  ];

  const coaCols = [
    { key: 'coa_number', label: 'COA', render: r0 => (
      <span>
        <span className="block font-mono text-[11px] font-bold text-[#1D1D1F]">{r0.coa_number}</span>
        <span className="block text-[10px] text-[#86868B]">{fmt.date(r0.ts)}</span>
      </span>) },
    { key: 'status', label: 'Status', render: r0 => (
      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${
        r0.status === 'issued' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
        {r0.status === 'issued' ? `Issued ${fmt.date(r0.issued_at)}` : 'Draft'}</span>) },
    { key: 'invoice_number', label: 'Invoice', render: r0 => r0.invoice_number
      ? <span className="font-mono text-[11px] text-[#515154]">{r0.invoice_number}</span>
      : <span className="inline-block rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-600">Unlinked</span> },
    { key: 'challan_number', label: 'Challan', render: r0 => <span className="font-mono text-[11px] text-[#515154]">{r0.challan_number}</span> },
    { key: 'qty', label: 'Qty', align: 'right', render: r0 => <span className="font-semibold">{fmt.num(r0.qty)}</span> },
    { key: 'batch_no', label: 'Batch', render: r0 => r0.batch_no ? <span className="font-mono text-[10px]">{r0.batch_no}</span> : <span className="text-gray-300">—</span> },
    { key: 'approved_by', label: 'Approved', render: r0 => r0.approved_by || <span className="text-gray-300">—</span> },
  ];

  const demandCols = [
    { key: 'po_number', label: 'Order', render: r0 => (
      <span>
        <span className="block font-mono text-[11px] font-bold text-[#1D1D1F]">{r0.po_number}</span>
        <span className="block text-[10px] text-[#86868B]">{fmt.date(r0.delivery_date)}</span>
      </span>) },
    { key: 'customer_name', label: 'Customer', cellClass: 'min-w-[110px]' },
    { key: 'product_name', label: 'Product', cellClass: 'min-w-[130px]', render: r0 => (
      <span>
        <span className="block font-semibold text-[#1D1D1F]">{r0.product_name}</span>
        {r0.product_code && <span className="block text-[10px] text-[#86868B]">{r0.product_code}</span>}
      </span>) },
    { key: 'party_artwork_code', label: 'Artwork', render: r0 => r0.party_artwork_code || <span className="text-gray-300">—</span> },
    { key: 'order_qty', label: 'Order Qty', align: 'right', render: r0 => <span className="font-semibold">{fmt.num(r0.order_qty)}</span> },
    { key: 'sheets_required', label: 'Sheets Required', align: 'right', render: r0 => <span className="font-bold">{fmt.num(r0.sheets_required)}</span> },
    // Is this line's board frozen on THIS material? The list is wider than the
    // Frozen figure above it by construction: a job the planning engine split
    // across two boards is a live claim on both but frozen on each for only its
    // own share, and a job that has already drawn part of its board keeps its
    // residue frozen while dropping out of the list entirely. Without the flag
    // a reader adds Sheets Required down the column and gets a total the strip
    // above does not show — which is the disagreement this tab just stopped
    // having with the row it opens from.
    { key: 'frozen', label: 'Frozen', render: r0 => r0.frozen
      ? <span className="inline-block whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">Frozen</span>
      : <span className="inline-block whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">Not frozen</span> },
    { key: 'planned_date', label: 'Planned Date', render: r0 => r0.planned_date
      ? <span className="text-[11px] text-[#515154]">{fmt.date(r0.planned_date)}</span>
      : <span className="text-gray-300">—</span> },
    { key: 'status', label: 'Status', render: r0 => (
      <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${ORDER_STATUS_CLS[r0.status] || 'bg-slate-100 text-slate-600'}`}>
        {fmt.title(r0.status)}</span>) },
  ];

  const poCols = [
    { key: 'po_number', label: 'PO', render: r0 => (
      <span>
        <span className="block font-mono text-[11px] font-bold text-[#1D1D1F]">{r0.po_number}</span>
        <span className="block text-[10px] text-[#86868B]">{fmt.date(r0.ts)}</span>
      </span>) },
    { key: 'vendor_name', label: 'Vendor', cellClass: 'min-w-[110px]' },
    { key: 'qty', label: 'Ordered', align: 'right', render: r0 => <span className="font-semibold">{fmt.num(r0.qty)}</span> },
    { key: 'rate', label: 'Rate', align: 'right', render: r0 => `₹${r0.rate}` },
    { key: 'received_qty', label: 'Received', align: 'right', render: r0 => (
      <span className={`font-semibold ${+r0.received_qty >= +r0.qty ? 'text-emerald-700' : 'text-amber-700'}`}>{fmt.num(r0.received_qty)}</span>) },
    { key: 'status', label: 'Status', render: r0 => (
      <span className="inline-block whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">{fmt.title(r0.status)}</span>) },
  ];
  const grnCols = [
    { key: 'grn_number', label: 'GRN', render: r0 => (
      <span>
        <span className="block font-mono text-[11px] font-bold text-[#1D1D1F]">{r0.grn_number}</span>
        <span className="block text-[10px] text-[#86868B]">{fmt.date(r0.ts)}</span>
      </span>) },
    { key: 'po_number', label: 'PO', render: r0 => r0.po_number ? <span className="font-mono text-[11px] text-[#515154]">{r0.po_number}</span> : <span className="text-[10px] text-[#86868B]">Direct</span> },
    { key: 'vendor_name', label: 'Vendor', render: r0 => r0.vendor_name || <span className="text-gray-300">—</span> },
    { key: 'qty', label: 'Qty', align: 'right', render: r0 => <span className="font-semibold">{fmt.num(r0.qty)}</span> },
    { key: 'batch_no', label: 'Batch', render: r0 => <span className="font-mono text-[10px]">{r0.batch_no}</span> },
    { key: 'status', label: 'QC', render: r0 => (
      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${
        r0.status === 'accepted' ? 'bg-emerald-50 text-emerald-700'
        : r0.status === 'rejected' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'}`}>{fmt.title(r0.status)}</span>) },
  ];

  // KPI strip per kind. Pending orders leads for products — the number the
  // plant most wants at a glance.
  const stats = kind === 'products' ? [
    { label: 'Pending orders', value: fmt.num(s.orders_pending), highlight: true },
    { label: 'Produced', value: fmt.num(s.produced), accent: 'text-emerald-700' },
    { label: 'Dispatched', value: fmt.num(s.dispatched), accent: 'text-sky-700' },
    { label: 'Invoiced', value: `${fmt.num(s.invoiced_qty)} · ${fmt.inr(s.invoiced_value)}` },
    { label: 'FG on hand', value: fmt.num(s.fg_on_hand) },
    { label: 'Await invoice', value: fmt.num(s.pending_invoice_qty), warn: +s.pending_invoice_qty > 0 },
    { label: 'Lines w/o COA', value: fmt.num(s.lines_without_coa), warn: +s.lines_without_coa > 0 },
  ] : kind === 'materials' ? [
    { label: 'Received', value: fmt.num(s.received), accent: 'text-emerald-700' },
    { label: 'Consumed', value: fmt.num(s.consumed), accent: 'text-sky-700' },
    // The SAME figure the Demand tab prints two inches below and the RM row
    // prints one click away — master-history's `available` is SUM(qty) WHERE
    // status='available', un-windowed, which is the shelf. It cannot keep the
    // old name while they carry the new one: two words for one number inside a
    // single drawer is the confusion this rebuild exists to end.
    { label: 'On Shelf', value: fmt.num(s.available) },
    { label: 'Quarantine', value: fmt.num(s.quarantine), warn: +s.quarantine > 0 },
    { label: 'On order', value: fmt.num(s.on_order) },
  ] : [
    { label: 'Runs', value: fmt.num(s.runs) },
    { label: 'Output', value: fmt.num(s.output), accent: 'text-emerald-700' },
    { label: 'Scrap', value: fmt.num(s.scrap), warn: +s.scrap > 0 },
    { label: 'Manual entries', value: fmt.num(s.manual_entries) },
    { label: 'Downtime notes', value: fmt.num(s.downtime_entries), warn: +s.downtime_entries > 0 },
  ];

  // Export spec for the active tab — same branded PDF/XLSX as everywhere else.
  const buildExport = () => {
    const base = {
      name: `${shownRecord.name} — ${tab}`,
      title: `${shownRecord.name} · ${views.find(v => v.key === tab)?.label}`,
      subtitle: `${meta.label} 360 · ${fmt.date(range.from)} — ${fmt.date(range.to)}`,
      meta: [shownRecord.code && `Code: ${shownRecord.code}`, shownRecord.customer_name && String(shownRecord.customer_name)].filter(Boolean),
    };
    const text = c => ({ ...c, render: undefined });
    if (tab === 'ledger') return kind === 'machines'
      ? { ...base, columns: [
          { key: 'ts', label: 'Date' }, { key: 'entry_type', label: 'Type' }, { key: 'description', label: 'Particulars' },
          { key: 'ref', label: 'Ref' }, { key: 'operator', label: 'Operator' }, { key: 'out', label: 'Qty' }, { key: 'scrap', label: 'Scrap' }],
          rows: ledger.map(l => ({ ...l, ts: dt(l.ts) })) }
      : { ...base, columns: [
          { key: 'ts', label: 'Date' }, { key: 'type', label: 'Type' }, { key: 'particulars', label: 'Particulars' },
          { key: 'in', label: 'In' }, { key: 'out', label: 'Out' }, { key: 'balance', label: 'Balance' }],
          rows: ledger.map(l => ({ ...l, ts: dt(l.ts), type: typeMeta(l.type).label,
            particulars: [l.label, l.batch_no && `Batch ${l.batch_no}`, l.note].filter(Boolean).join(' · ') })) };
    if (tab === 'orders') return { ...base, columns: orderCols.map(text),
      rows: orders.map(x => ({ ...x, po_number: `${x.po_number} (${fmt.date(x.po_date)})`, delivery_date: x.delivery_date ? fmt.date(x.delivery_date) : '—', status: fmt.title(x.status) })) };
    if (tab === 'invoices') return { ...base, columns: invoiceCols.map(text),
      rows: invoices.map(x => ({ ...x, invoice_number: `${x.invoice_number} (${fmt.date(x.invoice_date)})`, coa_number: x.coa_number ? `${x.coa_number} (${x.coa_status})` : 'No COA' })) };
    if (tab === 'coa') return { ...base, columns: coaCols.map(text),
      rows: coas.map(x => ({ ...x, invoice_number: x.invoice_number || 'Unlinked' })) };
    // The printout says the same three words the strip on screen says, in the
    // same order — a PDF of this tab is read next to the RM row it was opened
    // from, and "Available" on paper beside "On Shelf" on screen is the reader
    // asking whether they are the same figure.
    if (tab === 'demand') return { ...base,
      meta: [...base.meta, `On Shelf: ${sheets(demand?.available)}`, `Frozen: ${sheets(demand?.frozen)}`, `Shortfall: ${sheets(demand?.shortfall)}`],
      columns: demandCols.map(text),
      rows: demandLines.map(x => ({ ...x, po_number: `${x.po_number} (${fmt.date(x.delivery_date)})`, planned_date: x.planned_date ? fmt.date(x.planned_date) : '—', status: fmt.title(x.status), frozen: x.frozen ? 'Frozen' : 'Not frozen' })) };
    if (tab === 'purchases') return { ...base, sections: [
      { heading: 'Purchase Orders', columns: poCols.map(text), rows: purchases.map(x => ({ ...x, po_number: `${x.po_number} (${fmt.date(x.ts)})` })) },
      { heading: 'Goods Receipts', columns: grnCols.map(text), rows: grns.map(x => ({ ...x, grn_number: `${x.grn_number} (${fmt.date(x.ts)})`, po_number: x.po_number || 'Direct' })) },
    ] };
    const feed = tab === 'logs' ? logs : auditRows;
    return { ...base, columns: [
      { key: 'ts', label: 'When' }, { key: 'label', label: 'Record' }, { key: 'station', label: 'Station' },
      { key: 'action', label: 'Action' }, { key: 'detail', label: 'Detail' }, { key: 'user_name', label: 'By' }],
      rows: feed.map(e => ({ ...e, ts: dt(e.ts), label: e.label || `${fmt.title(e.entity)} #${e.entity_id ?? ''}`, station: stationText(e.station) || '—', action: prettyAction(e.action) })) };
  };

  if (!record) return null;

  return createPortal(
    <>
    <div className="no-print fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-6">
      <div className="absolute inset-0 bg-[#1D1D1F]/25 backdrop-blur-[3px] animate-fadeIn" onClick={onClose} />
      <div className="glass relative flex max-h-[92vh] w-full max-w-[900px] flex-col overflow-hidden rounded-[26px] animate-scaleIn">

          {/* Header */}
          <div className="flex items-center gap-2.5 border-b border-[#1D1D1F]/[0.06] bg-white/40 px-4 py-3.5">
            <span className={`flex h-9 w-9 items-center justify-center rounded-full ${meta.tint}`}><meta.icon size={16} /></span>
            <div className="min-w-0 flex-1">
              {canEditProduct ? (
                <button type="button" title="Edit Product Master"
                  onClick={() => setEditingProduct(shownRecord)}
                  className="group flex max-w-full items-center gap-1.5 text-left text-sm font-bold tracking-[-0.01em] text-[#1D1D1F] outline-none hover:text-[#0064D2] focus-visible:text-[#0064D2]">
                  <span className="truncate group-hover:underline group-focus-visible:underline">{shownRecord.name}</span>
                  <Pencil size={12} className="shrink-0 text-[#86868B] transition-colors group-hover:text-[#0064D2] group-focus-visible:text-[#0064D2]" />
                </button>
              ) : (
                <p className="truncate text-sm font-bold tracking-[-0.01em] text-[#1D1D1F]">{shownRecord.name}</p>
              )}
              <p className="truncate text-[11px] text-[#86868B]">
                {meta.label} 360°{shownRecord.code ? ` · ${shownRecord.code}` : ''}
                {shownRecord.customer_name ? ` · ${shownRecord.customer_name}` : ''}
              </p>
            </div>
            {actions}
            <ExportMenu build={buildExport} />
            <button onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-[#1D1D1F]/[0.05] text-[#86868B] transition-colors hover:bg-[#1D1D1F]/[0.10] hover:text-[#1D1D1F]">
              <X size={15} />
            </button>
          </div>

          {kind === 'products' && <ProductBrief record={shownRecord} />}

          {/* Timeline selection */}
          <div className="space-y-2 border-b border-[#1D1D1F]/[0.06] bg-white/25 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-1">
              {PRESETS.map(p => (
                <button key={p.key} onClick={() => applyPreset(p.key)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all duration-200 ease-apple ${
                    range.preset === p.key
                      ? 'bg-white text-[#007AFF] shadow-[0_2px_8px_rgba(0,122,255,0.16),inset_0_1px_0_rgba(255,255,255,0.95)] ring-1 ring-white/80'
                      : 'text-[#515154] hover:bg-white/55 hover:text-[#1D1D1F]'}`}>
                  {p.label}
                </button>
              ))}
              <span className="mx-1 h-4 w-px bg-[#1D1D1F]/10" />
              <CalendarDays size={13} className="shrink-0 text-[#86868B]" />
              <input type="date" className={`${dateInputCls} !w-[130px]`} value={range.from} max={range.to}
                onChange={e => e.target.value && setCustom({ from: e.target.value })} />
              <span className="text-[11px] text-[#86868B]">to</span>
              <input type="date" className={`${dateInputCls} !w-[130px]`} value={range.to} min={range.from}
                onChange={e => e.target.value && setCustom({ to: e.target.value })} />
            </div>
            {/* KPI strip */}
            <div className={`grid gap-1.5 ${
              stats.length >= 7 ? 'grid-cols-4 sm:grid-cols-7'
              : stats.length > 5 ? 'grid-cols-3 sm:grid-cols-6' : 'grid-cols-5'}`}>
              {stats.map(st => <Stat key={st.label} {...st} />)}
            </div>
          </div>

          {/* Tabs */}
          <div className="border-b border-[#1D1D1F]/[0.06] bg-white/25 px-4 py-2">
            <SubTabs views={views} active={tab} onChange={setTab} />
          </div>

          {/* Content */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && !data && (
              <div className="flex items-center justify-center gap-2 py-14 text-sm text-[#86868B]">
                <Loader2 size={16} className="animate-spin" /> Loading history…
              </div>
            )}
            {data && tab === 'orders' && (
              <div>
                {orders.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[#1D1D1F]/[0.06] bg-white/40 px-4 py-2 text-[11px] font-medium text-[#515154]">
                    <span>Ordered <b className="tabular-nums text-[#1D1D1F]">{fmt.num(s.ordered_total)}</b></span>
                    <span>Dispatched <b className="tabular-nums text-sky-700">{fmt.num(s.ordered_dispatched)}</b></span>
                    <span>Pending <b className="tabular-nums text-amber-700">{fmt.num(s.orders_pending)}</b>{+s.open_order_lines > 0 ? ` · ${s.open_order_lines} open line${s.open_order_lines > 1 ? 's' : ''}` : ''}</span>
                    <span className="text-[10px] text-[#86868B]">(totals lifetime · list windowed by PO date)</span>
                  </div>
                )}
                <Sheet cols={orderCols} rows={orders} empty="No orders in this window." />
              </div>
            )}
            {data && tab === 'ledger' && <Sheet cols={ledgerCols} rows={ledger} empty="No movements in this window." />}
            {data && tab === 'invoices' && <Sheet cols={invoiceCols} rows={invoices} empty="No invoices in this window." />}
            {data && tab === 'coa' && <Sheet cols={coaCols} rows={coas} empty="No COAs in this window." />}
            {tab === 'demand' && (
              demandLoading && !demand ? (
                <div className="flex items-center justify-center gap-2 py-14 text-sm text-[#86868B]">
                  <Loader2 size={16} className="animate-spin" /> Loading demand…
                </div>
              ) : (
                <div>
                  {/* The board's position, in the RM row's own three words and
                      its own two colours — this strip is read one click from
                      that row, and a second vocabulary here is the confusion
                      the rebuild removes.

                      Shown whenever the figures have loaded, NOT only when the
                      list under it has rows. The scalars are the board's
                      position now, not a sum of this list: a job that has drawn
                      part of its board leaves the list entirely (it has drawn,
                      so its board question is closed) while its undrawn residue
                      stays frozen. Gating on the list would blank a real Frozen
                      figure on exactly those boards. */}
                  {demand && (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[#1D1D1F]/[0.06] bg-white/40 px-4 py-2 text-[11px] font-medium text-[#515154]">
                      <span>On Shelf <b className="tabular-nums text-[#1D1D1F]">{sheets(demand.available)}</b></span>
                      <span>Frozen <b className="tabular-nums text-amber-700">{sheets(demand.frozen)}</b></span>
                      <span>Shortfall <b className={`tabular-nums ${+demand.shortfall > 0 ? 'font-bold text-red-600' : 'text-emerald-700'}`}>{sheets(demand.shortfall)}</b></span>
                      {+demand.shortfall > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-600">Stock short</span>
                      )}
                    </div>
                  )}
                  <Sheet cols={demandCols} rows={demandLines} empty="No live job claims on this material." />
                </div>
              )
            )}
            {data && tab === 'purchases' && (
              <div>
                <p className="px-4 pt-3 text-[10px] font-bold uppercase tracking-[0.14em] text-[#86868B]">Purchase Orders</p>
                <Sheet cols={poCols} rows={purchases} empty="No purchase orders in this window." />
                <p className="border-t border-[#1D1D1F]/[0.06] px-4 pt-3 text-[10px] font-bold uppercase tracking-[0.14em] text-[#86868B]">Goods Receipts (GRN)</p>
                <Sheet cols={grnCols} rows={grns} empty="No GRNs in this window." />
              </div>
            )}
            {data && tab === 'logs' && <Feed events={logs} empty="No activity in this window." />}
            {data && tab === 'audit' && <Feed events={auditRows} empty="No master changes in this window." />}
          </div>
      </div>
    </div>
    <ProductMasterEditor
      open={!!editingProduct}
      product={editingProduct || shownRecord}
      onClose={() => setEditingProduct(null)}
      onSaved={saved => {
        setData(current => current ? { ...current, record: { ...current.record, ...saved } } : current);
        setRefreshVersion(version => version + 1);
      }}
    />
    </>,
    document.body,
  );
}
