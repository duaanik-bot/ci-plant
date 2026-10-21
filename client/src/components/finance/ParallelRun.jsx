// ParallelRun: the Reports page's Parallel Run tab (spec §9.2, §11.3). Props: { book, onLedger, version }
//
// At each month end during the parallel run the accountant uploads Tally's trial balance for that date; this tab sets it beside
// Finance's own closing balances, ledger by ledger, and the target is zero differences. The month-end uploads of the book come from
// GET /finance/imports?book&purpose=parallel_tb (newest first, and the newest is shown to begin with); the comparison is
// GET /finance/reports/parallel-run?import=<id>.
//
//   a row per Finance ledger that a Tally row is matched to, and per Finance ledger with a balance that no Tally row is matched to
//   difference = Tally less Finance (ruling R38), signed the ledger way: the Dr or Cr by which Tally's balance is ahead of Finance's
//   a row that differs, by a paisa or more, is red (ci-row-alarm) and is held at the top of the table whatever it is sorted by
//   a row opens that ledger's statement for the year up to the import's date (onLedger), from the later of 1 April and the day the books
//   begin (finPeriodStart), where the gap can be traced
//   the Tally rows matched to no ledger are listed below, with their Tally closing
//
// There is nothing to compare until an upload exists. "Upload Tally TB" (ParallelUpload: a month-end "As at", the Tally Trial Balance read
// in the browser, POST /finance/imports with purpose parallel_tb) is offered to a login that may import (capability `import`), beside the
// picker and in the empty state; when it has gone through, this tab reloads its uploads and opens the new one.
import { useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle2, FileQuestion } from 'lucide-react';
import { fmt } from '../../api.js';
import { DataTable, Field, KpiCard, KpiRow, Select } from '../ui.jsx';
import useReport from './useReport.js';
import { LoadNotice } from './ReportParts.jsx';
import ParallelUpload from './ParallelUpload.jsx';
import { finCan } from '../../lib/finance/caps.js';
import { finFormatINR } from '../../lib/finance/money.js';
import { finDateText } from '../../lib/finance/voucher.js';
import {
  finExportProps, finImportLabel, finLedgerNameNote, finParallelRowClass, finPeriodStart, finPickImport, finReportEmpty, finUnsorted,
} from '../../lib/finance/reports.js';

