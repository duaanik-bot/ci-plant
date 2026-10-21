// MonthsYears: Setup's second tab (spec §6.2, §10). Props: { book, can }.
//
// Each financial year as a grid of its twelve months, April first, each with the status it is in:
//   Open          normal posting
//   Closing       only entries an Approver approves post (the CA finalising; audit adjustments)
//   Locked        nothing posts; unlocking is an Approver's act, with a reason, and audited
//   Before books  before the books begin: only the Opening voucher, and a reversal of it, may be dated there; it never moves
// An Approver (capability `approve`) is offered the moves a month can make, and ONLY those: the buttons come from FIN_PERIOD_TRANSITIONS
// (periods.js, the one table finSetPeriodStatus judges a move with), so a button is never drawn that the server would refuse. A move
// that needs a reason asks for one first (the Reopen and the Unlock); the others ask to be sure, saying what the move does.
// PUT /finance/periods/:id/status { status, reason }. Anyone who can read the book sees the grid; the rest of the login sees no buttons.
//
// "Add next financial year" is the admin's: POST /finance/years { book_id, label }, the label being the one after the latest year
// (finNextYearLabel). The new year's months are all open (those before the books begin are not, for a first year).
//
// The newest year is first. A write that fails reloads the grid (another Approver may have moved the month meanwhile, and the buttons
// follow the month's real status), says so when nothing answered (useNoAnswer), and leaves its dialog open so nothing typed is lost.
// The exceptions are a move the server refuses because the month is no longer where the screen thought (FIN_BAD_TRANSITION), and a year
// another admin has just added (FIN_EXISTS): the grid now shows the truth, so the dialog that asked about the old question closes.
import { useMemo, useState } from 'react';
import { CalendarPlus } from 'lucide-react';
import { api, fmt } from '../../api.js';
import { Button, ConfirmDialog, useToast } from '../ui.jsx';
import { ReasonDialog } from './VoucherDetail.jsx';
import { LoadNotice } from './ReportParts.jsx';
import { Chip } from './SetupParts.jsx';
import useNoAnswer from './useNoAnswer.js';
import useReport from './useReport.js';
import { finDateText } from '../../lib/finance/voucher.js';
import { finPeriodLabel, finPeriodMoveEffect, finPeriodMoveLabel, finPeriodMoves } from '../../lib/finance/periods.js';
import { finNextYearLabel } from '../../lib/finance/setup.js';

const STATUS_TONE = { open: 'good', closing: 'amber', locked: 'slate', before_books: 'muted' };

