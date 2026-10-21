// LedgerStatement: the Reports page's Ledger tab (spec §9.2). Props:
//   { book, ledgerId, onPickLedger, from, to, onPeriod, onVoucher, version }
//
// GET /finance/reports/ledger?ledger&from&to. The ledger and the period live in the page's URL (?ledger&from&to), so a drill-down from
// the trial balance is a link that can be shared and Back returns to it. The opening, each posted line with the balance after it, and
// the closing (which is the trial balance's closing for the ledger as at `to`). A row is one posted line of the ledger: it opens its
// voucher (onVoucher).
//
// A running balance only means something in the order it was run, so NO column sorts (finUnsorted). The opening and closing are the
// cards above the table; they ride along in an export as its summary.
//
// The ledger must be one of THIS book's. The picker lists the book's ledgers, so a ?ledger= that is not among them (a pasted link, or
// the book switch used while a statement was open) is said so and not asked for; and an answer whose ledger belongs to another book is
// never drawn, whatever was asked, so a statement can never sit under the wrong book's name. Switched-off ledgers are offered here:
// they keep their history.
import { useMemo } from 'react';
import { ArrowDownLeft, ArrowUpRight, BookOpen, Scale } from 'lucide-react';
import { DataTable, Field, KpiCard, KpiRow } from '../ui.jsx';
import LedgerPicker, { useBookLedgers } from './LedgerPicker.jsx';
import useReport from './useReport.js';
import { LoadNotice, PeriodFields } from './ReportParts.jsx';
import { finFormatINR } from '../../lib/finance/money.js';
import { finDateText, finTypeLabel } from '../../lib/finance/voucher.js';
import {
  finExportProps, finLedgerStatus, finPeriodText, finRangeProblem, finReportEmpty, finStatementBelongs, finStatementSummary, finUnsorted,
} from '../../lib/finance/reports.js';

export default function LedgerStatement({ book, ledgerId, onPickLedger, from, to, onPeriod, onVoucher, version }) {
  const { ledgers, failed: listFailed, reload: reloadLedgers } = useBookLedgers(book.id);
  // The picker offers every ledger of the book, a switched-off one too (marked), since a report is about what was posted.
  const pickable = useMemo(
    () => (ledgers == null ? null : ledgers.map(l => (l.active ? l : { ...l, name: `${l.name} (switched off)`, active: true }))), [ledgers]);
  // Whether the ledger asked for is in this book (finLedgerStatus): a statement is asked for only when it is.
  const status = finLedgerStatus(ledgerId, ledgers, listFailed);

  const problem = finRangeProblem(from, to);
  const url = status === 'in' && !problem
    ? `/finance/reports/ledger?${new URLSearchParams({ ledger: String(ledgerId), from, to })}` : null;
  const { data, failed, reload } = useReport(url, version);
  // The answer's own ledger is the last word on whose it is.
  const statement = finStatementBelongs(data, book.id) ? data : null;
  const elsewhere = status === 'elsewhere' || (data != null && statement == null);

  const rows = useMemo(() => (statement ? statement.entries.map((entry, _i) => ({ ...entry, _i })) : []), [statement]);

  const blocked = status === 'none' ? 'Choose a ledger to see its statement.'
    : elsewhere ? `That ledger isn't in ${book.name}. Choose one from the list above.`
    : problem ? 'Choose a period that ends after it starts.' : undefined;

  const columns = finUnsorted([
    { key: 'voucher_date', label: 'Date', card: 'metric', render: r => <span className="whitespace-nowrap">{finDateText(r.voucher_date)}</span> },
    { key: 'number', label: 'Number', card: 'title', render: r => <span className="whitespace-nowrap font-semibold">{r.number || '—'}</span> },
    { key: 'voucher_type', label: 'Type', card: 'detail', render: r => finTypeLabel(r.voucher_type) },
    { key: 'against', label: 'Against', card: 'subtitle', render: r => r.against || '—' },
    { key: 'narration', label: 'Narration', card: 'detail', export: r => r.narration || '',
      render: r => <span className="block max-w-[22rem] truncate" title={r.narration || ''}>{r.narration || <span className="text-gray-300">—</span>}</span> },
    { key: 'debit_paise', label: 'Debit', align: 'right', card: 'metric', render: r => (r.debit_paise > 0 ? finFormatINR(r.debit_paise) : '') },
    { key: 'credit_paise', label: 'Credit', align: 'right', card: 'metric', render: r => (r.credit_paise > 0 ? finFormatINR(r.credit_paise) : '') },
    { key: 'balance_paise', label: 'Balance', align: 'right', card: 'metric',
      render: r => <span className="font-semibold">{finFormatINR(r.balance_paise, { drcr: true })}</span> },
  ]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="Ledger" className="w-full sm:w-96">
          <LedgerPicker bookId={book.id} ledgers={pickable} value={ledgerId} onChange={id => onPickLedger(id)} />
        </Field>
        <PeriodFields from={from} to={to} onChange={onPeriod} />
      </div>

      {/* The book's ledgers are what the picker offers: without them it says "No results found" and nothing else, so a failed read says so. */}
      <LoadNotice failed={listFailed} shown={false} what="the ledgers, so none can be picked" onRetry={reloadLedgers} />
      <LoadNotice failed={failed} shown={Boolean(statement)} what="the statement" onRetry={reload} />

      {statement && (
        <>
          <div className="mb-3">
            <div className="break-words text-lg font-extrabold tracking-[-0.02em] text-[#1D1D1F]">{statement.ledger.name}</div>
            <div className="text-sm text-[#6E6E73]">{statement.ledger.group_name} · {finPeriodText(from, to)}</div>
          </div>
          <KpiRow cols={4}>
            <KpiCard compact icon={BookOpen} label="Opening" value={finFormatINR(statement.opening_paise, { drcr: true })} sub={`before ${finDateText(from)}`} />
            <KpiCard compact icon={ArrowDownLeft} label="Debits" value={finFormatINR(statement.total_debit_paise)} sub="in the period" />
            <KpiCard compact icon={ArrowUpRight} label="Credits" value={finFormatINR(statement.total_credit_paise)} sub="in the period" />
            <KpiCard compact icon={Scale} label="Closing" value={finFormatINR(statement.closing_paise, { drcr: true })} sub={`as at ${finDateText(to)}`} />
          </KpiRow>
        </>
      )}

      <DataTable rows={rows} columns={columns} getRowId={r => r._i} onRowClick={r => onVoucher(r.voucher_id)}
        empty={finReportEmpty({ known: Boolean(statement), failed, none: 'No entries in this period.', blocked })}
        {...(statement ? finExportProps(book, {
          name: `Ledger ${statement.ledger.name}`, subtitle: `${book.name} · ${finPeriodText(from, to)}`,
          meta: [`Group: ${statement.ledger.group_name}`], summary: finStatementSummary(statement),
        }) : {})} />
    </div>
  );
}
