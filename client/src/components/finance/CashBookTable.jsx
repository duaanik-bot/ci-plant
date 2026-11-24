// CashBookTable: one bank or cash account's book on the Cash & Bank page (spec §5). Props:
//   { book, failed, onRetry, from, to, onPeriod, mayEnter, exportProps, onOpen(voucherId), onRedo(entry) }
//
// `book` is GET /finance/cash/book's answer for the account and the window on show, or null while it has not come. The window is the
// page's (?from, ?to: the current month by default); the arrows step a month either way and the date boxes take any window up to a
// year (the server's limit). What is drawn:
//   • the book itself: the opening, every posted line of the window with a running balance, and the closing with the window's
//     totals (finBookRows). A running balance is true only in the order it was run, so NO column sorts (DataTable sorts by its first
//     sortable column when it is given no default): the rows keep the server's order, date and then entry order. "Particulars" names
//     the other side of each entry and, for a party, what it settled ("Auto: 3 bills, ₹0 on account"). A row opens its voucher; an
//     entry that settles bills offers Redo, to a login that can enter (`mayEnter`).
//   • apart, below it and outside every balance: the vouchers waiting for approval that touch the account, greyed, with their own
//     subtotal (finPendingRows). A row opens the voucher, where an Approver approves it.
// Export (Excel or PDF, and Print, which opens the PDF to print) is the shared ExportMenu's, whose code loads on the click: the opening
// and closing ride in the export as rows of the book, and its totals as the summary.
import { ChevronLeft, ChevronRight, Hourglass, RotateCcw } from 'lucide-react';
import { Button, DataTable } from '../ui.jsx';
import { LoadNotice, PeriodFields } from './ReportParts.jsx';
import { finFormatINR } from '../../lib/finance/money.js';
import { finDateText, finTypeLabel } from '../../lib/finance/voucher.js';
import { finPeriodText } from '../../lib/finance/reports.js';
import { finBookRows, finMonthWindow, finPendingRows } from '../../lib/finance/cash.js';

const money = paise => (paise > 0 ? finFormatINR(paise) : '');

// What the Particulars cell says of a row, as text: the export's cell, and the screen's title on hover.
function particularsText(r) {
  if (r.kind === 'opening') return 'Opening balance';
  if (r.kind === 'closing') return 'Closing balance · the window’s totals';
  return [r.particulars || '—', r.adjustment, r.narration].filter(Boolean).join(' · ');
}

export default function CashBookTable({ book, failed, onRetry, from, to, onPeriod, mayEnter, exportProps, onOpen, onRedo }) {
  const rows = finBookRows(book);
  const pending = finPendingRows(book);
  const step = delta => onPeriod(finMonthWindow(from, delta));

  const columns = [
    { key: 'date', label: 'Date', sortable: false, card: 'metric',
      render: r => <span className="whitespace-nowrap">{finDateText(r.date)}</span> },
    { key: 'number', label: 'Voucher', sortable: false, card: 'title',
      render: r => (r.kind === 'entry' ? <span className="whitespace-nowrap font-semibold">{r.number || '—'}</span> : '') },
    { key: 'particulars', label: 'Particulars', sortable: false, card: 'subtitle', export: particularsText,
      render: r => (r.kind !== 'entry'
        ? <span className="font-semibold text-[#6E6E73]">{particularsText(r)}</span>
        : (
          <span className="block max-w-[30rem]" title={particularsText(r)}>
            <span className="font-medium">{r.particulars || '—'}</span>
            {r.adjustment && <span className="text-[#6E6E73]"> · {r.adjustment}</span>}
            {r.narration && <span className="block truncate text-xs text-[#86868B]">{r.narration}</span>}
          </span>
        )) },
    { key: 'in_paise', label: 'In', align: 'right', sortable: false, card: 'metric',
      render: r => <span className={r.kind === 'closing' ? 'font-semibold' : ''}>{money(r.in_paise)}</span> },
    { key: 'out_paise', label: 'Out', align: 'right', sortable: false, card: 'metric',
      render: r => <span className={r.kind === 'closing' ? 'font-semibold' : ''}>{money(r.out_paise)}</span> },
    { key: 'balance_paise', label: 'Balance', align: 'right', sortable: false, card: 'metric',
      render: r => <span className="font-semibold">{finFormatINR(r.balance_paise)}</span> },
    { key: '_redo', label: '', sortable: false, card: 'actions',
      render: r => (mayEnter && r.kind === 'entry' && r.adjustment != null
        ? <Button size="sm" variant="ghost" title="Redo which bills this entry settles" onClick={() => onRedo(r)}><RotateCcw size={13} /> Redo</Button>
        : null) },
  ];

  const pendingColumns = [
    { key: 'date', label: 'Date', sortable: false, card: 'metric',
      render: r => <span className="whitespace-nowrap">{finDateText(r.date)}</span> },
    { key: 'voucher_type', label: 'Type', sortable: false, card: 'title', render: r => finTypeLabel(r.voucher_type) },
    { key: 'particulars', label: 'Particulars', sortable: false, card: 'subtitle',
      render: r => (
        <span className="block max-w-[30rem]">
          <span className="font-medium">{r.particulars || '—'}</span>
          {r.narration && <span className="block truncate text-xs">{r.narration}</span>}
        </span>
      ) },
    { key: 'in_paise', label: 'In', align: 'right', sortable: false, card: 'metric', render: r => money(r.in_paise) },
    { key: 'out_paise', label: 'Out', align: 'right', sortable: false, card: 'metric', render: r => money(r.out_paise) },
    { key: 'submitted_by', label: 'Sent by', sortable: false, card: 'metric', render: r => r.submitted_by || '—' },
  ];

  const account = book?.ledger;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-lg font-extrabold tracking-[-0.02em] text-[#1D1D1F]">
            {account ? (account.holder_name ? `${account.holder_name} · ${account.name}` : account.name) : 'The book'}
          </div>
          <div className="text-sm text-[#6E6E73]">{account ? `${account.group_name} · ` : ''}{finPeriodText(from, to)}</div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Button variant="secondary" size="sm" aria-label="The month before" onClick={() => step(-1)}><ChevronLeft size={14} /></Button>
          <Button variant="secondary" size="sm" aria-label="The month after" onClick={() => step(1)}><ChevronRight size={14} /></Button>
          <PeriodFields from={from} to={to} onChange={onPeriod} />
        </div>
      </div>

      <LoadNotice failed={failed} shown={Boolean(book)} what="the book" onRetry={onRetry} />

      <DataTable rows={rows} columns={columns} getRowId={r => r._row} serialNumber={false}
        onRowClick={r => { if (r.kind === 'entry') onOpen(r.voucher_id); }}
        rowClass={r => (r.kind === 'entry' ? '' : 'bg-[#1D1D1F]/[0.03]')}
        empty={book ? 'Nothing in this window.' : failed ? 'The book couldn’t load.' : 'Loading…'}
        {...(book ? exportProps : {})} />

      {pending.rows.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-sm font-bold text-[#515154]">
              <Hourglass size={14} className="text-amber-600" /> Waiting for approval · not in the balance
            </span>
            <span className="text-sm font-semibold tabular-nums text-[#6E6E73]">
              Subtotal: in {finFormatINR(pending.in_paise)} · out {finFormatINR(pending.out_paise)}
            </span>
          </div>
          <DataTable rows={pending.rows} columns={pendingColumns} getRowId={r => r._row} serialNumber={false}
            onRowClick={r => onOpen(r.voucher_id)} rowClass={() => 'opacity-60'} />
        </div>
      )}
    </div>
  );
}