export default function MonthsYears({ book, can }) {
  const toast = useToast();
  const noAnswer = useNoAnswer();
  const { data, failed, reload } = useReport(`/finance/books/${book.id}/years`);
  const [move, setMove] = useState(null);          // { month, to, reason } a move waiting for its dialog
  const [adding, setAdding] = useState(false);

  const years = data?.years ?? null;
  const newestFirst = useMemo(() => (years ? [...years].sort((a, b) => b.start_date.localeCompare(a.start_date)) : []), [years]);
  const nextLabel = years ? finNextYearLabel(years, book.books_begin) : null;
  const mayMove = can('approve');

  const moveMonth = async reason => {
    const { month, to } = move;
    try {
      await api.put(`/finance/periods/${month.id}/status`, { status: to, ...(reason ? { reason } : {}) });
    } catch (e) {
      noAnswer(e);
      await reload();
      // The month is not where this screen thought it was: another Approver moved it. The toast has said where it is and the grid now
      // shows it, so the question the dialog asks no longer stands, and it closes. Any other refusal leaves it, with what was typed.
      if (e?.data?.code === 'FIN_BAD_TRANSITION') { setMove(null); return; }
      throw e;
    }
    toast.success(`${month.label} is now ${finPeriodLabel(to).toLowerCase()}`);
    setMove(null);
    await reload();
  };

  const addYear = async () => {
    try {
      await api.post('/finance/years', { book_id: book.id, label: nextLabel });
    } catch (e) {
      noAnswer(e);
      // The year is already there: another admin added it. The toast has said so. The dialog closes BEFORE the grid reloads, because the
      // reload moves nextLabel on and a dialog left open would be asking about the year after. Any other refusal leaves it.
      const exists = e?.data?.code === 'FIN_EXISTS';
      if (exists) setAdding(false);
      await reload();
      if (exists) return;
      throw e;
    }
    toast.success(`Financial year ${nextLabel} added`);
    setAdding(false);
    await reload();
  };

  const tile = month => {
    const moves = mayMove ? finPeriodMoves(month.status) : [];
    return (
      <li key={month.id} className={`flex min-w-0 flex-col gap-1.5 rounded-2xl border border-white/70 bg-white/55 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] ${month.status === 'before_books' ? 'opacity-70' : ''}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-bold text-[#1D1D1F]">{month.label}</span>
          <Chip tone={STATUS_TONE[month.status] ?? 'neutral'}>{finPeriodLabel(month.status)}</Chip>
        </div>
        {month.status_changed_by && (
          <div className="truncate text-[11px] text-slate-400" title={`${month.status_changed_by}, ${fmt.dt(month.status_changed_at)}`}>
            {month.status_changed_by} · {fmt.dt(month.status_changed_at)}
          </div>
        )}
        {moves.length > 0 && (
          <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
            {moves.map(m => (
              <Button key={m.to} size="sm" variant={m.reason ? 'ghost' : 'secondary'} onClick={() => setMove({ month, to: m.to, reason: m.reason })}>
                {finPeriodMoveLabel(month.status, m.to)}
              </Button>
            ))}
          </div>
        )}
      </li>
    );
  };

  const label = move ? finPeriodMoveLabel(move.month.status, move.to) : '';
  const effect = move ? finPeriodMoveEffect(move.month.status, move.to) : '';

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-3xl text-xs text-slate-500">
          Open months take normal posting. A closing month takes only entries an Approver approves. A locked month takes nothing until it is unlocked.
          {mayMove ? '' : ' Only an Approver can move a month.'}
        </p>
        {can('admin') && nextLabel && (
          <Button variant="secondary" onClick={() => setAdding(true)}><CalendarPlus size={14} /> Add next financial year</Button>
        )}
      </div>

      <LoadNotice failed={failed} shown={Boolean(years)} what="the months" onRetry={reload} />
      {!years && !failed && <div className="py-12 text-center text-sm text-gray-400">Loading…</div>}
      {years && years.length === 0 && <p className="py-12 text-center text-sm text-slate-500">This book has no financial year yet.</p>}

      <div className="space-y-5">
        {newestFirst.map(year => (
          <section key={year.id} aria-label={`Financial year ${year.label}`}>
            <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
              <h2 className="text-base font-extrabold tracking-[-0.02em] text-[#1D1D1F]">Financial year {year.label}</h2>
              <span className="text-xs text-slate-500">{finDateText(year.start_date)} to {finDateText(year.end_date)}</span>
            </div>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
              {year.periods.map(tile)}
            </ul>
          </section>
        ))}
      </div>

      {move?.reason && (
        <ReasonDialog title={`${label} ${move.month.label}`} confirmLabel={label} label="Why?" intro={`${effect} Say why: it is kept in the activity log.`}
          onSubmit={moveMonth} onClose={() => setMove(null)} />
      )}
      <ConfirmDialog open={Boolean(move) && !move.reason} onClose={() => setMove(null)} onConfirm={() => moveMonth()}
        title={move ? `${label} ${move.month.label}?` : ''} message={effect} confirmLabel={label || 'Confirm'} />
      <ConfirmDialog open={adding} onClose={() => setAdding(false)} onConfirm={addYear}
        title={`Add the ${nextLabel} financial year?`} message="It starts with its twelve months, April to March, and they are all open." confirmLabel="Add year" />
    </div>
  );
}
