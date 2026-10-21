// VoucherForm: type a voucher, or edit a draft (spec §10). It opens inside the shared Modal.
//
//   <VoucherForm book={book} type="journal" onClose={...} onSaved={voucher => ...} />          a new voucher
//   <VoucherForm book={book} type={v.voucher_type} voucher={{ ...v, lines }} ... />            a draft being edited
//
// `voucher` is the voucher view's voucher with its `lines` beside it. The form has two ways out, and both save a DRAFT first:
//   Keep as draft   the draft is made (POST /finance/vouchers) or edited (PUT /finance/vouchers/:id); it waits in Drafts.
//   Save            the same, then POST /finance/vouchers/:id/submit: it posts at once, or goes to an Approver, as the book's
//                   rules say. The server's refusal of the submit (it does not balance, a journal on a bank ledger, a locked
//                   month) leaves the draft saved and the form open, with the server's sentence in the toast; the next
//                   Save edits that same draft and tries again.
//
// WHICH writes a save makes, and in what order, is voucher.js' (finRunSave, ruling R55); this form supplies the sending. The save key
// (client_key) is made once per opened form and rides on every POST of it, never on a PUT. The server answers a repeat of a key with
// the draft the first POST made, edits unapplied, so when a POST has gone out and its answer never came, the next save POSTs again
// only to learn the draft's id and then PUTs what is on screen to it, before anything is submitted or reported kept.
//
// A refusal is a 4xx with { code, error, field }: api.js has already put the sentence in the toast, and the form stays open. When
// `field` names a cell it is shown under that cell as well (the server counts the lines it was SENT, so the form maps the
// numbers back through finSentRows). A write that got no answer at all is said by useNoAnswer, and the notice at the foot of the form
// says it MAY have gone through and points to the Day Book: never "not submitted" for a submit whose answer was merely lost.
// Dr and Cr are typed as text and read on every keystroke, tidied and checked when the cell is left (voucher.js); a cell that cannot
// be read stops the save and says why under itself.
//
// Keyboard (finVoucherKey): Enter moves to the next field and Shift+Enter to the one before; Enter on the last field of the last
// line while the voucher does not balance adds a line already holding what balances it; Ctrl or Cmd with Enter saves. Enter on
// the ledger picker with its list open chooses (the picker takes that key itself), and the form moves on to the amount.
//
// Esc or a click outside asks first when something has been typed: a Select inside a dialog lets its Esc through to the dialog,
// and a voucher half keyed in is not worth losing to a stray key.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../../api.js';
import { Button, ConfirmDialog, Field, Input, Modal, Textarea, useToast } from '../ui.jsx';
import { dayOf } from '../../lib/dayOf.js';
import { storage } from '../../lib/safeStorage.js';
import { finFormatINR } from '../../lib/finance/money.js';
import {
  finAmountText, finBalancingLine, finBlankLine, finDifference, finDraftBody, finFieldTarget, finLineFromApi, finNewSaveKey, finPickDate,
  finRunSave, finSaveNotice, finSentRows, finSettleAmounts, finTypeLabel, finVoucherKey,
} from '../../lib/finance/voucher.js';
import { useBookLedgers } from './LedgerPicker.jsx';
import LineRow, { LINE_GRID, cellProblem, redRing } from './LineRow.jsx';
import useNoAnswer from './useNoAnswer.js';

// The date a person last saved a voucher on is kept, so a day's vouchers do not each start at today.
const LAST_DATE = 'fin_last_date';

// A form line is voucher.js' line with a React key of its own and the server's complaints about its cells ({ column: sentence }).
let keySeed = 0;
const withKey = line => ({ key: ++keySeed, server: {}, ...line });
const startLines = voucher => {
  const lines = (voucher?.lines ?? []).map(line => withKey(finLineFromApi(line)));
  while (lines.length < 2) lines.push(withKey(finBlankLine()));
  return lines;
};

// What the screen holds, as one string: how the form tells whether anything has been typed since the server last took it.
const screenKey = ({ date, narration, reference, lines }) => JSON.stringify([date, narration, reference,
  lines.map(l => [l.ledger_id, l.debit_text, l.credit_text, l.narration, l.bill_ref, l.bill_date, l.due_date])]);

// The server names a column of a line; the form names the cell that draws it.
const CELL_OF = { ledger_id: 'ledger', debit_paise: 'debit', credit_paise: 'credit', narration: 'narration', bill_ref: 'bill_ref', bill_date: 'bill_date', due_date: 'due_date' };
const COLUMN_OF = Object.fromEntries(Object.entries(CELL_OF).map(([column, cell]) => [cell, column]));

