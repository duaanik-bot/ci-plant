// JournalRegister: the Reports page's Journal Register tab and, from the same component, its Self-approved tab (spec §9.2). Props:
//   { book, from, to, onPeriod, onVoucher, version }
//
//   GET /finance/reports/journal-register?book&from&to&type   the posted vouchers of the book dated in the period, each with its lines
//   GET /finance/reports/self-approved?book&from&to           the posted vouchers an Approver passed on their own authority
//
// A row is a voucher: it opens in the voucher detail (onVoucher). The register shows each voucher's lines in one cell (the first few,
// and how many more: an Opening voucher has a line for every ledger in the book). The server sends every voucher of the period,
// uncapped, so the period is always sent, and the page always has one.
//
// Not a running balance, so the columns sort; the table opens in the order the server sends (date, then the order they were posted
// in, then id), which the `_order` index keeps. Search reaches the lines too (rowMatches reads every value of a row, and the ledger
// names are among them), and is held here, not by the table, so a search that hides every row says so and never "no vouchers were
// posted". Export is offered only to a book whose grant allows it (finExportProps).
import { useMemo, useState } from 'react';
import { DataTable, Field, rowMatches, Select } from '../ui.jsx';
import useReport from './useReport.js';
import { LoadNotice, PeriodFields } from './ReportParts.jsx';
import { finFormatINR } from '../../lib/finance/money.js';
import { FIN_TYPE_LABELS, finDateText, finNumberKey, finTypeLabel } from '../../lib/finance/voucher.js';
import { finSearchEmpty } from '../../lib/finance/page.js';
import {
  finExportProps, finLineText, finPeriodText, finRangeProblem, finRegisterLines, finReportEmpty,
} from '../../lib/finance/reports.js';

export default function JournalRegister({ book, from, to, onPeriod, onVoucher, version, selfApproved = false }) {
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const problem = finRangeProblem(from, to);
  const query = new URLSearchParams({ book: String(book.id), from, to });
  if (!selfApproved && type) query.set('type', type);
  const url = problem ? null : `/finance/reports/${selfApproved ? 'self-approved' : 'journal-register'}?${query}`;
  const { data, failed, reload } = useReport(url, version);

  const rows = useMemo(() => (data ? data.vouchers.map((voucher, _order) => ({ ...voucher, _order })) : []), [data]);
  // The search is held here and not by the table, so the empty line below can tell a search that hid every row from a period that had none.
  const shown = useMemo(() => (search.trim() ? rows.filter(r => rowMatches(r, search)) : rows), [rows, search]);

  const columns = [
    { key: 'voucher_date', label: 'Date', card: 'metric', render: r => <span className="whitespace-nowrap">{finDateText(r.voucher_date)}</span> },
    { key: 'number', label: 'Number', card: 'title', sortValue: r => finNumberKey(r.number), render: r => <span className="whitespace-nowrap font-semibold">{r.number || '—'}</span> },
    { key: 'voucher_type', label: 'Type', card: 'metric', sortValue: r => finTypeLabel(r.voucher_type), render: r => finTypeLabel(r.voucher_type) },
    { key: 'narration', label: 'Narration', sortable: false, card: 'subtitle', export: r => r.narration || '',
      render: r => <span className="block max-w-[22rem] truncate" title={r.narration || ''}>{r.narration || <span className="text-gray-300">—</span>}</span> },
    ...(selfApproved ? [] : [{
      key: 'lines', label: 'Ledgers', sortable: false, card: 'detail',
      export: r => r.lines.map(finLineText).join('\n'),
      render: r => {
        const { shown, more } = finRegisterLines(r.lines);
        return (
          <ul className="space-y-0.5 text-xs">
            {shown.map((line, i) => (
              <li key={i} className="flex justify-between gap-4">
                <span className="min-w-0 truncate">{line.ledger_name}</span>
                <span className="shrink-0 whitespace-nowrap tabular-nums">{line.debit_paise > 0 ? 'Dr' : 'Cr'} {finFormatINR(line.debit_paise > 0 ? line.debit_paise : line.credit_paise)}</span>
              </li>
            ))}
            {more > 0 && <li className="text-slate-400">and {more} more {more === 1 ? 'line' : 'lines'}: open the voucher</li>}
          </ul>
        );
      },
    }]),
    { key: 'total_paise', label: 'Amount', align: 'right', card: 'metric', render: r => <span className="font-semibold tabular-nums">{finFormatINR(r.total_paise)}</span> },
  ];

  const name = selfApproved ? 'Self-approved Vouchers' : 'Journal Register';
  const base = selfApproved ? 'No entry was self-approved in this period.' : (type ? `No ${finTypeLabel(type)} vouchers were posted in this period.` : 'No vouchers were posted in this period.');
  const none = finSearchEmpty({ searching: search.trim() !== '', total: rows.length, none: base, noun: selfApproved ? 'self-approved vouchers' : 'vouchers' });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <PeriodFields from={from} to={to} onChange={onPeriod} />
        {!selfApproved && (
          <Field label="Type" className="w-40">
            <Select value={type} onChange={e => setType(e.target.value)} placeholder="All types">
              <option value="">All types</option>
              {Object.entries(FIN_TYPE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </Select>
          </Field>
        )}
      </div>
      {selfApproved && (
        <p className="mb-3 text-xs text-slate-500">
          Entries an Approver posted on their own authority, because approval was needed and no one else gave it. One that was later reversed stays on the list.
        </p>
      )}

      <LoadNotice failed={failed} shown={Boolean(data)} what={selfApproved ? 'the self-approved list' : 'the register'} onRetry={reload} />

      <DataTable rows={shown} columns={columns} getRowId={r => r.id} defaultSort={{ key: '_order', dir: 'asc' }}
        onRowClick={r => onVoucher(r.id)} searchValue={search} onSearchChange={setSearch}
        searchPlaceholder={selfApproved ? 'Search number or narration…' : 'Search number, narration or ledger…'}
        empty={finReportEmpty({ known: Boolean(data), failed, none, blocked: problem && 'Choose a period that ends after it starts.' })}
        {...finExportProps(book, {
          name, subtitle: `${book.name} · ${finPeriodText(from, to)}`,
          ...(type && !selfApproved ? { meta: [`Type: ${finTypeLabel(type)}`] } : {}),
        })} />
    </div>
  );
}

// The Self-approved tab: the same list without the lines and the type filter.
export function SelfApproved(props) {
  return <JournalRegister {...props} selfApproved />;
}
