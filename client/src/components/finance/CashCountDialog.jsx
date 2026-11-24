// CashCountDialog: count a cash account, and clear a count's difference (Cash & Bank spec §5.5). Props:
//   { book, accounts, ledgerId, mayEnter, onClose, onChanged }
//
// `accounts` are the tiles; the dialog counts a cash account, a holder's included (a bank is never counted), the one `ledgerId` names
// or the first. What it does:
//   • Count: the date, the counted amount (typed, read by finToPaiseTyped) and a note, POST /finance/cash/counts. It posts nothing: the
//     server reads the book balance on that day beside the counted amount, and the answer says the difference, short or excess.
//   • Clear: a difference is cleared only from its count, POST /finance/cash/counts/:id/clear, by a "Cash short / excess" entry: a
//     receipt for an excess, a payment for a shortage, against the Cash Short & Excess ledger. It always waits for the MD (the
//     cash_difference rule) unless an Approver makes it, so the person who keeps the cash cannot clear their own shortage.
//   • The account's counts, newest first (GET /finance/cash/counts?ledger=), each with its difference and whether it was cleared. Clear
//     is offered on the newest one only, while its difference stands: a later count that matches says the cash and the book agree.
// Counting and clearing are entries of a login that can enter (`mayEnter`); any login that reads the book sees the counts. Each is one
// press at a time, Ctrl+Enter's included (ruling R57): a count mints no number, so the client's join of a repeated POST is not for it,
// and the dialog's own guard is what keeps a double press from recording two counts.
//
// Keys, as the entry form's: Ctrl or Cmd with Enter records the count, wherever focus is (useSaveKey, on window while the dialog is open:
// ruling R72); and, taken in the capture phase before the account picker sees them (finding F1), Enter and Shift+Enter move between the
// boxes, and in the picker choose nothing until something is typed in it or its list is steered with the arrows; Esc closes, and an
// open list keeps its own Esc.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmt } from '../../api.js';
import { Button, Field, Input, Modal, Select, useToast } from '../ui.jsx';
import useNoAnswer from './useNoAnswer.js';
import useSaveKey from './useSaveKey.js';
import { dayOf } from '../../lib/dayOf.js';
import { finFormatINR, finToPaiseTyped } from '../../lib/finance/money.js';
import { finDateText } from '../../lib/finance/voucher.js';
import { finEntryDate } from '../../lib/finance/cash.js';

const BOXES = ['account', 'date', 'counted', 'note'];
// A picker's list closes on a click outside it, not when the keyboard leaves it: a keyboard move out of the picker closes it so.
const closeLists = () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
const labelOf = a => (a.holder_name ? `${a.holder_name} · ${a.name}` : a.name);

// A count's difference, said the way the tile says it.
function differenceText(count) {
  const gap = count.difference_paise;
  if (gap === 0) return 'matches the book';
  return `${gap < 0 ? 'short' : 'excess'} ${finFormatINR(Math.abs(gap))}`;
}