export default function VoucherForm({ book, type, voucher, onClose, onSaved }) {
  const toast = useToast();
  const noAnswer = useNoAnswer();
  const editing = Boolean(voucher);
  const { ledgers, failed: ledgersFailed, reload: reloadLedgers } = useBookLedgers(book.id);
  const ledgerById = useMemo(() => new Map((ledgers ?? []).map(l => [l.id, l])), [ledgers]);

  const [date, setDate] = useState(() => (editing ? voucher.voucher_date : finPickDate(storage.getItem(LAST_DATE), dayOf(new Date()))));
  const [narration, setNarration] = useState(voucher?.narration ?? '');
  const [reference, setReference] = useState(voucher?.reference ?? '');
  const [lines, setLines] = useState(() => startLines(voucher));
  const [problems, setProblems] = useState({});          // the server's complaints about the voucher's own fields
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);           // "lose what you typed?" is on screen

  const savingRef = useRef(false);
  const saveKey = useRef(null);
  if (saveKey.current === null) saveKey.current = finNewSaveKey();
  // What the form knows of the server's side: the draft it holds for this form, and whether a POST of this form's key is out there.
  const writes = useRef({ savedId: voucher?.id ?? null, keySent: false });
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const bodyRef = useRef(null);
  const pendingFocus = useRef({ cell: 'date' });     // the form opens on its date

  const difference = finDifference(lines);
  const totalDebit = lines.reduce((sum, line) => sum + line.debit_paise, 0);
  const totalCredit = lines.reduce((sum, line) => sum + line.credit_paise, 0);
  const sent = finSentRows(lines);

  // Whether anything has been typed since the form opened, or since the last time the server took what is on screen.
  const cleanAs = useRef(null);
  if (cleanAs.current === null) cleanAs.current = screenKey({ date, narration, reference, lines });
  const dirty = screenKey({ date, narration, reference, lines }) !== cleanAs.current;

  // ── Focus ────────────────────────────────────────────────────────────────────────────────
  const flowFields = () => Array.from(bodyRef.current?.querySelectorAll('[data-fin-field]') ?? []).filter(el => !el.disabled);
  const focusEl = el => {
    if (!el) return;
    el.focus();
    if (el.tagName === 'INPUT' && el.type !== 'date' && typeof el.select === 'function') el.select();
  };
  const focusCell = (key, cell) => focusEl(bodyRef.current?.querySelector(`[data-fin-line="${key}"][data-fin-cell="${cell}"]`));
  // A cell is asked for in an event handler and focused once the render that follows has drawn it.
  useEffect(() => {
    const wanted = pendingFocus.current;
    if (!wanted) return;
    pendingFocus.current = null;
    if (wanted.cell === 'date') focusEl(bodyRef.current?.querySelector('[data-fin-cell="date"]'));
    else focusCell(wanted.key, wanted.cell);
  });

  // ── Editing lines ────────────────────────────────────────────────────────────────────────
  const edit = (key, cell, change) => setLines(ls => ls.map(l => {
    if (l.key !== key) return l;
    const next = typeof change === 'function' ? change(l) : { ...l, ...change };
    // what the server said about this cell is out of date the moment it is edited
    const server = { ...next.server };
    delete server[COLUMN_OF[cell]];
    return { ...next, server };
  }));
  // Leaving an amount cell tidies its text or marks it unreadable. It says nothing new about what the SERVER said of the cell.
  const settleLine = key => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...finSettleAmounts(l) } : l)));
  const pickLedger = (key, id, ledger) => {
    edit(key, 'ledger', l => ({
      ...l, ledger_id: id,
      // bill details belong to a party's ledger; the server refuses them on any other
      ...(ledger?.is_party ? {} : { bill_ref: '', bill_date: '', due_date: '' }),
    }));
    if (id != null) {
      const line = linesRef.current.find(l => l.key === key);
      pendingFocus.current = { key, cell: line?.credit_paise > 0 ? 'credit' : 'debit' };
    }
  };
  const addLine = balanced => {
    const row = withKey(finBlankLine());
    const fill = balanced ? finBalancingLine(linesRef.current) : null;
    if (fill) {
      Object.assign(row, {
        debit_paise: fill.debit_paise, credit_paise: fill.credit_paise,
        debit_text: finAmountText(fill.debit_paise), credit_text: finAmountText(fill.credit_paise),
      });
    }
    pendingFocus.current = { key: row.key, cell: 'ledger' };
    setLines(ls => [...ls, row]);
  };
  const removeLine = key => setLines(ls => (ls.length > 1 ? ls.filter(l => l.key !== key) : ls));

  // ── Keys ─────────────────────────────────────────────────────────────────────────────────
  const onKeyDown = e => {
    if (e.key === 'Escape') {
      // Esc shuts a picker's open list, and the dialog's own Esc listener (on window) would close the voucher under it with the
      // same key press. While a list is open that press is the picker's alone.
      if (document.querySelector('[data-ci-overlay].glass')) e.stopPropagation();
      return;
    }
    if (e.defaultPrevented || e.nativeEvent?.isComposing) return;     // the picker took this Enter to choose a ledger
    const fields = flowFields();
    const lineFields = fields.filter(el => el.hasAttribute('data-fin-line'));
    const action = finVoucherKey(e, {
      atLastField: lineFields.length > 0 && lineFields[lineFields.length - 1] === e.target, difference,
    });
    if (!action) return;
    if (action === 'save') { e.preventDefault(); save(true); return; }
    const at = fields.indexOf(e.target);
    if (at < 0 || e.target.tagName === 'TEXTAREA') return;            // Enter in the narration is a new line
    e.preventDefault();
    if (action === 'add-line') addLine(true);
    else focusEl(fields[at + (action === 'next' ? 1 : -1)]);
  };

  // ── Saving ───────────────────────────────────────────────────────────────────────────────
  // The server's sentence is in the toast already. Where it names a cell, the cell shows it too.
  const explain = (e, sentRows, settled) => {
    const target = finFieldTarget(e?.data?.field, sentRows);
    if (!target) return;
    if (target.name) { setProblems(p => ({ ...p, [target.name]: e.message })); return; }
    const row = settled[target.row];
    const column = target.column && CELL_OF[target.column] ? target.column : 'ledger_id';
    setLines(ls => ls.map(l => (l.key === row.key ? { ...l, server: { ...l.server, [column]: e.message } } : l)));
    pendingFocus.current = { key: row.key, cell: CELL_OF[column] };
  };

  async function save(thenSubmit) {
    if (savingRef.current) return;
    setProblems({});
    setNotice('');
    // Every cell is read again from its text: a figure typed a moment ago has not been left yet, and one that cannot be read
    // must stop the save here, under its own cell, rather than go as nothing. What the server said about a cell last time is no
    // longer true of this attempt; it will say again if it is.
    const settled = lines.map(line => ({ ...line, ...finSettleAmounts(line), server: {} }));
    setLines(settled);
    const bad = settled.find(line => line.debit_error || line.credit_error);
    if (bad) { pendingFocus.current = { key: bad.key, cell: bad.debit_error ? 'debit' : 'credit' }; return; }

    savingRef.current = true;
    setSaving(true);
    const sentRows = finSentRows(settled);
    const screen = { date, narration, reference, lines: settled };
    try {
      const run = await finRunSave({
        state: writes.current,
        thenSubmit,
        send: async (step, known) => {
          if (step === 'submit') return (await api.post(`/finance/vouchers/${known.savedId}/submit`)).voucher;
          const draft = step === 'post'
            ? (await api.post('/finance/vouchers', finDraftBody(screen, { bookId: book.id, type, clientKey: saveKey.current }))).voucher
            : (await api.put(`/finance/vouchers/${known.savedId}`, finDraftBody(screen))).voucher;
          // The server now holds what is on screen: after a PUT, or after the POST that made the draft. A POST that only replayed an
          // earlier one handed back THAT draft, and the PUT after it is what puts the screen into it.
          if (step === 'put' || !known.keySent) {
            storage.setItem(LAST_DATE, date);
            cleanAs.current = screenKey(screen);
          }
          return draft;
        },
      });
      writes.current = run.state;
      if (run.ok) {
        toast.success(!thenSubmit ? 'Draft kept' : run.voucher.status === 'posted' ? `Posted ${run.voucher.number}` : 'Sent for approval');
        onSaved?.(run.voucher);
        onClose();
        return;
      }
      noAnswer(run.error);
      setNotice(finSaveNotice({ step: run.step, error: run.error, state: run.state }));
      explain(run.error, sentRows, settled);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const requestClose = () => {
    if (asking || saving) return;
    if (dirty) setAsking(true); else onClose();
  };

  // ── What is drawn ────────────────────────────────────────────────────────────────────────
  const title = `${editing ? 'Edit draft' : 'New'} ${finTypeLabel(type)} voucher · ${book.name}`;
  const balanced = difference === 0;
  const footer = (
    <>
      <span aria-live="polite" title={balanced ? 'Debits and credits agree' : difference > 0 ? 'Debits are ahead of credits' : 'Credits are ahead of debits'}
        className={`mr-auto self-center text-sm font-semibold tabular-nums ${balanced ? 'text-emerald-600' : 'text-red-600'}`}>
        Difference {finFormatINR(difference, { drcr: true })}
      </span>
      <Button variant="secondary" onClick={requestClose} disabled={saving}>Cancel</Button>
      <Button variant="secondary" onClick={() => save(false)} disabled={saving}>Keep as draft</Button>
      <Button onClick={() => save(true)} disabled={saving}>Save</Button>
    </>
  );

  return (
    <>
      <Modal open wide onClose={requestClose} title={title} footer={footer}>
        <div data-ci-form ref={bodyRef} onKeyDown={onKeyDown}>
          {voucher?.last_reject_reason && (
            <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Sent back{voucher.last_rejected_by ? ` by ${voucher.last_rejected_by}` : ''}: {voucher.last_reject_reason}
            </p>
          )}
          {ledgersFailed && (
            <p className="mb-3 flex items-center gap-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
              The ledgers didn't load, so none can be picked.
              <button type="button" onClick={reloadLedgers} className="font-semibold underline">Try again</button>
            </p>
          )}

          <div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
              <Field label="Date" required>
                <Input type="date" value={date} data-fin-field="date" data-fin-cell="date" aria-invalid={Boolean(problems.voucher_date)}
                  className={redRing(problems.voucher_date)}
                  onChange={e => { setDate(e.target.value); setProblems(p => ({ ...p, voucher_date: '' })); }} />
                {problems.voucher_date && cellProblem(problems.voucher_date)}
              </Field>
            </div>

            {/* The lines. Rows are numbered the way the server counts them (blank rows are not lines), so "Line 2 needs a
                ledger" in a toast is the second NUMBERED row. */}
            <div className="mt-4">
              <div className={`${LINE_GRID} px-0.5 pb-1 text-[11px] font-bold uppercase tracking-wide text-[#86868B]`}>
                <span className="text-right">#</span>
                <span>Ledger</span>
                <span className="text-right">Debit ₹</span>
                <span className="text-right">Credit ₹</span>
                <span />
              </div>
              {problems.lines && <p className="mb-1 text-xs text-red-600">{problems.lines}</p>}

              <div className="divide-y divide-[#1D1D1F]/[0.06]">
                {lines.map((line, i) => {
                  const number = sent.indexOf(i) + 1;
                  return (
                    <LineRow key={line.key} line={line} label={number || i + 1} number={number} ledger={ledgerById.get(line.ledger_id)}
                      ledgers={ledgers} bookId={book.id} canRemove={lines.length > 1}
                      onPick={(id, picked) => pickLedger(line.key, id, picked)}
                      onEdit={(cell, change) => edit(line.key, cell, change)}
                      onSettle={() => settleLine(line.key)}
                      onRemove={() => removeLine(line.key)} />
                  );
                })}
              </div>

              <div className={`${LINE_GRID} border-t border-[#1D1D1F]/[0.10] pt-2 text-sm font-bold tabular-nums`}>
                <span />
                <span className="flex items-center justify-between gap-2">
                  <Button variant="ghost" size="sm" onClick={() => addLine(false)}><Plus size={14} /> Add line</Button>
                  <span className="text-xs font-semibold uppercase tracking-wide text-[#86868B]">Total</span>
                </span>
                <span className="px-3 text-right">{finFormatINR(totalDebit)}</span>
                <span className="px-3 text-right">{finFormatINR(totalCredit)}</span>
                <span />
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
              <Field label="Narration">
                <Textarea value={narration} data-fin-field="narration" data-fin-cell="narration" rows={2}
                  className={redRing(problems.narration)}
                  onChange={e => { setNarration(e.target.value); setProblems(p => ({ ...p, narration: '' })); }} />
                {problems.narration && cellProblem(problems.narration)}
              </Field>
              <Field label="Reference">
                <Input value={reference} placeholder="Cheque or UTR no." data-fin-field="reference" data-fin-cell="reference"
                  className={redRing(problems.reference)}
                  onChange={e => { setReference(e.target.value); setProblems(p => ({ ...p, reference: '' })); }} />
                {problems.reference && cellProblem(problems.reference)}
              </Field>
            </div>
          </div>

          {notice && <p className="mt-3 rounded-xl bg-[#E1EFFF]/70 px-3 py-2 text-sm font-medium text-[#0064D2]">{notice}</p>}
          <p className="mt-3 text-[11px] text-[#86868B]">
            Enter moves to the next field, Shift+Enter back. Enter on the last field of an unbalanced voucher adds the line that balances it. Ctrl or Cmd with Enter saves.
          </p>
        </div>
      </Modal>
      <ConfirmDialog open={asking} onClose={() => setAsking(false)} onConfirm={() => { onClose(); }} danger
        title="Close without saving?" message="What you typed in this voucher has not been saved, and will be lost." confirmLabel="Close and lose it" />
    </>
  );
}
