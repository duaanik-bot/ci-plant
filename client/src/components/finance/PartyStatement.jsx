// PartyStatement: the Reports page's Party bills tab (Cash & Bank spec §6.2, §6.7; plan Task 15). Props:
//   { book, ledgerId, onPickLedger, onVoucher, version }
//
// GET /finance/reports/party?ledger=: a customer's or a vendor's bills as at the plant's today (the server's day), in three parts:
//   Open items    what is still owed on its bills (a customer's open debits, a vendor's open credits), each with what is open of it and
//                 its age in days, in the order Auto settles them (spec §6.3: the opening lump, then the oldest)
//   On account    money it holds on account, paid ahead or left over, not set against a bill yet
//   The check     the invariant's two sides beside the ledger's balance (spec §6.2): outstanding less on account is the balance, and
//                 the server says whether it holds
// The ledger lives in the page's URL (?ledger=), as the Ledger tab's does, so a link can be shared and Back returns to it. The picker
// lists this book's parties (is_party: a customer's or a vendor's ledger, by its group or its link, the server's word), a switched-off
// one too (it keeps its bills); a ?ledger= that is not among them is said so and not asked for, and an answer whose ledger is another
// book's is never drawn. A row opens its voucher over the report. Both tables keep the server's order (finUnsorted), which is the point
// of the open items; an export is offered as on every report, to a grant that may.
import { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, Receipt, Scale, Wallet } from 'lucide-react';
import { DataTable, Field, KpiCard, KpiRow } from '../ui.jsx';
import LedgerPicker, { useBookLedgers } from './LedgerPicker.jsx';
import useReport from './useReport.js';
import { LoadNotice } from './ReportParts.jsx';
import { finFormatINR } from '../../lib/finance/money.js';
import { finDateText } from '../../lib/finance/voucher.js';
import {
  finAgeText, finExportProps, finLedgerStatus, finPartyCheck, finReportEmpty, finStatementBelongs, finUnsorted,
} from '../../lib/finance/reports.js';

const SIDE_WORD = { customer: 'Customer', vendor: 'Vendor' };

export default function PartyStatement({ book, ledgerId, onPickLedger, onVoucher, version }) {
  const { ledgers, failed: listFailed, reload: reloadLedgers } = useBookLedgers(book.id);
  const parties = useMemo(() => (ledgers == null ? null : ledgers.filter(l => l.is_party)
    .map(l => (l.active ? l : { ...l, name: `${l.name} (switched off)`, active: true }))), [ledgers]);
  const status = finLedgerStatus(ledgerId, parties, listFailed);

  const url = status === 'in' ? `/finance/reports/party?${new URLSearchParams({ ledger: String(ledgerId) })}` : null;
  const { data, failed, reload } = useReport(url, version);
  // The answer's own ledger is the last word on whose it is.
  const report = finStatementBelongs(data, book.id) ? data : null;
  const elsewhere = status === 'elsewhere' || (data != null && report == null);
  const check = report?.check ?? null;
  const shown = report ? finPartyCheck(check, report.ledger.side) : null;

  const blocked = status === 'none' ? 'Choose a customer or vendor to see its bills.'
    : elsewhere ? `That ledger isn't a customer's or a vendor's in ${book.name}. Choose one from the list above.` : undefined;

  const columns = finUnsorted([
    { key: 'label', label: 'Bill', card: 'title', render: r => <span className="whitespace-nowrap font-semibold">{r.label}</span> },
    { key: 'date', label: 'Date', card: 'detail', render: r => <span className="whitespace-nowrap">{finDateText(r.date)}</span> },
    { key: 'due_date', label: 'Due', card: 'detail', render: r => (r.due_date ? <span className="whitespace-nowrap">{finDateText(r.due_date)}</span> : '') },
    { key: 'age_days', label: 'Age', card: 'metric', export: r => finAgeText(r.age_days), render: r => <span className="whitespace-nowrap">{finAgeText(r.age_days)}</span> },
    { key: 'number', label: 'Voucher', card: 'subtitle', render: r => r.number || '' },
    { key: 'amount_paise', label: 'Amount', align: 'right', card: 'metric', render: r => finFormatINR(r.amount_paise) },
    { key: 'open_paise', label: 'Open', align: 'right', card: 'metric', render: r => <span className="font-semibold">{finFormatINR(r.open_paise)}</span> },
  ]);

  const exportOf = what => (report ? finExportProps(book, {
    name: `${what} ${report.ledger.name}`, subtitle: `${book.name} · as at ${finDateText(report.as_at)}`,
    summary: [
      { label: 'Outstanding', value: finFormatINR(check.outstanding_paise) },
      { label: 'On account', value: finFormatINR(check.on_account_paise) },
      { label: 'Ledger balance', value: shown.balance_text },
    ],
  }) : {});

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="Customer or vendor" className="w-full sm:w-96">
          <LedgerPicker bookId={book.id} ledgers={parties} value={ledgerId} placeholder="Choose a customer or vendor…" onChange={id => onPickLedger(id)} />
        </Field>
      </div>

      {/* The book's ledgers are what the picker offers: without them it says "No results found" and nothing else, so a failed read says so. */}
      <LoadNotice failed={listFailed} shown={false} what="the ledgers, so no party can be picked" onRetry={reloadLedgers} />
      <LoadNotice failed={failed} shown={Boolean(report)} what="the party's bills" onRetry={reload} />

      {report && (
        <>
          <div className="mb-3">
            <div className="break-words text-lg font-extrabold tracking-[-0.02em] text-[#1D1D1F]">{report.ledger.name}</div>
            <div className="text-sm text-[#6E6E73]">{SIDE_WORD[report.ledger.side] ?? 'Party'} · as at {finDateText(report.as_at)}</div>
          </div>
          <KpiRow cols={4}>
            <KpiCard compact icon={Receipt} label="Outstanding" value={finFormatINR(check.outstanding_paise)}
              sub={`${report.open_items.length} open ${report.open_items.length === 1 ? 'item' : 'items'}`} />
            <KpiCard compact icon={Wallet} label="On account" value={finFormatINR(check.on_account_paise)}
              sub={`${report.on_account.length} not set against a bill`} />
            <KpiCard compact icon={Scale} label="Ledger balance" value={shown.balance_text} sub="as the ledger holds it" />
            <KpiCard compact icon={check.ok ? CheckCircle2 : AlertTriangle} tone={check.ok ? 'good' : 'bad'} label="Check"
              value={check.ok ? 'Agrees' : 'Differs'} sub={`Outstanding less on account: ${finFormatINR(shown.net_paise)}`}
              title="What the open bills still owe, less the money on account, is the ledger's balance" />
          </KpiRow>
        </>
      )}

      <h3 className="mb-1 mt-4 text-xs font-bold uppercase tracking-[0.14em] text-[#86868B]">Open items</h3>
      <DataTable rows={report?.open_items ?? []} columns={columns} getRowId={r => r.line_id} serialNumber={false}
        onRowClick={r => onVoucher(r.voucher_id)}
        empty={finReportEmpty({ known: Boolean(report), failed, none: 'Nothing is outstanding on its bills.', blocked })}
        {...exportOf('Party bills')} />

      <h3 className="mb-1 mt-5 text-xs font-bold uppercase tracking-[0.14em] text-[#86868B]">On account</h3>
      <DataTable rows={report?.on_account ?? []} columns={columns} getRowId={r => r.line_id} serialNumber={false}
        onRowClick={r => onVoucher(r.voucher_id)}
        empty={finReportEmpty({ known: Boolean(report), failed, none: 'No money on account.', blocked })}
        {...exportOf('On account')} />
    </div>
  );
}