export default function CashCountDialog({ book, accounts, ledgerId, mayEnter, onClose, onChanged }) {
  const toast = useToast();
  const noAnswer = useNoAnswer();
  const cash = accounts.filter(a => a.account_kind === 'cash' || a.account_kind === 'holder');
  const [account, setAccount] = useState(() => (cash.some(a => a.ledger_id === ledgerId) ? ledgerId : cash[0]?.ledger_id ?? null));
  const [date, setDate] = useState(() => finEntryDate(null, dayOf(new Date()), book.books_begin));
  const [countedText, setCountedText] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');
  const [counts, setCounts] = useState({ ledger: null, rows: null, failed: false });
  const savingRef = useRef(false);    // one write at a time: a count, or a clearing
  const bodyRef = useRef(null);
  const steered = useRef(null);       // the picker whose list the arrows have moved in since it was given focus

  const tile = cash.find(a => a.ledger_id === account) ?? null;
  const loadCounts = useCallback(async () => {
    if (account == null) return;
    try {
      const answer = await api.get(`/finance/cash/counts?ledger=${account}`);
      setCounts({ ledger: account, rows: answer.counts, failed: false });
    } catch {
      setCounts(c => ({ ...c, ledger: account, failed: true }));
    }
  }, [account]);
  useEffect(() => { loadCounts(); }, [loadCounts]);

  const rows = counts.ledger === account ? counts.rows : null;
  const newest = rows?.[0] ?? null;
  // The tile knows whether the newest count's clearing waits for an Approver; the list does not say it.
  const waiting = tile?.last_count?.clearing_waiting === true && tile.last_count.count_date === newest?.count_date;
  const clearable = mayEnter && newest && newest.difference_paise !== 0 && newest.cleared_voucher_id == null && !waiting;

  const record = async () => {
    if (savingRef.current) return;
    let counted_paise;
    try {
      counted_paise = finToPaiseTyped(countedText);
    } catch (e) {
      setProblem(e.message);
      return;
    }
    setProblem('');
    savingRef.current = true;
    try {
      const answer = await api.post('/finance/cash/counts', { book_id: book.id, ledger_id: account, count_date: date, counted_paise, note: note.trim() || null });
      const made = answer.count;
      toast.success(made.difference_paise === 0 ? 'Counted: it matches the book' : `Counted: ${differenceText(made)}`);
      setCountedText('');
      setNote('');
      await loadCounts();
      onChanged?.();
    } catch (e) {
      noAnswer(e);
      if (Number.isInteger(e?.status)) setProblem(e.message);
    } finally {
      savingRef.current = false;
    }
  };

  const clear = async count => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      const answer = await api.post(`/finance/cash/counts/${count.id}/clear`);
      const v = answer.voucher;
      toast.success(v?.status === 'posted' ? `Cleared: posted ${v.number}` : 'The clearing waits for the MD’s approval');
      await loadCounts();
      onChanged?.();
    } catch (e) {
      noAnswer(e);
      await loadCounts();
    } finally {
      savingRef.current = false;
    }
  };

  // ── Keys (finding F1) ────────────────────────────────────────────────────────────────────
  const boxEl = box => bodyRef.current?.querySelector(`[data-fin-box="${box}"]`) ?? null;
  // What the picker shows that was typed: its text, unless that is only the chosen account's own name (put back after an Esc).
  const typedIn = input => {
    const text = input.value.trim();
    return text !== '' && text !== (tile ? labelOf(tile) : null);
  };
  // Ctrl or Cmd with Enter is caught on window before any of this, and records the count (ruling R72).
  useSaveKey(() => { if (mayEnter && account != null) record(); });
  const onKeyDownCapture = e => {
    const { key, shiftKey } = e;
    const box = e.target.getAttribute?.('data-fin-box') ?? null;
    if (key === 'Tab' && box === 'account') { closeLists(); return; }
    if (key === 'ArrowDown' || key === 'ArrowUp') { if (box === 'account') steered.current = e.target; return; }
    if (key !== 'Enter' || e.nativeEvent?.isComposing) return;
    if (!box || e.target.tagName !== 'INPUT') return;
    if (box === 'account' && (typedIn(e.target) || steered.current === e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (box === 'account') closeLists();
    const flow = BOXES.map(boxEl).filter(el => el && !el.disabled);
    const next = flow[flow.indexOf(e.target) + (shiftKey ? -1 : 1)];
    if (next) next.focus();
  };
  // Bubbling, Esc: an open list shuts on it, and the dialog's own Esc (on window) would close the dialog with the same press.
  const onKeyDown = e => {
    if (e.key === 'Escape' && document.querySelector('[data-ci-overlay].glass')) e.stopPropagation();
  };

  return (
    <Modal open wide onClose={onClose} title={`Count cash · ${book.code}`}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Done</Button>
        {mayEnter && <Button onClick={record} disabled={account == null}>Record the count</Button>}
      </>}>
      <div data-ci-form onKeyDownCapture={onKeyDownCapture} onFocusCapture={e => { if (steered.current !== e.target) steered.current = null; }}
        onKeyDown={onKeyDown} ref={bodyRef}>
        {cash.length === 0 && <p className="text-sm text-[#515154]">This book has no cash account to count.</p>}
        {cash.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
            <Field label="Cash account">
              <Select value={account ?? ''} data-fin-box="account" onChange={e => setAccount(e.target.value === '' ? null : Number(e.target.value))}
                options={cash.map(a => ({ value: a.ledger_id, label: labelOf(a) }))} />
            </Field>
            <div className="self-end pb-2 text-right text-sm text-[#515154]">
              Book now: <span className="font-bold tabular-nums text-[#1D1D1F]">{tile ? finFormatINR(tile.balance_paise) : '—'}</span>
            </div>
          </div>
        )}

        {mayEnter && cash.length > 0 && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[11rem_12rem_minmax(0,1fr)]">
            <Field label="Counted on" required>
              <Input type="date" value={date} data-fin-box="date" onChange={e => setDate(e.target.value)} />
            </Field>
            <Field label="Counted ₹" required>
              <Input inputMode="decimal" placeholder="0.00" className="text-right tabular-nums" value={countedText} data-fin-box="counted"
                onChange={e => { setCountedText(e.target.value); setProblem(''); }} />
            </Field>
            <Field label="Note">
              <Input value={note} placeholder="Who counted, what was found" data-fin-box="note" onChange={e => setNote(e.target.value)} />
            </Field>
          </div>
        )}
        {problem && <p className="mt-2 text-sm font-medium text-red-600">{problem}</p>}
        {mayEnter && (
          <p className="mt-2 text-xs text-[#86868B]">
            A count posts nothing. The book balance on that day is read beside it, and a difference stays on the tile until it is cleared
            here or a later count matches. Clearing always waits for the MD.
          </p>
        )}

        <div className="mt-4">
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-[#86868B]">Counts of this account</div>
          {counts.failed && rows == null && <p className="text-sm text-red-700">The counts didn&apos;t load.</p>}
          {rows == null && !counts.failed && <p className="text-sm text-[#86868B]">Loading…</p>}
          {rows?.length === 0 && <p className="text-sm text-[#515154]">Never counted.</p>}
          {rows?.length > 0 && (
            <ul className="divide-y divide-[#1D1D1F]/[0.06] rounded-xl border border-[#1D1D1F]/[0.08] bg-white/60">
              {rows.map(count => {
                const open = count.difference_paise !== 0 && count.cleared_voucher_id == null;
                return (
                  <li key={count.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <span className="w-28 font-semibold">{finDateText(count.count_date)}</span>
                    <span className="tabular-nums">counted {finFormatINR(count.counted_paise)}</span>
                    <span className="tabular-nums text-[#6E6E73]">book {finFormatINR(count.book_balance_paise)}</span>
                    <span className={`font-semibold ${open ? 'text-amber-700' : 'text-emerald-700'}`}>
                      {count.cleared_voucher_id != null ? `${differenceText(count)} · cleared` : differenceText(count)}
                      {count === newest && waiting ? ' · clearing waits for approval' : ''}
                    </span>
                    <span className="text-xs text-[#86868B]">{count.counted_by || '—'} · {fmt.dt(count.counted_at)}</span>
                    {count.note && <span className="basis-full text-xs text-[#6E6E73]">{count.note}</span>}
                    {count === newest && clearable && (
                      <Button size="sm" className="ml-auto" onClick={() => clear(count)}>Clear the difference</Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
