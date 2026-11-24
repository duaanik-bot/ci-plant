// AdjustPanel: which of a party's bills a receipt or payment settles (Cash & Bank spec §5.1, §6.3, §6.4, §6.5, §6.7).
//
//   <AdjustPanel ledgerId={party} side="credit" amountPaise={amount + tds} reference={ref} onChange={choice => ...} />   new money
//   <AdjustPanel ledgerId={party} lineId={line} scope="line" onChange={choice => ...} />                              a redo
//   <AdjustPanel ledgerId={party} lineId={line} scope="open" onChange={choice => ...} />                              an adjust
//
// It asks every time: [Auto – oldest first] [I'll pick]. Neither is chosen when it opens (its state starts null), and Auto comes first,
// in the tab order too. Both are buttons, so the choice is made from the keyboard as well (Tab, then Enter or Space).
//   • Auto settles the open bills oldest first until the money runs out (§6.3); the last may be part-settled.
//   • I'll pick lists the open bills, oldest first, a bill whose reference matches the typed one at the top (§6.4). Ticking one gives
//     it all that is open of it, until the money runs out; its amount can be typed over; unticking releases it. The ticks keep their
//     order (finTogglePick, finPickAmount).
// Before anything is saved it shows the preview, POST /finance/allocations/preview: what each bill gets, what is left of it, and what
// stays on account. With no bill open it reads "Nothing open". The preview is the server's, asked again (after a short pause) whenever
// the amount, the choice or the ticks change, and the newest answer is the one shown (newestAnswerGate). What is SAVED is the server's
// too: the entry sends only the choice ({ mode, picks }), which the posting works out again against the bills open then.
//
// `onChange({ mode, picks, preview, unreadable })` hands the form the choice, the latest preview (its on_account_paise feeds the
// warnings), and whether an amount typed against a bill cannot be read (the form does not save while it cannot).
// With `lineId` the panel previews a redo of that posted line (the preview's line_id): the server takes the side and the money from the
// line itself. `scope` says which redo (ruling R71): 'line', a Redo from the book, works all of the line again and counts the bills the
// line settles now as open again, since it releases them first ("₹81,600 to adjust again"); 'open', an Adjust from the money on
// account, keeps them and spends only what the line still holds on account ("₹11,600 on account to adjust").
//
// `cashDay` ({ voucher_date, account_ledger_id, client_key }, or null) is the entry's day and account, for the form's cash warnings: with
// it, the preview also answers the party's cash that day (party_cash_day_paise, ruling R59), which the form adds this entry to.
//
// Beside the choice it shows the party's standing (spec §6.7, ruling R58): what is outstanding on its bills and the money it already
// holds on account, from GET /finance/ledgers/:id/open-items, read once for the party the panel is for.
//
// AdjustDialog (below) is the panel in a dialog of its own, for Redo on a book row and Adjust on the unadjusted money: it saves through
// PUT /finance/lines/:id/allocations with the scope it was opened with, which changes no balance, needs no approval, and works in a
// month of any status (§6.5).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Button, Input, Modal, useToast } from '../ui.jsx';
import useNoAnswer from './useNoAnswer.js';
import useSaveKey from './useSaveKey.js';
import { newestAnswerGate } from '../../lib/newestAnswer.js';
import { finFormatINR, finToPaiseTyped } from '../../lib/finance/money.js';
import { finDateText } from '../../lib/finance/voucher.js';
import { finAdjustRows, finAdjustedText, finPickAmount, finTogglePick } from '../../lib/finance/cash.js';

const PREVIEW_PAUSE_MS = 250;

// What a bill gets, as the preview says it beside the bill.
function getsText(row) {
  if (row.settles === 'all') return `${finFormatINR(row.gets_paise)} settled`;
  if (row.settles === 'part') return `${finFormatINR(row.gets_paise)} part · ${finFormatINR(row.left_paise)} left`;
  return '';
}

