// "What should I walk to the floor right now?" — the one question the register
// could not answer. A card is on this list when it is approved, in date, nobody
// is holding it, and there is live work waiting on its product.
//
// The bands are the print plan's own stages, not an invented priority: Print
// Planning is what sets job_cards.machine_id, so a job WITH a press is already
// scheduled on a line, a job WITHOUT one is sitting in triage, and an open
// order line with no job card is further back still. Reading top to bottom is
// the order the cards should physically leave the cabinet in.
import { useMemo } from 'react';
import { fmt } from '../../api.js';
import { Button, DataTable } from '../../components/ui.jsx';
import { Printer, ArrowRight, AlertTriangle, CheckCircle2 } from 'lucide-react';
import ProductIdentity, { productExport, productSearchText } from '../../components/ProductIdentity.jsx';

// Mirrors WORK_TIERS in server/src/routes/shadecards.js. Kept in the same order
// and wording so a band never reads differently at the two ends.
const BANDS = [
  { tier: 1, label: 'Scheduled on a press', hint: 'Print Planning has put these on a line — issue these first',
    cls: 'border-red-300 bg-red-50/60', pill: 'bg-red-600 text-white' },
  { tier: 2, label: 'In Print Planning triage', hint: 'Job card raised, waiting for a press',
    cls: 'border-amber-300 bg-amber-50/50', pill: 'bg-amber-500 text-white' },
  { tier: 3, label: 'Sales order open', hint: 'Ordered, no job card raised yet',
    cls: 'border-slate-200 bg-slate-50/60', pill: 'bg-slate-500 text-white' },
];

// Work is waiting on these and the card CANNOT be handed out — it is past its
// 365-day life, so printing would refuse it at the press anyway.
//
// These are deliberately not part of `to_issue`: a storeman cannot issue an
// expired card, so listing it among the hand-out bands would be an instruction
// nobody can follow. But leaving it off the page entirely is worse — on the
// live data that is 16 jobs the plant cannot print, invisible in the one view
// whose whole job is to say what the floor is waiting on. It sits above the
// hand-out bands because re-approving it is more urgent than walking any card
// to the floor, and it is the only band whose action is "chase the customer"
// rather than "open the cabinet".
const BLOCKED_BAND = {
  tier: 0,
  label: 'Blocked — the card has expired',
  hint: 'Live work is waiting, but the card is past its 365-day life. Re-approve before it can be issued.',
  cls: 'border-red-500 bg-red-100/70', pill: 'bg-red-700 text-white',
};

// queue_pos is the press's own running order — respect it, so the list matches
// what the operator sees on the Live Floor rather than inventing a second
// opinion about what runs next.
const byQueue = rs => [...rs].sort((a, b) =>
  (a.work_queue_pos ?? 1e9) - (b.work_queue_pos ?? 1e9)
  || String(a.sc_number).localeCompare(String(b.sc_number)));

export default function ToIssue({ rows, onOpen }) {
  const banded = useMemo(() => {
    const live = rows.filter(r => r.to_issue);
    // Same test as `to_issue` on the server, except expired instead of in date.
    // Nobody is holding it, work is waiting, and the 365-day clock has run out.
    const blocked = rows.filter(r => r.status === 'approved' && !r.with_printing
      && r.expired_by_age && r.work_tier != null);
    return [
      { ...BLOCKED_BAND, rows: byQueue(blocked) },
      ...BANDS.map(b => ({ ...b, rows: byQueue(live.filter(r => r.work_tier === b.tier)) })),
    ];
  }, [rows]);

  const total = banded.reduce((n, b) => n + b.rows.length, 0);

  const columns = [
    { key: 'sc_number', label: 'Card No',
      render: r => <span className="font-semibold text-slate-900">{r.sc_number}</span> },
    { key: 'product_name', label: 'Product',
      render: r => <ProductIdentity row={r} compact codesClassName="max-w-[230px]" />,
      searchValue: productSearchText,
      export: productExport },
    { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
    { key: 'work_po_number', label: 'Waiting order',
      render: r => r.work_po_number
        ? <span className="font-medium text-brand-600">{r.work_po_number}</span>
        : <span className="text-slate-300">—</span> },
    { key: 'work_press_name', label: 'Where it is', sortValue: r => r.work_press_name || '',
      render: r => r.work_press_name
        ? <span className="whitespace-nowrap text-xs font-bold text-red-700">
            {r.work_press_name}{r.work_queue_pos != null && <span className="ml-1 font-medium text-slate-400">#{r.work_queue_pos}</span>}
          </span>
        : r.work_jc_number
          ? <span className="whitespace-nowrap text-xs font-semibold text-amber-700">{r.work_jc_number} · triage</span>
          : <span className="text-xs text-slate-400">not planned yet</span>,
      export: r => r.work_press_name || r.work_jc_number || 'not planned yet' },
    { key: 'age_days', label: 'Age', align: 'right', sortValue: r => r.age_days ?? -1,
      render: r => r.age_days == null ? '—'
        : <span className={`font-semibold tabular-nums ${r.age_days >= 335 ? 'text-amber-600' : 'text-slate-600'}`}>{r.age_days}d</span>,
      export: r => r.age_days != null ? `${r.age_days}d` : '—' },
    { key: '_act', label: '', sortable: false, export: () => '',
      render: r => (
        <Button size="sm" onClick={e => { e.stopPropagation(); onOpen(r.id); }}>
          <Printer size={13} /> Issue
        </Button>) },
  ];

  if (!total) {
    return (
      <div className="ci-data-panel p-8 text-center">
        <CheckCircle2 size={28} className="mx-auto mb-2 text-emerald-500" />
        <p className="text-sm font-bold text-slate-800">Nothing waiting to be issued</p>
        <p className="mt-1 text-xs text-slate-500">
          Every approved card the plant has live work for is already out with someone.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="glass rounded-[22px] border border-blue-200/60 bg-blue-50/50 p-4">
        <p className="flex items-center gap-2 text-sm font-extrabold text-blue-900">
          <Printer size={15} /> {fmt.num(total)} shade card{total === 1 ? '' : 's'} the floor is waiting on
        </p>
        <p className="mt-1 text-xs font-medium text-blue-900/80">
          Live work is on the order book for every one of these and nobody is holding them.
          Work down the list — but deal with any red <b>Blocked</b> band first: those cards
          have expired, so no amount of walking them to the floor will let a press run.
        </p>
      </div>

      {banded.map(b => b.rows.length > 0 && (
        <section key={b.tier} className={`rounded-[22px] border p-3 ${b.cls}`}>
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-extrabold ${b.pill}`}>
              {b.rows.length}
            </span>
            <span className="text-sm font-extrabold text-slate-800">{b.label}</span>
            <ArrowRight size={12} className="text-slate-300" />
            <span className="text-xs font-medium text-slate-500">{b.hint}</span>
            {b.tier === 1 && (
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-red-700">
                <AlertTriangle size={12} /> a press is scheduled to run these
              </span>)}
            {b.tier === 0 && (
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-red-800">
                <AlertTriangle size={12} /> printing will refuse these — send them for re-approval
              </span>)}
          </div>
          <DataTable
            exportName={`shade-cards-to-issue-tier-${b.tier}`}
            exportSubtitle={`${b.label} — ${b.hint}`}
            rows={b.rows}
            columns={columns}
            getRowId={r => r.id}
            onRowClick={r => onOpen(r.id)}
            empty="—"
          />
        </section>
      ))}
    </div>
  );
}
