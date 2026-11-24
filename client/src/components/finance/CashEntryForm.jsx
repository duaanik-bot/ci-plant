// CashEntryForm: Receive, Pay and Transfer (Cash & Bank spec §5.1–§5.3, §5.6, §5.7), in the shared Modal. Props:
//   { book, entryType: 'receive' | 'pay' | 'transfer', start, ledgers, accounts, unoffered, roles, hrAccess, onClose, onSaved }
//
//   start      what the form opens holding: { account_ledger_id, other_ledger_id, amount_paise, tds_paise, reference, narration }, any
//              of them. Clone hands it the last entry; a holder's shortcut, a transfer to or from the holder; a link in, the party.
//   ledgers    the book's ledgers (GET /finance/books/:id/ledgers), accounts the tiles (GET /finance/cash/accounts' accounts),
//              unoffered the ledgers no entry names (finUnofferedLedgerIds), roles the book's ledger roles (for TDS): the page reads
//              them once and hands them to every form it opens.
//   onSaved    (answer, entry): the server's answer, and the entry as it was sent, for Clone.
//
// What it asks (spec §5.1–§5.3): the date (the last one used, finEntryDate); the account the money comes into or goes out of (a holder's
// among them); who it comes from or goes to (finEntryChoices: customers first on Receive, vendors first on Pay, then every other ledger
// the entry may name; never a staff ledger, which HR pays, or Cash Short & Excess, which a count clears); the amount; TDS deducted, on a
// customer's receipt or a vendor's payment only; the reference and the narration. For a party, AdjustPanel asks Auto or I'll pick, with
// neither chosen, and previews what each bill gets. Every typed amount is read by finToPaiseTyped, never as a float.
//
// Saving is POST /finance/cash/entries, one body, submitted at once: it posts, or waits for an Approver as the book's rules say. The
// save key is made once per opened form and rides on every save of it, so a save whose answer was lost and is pressed again answers
// the entry the first one made (ruling R11), and says so when the form had been changed since. The warnings beside the form
// (finEntryWarnings) never refuse and never hold Save back: the server refuses only what it refuses, and its sentence is shown under
// the box it names.
//
// Keys (§5.7): Enter moves to the next box and Shift+Enter to the one before; Ctrl or Cmd with Enter saves, wherever focus is, even
// after a bill was ticked with the mouse (useSaveKey: on window, while the form is open, ruling R72); Esc closes, and asks first when
// something has been typed (a picker's open list keeps its own Esc). The form takes Enter in the capture phase, before a picker sees it
// (finding F1): a picker opens its list on focus with its first option lit and would choose it on any Enter, so in a picker with
// nothing typed in it Enter and Shift+Enter move on and choose nothing; once something is typed in a picker, or its list is steered
// with the arrows, Enter chooses there, and choosing moves on. On the page, r, p and t open the three forms (useEntryKeys) whenever
// nothing that takes typing has focus and nothing else is open over the page.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { api } from '../../api.js';
import { Button, ConfirmDialog, Field, Input, Modal, useToast } from '../ui.jsx';
import LedgerPicker from './LedgerPicker.jsx';
import AdjustPanel from './AdjustPanel.jsx';
import useNoAnswer from './useNoAnswer.js';
import useSaveKey from './useSaveKey.js';
import { dayOf } from '../../lib/dayOf.js';
import { storage } from '../../lib/safeStorage.js';
import { finIsValidDate } from '../../lib/finance/fy.js';
import { finFormatINR, finToPaiseTyped } from '../../lib/finance/money.js';
import { finAmountText, finDateText, finNewSaveKey } from '../../lib/finance/voucher.js';
import { finEntryChoices, finEntryDate, finEntryWarnings } from '../../lib/finance/cash.js';

// The date the last entry was saved on is kept, so a day's entries do not each start at today (spec §5.1).
const DATE_KEY = 'fin_cash_date';

// ── The page's keys ──────────────────────────────────────────────────────────────────────────

