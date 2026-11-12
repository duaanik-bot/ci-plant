// Status Sheet › Reports — the side drawer a name opens.
//
// Click a company, a PO, a product or a line in the report and this slides in
// from the right with three tabs:
//   Orders      — what was ordered: a company's POs, a PO's lines, a product's
//                 POs, or one line's facts. Every row clicks deeper.
//   Deliveries  — every challan against those lines, with vehicle and invoice.
//   Production  — every job card on those lines, stage by stage, with the
//                 quantities and dates the floor booked.
// A back arrow walks the click trail (company → PO → line → back), so a
// planner can follow one job down and come back without losing their place.
//
// It always shows the WHOLE history of what was clicked — every line, owed or
// delivered — whatever the report's own filters are set to (scopeLines).
// Orders come from the lines the report already holds; deliveries and
// production come from GET /status-sheet/report/detail.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, Building2, CheckCircle2, CircleDot, Circle, ExternalLink, Factory, FileText, Loader2,
  Package, PauseCircle, Rows3, Truck, X,
} from 'lucide-react';
import { api, fmt } from '../api.js';
import { SubTabs } from './ui.jsx';
import { SECTION_ORDER } from '../sections.js';
import {
  OPEN_KEYS, drawerCtx, groupDispatches, groupLines, groupDelivery, scopeLines, totalsOf, whereMix,
} from '../lib/statusReport.js';
import { NameLink, Pill, WhereChip, whereLabel } from './StatusReportBits.jsx';

const KIND = {
  company: { label: 'Company', icon: Building2 },
  po: { label: 'Purchase order', icon: FileText },
  product: { label: 'Product', icon: Package },
  line: { label: 'Order line', icon: Rows3 },
};

