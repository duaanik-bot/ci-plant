// TrialBalance: the Reports page's first tab (spec §9.2). Props:
//   { book, from, to, onPeriod, expanded, onExpanded, showEmpty, onShowEmpty, onLedger, version }
//
// GET /finance/reports/trial-balance?book&from&to. Every group of the book, rolled up through the group tree, opens one level at a time
// (finTbRows): a group's row toggles it, a ledger's row opens that ledger's statement for the same period (onLedger). Opening is
// everything dated before `from`; the period's debits and credits are those dated from `from` to `to`; closing is as at `to`.
// Figures are signed the ledger way (Dr for positive, Cr for negative) where they are balances, and a nil figure is left blank, as
// Tally leaves it (finTbCells); only a closing of nil on a row that had figures says ₹0.00, so a settled ledger is not mistaken for a
// blank one.
//
// The tree keeps its own order, so no column sorts (a sort would take a ledger out from under its group). Groups with no figures at
// all are left out unless asked for ("Show empty groups"): a new book lists twenty-nine groups and most of them are empty.
//
// The three cards above the table add up each LEDGER's balance on its own side (Tally's way), while a group row shows its NET, so a card
// can exceed the group rows beside it. They say so in their names and in a note (FIN_TB_FOOT, FIN_TB_FOOT_NOTE), and so does an export.
//
// What is open lives in the Reports page (expanded, showEmpty), not here, so it is still open when Back returns from a ledger.
// Export is offered only to a book whose grant allows it (finExportProps), and exports what is on screen: open the groups first.
import { useMemo } from 'react';
import { ArrowLeftRight, BookOpen, ChevronDown, ChevronRight, Scale } from 'lucide-react';
import { Button, Checkbox, DataTable, KpiCard, KpiRow } from '../ui.jsx';
import useReport from './useReport.js';
import { LoadNotice, PeriodFields } from './ReportParts.jsx';
import { finFormatINR } from '../../lib/finance/money.js';
import {
  FIN_TB_FOOT, FIN_TB_FOOT_NOTE, finTbBalance, finTbCells, finTbExpandable, finTbHolding, finTbRows,
} from '../../lib/finance/tb.js';
import { finDateText } from '../../lib/finance/voucher.js';
import {
  finExportProps, finPeriodText, finRangeProblem, finReportEmpty, finTbSummary, finUnsorted,
} from '../../lib/finance/reports.js';