const ENTRY_OF_KEY = new Map([['r', 'receive'], ['p', 'pay'], ['t', 'transfer']]);
const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const takesTyping = el => Boolean(el) && (TYPING.has(el.tagName) || el.isContentEditable === true);

// r opens Receive, p Pay and t Transfer (spec §5.7): `onKey(entryType)`. Never while an input, a textarea, a select or anything
// contenteditable has focus (the key is a letter being typed), never with Ctrl, Cmd or Alt held (the browser's own shortcuts), and
// never while a dialog, a menu or a picker's list is open over the page (they carry data-ci-overlay). `enabled` is the page's say.
export function useEntryKeys(onKey, enabled) {
  const latest = useRef(onKey);
  useEffect(() => { latest.current = onKey; }, [onKey]);
  useEffect(() => {
    if (!enabled) return undefined;
    const listen = e => {
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (takesTyping(e.target) || takesTyping(document.activeElement)) return;
      if (document.querySelector('[data-ci-overlay]')) return;
      const entry = ENTRY_OF_KEY.get(String(e.key).toLowerCase());
      if (!entry) return;
      e.preventDefault();
      latest.current(entry);
    };
    window.addEventListener('keydown', listen);
    return () => window.removeEventListener('keydown', listen);
  }, [enabled]);
}

// ── The form ─────────────────────────────────────────────────────────────────────────────────

const WORDS = {
  receive: { title: 'Receive', account: 'Into', other: 'From', otherHint: 'Customers first, then any ledger', reference: 'Reference', saved: 'receipt' },
  pay: { title: 'Pay', account: 'From', other: 'To', otherHint: 'Vendors first, then any ledger', reference: 'Their bill no.', saved: 'payment' },
  transfer: { title: 'Transfer', account: 'From', other: 'To', otherHint: 'Another bank or cash account', reference: 'Reference', saved: 'transfer' },
};

// The server names a field; the form names the box that shows it.
const BOX_OF = Object.freeze({
  voucher_date: 'date', account_ledger_id: 'account', other_ledger_id: 'other', amount_paise: 'amount', tds_paise: 'tds',
  reference: 'reference', narration: 'narration',
});
const BOX_ORDER = ['date', 'account', 'other', 'amount', 'tds', 'reference', 'narration'];
// The boxes that are pickers: a searchable list each (the shared Select), which opens on focus with its first option lit.
const PICKER_BOXES = new Set(['account', 'other']);
// A picker's list closes on a click outside it, and not when focus leaves it by the keyboard: a keyboard move out of a picker closes
// its list as that click would, so no list is left open over the form (where it would also take the form's Esc).
const closeLists = () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

const NO_ANSWER_NOTICE = 'The server did not answer, so this entry may or may not have been saved. Save again: it sends the same entry, which is saved once.';
const STAFF_NOTE = 'Staff advances and salaries are paid in HR';

// A typed amount, read the one way (finToPaiseTyped): { paise, error }. Nothing typed is `blank`.
function readAmount(text, blank = null) {
  if (String(text ?? '').trim() === '') return { paise: blank, error: null };
  try {
    return { paise: finToPaiseTyped(text), error: null };
  } catch (e) {
    return { paise: null, error: e.message };
  }
}