export default function AdjustPanel({ ledgerId, side = null, amountPaise = 0, reference = '', lineId = null, scope = 'line', cashDay = null, onChange }) {
  const noAnswer = useNoAnswer();
  const [mode, setMode] = useState(null);
  const [picks, setPicks] = useState([]);
  const [typed, setTyped] = useState({});          // line_id -> { text, error } of an amount being typed over a tick
  const [preview, setPreview] = useState(null);    // the newest answer, for what is on screen now
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [standing, setStanding] = useState(null);  // the party's outstanding and money on account (ruling R58)

  const gate = useRef(null);
  if (!gate.current) gate.current = newestAnswerGate();
  const latest = useRef(0);
  // Held in refs, so a new function from a parent's render (or a toast coming and going) never asks for the preview again.
  const told = useRef(onChange);
  useEffect(() => { told.current = onChange; }, [onChange]);
  const sayNoAnswer = useRef(noAnswer);
  useEffect(() => { sayNoAnswer.current = noAnswer; }, [noAnswer]);

  const money = Number.isSafeInteger(amountPaise) && amountPaise >= 0 ? amountPaise : 0;
  const ref = typeof reference === 'string' ? reference.trim() : '';
  // The body of the preview, as text, so the effect below asks again only when it would ask something else.
  const body = JSON.stringify(lineId != null
    ? { ledger_id: ledgerId, line_id: lineId, scope, mode, picks, reference: ref || null }
    : { ledger_id: ledgerId, side, amount_paise: money, mode, picks, reference: ref || null, ...(cashDay ?? {}) });

  // The party's standing, once for this party. A read that fails shows nothing: the preview still says what this entry settles.
  useEffect(() => {
    let live = true;
    setStanding(null);
    api.get(`/finance/ledgers/${ledgerId}/open-items`)
      .then(answer => { if (live) setStanding({ outstanding_paise: answer.outstanding_paise, on_account_paise: answer.on_account_paise }); })
      .catch(() => {});
    return () => { live = false; };
  }, [ledgerId]);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      const seq = gate.current.begin();
      latest.current = seq;
      setBusy(true);
      try {
        const answer = await api.post('/finance/allocations/preview', JSON.parse(body));
        if (!live || !gate.current.accept(seq)) return;
        setPreview(answer);
        setFailed(false);
      } catch (e) {
        if (live && seq === latest.current) { sayNoAnswer.current(e); setFailed(true); }
      } finally {
        if (live && seq === latest.current) setBusy(false);
      }
    }, PREVIEW_PAUSE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [body, attempt]);

  // `unreadable`: an amount typed against a ticked bill cannot be read, so the tick still holds what it held before; a form does not
  // save while it is so (the amount box's own rule), and says why.
  const unreadable = picks.some(p => typed[p.line_id]?.error);
  useEffect(() => { told.current?.({ mode, picks, preview, unreadable }); }, [mode, picks, preview, unreadable]);

  const choose = next => {
    setMode(next);
    if (next !== 'pick') { setPicks([]); setTyped({}); }
  };
  const tick = lineIdOf => {
    setPicks(list => finTogglePick(list, lineIdOf));
    setTyped(t => { const next = { ...t }; delete next[lineIdOf]; return next; });
  };
  // An amount typed over a tick is read as it is typed, never as a float: finToPaiseTyped, or its sentence under the box. Cleared, the
  // tick takes all that is open again. Read at once, so a save pressed straight after typing sends what was typed.
  const typeAmount = (lineIdOf, text) => {
    if (text.trim() === '') {
      setPicks(list => finPickAmount(list, lineIdOf, null));
      setTyped(t => ({ ...t, [lineIdOf]: { text, error: null } }));
      return;
    }
    try {
      const paise = finToPaiseTyped(text);
      if (paise <= 0) throw new Error('Enter an amount above nothing, or clear it for all that is open');
      setPicks(list => finPickAmount(list, lineIdOf, paise));
      setTyped(t => ({ ...t, [lineIdOf]: { text, error: null } }));
    } catch (e) {
      setTyped(t => ({ ...t, [lineIdOf]: { text, error: e.message } }));
    }
  };

  const rows = finAdjustRows(preview?.items, preview?.allocations);
  const picked = new Set(picks.map(p => p.line_id));
  const amount = lineId != null ? preview?.amount_paise : money;

  return (
    <div className="rounded-2xl border border-[#1D1D1F]/[0.08] bg-white/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-[#1D1D1F]">Adjust against bills:</span>
        <Button size="sm" variant={mode === 'auto' ? 'primary' : 'secondary'} aria-pressed={mode === 'auto'} onClick={() => choose('auto')}>
          Auto – oldest first
        </Button>
        <Button size="sm" variant={mode === 'pick' ? 'primary' : 'secondary'} aria-pressed={mode === 'pick'} onClick={() => choose('pick')}>
          I'll pick
        </Button>
        {busy && <span className="text-xs text-[#86868B]">checking…</span>}
        <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[#6E6E73]">
          {standing && Number.isSafeInteger(standing.outstanding_paise) && (
            <span>Outstanding <span className="font-semibold tabular-nums text-[#1D1D1F]">{finFormatINR(standing.outstanding_paise)}</span></span>
          )}
          {standing && Number.isSafeInteger(standing.on_account_paise) && (
            <span>Already on account{' '}
              <span className={`font-semibold tabular-nums ${standing.on_account_paise > 0 ? 'text-amber-700' : 'text-[#1D1D1F]'}`}>{finFormatINR(standing.on_account_paise)}</span>
            </span>
          )}
          {lineId != null && Number.isSafeInteger(amount) && (
            <span className="font-semibold">
              {scope === 'open' ? `${finFormatINR(amount)} on account to adjust` : `${finFormatINR(amount)} to adjust again`}
            </span>
          )}
        </span>
      </div>

      {failed && (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm font-medium text-red-700">
          The preview didn't come.
          <button type="button" className="font-semibold underline" onClick={() => setAttempt(n => n + 1)}>Try again</button>
        </p>
      )}

      {preview && rows.length === 0 && (
        <p className="mt-2 text-sm font-medium text-[#515154]">Nothing open: all of it stays on account.</p>
      )}
      {preview == null && !failed && <p className="mt-2 text-sm text-[#86868B]">Reading the open bills…</p>}

      {rows.length > 0 && (
        <div className={`mt-2 max-h-72 overflow-y-auto ${busy ? 'opacity-70' : ''}`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-[#86868B]">
                {mode === 'pick' && <th className="w-8 py-1" />}
                <th className="py-1 pr-2">Bill</th>
                <th className="py-1 pr-2">Date</th>
                <th className="py-1 pr-2 text-right">Age</th>
                <th className="py-1 pr-2 text-right">Open</th>
                {mode === 'pick' && <th className="py-1 pr-2 text-right">Amount</th>}
                <th className="py-1 text-right">Gets</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.line_id} className="border-t border-[#1D1D1F]/[0.06] align-top">
                  {mode === 'pick' && (
                    <td className="py-1.5">
                      <input type="checkbox" className="h-4 w-4 rounded accent-[#007AFF]" checked={picked.has(row.line_id)}
                        aria-label={`Pick ${row.label}`} onChange={() => tick(row.line_id)} />
                    </td>
                  )}
                  <td className="py-1.5 pr-2 font-medium">{row.label}</td>
                  <td className="whitespace-nowrap py-1.5 pr-2 text-[#6E6E73]">
                    {finDateText(row.date)}{row.due_date ? <span className="block text-[11px]">due {finDateText(row.due_date)}</span> : null}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-[#6E6E73]">{row.age_days != null ? `${row.age_days} d` : ''}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{finFormatINR(row.open_paise)}</td>
                  {mode === 'pick' && (
                    <td className="py-1.5 pr-2 text-right">
                      {picked.has(row.line_id) && (
                        <>
                          <Input className="ml-auto h-8 w-32 text-right" inputMode="decimal" placeholder="all open"
                            value={typed[row.line_id]?.text ?? ''} aria-label={`Amount for ${row.label}`}
                            onChange={e => typeAmount(row.line_id, e.target.value)} />
                          {typed[row.line_id]?.error && <span className="mt-0.5 block text-xs text-red-600">{typed[row.line_id].error}</span>}
                        </>
                      )}
                    </td>
                  )}
                  <td className={`py-1.5 text-right tabular-nums ${row.settles === 'part' ? 'text-amber-700' : row.settles ? 'text-emerald-700' : 'text-[#86868B]'}`}>
                    {getsText(row) || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview && (
        <div className="mt-2 flex items-center justify-between border-t border-[#1D1D1F]/[0.08] pt-2 text-sm">
          <span className="font-semibold text-[#515154]">On account</span>
          <span className={`font-bold tabular-nums ${preview.on_account_paise > 0 ? 'text-amber-700' : 'text-[#1D1D1F]'}`}>
            {finFormatINR(preview.on_account_paise)}
          </span>
        </div>
      )}
      {mode == null && rows.length > 0 && (
        <p className="mt-1 text-xs text-[#86868B]">Choose Auto or I'll pick. Until you do, all of it stays on account.</p>
      )}
    </div>
  );
}

// The panel in a dialog of its own: Redo on a book row, Adjust on an item of the unadjusted money. `target` is { scope, line_id,
// ledger_id, title, sub }: the posted party line whose adjustment is worked out again, and how (ruling R71): scope 'line', a Redo, the
// whole line again; 'open', an Adjust, only what it still holds on account, what it settles already kept. Saving needs a choice (the
// route asks for Auto or Pick), Ctrl or Cmd with Enter saves wherever focus is, a bill ticked with the mouse included (useSaveKey,
// ruling R72), and the answer, what the server settled, is what the toast says.
export function AdjustDialog({ target, onClose, onDone }) {
  const toast = useToast();
  const noAnswer = useNoAnswer();
  const [choice, setChoice] = useState(null);
  const savingRef = useRef(false);

  const save = useCallback(async () => {
    if (!choice?.mode || choice.unreadable || savingRef.current) return;
    savingRef.current = true;
    try {
      const answer = await api.put(`/finance/lines/${target.line_id}/allocations`, { mode: choice.mode, picks: choice.mode === 'pick' ? choice.picks : [], scope: target.scope });
      toast.success(finAdjustedText(answer));
      onDone?.(answer);
      onClose();
    } catch (e) {
      noAnswer(e);
    } finally {
      savingRef.current = false;
    }
  }, [choice, target.line_id, target.scope, toast, noAnswer, onDone, onClose]);

  useSaveKey(save);

  return (
    <Modal open wide onClose={onClose} title={target.title}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={!choice?.mode || choice.unreadable}>Save adjustment <kbd className="ml-1 text-[10px] font-bold opacity-80">Ctrl+Enter</kbd></Button>
      </>}>
      <div data-ci-form>
        {target.sub && <p className="mb-3 text-sm text-[#515154]">{target.sub}</p>}
        <AdjustPanel ledgerId={target.ledger_id} lineId={target.line_id} scope={target.scope} onChange={setChoice} />
        <p className="mt-3 text-xs text-[#86868B]">
          {target.scope === 'open'
            ? 'Adjust settles only the money still on account: the bills this entry settles already stay settled. It changes no balance, needs no approval, and works in a closed month too.'
            : 'A redo works the whole entry again: the bills it settles now are open again until you choose. It changes no balance, only which bills are open. It needs no approval, and works in a closed month too.'}
        </p>
      </div>
    </Modal>
  );
}