export default function ParallelRun({ book, onLedger, version }) {
  const uploads = useReport(`/finance/imports?${new URLSearchParams({ book: String(book.id), purpose: 'parallel_tb' })}`, version);
  const imports = uploads.data?.imports ?? [];
  const [pick, setPick] = useState(null);
  const chosen = finPickImport(imports, pick);

  // The upload button, for a login that may import. A new upload is opened as soon as the list has it.
  const mayImport = finCan(book.roles, 'import');
  const uploadButton = mayImport
    ? <ParallelUpload book={book} onUploaded={async id => { await uploads.reload(); setPick(id); }} />
    : null;

  const run = useReport(chosen ? `/finance/reports/parallel-run?import=${chosen.id}` : null, version);
  // The comparison is of this book's upload, whatever was asked.
  const report = run.data && run.data.import.book_id === book.id ? run.data : null;

  // The same rows for as long as the answer is the same: the table starts its window again whenever its rows change.
  const rows = useMemo(() => (report?.rows ?? []).map((row, _order) => ({ ...row, _order })), [report]);
  const unmatched = useMemo(() => (report?.unmatched ?? []).map((row, _i) => ({ ...row, _i })), [report]);
  const differing = report?.totals.differing ?? 0;

  const columns = [
    { key: 'ledger_name', label: 'Ledger', card: 'title',
      render: r => {
        const note = finLedgerNameNote(r);
        return (
          <div className="min-w-0">
            <div className="font-semibold">{r.ledger_name}</div>
            {note && <div className="text-xs font-normal text-slate-500">{note}</div>}
          </div>
        );
      } },
    { key: 'tally_closing_paise', label: 'Tally closing', align: 'right', card: 'metric',
      render: r => (r.tally_name == null ? '—' : finFormatINR(r.tally_closing_paise, { drcr: true })) },
    { key: 'finance_closing_paise', label: 'Finance closing', align: 'right', card: 'metric', render: r => finFormatINR(r.finance_closing_paise, { drcr: true }) },
    // Sorted by the size of the gap, whichever way it runs: the largest differences are the ones to chase.
    { key: 'difference_paise', label: 'Difference (Tally minus Finance)', align: 'right', card: 'metric', sortValue: r => Math.abs(r.difference_paise),
      render: r => (r.difference_paise === 0
        ? <span className="text-slate-400">{finFormatINR(0)}</span>
        : <span className="font-bold text-red-600">{finFormatINR(r.difference_paise, { drcr: true })}</span>) },
  ];
  // A sheet has room a screen does not: the name Finance holds and the name Tally gave it are two columns there, not a name with a note.
  const exportColumns = [
    { key: 'ledger_name', label: 'Ledger', export: r => r.ledger_name },
    { key: 'tally_name', label: 'Tally name', export: r => r.tally_name ?? 'Not in the Tally file' },
    ...columns.slice(1),
  ];
  const unmatchedColumns = finUnsorted([
    { key: 'tally_name', label: 'Tally ledger', card: 'title', render: r => <span className="font-semibold">{r.tally_name}</span> },
    { key: 'tally_closing_paise', label: 'Tally closing', align: 'right', card: 'metric', render: r => finFormatINR(r.tally_closing_paise, { drcr: true }) },
  ]);

  const asAt = report?.import.as_at;
  const subtitle = report ? `${book.name} · Tally trial balance as at ${finDateText(asAt)}` : book.name;

  // Nothing to choose from: loading, could not load (the notice below says so), or no upload yet.
  let body;
  if (!uploads.data) {
    body = uploads.failed ? null : <p className="py-12 text-center text-sm text-gray-400">Loading…</p>;
  } else if (imports.length === 0) {
    body = (
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-[#1D1D1F]/[0.03] px-4 py-6 text-sm text-slate-600">
        <p className="min-w-0 flex-1">
          No Tally trial balance has been uploaded for {book.name} yet.{' '}
          {mayImport ? 'Upload each month-end Tally trial balance here' : 'The accountant uploads each month-end Tally trial balance here'}; once
          one is in, this tab sets it beside Finance's own figures, ledger by ledger.
        </p>
        {uploadButton}
      </div>
    );
  } else {
    body = (
      <>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Field label="Tally trial balance" className="w-full sm:w-[28rem]">
            <Select options={imports.map(i => ({ value: i.id, label: finImportLabel(i) }))} value={chosen.id}
              onChange={e => setPick(Number(e.target.value) || null)} placeholder="Choose an upload" />
          </Field>
          {uploadButton && <div className="ml-auto flex flex-wrap gap-2">{uploadButton}</div>}
        </div>

        <LoadNotice failed={run.failed} shown={Boolean(report)} what="the comparison" onRetry={run.reload} />

        {report && (
          <KpiRow cols={3}>
            <KpiCard compact icon={CalendarDays} label="Tally trial balance as at" value={finDateText(asAt)}
              sub={Array.isArray(chosen.file_names) && chosen.file_names.length ? chosen.file_names.join(', ') : undefined} />
            <KpiCard compact icon={differing ? AlertTriangle : CheckCircle2} tone={differing ? 'bad' : 'good'} label="Ledgers that differ"
              value={fmt.num(differing)} sub={differing ? 'highlighted in the table' : 'Finance agrees with Tally'} />
            <KpiCard compact icon={FileQuestion} tone={unmatched.length ? 'warn' : 'neutral'} label="Tally rows with no ledger"
              value={fmt.num(unmatched.length)} sub={unmatched.length ? 'listed below the table' : 'every Tally row is matched'} />
          </KpiRow>
        )}

        <DataTable rows={rows} columns={columns} getRowId={r => r.ledger_id} defaultSort={{ key: '_order', dir: 'asc' }}
          pinTop={r => r.difference_paise !== 0} rowClass={finParallelRowClass}
          onRowClick={r => onLedger(r.ledger_id, { from: finPeriodStart(asAt, book.books_begin), to: asAt })}
          empty={finReportEmpty({ known: Boolean(report), failed: run.failed, none: 'Neither Tally nor Finance has a balance on any ledger.' })}
          {...finExportProps(book, { name: 'Parallel Run', subtitle, columns: exportColumns })} />

        {report && (
          <div className="mt-6">
            <h2 className="mb-1 text-sm font-bold text-[#1D1D1F]">Tally rows with no Finance ledger</h2>
            <p className="mb-2 text-xs text-slate-500">
              These Tally rows are matched to no ledger of {book.name}, so there is no balance of Finance's to set them beside.
            </p>
            <DataTable rows={unmatched} columns={unmatchedColumns} getRowId={r => r._i}
              empty="Every Tally row is matched to a Finance ledger."
              {...finExportProps(book, { name: 'Parallel Run - unmatched Tally rows', subtitle })} />
          </div>
        )}
      </>
    );
  }

  return (
    <div>
      <LoadNotice failed={uploads.failed} shown={Boolean(uploads.data)} what="the Tally uploads" onRetry={uploads.reload} />
      {body}
    </div>
  );
}
