// OpeningCorrection: the Opening Balances page's corrections (Cash & Bank spec §9.4, §9.5; plan Task 15). Props:
//   { book, can, read, openingStands }
//
// A wrong figure in the Opening is put right by a correction: a journal dated the Opening's own date, the day before the books begin,
// that changes only what was wrong. Its lines balance, and may be any ledger of the book, the system's own included (the staff ledgers
// and Salary Payable, which the Opening itself holds: H6; the cut-over check of §9.5 is fixed this way), with bill details on a party's
// ledger. It always waits for an Approver, unless an Approver makes it: then it posts at once, self-approved.
//
// `read` is the page's read of GET /finance/opening-corrections?book= (useReport: { data, failed, reload }), { corrections, by_ledger }:
//   Opening + corrections   each ledger a posted correction touched: its line in the Opening, the corrections' net, and the two together
//   Corrections             every correction but a discarded one, oldest first: drafts sent back, those waiting, those posted, and the
//                           reversals of corrections, each opening over the Day Book (/finance?voucher=), where Approve, Reject, Reverse
//                           and the rest are the voucher's own
// Both tables keep the server's order (finUnsorted).
//
// New correction (capability `enter`, and only while the Opening stands: `openingStands`) opens a form: lines picked with LedgerPicker,
// through the voucher form's own line row (LineRow, with the system's ledgers offered), Dr and Cr typed in rupees and read by voucher.js
// (finSetAmount, finSettleAmounts: money.js's finToPaiseTyped), and a narration. POST /finance/opening-corrections { book_id, lines,
// narration, client_key } submits it at once. Posting mints its number, so it is in writeOnce.js MINTING_POSTS (a double press is joined),
// and the save key is made once per opened form, so a second Save after an answer that never came is the same correction, never a
// second one. The server answers a repeated key with the correction the first save made, whatever the second one carried, so after an
// answer that never came (or a 5xx) the lines are locked until Save is pressed again as it was: an edit made in between would be lost
// without a word. A refusal (a 4xx) wrote nothing, so the form opens again, with the server's sentence (api.js toasts it) under the
// line cell it names too, else at the foot; a write with no answer is said (useNoAnswer). One press at a time (ruling R57). Esc or a
// click outside asks first once something is typed.
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../../api.js';
import { Button, ConfirmDialog, DataTable, Field, Modal, Textarea, useToast } from '../ui.jsx';
import { useBookLedgers } from './LedgerPicker.jsx';
import LineRow, { LINE_GRID } from './LineRow.jsx';
import { LoadNotice } from './ReportParts.jsx';
import { Chip, ReadOnlyFact } from './SetupParts.jsx';
import useNoAnswer from './useNoAnswer.js';
import { finFormatINR } from '../../lib/finance/money.js';
import { finCorrectionNote, finOpeningAsAt } from '../../lib/finance/opening.js';
import { finUnsorted } from '../../lib/finance/reports.js';
import { finSetupEmpty } from '../../lib/finance/setup.js';
import {
  finBlankLine, finDateText, finDifference, finFieldTarget, finFormLinesToApi, finIsEmptyLine, finIsNoAnswer, finNewSaveKey, finNumberText,
  finSentRows, finSettleAmounts, finStatusOf,
} from '../../lib/finance/voucher.js';

// A form line is voucher.js' line with a React key of its own and the server's complaints about its cells ({ column: sentence }).
let keySeed = 0;
const withKey = line => ({ key: ++keySeed, server: {}, ...line });

// The server names a column of a line; the line row names the cell that draws it.
const CELL_OF = { ledger_id: 'ledger', debit_paise: 'debit', credit_paise: 'credit', narration: 'narration', bill_ref: 'bill_ref', bill_date: 'bill_date', due_date: 'due_date' };
const COLUMN_OF = Object.fromEntries(Object.entries(CELL_OF).map(([column, cell]) => [cell, column]));

// A voucher's status, in the Setup chips' language.
const STATUS_TONE = { draft: 'neutral', waiting: 'amber', posted: 'good', reversed: 'bad', discarded: 'muted' };

const NO_ANSWER = "We couldn't confirm the correction was saved. Press Save again as it is: if it was saved, you get that same correction back, never a second one.";

