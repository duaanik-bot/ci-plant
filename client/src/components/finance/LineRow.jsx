// LineRow: one line of the voucher entry grid (VoucherForm). The ledger, the Dr and Cr cells and a remove button, and under them the line
// narration and, on a party's ledger, the bill reference, bill date and due date. It holds no state: the form owns the lines.
//
// Every cell carries data-fin-line (the line's React key) and data-fin-cell (which cell). The cells the Enter key walks (the ledger, Dr,
// Cr and the bill fields, but not the line narration) also carry data-fin-field. The form finds a cell to focus, and the last field of the
// last line, by those attributes, so they are part of this component's contract.
//
//   number   how the server will count this line (blank rows are not lines), 0 for a blank row; the row shows a dot for 0
//   label    what a screen reader calls it: the number, or the row's place when it has none
//   ledger   the ledger picked on this line (from the book's list), which says whether the bill fields show
//   onEdit(cell, change)   a cell was changed: `change` is the new field values, or a function from the line to the new line
//   onSettle()             an amount cell was left: its text is tidied or marked unreadable
//   onPick(id, ledger)     a ledger was picked, or cleared (null)
import { X } from 'lucide-react';
import { Input } from '../ui.jsx';
import { finSetAmount } from '../../lib/finance/voucher.js';
import LedgerPicker from './LedgerPicker.jsx';

// The grid the header, the rows and the totals share, so their columns line up.
export const LINE_GRID = 'grid grid-cols-[2rem_minmax(0,1fr)_8.5rem_8.5rem_2rem] items-start gap-x-2 gap-y-1';
export const cellProblem = text => <span className="mt-0.5 block text-[11px] leading-snug text-red-600">{text}</span>;
export const redRing = bad => (bad ? '!border-red-400 !ring-2 !ring-red-200' : '');

export default function LineRow({ line, label, number, ledger, ledgers, bookId, canRemove, onPick, onEdit, onSettle, onRemove }) {
  const billing = Boolean(ledger?.is_party) || Boolean(line.bill_ref || line.bill_date || line.due_date);
  const common = { 'data-fin-line': line.key };
  const problems = { debit: line.debit_error || line.server?.debit_paise, credit: line.credit_error || line.server?.credit_paise };

  return (
    <div className={`${LINE_GRID} py-2`}>
      <span className="pt-2.5 text-right text-xs tabular-nums text-slate-400">{number || '·'}</span>
      <div className="min-w-0">
        <LedgerPicker bookId={bookId} ledgers={ledgers} manualOnly value={line.ledger_id}
          aria-label={`Line ${label} ledger`} data-fin-field="ledger" data-fin-cell="ledger" {...common}
          className={redRing(line.server?.ledger_id)} onChange={onPick} />
        {line.server?.ledger_id && cellProblem(line.server.ledger_id)}
      </div>
      {['debit', 'credit'].map(side => (
        <div key={side} className="min-w-0">
          <Input value={line[`${side}_text`]} inputMode="decimal" autoComplete="off" placeholder="0.00"
            aria-label={`Line ${label} ${side}`} aria-invalid={Boolean(problems[side])}
            data-fin-field={side} data-fin-cell={side} {...common}
            className={`text-right tabular-nums ${redRing(problems[side])}`}
            onChange={e => onEdit(side, l => finSetAmount(l, side, e.target.value))}
            onBlur={onSettle} />
          {problems[side] && cellProblem(problems[side])}
        </div>
      ))}
      <button type="button" aria-label={`Remove line ${label}`} title="Remove this line" onClick={onRemove} disabled={!canRemove}
        className="mt-1.5 flex h-7 w-7 items-center justify-center rounded-full text-[#86868B] transition hover:bg-red-50 hover:text-red-600 disabled:opacity-30 touch:h-10 touch:w-10">
        <X size={14} />
      </button>

      <div className="col-span-3 col-start-2 mt-1 flex flex-wrap items-start gap-2">
        <div className="min-w-[12rem] flex-1">
          <Input value={line.narration} placeholder="Line narration (optional)" aria-label={`Line ${label} narration`}
            data-fin-cell="narration" {...common} className={`!h-9 text-xs ${redRing(line.server?.narration)}`}
            onChange={e => onEdit('narration', { narration: e.target.value })} />
          {line.server?.narration && cellProblem(line.server.narration)}
        </div>
        {billing && (
          <>
            <div className="w-36">
              <Input value={line.bill_ref} placeholder="Bill ref" maxLength={100} aria-label={`Line ${label} bill reference`}
                data-fin-field="bill_ref" data-fin-cell="bill_ref" {...common} className={`!h-9 text-xs ${redRing(line.server?.bill_ref)}`}
                onChange={e => onEdit('bill_ref', { bill_ref: e.target.value })} />
              {line.server?.bill_ref && cellProblem(line.server.bill_ref)}
            </div>
            <div className="w-36" title="Bill date">
              <Input type="date" value={line.bill_date} aria-label={`Line ${label} bill date`}
                data-fin-field="bill_date" data-fin-cell="bill_date" {...common} className={`!h-9 text-xs ${redRing(line.server?.bill_date)}`}
                onChange={e => onEdit('bill_date', { bill_date: e.target.value })} />
              {line.server?.bill_date && cellProblem(line.server.bill_date)}
            </div>
            <div className="w-36" title="Due date">
              <Input type="date" value={line.due_date} aria-label={`Line ${label} due date`}
                data-fin-field="due_date" data-fin-cell="due_date" {...common} className={`!h-9 text-xs ${redRing(line.server?.due_date)}`}
                onChange={e => onEdit('due_date', { due_date: e.target.value })} />
              {line.server?.due_date && cellProblem(line.server.due_date)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
