// "What does the order book need from this module right now?" — one row per
// LIVE SALES ORDER LINE, not per card.
//
// The old version started from approved cards and asked whether work was
// waiting. That inverts the plant's question and is structurally blind to the
// order lines that have no card at all, which is the biggest backlog here.
//
// Banded by ACTION NEEDED rather than by press proximity. Press proximity is
// the right axis once Print Planning is running, but with almost no job cards
// raised nearly every line lands in one tier and the banding says nothing.
// Urgency survives as the sort inside each band, so tier-1 rows float up
// automatically the moment planning fills in.
import { useMemo } from 'react';
import { fmt } from '../../api.js';
import { Button, DataTable } from '../../components/ui.jsx';
import { Printer, Plus, RefreshCw, AlertTriangle, CheckCircle2, ArrowRight } from 'lucide-react';

// Band colouring. The bands themselves — number, label, hint and action — come
// from the server so a band can never read differently at the two ends.
const BAND_STYLE = {
  1: { cls: 'border-red-300 bg-red-50/60',         pill: 'bg-red-600 text-white' },
  2: { cls: 'border-emerald-300 bg-emerald-50/50', pill: 'bg-emerald-600 text-white' },
  3: { cls: 'border-amber-300 bg-amber-50/50',     pill: 'bg-amber-500 text-white' },
  4: { cls: 'border-violet-200 bg-violet-50/50',   pill: 'bg-violet-500 text-white' },
  5: { cls: 'border-slate-200 bg-slate-50/60',     pill: 'bg-slate-500 text-white' },
};

// Several live lines can share one product, so one card can clear several rows.
// Saying "72 lines" alone reads as "72 cards to make", which overstates the
// work and is the kind of number that stops somebody starting.
const distinctProducts = rows => new Set(rows.map(r => r.product_id)).size;