export default function TrialBalance({ book, from, to, onPeriod, expanded, onExpanded, showEmpty, onShowEmpty, onLedger, version }) {
  const problem = finRangeProblem(from, to);
  const url = problem ? null : `/finance/reports/trial-balance?${new URLSearchParams({ book: String(book.id), from, to })}`;
  const { data: tb, failed, reload } = useReport(url, version);

  const rows = useMemo(() => (tb ? finTbRows(tb, expanded, { hideEmpty: !showEmpty }) : []), [tb, expanded, showEmpty]);
  const openable = useMemo(() => (tb ? finTbExpandable(tb) : new Set()), [tb]);
  const holding = useMemo(() => (tb ? finTbHolding(tb) : new Set()), [tb]);

  const toggle = id => onExpanded(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // A click on a row does what its name does: a group opens or shuts, a ledger opens its statement. The name is a real button too
  // (the table leaves a click on a button to the button), so the keyboard and a screen reader reach the same thing.
  const act = row => {
    if (row.kind === 'ledger') onLedger(row.id);
    else if (openable.has(row.id)) toggle(row.id);
  };

  const nameCell = row => {
    const indent = { paddingLeft: `${row.depth * 1.25}rem` };
    if (row.kind === 'ledger') {
      return (
        <span className="flex items-center gap-1.5" style={indent}>
          <span className="w-3.5 shrink-0" aria-hidden />
          <button type="button" onClick={() => onLedger(row.id)} className="min-w-0 break-words text-left font-medium text-brand-600 hover:underline">{row.name}</button>
        </span>
      );
    }
    const can = openable.has(row.id);
    const open = expanded.has(row.id);
    const Caret = open ? ChevronDown : ChevronRight;
    return (
      <span className="flex items-center gap-1.5" style={indent}>
        {can ? (
          <button type="button" aria-expanded={open} onClick={() => toggle(row.id)} className="flex min-w-0 items-center gap-1.5 text-left">
            <Caret size={14} className="shrink-0 text-slate-400" />
            <span className="min-w-0 break-words">{row.name}</span>
          </button>
        ) : (
          <>
            <span className="w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{row.name}</span>
          </>
        )}
      </span>
    );
  };

  // A group that holds ledgers with figures but nets to nothing says ₹0.00 and does not read as an empty one (finTbCells).
  const cells = r => finTbCells(r, r.kind === 'group' && holding.has(r.id));
  const columns = finUnsorted([
    { key: 'name', label: 'Name', card: 'title', render: nameCell, export: r => `${'  '.repeat(r.depth)}${r.name}` },
    { key: 'opening_paise', label: 'Opening', align: 'right', card: 'metric', render: r => cells(r).opening },
    { key: 'debit_paise', label: 'Debit', align: 'right', card: 'metric', render: r => cells(r).debit },
    { key: 'credit_paise', label: 'Credit', align: 'right', card: 'metric', render: r => cells(r).credit },
    { key: 'closing_paise', label: 'Closing', align: 'right', card: 'metric', render: r => cells(r).closing },
  ]);

  const gaps = tb ? finTbBalance(tb.totals) : null;
  const pair = (label, icon, dr, cr, drWord, crWord, gap) => (
    <KpiCard key={label} compact icon={icon} label={label} title={FIN_TB_FOOT_NOTE} tone={gap ? 'bad' : 'neutral'}
      value={`${drWord} ${finFormatINR(dr)}`}
      sub={`${crWord} ${finFormatINR(cr)}${gap ? ` · the two sides differ by ${finFormatINR(Math.abs(gap))}` : ''}`} />
  );

  const none = showEmpty ? 'This book has no groups yet.' : `Nothing has been posted in this book up to ${finDateText(to)}.`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <PeriodFields from={from} to={to} onChange={onPeriod} />
        <div className="flex flex-wrap items-center gap-2 pb-1">
          <Button size="sm" variant="secondary" disabled={!tb || openable.size === 0} onClick={() => onExpanded(new Set(openable))}>Expand all</Button>
          <Button size="sm" variant="secondary" disabled={expanded.size === 0} onClick={() => onExpanded(new Set())}>Collapse all</Button>
          <Checkbox label="Show empty groups" checked={showEmpty} onChange={e => onShowEmpty(e.target.checked)} />
        </div>
      </div>
      {!problem && (
        <p className="mb-3 text-xs text-slate-500">
          Opening is everything dated before {finDateText(from)}; the period is {finPeriodText(from, to)}; closing is as at {finDateText(to)}.
        </p>
      )}

      <LoadNotice failed={failed} shown={Boolean(tb)} what="the trial balance" onRetry={reload} />

      {tb && (
        <KpiRow cols={3}>
          {pair(FIN_TB_FOOT.opening, BookOpen, tb.totals.opening_dr, tb.totals.opening_cr, 'Dr', 'Cr', gaps.opening)}
          {pair(FIN_TB_FOOT.period, ArrowLeftRight, tb.totals.debit, tb.totals.credit, 'Debit', 'Credit', gaps.movement)}
          {pair(FIN_TB_FOOT.closing, Scale, tb.totals.closing_dr, tb.totals.closing_cr, 'Dr', 'Cr', gaps.closing)}
        </KpiRow>
      )}

      <DataTable rows={rows} columns={columns} getRowId={r => `${r.kind}-${r.id}`} serialNumber={false}
        onRowClick={act} rowClass={r => (r.kind === 'group' ? 'font-semibold' : '')}
        empty={finReportEmpty({ known: Boolean(tb), failed, none, blocked: problem && 'Choose a period that ends after it starts.' })}
        {...finExportProps(book, {
          name: 'Trial Balance', subtitle: `${book.name} · ${finPeriodText(from, to)}`, meta: [FIN_TB_FOOT_NOTE],
          summary: tb ? finTbSummary(tb.totals) : undefined,
        })} />
    </div>
  );
}