// The form of a new correction, opened over the page (exported for the page's smoke render, as AdjustPanel's AdjustDialog is).
export function CorrectionForm({ book, onClose, onSaved, onFailed }) {
  const toast = useToast();
  const noAnswer = useNoAnswer();
  const { ledgers, failed: ledgersFailed, reload: reloadLedgers } = useBookLedgers(book.id);
  const ledgerById = useMemo(() => new Map((ledgers ?? []).map(l => [l.id, l])), [ledgers]);
  const [lines, setLines] = useState(() => [withKey(finBlankLine()), withKey(finBlankLine())]);
  const [narration, setNarration] = useState('');
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  const [unsure, setUnsure] = useState(false);   // a save went out and no answer came: the lines are locked until Save is pressed again
  const savingRef = useRef(false);
  const saveKey = useRef(finNewSaveKey());
  const day = finOpeningAsAt(book.books_begin);

  const difference = finDifference(lines);
  const totalDebit = lines.reduce((sum, line) => sum + line.debit_paise, 0);
  const totalCredit = lines.reduce((sum, line) => sum + line.credit_paise, 0);
  const sent = finSentRows(lines);
  const typed = narration.trim() !== '' || lines.some(line => !finIsEmptyLine(line));

  const edit = (key, cell, change) => setLines(ls => ls.map(l => {
    if (l.key !== key) return l;
    const next = typeof change === 'function' ? change(l) : { ...l, ...change };
    const server = { ...next.server };
    delete server[COLUMN_OF[cell]];
    return { ...next, server };
  }));
  const settleLine = key => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...finSettleAmounts(l) } : l)));
  // bill details belong to a party's ledger; the server refuses them on any other
  const pickLedger = (key, id, ledger) => edit(key, 'ledger', l => ({ ...l, ledger_id: id, ...(ledger?.is_party ? {} : { bill_ref: '', bill_date: '', due_date: '' }) }));
  const removeLine = key => setLines(ls => (ls.length > 1 ? ls.filter(l => l.key !== key) : ls));

  const save = async () => {
    if (savingRef.current) return;
    setProblem('');
    // Every cell is read again from its text: one that cannot be read stops the save, under itself.
    const settled = lines.map(line => ({ ...line, ...finSettleAmounts(line), server: {} }));
    setLines(settled);
    if (settled.some(line => line.debit_error || line.credit_error)) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const { voucher } = await api.post('/finance/opening-corrections', { book_id: book.id, lines: finFormLinesToApi(settled), narration: narration.trim() || null, client_key: saveKey.current });
      toast.success(voucher.status === 'posted' ? `Correction posted as ${voucher.number}` : 'Correction sent to an Approver');
      await onSaved(voucher);
    } catch (e) {
      noAnswer(e);
      // A refusal (a 4xx) wrote nothing; no answer, or a 5xx, may have: the same lines go again, or nothing does.
      const refused = !finIsNoAnswer(e) && e.status >= 400 && e.status < 500;
      setUnsure(!refused);
      // The server's sentence is in the toast; under the cell it names as well, or at the foot.
      const target = finFieldTarget(e?.data?.field, finSentRows(settled));
      if (refused && target?.row != null) {
        const row = settled[target.row];
        const column = target.column && CELL_OF[target.column] ? target.column : 'ledger_id';
        setLines(ls => ls.map(l => (l.key === row.key ? { ...l, server: { ...l.server, [column]: e.message } } : l)));
      } else {
        setProblem(refused ? e?.message ?? '' : NO_ANSWER);
      }
      await onFailed?.();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // After a save with no answer there may be nothing to lose: the list says whether it was saved.
  const requestClose = () => {
    if (saving || asking) return;
    if (typed && !unsure) setAsking(true); else onClose();
  };
  // Esc shuts a picker's open list, and the dialog's own Esc listener would close the form under it with the same press.
  const onKeyDown = e => {
    if (e.key === 'Escape' && document.querySelector('[data-ci-overlay].glass')) e.stopPropagation();
  };

  const balanced = difference === 0;
  const footer = (
    <>
      <span aria-live="polite" className={`mr-auto self-center text-sm font-semibold tabular-nums ${balanced ? 'text-emerald-600' : 'text-red-600'}`}>
        Difference {finFormatINR(difference, { drcr: true })}
      </span>
      <Button variant="secondary" onClick={requestClose} disabled={saving}>Cancel</Button>
      <Button onClick={save} disabled={saving}>Save</Button>
    </>
  );

  return (
    <>
      <Modal open wide onClose={requestClose} title={`New opening correction · ${book.name}`} footer={footer}>
        <div data-ci-form onKeyDown={onKeyDown}>
          <div className="mb-3 grid gap-3 sm:grid-cols-2">
            <ReadOnlyFact label="Date">{`${finDateText(day)}, the Opening's own date`}</ReadOnlyFact>
            <ReadOnlyFact label="Approval">{finCorrectionNote(book.roles)}</ReadOnlyFact>
          </div>
          <p className="mb-3 text-xs text-slate-500">
            Change only the figures that were wrong: the lines must balance. Any ledger may be used, the staff ledgers too, and a party&apos;s
            line can carry its bill.
          </p>
          {ledgersFailed && (
            <p className="mb-3 flex items-center gap-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
              The ledgers didn&apos;t load, so none can be picked.
              <button type="button" onClick={reloadLedgers} className="font-semibold underline">Try again</button>
            </p>
          )}

          <fieldset disabled={unsure} className="m-0 min-w-0 border-0 p-0">
          <div className={`${LINE_GRID} px-0.5 pb-1 text-[11px] font-bold uppercase tracking-wide text-[#86868B]`}>
            <span className="text-right">#</span>
            <span>Ledger</span>
            <span className="text-right">Debit ₹</span>
            <span className="text-right">Credit ₹</span>
            <span />
          </div>
          <div className="divide-y divide-[#1D1D1F]/[0.06]">
            {lines.map((line, i) => {
              const number = sent.indexOf(i) + 1;
              return (
                <LineRow key={line.key} line={line} label={number || i + 1} number={number} ledger={ledgerById.get(line.ledger_id)}
                  ledgers={ledgers} bookId={book.id} canRemove={lines.length > 1} manualOnly={false}
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
              <Button variant="ghost" size="sm" onClick={() => setLines(ls => [...ls, withKey(finBlankLine())])}><Plus size={14} /> Add line</Button>
              <span className="text-xs font-semibold uppercase tracking-wide text-[#86868B]">Total</span>
            </span>
            <span className="px-3 text-right">{finFormatINR(totalDebit)}</span>
            <span className="px-3 text-right">{finFormatINR(totalCredit)}</span>
            <span />
          </div>

          <Field label="Narration" className="mt-4">
            <Textarea value={narration} rows={2} maxLength={2000} placeholder="What was wrong in the Opening"
              onChange={e => setNarration(e.target.value)} />
          </Field>
          </fieldset>
          {problem && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700" role="alert">{problem}</p>}
        </div>
      </Modal>
      <ConfirmDialog open={asking} onClose={() => setAsking(false)} onConfirm={() => { onClose(); }} danger
        title="Close without saving?" message="What you typed in this correction has not been saved, and will be lost." confirmLabel="Close and lose it" />
    </>
  );
}

export default function OpeningCorrection({ book, can, read, openingStands }) {
  const navigate = useNavigate();
  const { data, failed, reload } = read;
  const [open, setOpen] = useState(false);
  const mayEnter = can('enter');
  const known = Boolean(data);
  const day = finOpeningAsAt(book.books_begin);

  const ledgerColumns = finUnsorted([
    { key: 'name', label: 'Ledger', card: 'title', render: r => <span className="font-semibold">{r.name}</span> },
    { key: 'opening_paise', label: 'Opening', align: 'right', card: 'metric', render: r => finFormatINR(r.opening_paise, { drcr: true }) },
    { key: 'corrections_paise', label: 'Corrections', align: 'right', card: 'metric', render: r => finFormatINR(r.corrections_paise, { drcr: true }) },
    { key: 'total_paise', label: 'Opening + corrections', align: 'right', card: 'metric',
      render: r => <span className="font-semibold">{finFormatINR(r.total_paise, { drcr: true })}</span> },
  ]);

  const fixColumns = finUnsorted([
    { key: 'number', label: 'Number', card: 'title', render: r => <span className="whitespace-nowrap font-semibold">{finNumberText(r)}</span> },
    { key: 'status', label: 'Status', card: 'status', render: r => {
      const status = finStatusOf(r);
      return <Chip tone={STATUS_TONE[status.key] ?? 'neutral'}>{status.label}</Chip>;
    } },
    { key: 'narration', label: 'Narration', card: 'subtitle', render: r => (
      <span className="block max-w-[26rem] break-words">
        {r.narration || <span className="text-gray-300">—</span>}
        {r.reversal_of_id != null && <span className="block text-xs text-slate-500">The reversal of a correction</span>}
      </span>
    ) },
    { key: 'total_paise', label: 'Amount', align: 'right', card: 'metric', render: r => finFormatINR(r.total_paise) },
  ]);

  const saved = async () => { setOpen(false); await reload(); };

  return (
    <section className="mt-8 max-w-5xl">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-extrabold tracking-[-0.02em] text-[#1D1D1F]">Opening corrections</h2>
          <p className="max-w-3xl text-xs text-slate-500">
            A correction puts right a figure that was wrong in the Opening: a journal dated {finDateText(day)}, the Opening&apos;s own date,
            changing only what was wrong. Opening corrections always need an Approver.
          </p>
        </div>
        {mayEnter && <Button onClick={() => setOpen(true)} disabled={!openingStands}><Plus size={14} /> New correction</Button>}
      </div>
      {mayEnter && !openingStands && (
        <p className="mb-3 text-xs text-slate-500">A correction can be made once the Opening voucher has posted.</p>
      )}

      <LoadNotice failed={failed} shown={known} what="the opening corrections" onRetry={reload} />

      <h3 className="mb-1 mt-4 text-xs font-bold uppercase tracking-[0.14em] text-[#86868B]">Opening + corrections</h3>
      <DataTable rows={data?.by_ledger ?? []} columns={ledgerColumns} getRowId={r => r.ledger_id} serialNumber={false}
        empty={finSetupEmpty({ known, failed, none: 'No posted correction has changed a ledger yet.' })} />

      <h3 className="mb-1 mt-5 text-xs font-bold uppercase tracking-[0.14em] text-[#86868B]">Corrections</h3>
      <DataTable rows={data?.corrections ?? []} columns={fixColumns} getRowId={r => r.id} serialNumber={false}
        onRowClick={r => navigate(`/finance?voucher=${r.id}`)}
        empty={finSetupEmpty({ known, failed, none: 'There are no opening corrections.' })} />

      {open && <CorrectionForm book={book} onClose={() => setOpen(false)} onSaved={saved} onFailed={reload} />}
    </section>
  );
}