// Where this LINE has reached in the print plan.
function WhereItIs({ row }) {
  if (row.work_tier === 1)
    return (
      <span className="whitespace-nowrap text-xs font-bold text-red-700">
        {row.press_name}
        {row.queue_pos != null && <span className="ml-1 font-medium text-slate-400">#{row.queue_pos}</span>}
      </span>);
  if (row.work_tier === 2)
    return <span className="whitespace-nowrap text-xs font-semibold text-amber-700">{row.jc_number} · triage</span>;
  return <span className="text-xs text-slate-400">not planned yet</span>;
}

function CardCell({ row }) {
  if (!row.card_id) return <span className="text-xs font-semibold text-red-600">no card</span>;
  return (
    <span className="whitespace-nowrap text-xs">
      <span className="font-semibold text-slate-900">{row.sc_number}</span>
      {row.age_unknown
        ? <span className="ml-1 font-semibold text-amber-600" title="No date on record — this card's age cannot be checked">no date</span>
        : row.age_days != null && (
            <span className={`ml-1 font-semibold tabular-nums ${row.age_days >= 365 ? 'text-red-600' : row.age_days >= 335 ? 'text-amber-600' : 'text-slate-400'}`}>
              {row.age_days}d</span>)}
    </span>);
}

export default function ToIssue({ rows, bands, onOpen, onCreate }) {
  const banded = useMemo(() => (bands || []).map(b => ({
    ...b,
    ...BAND_STYLE[b.band],
    rows: rows.filter(r => r.band === b.band)
      // Urgency inside the band: on a press, then triage, then order-only, then
      // the press's own running order — so this matches what the Live Floor
      // shows rather than inventing a second opinion about what runs next.
      .sort((a, c) => (a.work_tier - c.work_tier)
        || ((a.queue_pos ?? 1e9) - (c.queue_pos ?? 1e9))
        || String(a.po_number).localeCompare(String(c.po_number))),
  })), [rows, bands]);

  const actionable = rows.filter(r => r.band <= 3).length;

  const columns = band => [
    { key: 'po_number', label: 'Sales Order',
      render: r => <span className="font-medium text-brand-600">{r.po_number}</span> },
    { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
    { key: 'product_name', label: 'Product',
      render: r => (
        <span>{r.product_name || '—'}
          {r.product_code && <span className="ml-1 text-slate-400">{r.product_code}</span>}</span>),
      export: r => `${r.product_name || ''} ${r.product_code || ''}`.trim() || '—' },
    { key: 'order_qty', label: 'Qty', align: 'right',
      render: r => <span className="tabular-nums">{fmt.num(r.order_qty)}</span> },
    { key: '_where', label: 'Where the job is', sortValue: r => r.work_tier,
      render: r => <WhereItIs row={r} />,
      export: r => r.press_name || r.jc_number || 'not planned yet' },
    { key: 'sc_number', label: 'Shade card', sortValue: r => r.sc_number || '',
      render: r => <CardCell row={r} />,
      export: r => r.sc_number || 'no card' },
    { key: '_holder', label: 'Held by', sortValue: r => r.holder?.issued_to || '',
      render: r => r.holder
        ? <span className="whitespace-nowrap text-xs font-semibold text-blue-700">
            {r.holder.issued_to}<span className="ml-1 font-normal text-slate-400">· {fmt.title(r.holder.department)}</span></span>
        : <span className="text-xs text-slate-400">in store</span>,
      export: r => r.holder ? `${r.holder.issued_to} (${r.holder.department})` : 'in store' },
    { key: '_act', label: '', sortable: false, export: () => '',
      render: r => {
        // The label is the server's ISSUE_BANDS[].action, never a string typed
        // here. Bands 4 and 5 carry action: null and render nothing.
        if (!band.action) return null;
        if (band.band === 1)
          return (
            <Button size="sm" onClick={e => { e.stopPropagation(); onCreate(r.order_line_id); }}>
              <Plus size={13} /> {band.action}
            </Button>);
        if (band.band === 2)
          return (
            <Button size="sm" onClick={e => { e.stopPropagation(); onOpen(r.card_id); }}>
              <Printer size={13} /> {band.action}
            </Button>);
        return (
          <Button size="sm" variant="secondary" onClick={e => { e.stopPropagation(); onOpen(r.card_id); }}>
            <RefreshCw size={13} /> {band.action}
          </Button>);
      } },
  ];

  if (!rows.length) {
    return (
      <div className="ci-data-panel p-8 text-center">
        <CheckCircle2 size={28} className="mx-auto mb-2 text-emerald-500" />
        <p className="text-sm font-bold text-slate-800">The order book needs nothing from this module</p>
        <p className="mt-1 text-xs text-slate-500">
          Every live sales order has an approved shade card in printing's hands.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="glass rounded-[22px] border border-blue-200/60 bg-blue-50/50 p-4">
        <p className="flex items-center gap-2 text-sm font-extrabold text-blue-900">
          <Printer size={15} /> {fmt.num(actionable)} of {fmt.num(rows.length)} live order line{rows.length === 1 ? '' : 's'} need something
        </p>
        <p className="mt-1 text-xs font-medium text-blue-900/80">
          One row per sales order line still owed to a customer, grouped by what it needs
          from this module. Inside each group the most urgent job is first.
        </p>
      </div>

      {banded.map(b => b.rows.length > 0 && (
        <section key={b.band} className={`rounded-[22px] border p-3 ${b.cls}`}>
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-extrabold ${b.pill}`}>
              {b.rows.length}
            </span>
            <span className="text-sm font-extrabold text-slate-800">{b.label}</span>
            <ArrowRight size={12} className="text-slate-300" />
            <span className="text-xs font-medium text-slate-500">{b.hint}</span>
            {b.band === 1 && (
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-red-700">
                <AlertTriangle size={12} />
                {distinctProducts(b.rows)} card{distinctProducts(b.rows) === 1 ? '' : 's'} would clear all {b.rows.length}
              </span>)}
          </div>
          <DataTable
            exportName={`shade-cards-to-issue-${b.key}`}
            exportSubtitle={`${b.label} — ${b.hint}`}
            rows={b.rows} columns={columns(b)} getRowId={r => r.order_line_id}
            onRowClick={r => r.card_id ? onOpen(r.card_id) : onCreate(r.order_line_id)}
            empty="—"
          />
        </section>
      ))}
    </div>
  );
}