export default function CashEntryForm({ book, entryType, start = {}, ledgers, accounts, unoffered, roles, hrAccess, onClose, onSaved }) {
  const toast = useToast();
  const noAnswer = useNoAnswer();
  const words = WORDS[entryType];

  // What it opens holding: a ledger it is handed is kept only while this entry may name it.
  const [date, setDate] = useState(() => finEntryDate(storage.getItem(DATE_KEY), dayOf(new Date()), book.books_begin));
  const [account, setAccount] = useState(() => (
    finEntryChoices({ entry_type: entryType, ledgers, accounts, unoffered }).accounts.some(l => l.id === start.account_ledger_id)
      ? start.account_ledger_id : null));
  const [other, setOther] = useState(() => (
    finEntryChoices({ entry_type: entryType, ledgers, accounts, unoffered, except: start.account_ledger_id ?? null }).others
      .some(l => l.id === start.other_ledger_id) ? start.other_ledger_id : null));
  const [amountText, setAmountText] = useState(() => finAmountText(start.amount_paise));
  const [tdsText, setTdsText] = useState(() => finAmountText(start.tds_paise));
  const [reference, setReference] = useState(start.reference ?? '');
  const [narration, setNarration] = useState(start.narration ?? '');
  const [choice, setChoice] = useState(null);         // AdjustPanel's { mode, picks, preview, unreadable }
  const [problems, setProblems] = useState({});       // box -> sentence, and `form` for one about the whole entry
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);        // "lose what you typed?" is on screen
  const savingRef = useRef(false);
  const saveKey = useRef(null);
  if (saveKey.current === null) saveKey.current = finNewSaveKey();
  const bodyRef = useRef(null);

  const choices = finEntryChoices({ entry_type: entryType, ledgers, accounts, unoffered, except: account });
  const ledgerById = useMemo(() => new Map((ledgers ?? []).map(l => [l.id, l])), [ledgers]);
  const otherLedger = other != null ? ledgerById.get(other) ?? null : null;
  const party = entryType !== 'transfer' && otherLedger?.is_party === true;
  const tdsSide = entryType === 'receive' ? 'customer' : entryType === 'pay' ? 'vendor' : null;
  const tdsOffered = tdsSide != null && otherLedger?.party_side === tdsSide;
  const tdsRole = entryType === 'receive' ? 'tds_receivable' : 'tds_payable';
  const tdsMissing = tdsOffered && roles != null && !Number.isSafeInteger(roles[tdsRole]);
  const amount = readAmount(amountText);
  const tds = tdsOffered ? readAmount(tdsText, 0) : { paise: 0, error: null };
  const partyAmount = amount.paise != null && tds.paise != null ? amount.paise + tds.paise : 0;
  const tile = (accounts ?? []).find(a => a.ledger_id === account) ?? null;
  const warnings = finEntryWarnings({ entry_type: entryType, account: tile, amount_paise: amount.paise, preview: party ? choice?.preview : null });

  // Whether anything has been typed since the form opened.
  const screen = JSON.stringify([date, account, other, amountText, tdsText, reference, narration, choice?.mode ?? null, choice?.picks ?? []]);
  const opened = useRef(screen);
  const dirty = screen !== opened.current;

  // ── Focus ────────────────────────────────────────────────────────────────────────────────
  const boxEl = box => bodyRef.current?.querySelector(`[data-fin-box="${box}"]`) ?? null;
  const focusEl = el => {
    if (!el) return;
    el.focus();
    if (el.tagName === 'INPUT' && el.type !== 'date' && typeof el.select === 'function') el.select();
  };
  const pending = useRef(null);
  useEffect(() => {
    const box = pending.current;
    if (!box) return;
    pending.current = null;
    focusEl(boxEl(box));
  });
  // It opens on the first box still to fill: the account, then who, then the amount. Once, as it opens.
  const firstBox = useRef(account == null ? 'account' : other == null ? 'other' : 'amount');
  useEffect(() => {
    const timer = setTimeout(() => focusEl(boxEl(firstBox.current)), 0);
    return () => clearTimeout(timer);
  }, []);

  const pickAccount = id => {
    setAccount(id);
    setProblems(p => ({ ...p, account: '' }));
    if (entryType === 'transfer' && id != null && id === other) setOther(null);
    if (id != null) pending.current = other == null || id === other ? 'other' : 'amount';
  };
  const pickOther = id => {
    setOther(id);
    setChoice(null);
    setProblems(p => ({ ...p, other: '', tds: '' }));
    if (id != null) pending.current = 'amount';
  };

  // ── Keys ─────────────────────────────────────────────────────────────────────────────────
  // The picker whose list the arrows have moved in since it was given focus: Enter there is a choice.
  const steered = useRef(null);
  // What a picker shows that was typed: its text, unless that is only the chosen ledger's own name (put back after an Esc).
  const typedIn = (input, box) => {
    const text = input.value.trim();
    return text !== '' && text !== (ledgerById.get(box === 'account' ? account : other)?.name ?? null);
  };
  // To the next box or the one before, in the form's order; past the last box, to the adjustment's first button.
  const move = (from, step) => {
    if (PICKER_BOXES.has(from.getAttribute('data-fin-box'))) closeLists();
    const flow = BOX_ORDER.map(boxEl).filter(el => el && !el.disabled);
    const next = flow[flow.indexOf(from) + step];
    if (next) focusEl(next);
    else if (step > 0) focusEl(bodyRef.current?.querySelector('[data-fin-adjust] button'));
  };
  // The capture phase: these keys reach the form before a picker sees them (finding F1). Ctrl or Cmd with Enter never comes here: it is
  // caught on window first, and saves (useSaveKey, below).
  const onKeyDownCapture = e => {
    const { key, shiftKey } = e;
    const box = e.target.getAttribute?.('data-fin-box') ?? null;
    if (key === 'Tab' && PICKER_BOXES.has(box)) { closeLists(); return; }
    if (key === 'ArrowDown' || key === 'ArrowUp') { if (PICKER_BOXES.has(box)) steered.current = e.target; return; }
    if (key !== 'Enter' || e.nativeEvent?.isComposing) return;
    if (!box || e.target.tagName !== 'INPUT') return;                    // a button's Enter presses it; the adjustment's boxes are its own
    // In a picker, Enter is the picker's once something is typed in it or its list is steered: it chooses, and choosing moves on.
    if (PICKER_BOXES.has(box) && (typedIn(e.target, box) || steered.current === e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    move(e.target, shiftKey ? -1 : 1);
  };
  // Bubbling, Esc: a picker's open list shuts on it, and the dialog's own Esc listener (on window) would close the form under it with
  // the same key press. While a list is open that press is the picker's alone.
  const onKeyDown = e => {
    if (e.key === 'Escape' && document.querySelector('[data-ci-overlay].glass')) e.stopPropagation();
  };

  // ── Saving ───────────────────────────────────────────────────────────────────────────────
  async function save() {
    if (savingRef.current) return;
    const found = {};
    if (!finIsValidDate(date)) found.date = 'Enter the date.';
    if (account == null) found.account = entryType === 'receive' ? 'Choose the account the money comes into.' : 'Choose the account the money goes out of.';
    if (other == null) found.other = entryType === 'transfer' ? 'Choose the account the money goes to.' : entryType === 'receive' ? 'Choose who the money is from.' : 'Choose who the money goes to.';
    if (amount.error) found.amount = amount.error;
    else if (!amount.paise) found.amount = 'Enter the amount.';
    if (tds.error) found.tds = tds.error;
    // An amount typed against a ticked bill that cannot be read stops the save as an amount box's does: it is not a warning.
    if (party && choice?.mode === 'pick' && choice.unreadable) found.adjust = 'An amount typed against a bill cannot be read: fix it, or clear it for all that is open.';
    const firstProblem = BOX_ORDER.find(box => found[box]);
    if (firstProblem || found.adjust) {
      setProblems(found);
      if (firstProblem) focusEl(boxEl(firstProblem));
      return;
    }

    const body = {
      book_id: book.id,
      entry_type: entryType,
      voucher_date: date,
      account_ledger_id: account,
      other_ledger_id: other,
      amount_paise: amount.paise,
      tds_paise: tds.paise,
      reference: reference.trim() || null,
      narration: narration.trim() || null,
      adjust: party && choice?.mode ? { mode: choice.mode, picks: choice.mode === 'pick' ? choice.picks : [] } : null,
      client_key: saveKey.current,
    };
    savingRef.current = true;
    setSaving(true);
    setProblems({});
    setNotice('');
    try {
      const answer = await api.post('/finance/cash/entries', body);
      storage.setItem(DATE_KEY, date);
      const v = answer.voucher;
      const named = v?.number || 'an entry waiting for approval';
      if (answer.replayed) {
        // Ruling R11: a retry answers the entry its key saved, as it stands; when the form had been changed since, it says so.
        toast.info(answer.replay_differs ? `Already saved as ${named}. The changes made since were not saved.` : `Already saved as ${named}.`);
      } else {
        toast.success(v?.status === 'posted' ? `Posted ${v.number}` : `The ${words.saved} waits for approval`);
      }
      onSaved?.(answer, {
        entry_type: entryType, account_ledger_id: account, other_ledger_id: other, amount_paise: body.amount_paise, tds_paise: body.tds_paise,
        reference: body.reference, narration: body.narration,
      });
      onClose();
    } catch (e) {
      noAnswer(e);
      if (!Number.isInteger(e?.status)) setNotice(NO_ANSWER_NOTICE);
      const box = typeof e?.data?.field === 'string' && Object.prototype.hasOwnProperty.call(BOX_OF, e.data.field) ? BOX_OF[e.data.field] : null;
      if (box) { setProblems({ [box]: e.message }); focusEl(boxEl(box)); }
      else if (Number.isInteger(e?.status)) setProblems({ form: e.message });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  // Ctrl or Cmd with Enter saves wherever focus is while the form is open (ruling R72), but not while "Close without saving?" asks.
  useSaveKey(save, !asking);

  const requestClose = () => {
    if (saving || asking) return;
    if (dirty) setAsking(true); else onClose();
  };

  // ── What is drawn ────────────────────────────────────────────────────────────────────────
  const problem = box => (problems[box] ? <span className="mt-1 block text-xs font-medium text-red-600">{problems[box]}</span> : null);
  const ring = box => (problems[box] ? 'border-red-400 ring-2 ring-red-200' : '');
  const footer = (
    <>
      <Button variant="secondary" onClick={requestClose} disabled={saving}>Cancel</Button>
      <Button onClick={save} disabled={saving}>Save <kbd className="ml-1 text-[10px] font-bold opacity-80">Ctrl+Enter</kbd></Button>
    </>
  );

  return (
    <>
      <Modal open wide onClose={requestClose} title={`${words.title} · ${book.code} · ${finDateText(date)}`} footer={footer}>
        <div data-ci-form ref={bodyRef} onKeyDownCapture={onKeyDownCapture} onKeyDown={onKeyDown}
          onFocusCapture={e => { if (steered.current !== e.target) steered.current = null; }}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[11rem_minmax(0,1fr)_minmax(0,1fr)]">
            <Field label="Date" required>
              <Input type="date" value={date} data-fin-box="date" className={ring('date')}
                onChange={e => { setDate(e.target.value); setProblems(p => ({ ...p, date: '' })); }} />
              {problem('date')}
            </Field>
            <Field label={words.account} required>
              <LedgerPicker bookId={book.id} ledgers={ledgers == null ? null : choices.accounts} value={account} manualOnly
                placeholder="Bank or cash account…" data-fin-box="account" onChange={pickAccount} />
              {problem('account')}
            </Field>
            <Field label={words.other} required hint={words.otherHint}>
              <LedgerPicker bookId={book.id} ledgers={ledgers == null ? null : choices.others} value={other} manualOnly
                placeholder={entryType === 'transfer' ? 'Bank or cash account…' : 'Type to search…'} data-fin-box="other" onChange={pickOther} />
              {problem('other')}
            </Field>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Amount ₹" required>
              <Input inputMode="decimal" placeholder="0.00" value={amountText} data-fin-box="amount" className={`text-right tabular-nums ${ring('amount')}`}
                onChange={e => { setAmountText(e.target.value); setProblems(p => ({ ...p, amount: '' })); }}
                onBlur={() => { if (amount.paise) setAmountText(finAmountText(amount.paise)); }} />
              {amount.error ? <span className="mt-1 block text-xs font-medium text-red-600">{amount.error}</span> : problem('amount')}
            </Field>
            {tdsOffered ? (
              <Field label="TDS deducted ₹" hint={tdsMissing ? `Set the TDS ${entryType === 'receive' ? 'receivable' : 'payable'} ledger in Finance Setup → HR & payroll first.` : 'Optional'}>
                <Input inputMode="decimal" placeholder="0.00" value={tdsText} data-fin-box="tds" className={`text-right tabular-nums ${ring('tds')}`}
                  onChange={e => { setTdsText(e.target.value); setProblems(p => ({ ...p, tds: '' })); }}
                  onBlur={() => { if (tds.paise) setTdsText(finAmountText(tds.paise)); }} />
                {tds.error ? <span className="mt-1 block text-xs font-medium text-red-600">{tds.error}</span> : problem('tds')}
              </Field>
            ) : <div className="hidden sm:block" />}
            <Field label={words.reference}>
              <Input value={reference} placeholder={entryType === 'pay' ? 'Their bill number' : 'Cheque, UTR or slip no.'} data-fin-box="reference"
                className={ring('reference')} onChange={e => { setReference(e.target.value); setProblems(p => ({ ...p, reference: '' })); }} />
              {problem('reference')}
            </Field>
          </div>

          <div className="mt-3">
            <Field label="Narration">
              <Input value={narration} data-fin-box="narration" className={ring('narration')}
                onChange={e => { setNarration(e.target.value); setProblems(p => ({ ...p, narration: '' })); }} />
              {problem('narration')}
            </Field>
          </div>

          {entryType === 'pay' && (
            <p className="mt-3 text-sm text-[#515154]">
              {hrAccess ? <Link to="/hr" className="font-semibold text-[#0064D2] hover:underline">{STAFF_NOTE} →</Link> : `${STAFF_NOTE}.`}
            </p>
          )}

          {party && (
            <div className="mt-3" data-fin-adjust>
              <AdjustPanel key={other} ledgerId={other} side={entryType === 'receive' ? 'credit' : 'debit'} amountPaise={partyAmount}
                reference={reference}
                cashDay={finIsValidDate(date) && account != null ? { voucher_date: date, account_ledger_id: account, client_key: saveKey.current } : null}
                onChange={next => { setChoice(next); if (!next.unreadable) setProblems(p => (p.adjust ? { ...p, adjust: '' } : p)); }} />
              {problem('adjust')}
            </div>
          )}
          {party && amount.paise > 0 && tds.paise > 0 && (
            <p className="mt-1 text-xs text-[#86868B]">The bills are settled with {finFormatINR(partyAmount)}: the amount and the TDS together.</p>
          )}

          {warnings.length > 0 && (
            <ul className="mt-3 space-y-1 rounded-xl bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
              {warnings.map(w => (
                <li key={w.code} className="flex items-start gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{w.sentence}</li>
              ))}
              <li className="text-xs font-normal text-amber-700">Warnings never stop an entry.</li>
            </ul>
          )}

          {problems.form && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{problems.form}</p>}
          {notice && <p className="mt-3 rounded-xl bg-[#E1EFFF]/70 px-3 py-2 text-sm font-medium text-[#0064D2]">{notice}</p>}
          <p className="mt-3 text-[11px] text-[#86868B]">
            Enter moves to the next box, Shift+Enter back. Ctrl or Cmd with Enter saves. Esc closes.
          </p>
        </div>
      </Modal>
      <ConfirmDialog open={asking} onClose={() => setAsking(false)} onConfirm={() => { onClose(); }} danger
        title="Close without saving?" message="What you typed in this entry has not been saved, and will be lost." confirmLabel="Close and lose it" />
    </>
  );
}