function Section({ title, right, children }) {
  return (
    <section className="rounded-[18px] border border-white/75 bg-white/60 p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
      {(title || right) && (
        <div className="mb-2 flex items-center gap-2">
          {title && <h4 className="min-w-0 flex-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[#6E6E73]">{title}</h4>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

function Fact({ label, children }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-bold uppercase tracking-wider text-[#86868B]">{label}</div>
      <div className="truncate text-sm font-semibold text-[#1D1D1F]">{children ?? '—'}</div>
    </div>
  );
}

const Stat = ({ label, value, tone = '' }) => (
  <div className="rounded-2xl bg-white/70 px-3 py-2">
    <div className="text-[10px] font-bold uppercase tracking-wider text-[#86868B]">{label}</div>
    <div className={`text-base font-bold tabular-nums ${tone}`}>{value}</div>
  </div>
);

const Qty = ({ ordered, delivered, pending }) => (
  <div className="flex shrink-0 gap-3 text-right text-xs tabular-nums">
    <div><div className="text-[10px] text-[#86868B]">Ordered</div>{fmt.num(ordered)}</div>
    <div><div className="text-[10px] text-[#86868B]">Delivered</div><span className="text-emerald-700">{fmt.num(delivered)}</span></div>
    <div><div className="text-[10px] text-[#86868B]">Pending</div><span className={pending > 0 ? 'font-semibold text-amber-700' : 'text-gray-400'}>{fmt.num(pending)}</span></div>
  </div>
);

const Mix = ({ counts }) => (
  <div className="flex flex-wrap gap-1">
    {whereMix(counts, SECTION_ORDER).map(m => <WhereChip key={m.key} k={m.key} count={m.count} />)}
  </div>
);

const Empty = ({ children }) => <p className="py-6 text-center text-sm text-[#86868B]">{children}</p>;

// ── Orders tab ───────────────────────────────────────────────────────────────
function OrdersTab({ ctx, scoped, open }) {
  if (ctx.kind === 'company') {
    const pos = groupLines(scoped, 'po').sort((a, b) => String(b.po_date || '').localeCompare(String(a.po_date || '')));
    const openPos = pos.filter(p => OPEN_KEYS.includes(p.delivery));
    return (
      <Section title={`Purchase orders · ${pos.length} (${openPos.length} open)`}>
        <ul className="divide-y divide-[#1D1D1F]/[0.06]">
          {pos.map(p => (
            <li key={p.id} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2.5">
              <div className="min-w-[120px] flex-1">
                <NameLink onOpen={() => open(drawerCtx('po', p))} title="Open this PO">PO {p.po_number}</NameLink>
                <div className="text-[11px] text-[#86868B]">{fmt.date(p.po_date)} · {p.lines} line{p.lines === 1 ? '' : 's'}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1"><Pill k={p.delivery} /><Mix counts={p.where_counts} /></div>
              </div>
              <Qty ordered={p.qty} delivered={p.dispatched_qty} pending={p.pending_qty} />
            </li>
          ))}
        </ul>
      </Section>
    );
  }
  if (ctx.kind === 'po' || ctx.kind === 'product') {
    const rows = [...scoped].sort((a, b) => (ctx.kind === 'po'
      ? String(a.product_name).localeCompare(String(b.product_name))
      : String(b.po_date || '').localeCompare(String(a.po_date || ''))));
    const first = scoped[0] || {};
    return (
      <div className="space-y-3">
        {ctx.kind === 'po' && (
          <Section title="PO">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Fact label="Company">{first.customer_name}</Fact>
              <Fact label="PO date">{fmt.date(first.po_date)}</Fact>
              <Fact label="Delivery date">{first.delivery_date ? fmt.date(first.delivery_date) : '—'}</Fact>
              <Fact label="PO value">{fmt.inr(scoped.reduce((s, l) => s + l.value, 0))}</Fact>
            </div>
          </Section>
        )}
        {ctx.kind === 'product' && (
          <Section title="Product">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Fact label="Company">{first.customer_name}</Fact>
              <Fact label="Internal code">{first.product_code}</Fact>
              <Fact label="Item code">{first.party_item_code}</Fact>
              <Fact label="Artwork code">{first.party_artwork_code}</Fact>
            </div>
          </Section>
        )}
        <Section title={ctx.kind === 'po' ? `Products on this PO · ${rows.length}` : `POs for this product · ${rows.length}`}>
          <ul className="divide-y divide-[#1D1D1F]/[0.06]">
            {rows.map(l => (
              <li key={l.line_id} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2.5">
                <div className="min-w-[160px] flex-1">
                  {ctx.kind === 'po'
                    ? <NameLink onOpen={() => open(drawerCtx('line', l))} title="Open this line">{l.product_name}</NameLink>
                    : <NameLink onOpen={() => open(drawerCtx('po', l))} title="Open this PO">PO {l.po_number}</NameLink>}
                  <div className="text-[11px] text-[#86868B]">
                    {ctx.kind === 'po'
                      ? [l.product_code, l.party_item_code].filter(Boolean).join(' · ')
                      : `${fmt.date(l.po_date)} · ₹${(+l.rate || 0).toFixed(2)}`}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <Pill k={l.delivery} /><WhereChip k={l.where} />
                    {ctx.kind === 'product' && (
                      <button type="button" onClick={() => open(drawerCtx('line', l))} className="text-[11px] font-semibold text-[#0064D2] hover:underline">Line details</button>
                    )}
                  </div>
                  {(l.line_remark || l.remarks) && <div className="mt-1 text-[11px] text-[#6E6E73]">{l.line_remark || l.remarks}</div>}
                </div>
                <Qty ordered={l.delivery === 'cancelled' ? 0 : l.qty} delivered={l.dispatched_qty} pending={l.pending_qty} />
              </li>
            ))}
          </ul>
        </Section>
      </div>
    );
  }
  const l = scoped[0];
  if (!l) return <Empty>This line is no longer in the report.</Empty>;
  return (
    <Section title="Line">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Fact label="Company"><NameLink onOpen={() => open(drawerCtx('company', l))}>{l.customer_name}</NameLink></Fact>
        <Fact label="PO"><NameLink onOpen={() => open(drawerCtx('po', l))}>PO {l.po_number}</NameLink></Fact>
        <Fact label="Product"><NameLink onOpen={() => open(drawerCtx('product', l))}>{l.product_name}</NameLink></Fact>
        <Fact label="PO date">{fmt.date(l.po_date)}</Fact>
        <Fact label="Delivery date">{l.delivery_date ? fmt.date(l.delivery_date) : '—'}</Fact>
        <Fact label="Codes">{[l.product_code, l.party_item_code, l.party_artwork_code].filter(Boolean).join(' · ') || '—'}</Fact>
        <Fact label="Ordered">{fmt.num(l.qty)}</Fact>
        <Fact label="Delivered">{fmt.num(l.dispatched_qty)}</Fact>
        <Fact label="Pending">{fmt.num(l.pending_qty)}</Fact>
        <Fact label="Rate">₹{(+l.rate || 0).toFixed(2)}</Fact>
        <Fact label="Value">{fmt.inr(l.value)}</Fact>
        <Fact label="Pending value">{fmt.inr(l.pending_value)}</Fact>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5"><Pill k={l.delivery} /><WhereChip k={l.where} /></div>
      {(l.line_remark || l.remarks) && <p className="mt-2 text-xs text-[#515154]">{l.line_remark || l.remarks}</p>}
    </Section>
  );
}

// ── Deliveries tab ───────────────────────────────────────────────────────────
function DeliveriesTab({ challans, multiProduct }) {
  if (!challans.length) return <Empty>Nothing delivered yet.</Empty>;
  return (
    <Section title={`Challans · ${challans.length}`}>
      <ul className="divide-y divide-[#1D1D1F]/[0.06]">
        {challans.map(c => (
          <li key={c.dispatch_id} className="py-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Link to={`/dispatch/challan/${c.dispatch_id}`} target="_blank" rel="noopener"
                className="inline-flex items-center gap-1 font-semibold text-[#0064D2] hover:underline">
                <Truck size={13} /> {c.challan_number || `Challan ${c.dispatch_id}`} <ExternalLink size={11} />
              </Link>
              <span className="text-xs text-[#6E6E73]">{fmt.date(c.dispatched_at)}</span>
              {c.vehicle && <span className="text-xs text-[#6E6E73]">· {c.vehicle}</span>}
              <span className="ml-auto text-sm font-bold tabular-nums text-emerald-700">{fmt.num(c.qty)}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[#6E6E73]">
              {c.invoices.length
                ? c.invoices.map(i => (
                  <Link key={i.id} to={`/invoices/${i.id}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 font-semibold text-[#0064D2] hover:underline">
                    Invoice {i.number} <ExternalLink size={10} />
                  </Link>))
                : <span>Not invoiced yet</span>}
            </div>
            {multiProduct && (
              <ul className="mt-1 space-y-0.5 text-[11px] text-[#515154]">
                {c.items.map((it, i) => (
                  <li key={i} className="flex gap-2"><span className="min-w-0 flex-1 truncate">{it.product_name || `Line ${it.line_id}`}{it.po_number ? ` · PO ${it.po_number}` : ''}</span><span className="tabular-nums">{fmt.num(it.qty)}</span></li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ── Production tab ───────────────────────────────────────────────────────────
const STAGE_ICON = {
  completed: <CheckCircle2 size={14} className="text-emerald-600" />,
  in_progress: <CircleDot size={14} className="text-sky-600" />,
  partially_completed: <CircleDot size={14} className="text-sky-600" />,
  hold: <PauseCircle size={14} className="text-amber-600" />,
};
const statusWord = s => String(s || 'pending').replace(/_/g, ' ');

function JobCard({ card }) {
  return (
    <div className="rounded-xl border border-[#1D1D1F]/[0.07] bg-white/70 p-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link to={`/production/jobcard/${card.id}`} target="_blank" rel="noopener"
          className="inline-flex items-center gap-1 text-sm font-semibold text-[#0064D2] hover:underline">
          <Factory size={13} /> {card.jc_number || `Job card ${card.id}`} <ExternalLink size={11} />
        </Link>
        {card.gang_shared && <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">Gang run</span>}
        <span className="text-[11px] capitalize text-[#6E6E73]">{statusWord(card.status)}</span>
        <span className="ml-auto text-[11px] tabular-nums text-[#6E6E73]">
          Planned {fmt.num(card.qty_planned)}{card.qty_produced ? ` · Made ${fmt.num(card.qty_produced)}` : ''}{card.sheets_issued ? ` · ${fmt.num(card.sheets_issued)} sheets` : ''}
        </span>
      </div>
      {card.stages.length > 0 && (
        <ol className="mt-2 space-y-1">
          {card.stages.map((s, i) => (
            <li key={i} className="flex items-center gap-2 text-xs">
              {STAGE_ICON[s.status] || <Circle size={14} className="text-slate-300" />}
              <span className={`w-24 shrink-0 font-medium ${s.status === 'completed' ? 'text-[#1D1D1F]' : 'text-[#515154]'}`}>{whereLabel(s.stage)}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] capitalize text-[#6E6E73]">
                {statusWord(s.status)}
                {s.hold_reason ? ` — ${s.hold_reason}` : ''}
                {s.operator ? ` · ${s.operator}` : ''}
              </span>
              <span className="shrink-0 text-right text-[11px] tabular-nums text-[#6E6E73]">
                {s.qty_out != null && +s.qty_out > 0 ? `${fmt.num(s.qty_out)}${s.unit ? ` ${s.unit}` : ''}` : ''}
                {s.completed_at ? ` · ${fmt.date(s.completed_at)}` : s.started_at ? ` · since ${fmt.date(s.started_at)}` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ProductionTab({ ctx, scoped, cards, open }) {
  // A company's whole history is hundreds of lines; its production view is
  // what is still owed. A PO, a product or a line shows everything.
  const lines = ctx.kind === 'company' ? scoped.filter(l => OPEN_KEYS.includes(l.delivery)) : scoped;
  const byLine = new Map();
  for (const c of cards) {
    if (!byLine.has(c.line_id)) byLine.set(c.line_id, []);
    byLine.get(c.line_id).push(c);
  }
  const [limit, setLimit] = useState(25);
  if (!lines.length) return <Empty>No open lines.</Empty>;
  const shown = lines.slice(0, limit);
  return (
    <div className="space-y-3">
      {ctx.kind === 'company' && <p className="text-xs text-[#6E6E73]">Showing the {fmt.num(lines.length)} line{lines.length === 1 ? '' : 's'} still owed.</p>}
      {shown.map(l => {
        const lc = byLine.get(l.line_id) || [];
        return (
          <Section key={l.line_id}
            title={null}
            right={null}>
            <div className="mb-2 flex flex-wrap items-start gap-x-2 gap-y-1">
              <div className="min-w-0 flex-1">
                {ctx.kind === 'line'
                  ? <div className="font-semibold">{l.product_name}</div>
                  : <NameLink onOpen={() => open(drawerCtx('line', l))}>{l.product_name}</NameLink>}
                <div className="text-[11px] text-[#86868B]">PO {l.po_number} · {fmt.num(l.qty)} ordered · {fmt.num(l.pending_qty)} pending</div>
              </div>
              <WhereChip k={l.where} />
            </div>
            {lc.length
              ? <div className="space-y-2">{lc.map(c => <JobCard key={c.id} card={c} />)}</div>
              : <p className="text-xs text-[#86868B]">No job card yet — {whereLabel(l.where).toLowerCase()}.</p>}
          </Section>
        );
      })}
      {lines.length > limit && (
        <button type="button" onClick={() => setLimit(x => x + 25)}
          className="w-full rounded-full border border-[#1D1D1F]/10 bg-white py-2 text-xs font-semibold text-[#0064D2]">
          Show {Math.min(25, lines.length - limit)} more of {fmt.num(lines.length - limit)}
        </button>
      )}
    </div>
  );
}

// ── The drawer ───────────────────────────────────────────────────────────────
export default function StatusReportDrawer({ trail, lines, onOpen, onBack, onClose, onShowInReport }) {
  const ctx = trail[trail.length - 1] || null;
  const [tab, setTab] = useState('orders');
  const [detail, setDetail] = useState({ key: null, dispatches: [], job_cards: [], error: false });
  const scoped = useMemo(() => scopeLines(lines, ctx), [lines, ctx]);
  const ids = useMemo(() => scoped.map(l => l.line_id).join(','), [scoped]);
  const loading = !!ctx && detail.key !== ids;

  useEffect(() => {
    if (!ctx || !ids) return undefined;
    let live = true;
    api.get(`/status-sheet/report/detail?lines=${ids}`)
      .then(d => { if (live) setDetail({ key: ids, dispatches: d.dispatches || [], job_cards: d.job_cards || [], error: false }); })
      .catch(() => { if (live) setDetail({ key: ids, dispatches: [], job_cards: [], error: true }); });
    return () => { live = false; };
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ctx) return undefined;
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctx, onClose]);

  const lineById = useMemo(() => new Map(scoped.map(l => [l.line_id, l])), [scoped]);
  const challans = useMemo(() => groupDispatches(detail.dispatches, lineById), [detail.dispatches, lineById]);
  const t = useMemo(() => totalsOf(scoped), [scoped]);
  if (!ctx) return null;

  const K = KIND[ctx.kind];
  const Icon = K.icon;
  const first = scoped[0] || {};
  const title = ctx.kind === 'company' ? (first.customer_name || ctx.customer_name)
    : ctx.kind === 'po' ? `PO ${first.po_number ?? ctx.po_number}`
    : (first.product_name || ctx.product_name);
  const sub = ctx.kind === 'company' ? `${fmt.num(t.orders)} POs · ${fmt.num(t.lines)} lines`
    : ctx.kind === 'po' ? `${first.customer_name || ctx.customer_name} · ${fmt.date(first.po_date)}`
    : ctx.kind === 'product' ? (first.customer_name || ctx.customer_name)
    : `PO ${first.po_number ?? ctx.po_number} · ${first.customer_name || ctx.customer_name}`;
  // The badge counts what the tab shows: for a company, cards on lines still
  // owed (the tab hides delivered history there); otherwise every card.
  const prodLineIds = new Set((ctx.kind === 'company' ? scoped.filter(l => OPEN_KEYS.includes(l.delivery)) : scoped).map(l => l.line_id));
  const openCards = detail.job_cards.filter(c => prodLineIds.has(c.line_id)).length;
  const tabs = [
    { key: 'orders', label: 'Orders', icon: FileText },
    { key: 'deliveries', label: 'Deliveries', icon: Truck, count: loading ? undefined : challans.length },
    { key: 'production', label: 'Production', icon: Factory, count: loading ? undefined : openCards },
  ];
  const multiProduct = ctx.kind === 'company' || ctx.kind === 'po';

  return createPortal(
    <div data-ci-overlay className="no-print fixed inset-0 z-[58]" data-status-report-drawer="1">
      <div className="absolute inset-0 bg-[#1D1D1F]/25 backdrop-blur-[3px] animate-fadeIn" onClick={onClose} />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[720px] p-0 sm:p-3" role="dialog" aria-label={`${K.label} details`}>
        <div className="glass flex h-full w-full flex-col overflow-hidden rounded-none sm:rounded-[26px] animate-scaleIn">
          <div className="flex items-center gap-2.5 border-b border-[#1D1D1F]/[0.06] bg-white/45 px-4 py-3">
            {trail.length > 1 && (
              <button type="button" onClick={onBack} aria-label="Back"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#515154] hover:bg-white/80">
                <ArrowLeft size={17} />
              </button>
            )}
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0071F0] text-white shadow-[0_6px_16px_rgba(0,113,240,0.3)]"><Icon size={16} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#86868B]">{K.label}</div>
              <div className="truncate text-base font-bold text-[#1D1D1F]">{title}</div>
              <div className="truncate text-xs text-[#6E6E73]">{sub}</div>
            </div>
            <button type="button" onClick={onClose} aria-label="Close"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#515154] hover:bg-white/80">
              <X size={18} />
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Ordered" value={fmt.num(t.qty)} />
              <Stat label="Delivered" value={`${fmt.num(t.dispatched_qty)}`} tone="text-emerald-700" />
              <Stat label="Pending" value={fmt.num(t.pending_qty)} tone={t.pending_qty ? 'text-amber-700' : 'text-gray-400'} />
              <Stat label="Pending value" value={fmt.inr(t.pending_value)} />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Pill k={groupDelivery(t)} />
              <span className="text-[11px] text-[#86868B]">{t.fulfil_pct}% delivered</span>
              <span className="mx-1 h-3 w-px bg-[#1D1D1F]/10" />
              <Mix counts={t.where_counts} />
              {onShowInReport && ctx.kind !== 'line' && (
                <button type="button" onClick={() => onShowInReport(ctx)}
                  className="ml-auto text-[11px] font-semibold text-[#0064D2] hover:underline">
                  {ctx.kind === 'company' ? 'Show its POs in the report' : ctx.kind === 'po' ? 'Show its lines in the report' : 'Show in the report'}
                </button>
              )}
            </div>

            <SubTabs views={tabs} active={tab} onChange={setTab} />

            {detail.error && (
              <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-700">Couldn't load deliveries and production — try again in a moment.</p>
            )}
            {tab === 'orders' && <OrdersTab ctx={ctx} scoped={scoped} open={onOpen} />}
            {tab !== 'orders' && loading && (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-[#6E6E73]"><Loader2 size={16} className="animate-spin" /> Loading…</div>
            )}
            {tab === 'deliveries' && !loading && <DeliveriesTab challans={challans} multiProduct={multiProduct} />}
            {tab === 'production' && !loading && <ProductionTab key={ids} ctx={ctx} scoped={scoped} cards={detail.job_cards} open={onOpen} />}
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
