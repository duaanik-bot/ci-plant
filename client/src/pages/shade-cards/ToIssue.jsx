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

export default function ToIssue({ rows, onOpen }) {
  const banded = useMemo(() => {
    const live = rows.filter(r => r.to_issue);
    return BANDS.map(b => ({
      ...b,
      rows: live.filter(r => r.work_tier === b.tier)
        // queue_pos is the press's own running order — respect it, so the list
        // matches what the operator sees on the Live Floor rather than
        // inventing a second opinion about what runs next.
        .sort((a, b2) => (a.work_queue_pos ?? 1e9) - (b2.work_queue_pos ?? 1e9)
          || String(a.sc_number).localeCompare(String(b2.sc_number))),
    }));
  }, [rows]);

  const total = banded.reduce((n, b) => n + b.rows.length, 0);

  const columns = [
    { key: 'sc_number', label: 'Card No',
      render: r => <span className="font-semibold text-slate-900">{r.sc_number}</span> },
    { key: 'product_name', label: 'Product',
      render: r => (
        <span>{r.product_name || '—'}
          {r.product_code && <span className="ml-1 text-slate-400">{r.product_code}</span>}</span>),
      export: r => `${r.product_name || ''} ${r.product_code || ''}`.trim() || '—' },
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
          Approved, in date, and nobody is holding them — but there is live work on the order book
          for each one. Work down the list: the top band is already on a press.
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
