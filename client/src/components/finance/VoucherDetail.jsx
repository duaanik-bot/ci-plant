// VoucherDetail: one voucher, opened over the Day Book, Approvals or Drafts (spec §10).
//
//   <VoucherDetail id={12} me={me} book={book} setBook={setBook} onClose={...} onChanged={...} onOpen={id => ...} onEdit={view => ...} />
//
// It reads GET /finance/vouchers/:id and shows the voucher, its lines and totals, and its history. What a login may DO with it is
// the view's own `can` (finVoucherCan on the server: Submit, Approve, Reject, Reverse, Discard, Edit), never a rule of this screen's;
// the shell's `can` is not used here for that reason. Print is always there.
//
// The voucher's book is the voucher's own. A bell link names a voucher and no book (`/finance?voucher=12`), so the shell may be on
// the other book: the name shown comes from the voucher's book_id (me.books), and when that differs from the shell's book the
// detail asks the shell to switch ONCE (ruling R47; the page then draws afresh on the voucher's book and the two agree, so it
// cannot go round again). A login that does not hold the book gets no voucher at all (the server answers 404).
//
// Posting actions (Submit, Approve, Reverse) mint a number, and every action is one press at a time (lib/busyClick.js through the
// shared Button): a double click sends one request. A second action cannot start while one is on the wire.
//   Reject and Reverse ask first (a reason; Reverse also a date: never before the voucher's own, ruling R28, and for an Opening
//   voucher the date IS its own, shown and not offered, ruling R42). Discard asks to be sure.
//   A reversal that is on its way (`pending_reversal_id`) is said, with a way to it (ruling R29).
// A write that fails reloads the voucher (another login may have moved it: the buttons come from its `can`), and one that got no answer
// at all is said by useNoAnswer. A read that fails is not "not available to you": only a 404 says that; anything else says it could
// not load, with a Retry.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Pencil, Printer, RotateCcw, Send, Trash2, X } from 'lucide-react';
import { api, fmt } from '../../api.js';
import { Button, ConfirmDialog, DataTable, Field, Input, Modal, Textarea, useToast } from '../ui.jsx';
import useNoAnswer from './useNoAnswer.js';
import useRealtimeRefresh from '../../lib/useRealtimeRefresh.js';
import { dayOf } from '../../lib/dayOf.js';
import { FINANCE_TABLES } from '../../lib/finance/tables.js';
import { finBookOf } from '../../lib/finance/book.js';
import { finFormatINR } from '../../lib/finance/money.js';
import { finDateText, finNumberText, finStatusOf, finTypeLabel } from '../../lib/finance/voucher.js';

// ── Small shared pieces (the Vouchers page uses them too) ────────────────────────────────────

const STATUS_TONE = {
  draft: 'bg-gray-100 text-gray-600',
  waiting: 'bg-amber-50 text-amber-700',
  posted: 'bg-emerald-50 text-emerald-700',
  reversed: 'bg-red-50 text-red-700',
  discarded: 'bg-gray-100 text-gray-400 line-through',
};

// The status chip, drawn like the shared StatusBadge (which cannot take a label of its own).
export function VoucherStatus({ voucher }) {
  const { key, label } = finStatusOf(voucher);
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ring-[#1D1D1F]/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] ${STATUS_TONE[key] || STATUS_TONE.draft}`}>
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />
      {label}
    </span>
  );
}

// A dialog that wants a reason before it goes ahead (rejecting an entry). The reason is required; the server says so too.
// `onSubmit(reason)` returns the promise of the write: the dialog holds still while it runs, and its owner closes it on success.
export function ReasonDialog({ title, intro, label = 'Reason', confirmLabel, onSubmit, onClose }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await onSubmit(reason.trim()); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={busy ? () => {} : onClose} title={title}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="danger" onClick={go} disabled={!reason.trim() || busy}>{confirmLabel}</Button>
      </>}>
      {intro && <p className="mb-3 text-sm text-gray-600">{intro}</p>}
      <Field label={label} required>
        <Textarea autoFocus value={reason} onChange={e => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

// Reversing a posted voucher: a date and a reason. The reversal cannot be dated before the voucher it undoes (ruling R28), and
// an Opening voucher is reversed as at its own date, which is shown and not asked for (ruling R42).
function ReverseDialog({ voucher, onClose, onDone, onFailed }) {
  const noAnswer = useNoAnswer();
  const opening = voucher.voucher_type === 'opening';
  const today = dayOf(new Date());
  const [date, setDate] = useState(opening || today < voucher.voucher_date ? voucher.voucher_date : today);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState({});
  const go = async () => {
    setBusy(true);
    setProblems({});
    try {
      const out = await api.post(`/finance/vouchers/${voucher.id}/reverse`, { date, reason: reason.trim() });
      await onDone(out.voucher);
    } catch (e) {
      // The sentence is in the toast; where it names the date or the reason it is under that field too.
      noAnswer(e);
      if (e.data?.field === 'date' || e.data?.field === 'reason') setProblems({ [e.data.field]: e.message });
      onFailed?.();
    } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={busy ? () => {} : onClose} title={`Reverse ${voucher.number}`}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="danger" onClick={go} disabled={!reason.trim() || !date || busy}>Reverse</Button>
      </>}>
      <p className="mb-3 text-sm text-gray-600">
        A reversal is a new entry that mirrors this one with every debit and credit swapped. This voucher stays in the books, marked reversed.
      </p>
      <div className="space-y-3">
        {opening ? (
          <p className="rounded-xl bg-[#1D1D1F]/[0.04] px-3 py-2 text-sm">
            <span className="font-semibold">Date: {finDateText(voucher.voucher_date)}</span>
            <span className="block text-xs text-gray-500">An Opening voucher is reversed as at its own date, so the books never hold two openings at once.</span>
          </p>
        ) : (
          <Field label="Date of the reversal" required hint={`Not before ${finDateText(voucher.voucher_date)}, the date of the voucher.`}>
            <Input type="date" min={voucher.voucher_date} value={date} onChange={e => setDate(e.target.value)} />
            {problems.date && <span className="mt-0.5 block text-[11px] text-red-600">{problems.date}</span>}
          </Field>
        )}
        <Field label="Why is it being reversed?" required>
          <Textarea autoFocus value={reason} onChange={e => setReason(e.target.value)} />
          {problems.reason && <span className="mt-0.5 block text-[11px] text-red-600">{problems.reason}</span>}
        </Field>
      </div>
    </Modal>
  );
}

const ACTION_LABEL = {
  create: 'Draft made', edit: 'Edited', discard: 'Discarded', submit: 'Sent for approval', approve: 'Approved',
  reject: 'Sent back', post: 'Posted', reverse: 'Reversal entered',
};

const Fact = ({ label, children }) => (children ? (
  <div className="min-w-0">
    <div className="text-[10px] font-bold uppercase tracking-wide text-[#86868B]">{label}</div>
    <div className="break-words text-sm text-[#1D1D1F]">{children}</div>
  </div>
) : null);

const LinkButton = ({ onClick, children }) => (
  <button type="button" onClick={onClick} className="font-semibold text-brand-600 hover:underline">{children}</button>
);

// `onEdit(view)` opens the form on a draft; a page that cannot offer the form (a phone) leaves it out, and there is no Edit button.
export default function VoucherDetail({ id, me, book, setBook, onClose, onChanged, onOpen, onEdit }) {
  const toast = useToast();
  const noAnswer = useNoAnswer();
  const navigate = useNavigate();
  const [view, setView] = useState(null);
  const [failed, setFailed] = useState(null);          // a first read that failed: 'gone' (a 404) or 'trouble' (anything else)
  const [dialog, setDialog] = useState(null);          // 'reject' | 'reverse' | 'discard'
  const [acting, setActing] = useState(null);          // the action on the wire
  const seen = useRef(false);

  const load = useCallback(() => api.get(`/finance/vouchers/${id}`)
    .then(answer => { seen.current = true; setView(answer); setFailed(null); })
    // a refresh that fails leaves the voucher that is on screen; only a first read that fails says anything, and only a 404 says
    // the voucher is not the login's to see
    .catch(e => { if (!seen.current) setFailed(e?.status === 404 ? 'gone' : 'trouble'); }), [id]);
  useEffect(() => { seen.current = false; setView(null); setFailed(null); load(); }, [load]);
  useRealtimeRefresh(load, FINANCE_TABLES);

  // Ruling R47: a bell link names a voucher and no book. Once the voucher says whose it is, the shell switches to that book if the
  // login holds it. Only when the two differ, and once per book, so it cannot loop.
  const switched = useRef(null);
  const ownBookId = view?.voucher.book_id;
  useEffect(() => {
    if (ownBookId == null || ownBookId === book.id || switched.current === ownBookId) return;
    switched.current = ownBookId;
    setBook?.(ownBookId);
  }, [ownBookId, book.id, setBook]);

  const v = view?.voucher;
  const can = view?.can ?? {};
  const own = v ? finBookOf(me?.books, v.book_id) : null;

  // A write that fails says so (a dropped connection says it here; a refusal api.js has said), reloads the voucher, since another login
  // may have moved it and the buttons follow its `can`, and lets the failure through: a dialog that asked for it stays open.
  const failedWrite = async e => { noAnswer(e); await load(); throw e; };
  const act = (name, run) => async () => {
    if (acting) return;
    setActing(name);
    try { await run(); } catch (e) { await failedWrite(e); } finally { setActing(null); }
  };
  const refresh = async () => { await load(); onChanged?.(); };
  const post = (action, body) => api.post(`/finance/vouchers/${id}/${action}`, body).then(out => out.voucher);

  const submit = act('submit', async () => {
    const out = await post('submit');
    toast.success(out.status === 'posted' ? `Posted ${out.number}` : 'Sent for approval');
    await refresh();
  });
  const approve = act('approve', async () => {
    const out = await post('approve');
    toast.success(`Approved and posted ${out.number}`);
    await refresh();
  });
  const reject = async reason => {
    try { await post('reject', { reason }); } catch (e) { await failedWrite(e); }
    toast.success('Sent back to its maker');
    setDialog(null);
    onChanged?.();
    onClose();
  };
  const discard = act('discard', async () => {
    await post('discard');
    toast.success('Draft discarded');
    onChanged?.();
    onClose();
  });
  const reversed = async out => {
    toast.success(out.status === 'posted' ? `Reversal ${out.number} posted` : 'Reversal sent for approval');
    setDialog(null);
    await refresh();
  };

  const lines = view?.lines ?? [];
  const totalDebit = lines.reduce((sum, l) => sum + l.debit_paise, 0);
  const totalCredit = lines.reduce((sum, l) => sum + l.credit_paise, 0);

  const footer = (
    <>
      <Button variant="secondary" onClick={() => navigate(`/finance/vouchers/${id}/print`)}><Printer size={14} /> Print</Button>
      {can.discard && <Button variant="ghost" onClick={() => setDialog('discard')} disabled={Boolean(acting)}><Trash2 size={14} /> Discard</Button>}
      {can.edit && onEdit && <Button variant="secondary" onClick={() => onEdit(view)} disabled={Boolean(acting)}><Pencil size={14} /> Edit</Button>}
      {can.reverse && <Button variant="secondary" onClick={() => setDialog('reverse')} disabled={Boolean(acting)}><RotateCcw size={14} /> Reverse</Button>}
      {can.reject && <Button variant="danger" onClick={() => setDialog('reject')} disabled={Boolean(acting)}><X size={14} /> Reject</Button>}
      {can.approve && <Button variant="success" onClick={approve} disabled={Boolean(acting)}><Check size={14} /> Approve</Button>}
      {can.submit && <Button onClick={submit} disabled={Boolean(acting)}><Send size={14} /> Submit</Button>}
    </>
  );

  return (
    <>
      <Modal open wide onClose={dialog || acting ? () => {} : onClose} title={v ? `${finTypeLabel(v.voucher_type)} voucher` : 'Voucher'}
        footer={view ? footer : <Button variant="secondary" onClick={onClose}>Close</Button>}>
        {!view ? (
          <div className="py-10 text-center text-sm text-gray-400">
            {failed === 'gone' && <p>This voucher isn't available to you.</p>}
            {failed === 'trouble' && (
              <div className="flex flex-col items-center gap-3">
                <p className="text-red-600">Couldn't load this voucher.</p>
                <Button size="sm" variant="secondary" onClick={() => { setFailed(null); return load(); }}>Retry</Button>
              </div>
            )}
            {!failed && <p>Loading…</p>}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="break-words text-xl font-extrabold tracking-[-0.02em] text-[#1D1D1F]">{finNumberText(v)}</div>
                <div className="text-sm text-[#6E6E73]">
                  {finTypeLabel(v.voucher_type)} · {finDateText(v.voucher_date)}{own ? ` · ${own.name}` : ''}
                </div>
              </div>
              <VoucherStatus voucher={v} />
            </div>

            {v.reversal_of_number && (
              <p className="text-sm text-gray-600">A reversal of <LinkButton onClick={() => onOpen?.(v.reversal_of_id)}>{v.reversal_of_number}</LinkButton>.</p>
            )}
            {v.reversed_by_number && (
              <p className="text-sm text-gray-600">Reversed by <LinkButton onClick={() => onOpen?.(v.reversed_by_id)}>{v.reversed_by_number}</LinkButton>.</p>
            )}
            {v.pending_reversal_id != null && (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Reversal waiting for approval. <LinkButton onClick={() => onOpen?.(v.pending_reversal_id)}>Open it</LinkButton>
              </p>
            )}
            {v.status === 'draft' && v.last_reject_reason && (
              <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
                Sent back{v.last_rejected_by ? ` by ${v.last_rejected_by}` : ''}: {v.last_reject_reason}
              </p>
            )}

            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
              <Fact label="Made by">{v.created_by ? `${v.created_by} · ${fmt.dt(v.created_at)}` : null}</Fact>
              <Fact label="Submitted by">{v.submitted_by ? `${v.submitted_by} · ${fmt.dt(v.submitted_at)}` : null}</Fact>
              <Fact label="Approved by">{v.approved_by ? `${v.approved_by}${v.self_approved ? ' (self-approved)' : ''} · ${fmt.dt(v.approved_at)}` : null}</Fact>
              <Fact label="Posted by">{v.posted_by ? `${v.posted_by} · ${fmt.dt(v.posted_at)}` : null}</Fact>
              <Fact label="Reference">{v.reference}</Fact>
            </div>

            {v.narration && <p className="whitespace-pre-wrap rounded-xl bg-[#1D1D1F]/[0.03] px-3 py-2 text-sm text-[#1D1D1F]">{v.narration}</p>}

            <div>
              <DataTable dense rows={lines} getRowId={l => l.id} empty="This voucher has no lines yet"
                columns={[
                  { key: 'ledger_name', label: 'Ledger', sortable: false, card: 'title', render: l => (
                    <div className="min-w-0">
                      <div className="font-semibold">{l.ledger_name}{l.ledger_code ? <span className="ml-1.5 text-xs font-normal text-gray-400">{l.ledger_code}</span> : null}</div>
                      {l.narration && <div className="text-xs text-gray-500">{l.narration}</div>}
                      {(l.bill_ref || l.bill_date || l.due_date) && (
                        <div className="text-xs text-gray-500">
                          Bill {l.bill_ref || '—'}{l.bill_date ? ` · ${finDateText(l.bill_date)}` : ''}{l.due_date ? ` · due ${finDateText(l.due_date)}` : ''}
                        </div>
                      )}
                    </div>) },
                  { key: 'debit_paise', label: 'Debit', sortable: false, align: 'right', card: 'metric',
                    render: l => (l.debit_paise > 0 ? <span className="font-semibold tabular-nums">{finFormatINR(l.debit_paise)}</span> : '') },
                  { key: 'credit_paise', label: 'Credit', sortable: false, align: 'right', card: 'metric',
                    render: l => (l.credit_paise > 0 ? <span className="font-semibold tabular-nums">{finFormatINR(l.credit_paise)}</span> : '') },
                ]} />
              <div className="mt-2 flex items-center justify-end gap-6 px-2 text-sm font-bold tabular-nums">
                <span className="text-xs font-semibold uppercase tracking-wide text-[#86868B]">Total</span>
                <span>{finFormatINR(totalDebit)}</span>
                <span>{finFormatINR(totalCredit)}</span>
              </div>
            </div>

            {view.history.length > 0 && (
              <div>
                <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-[#86868B]">History</div>
                <ol className="space-y-2 border-l-2 border-[#1D1D1F]/10 pl-4">
                  {view.history.map(h => (
                    <li key={h.id} className="text-sm">
                      <span className="font-semibold text-[#1D1D1F]">{ACTION_LABEL[h.action] ?? h.action}</span>
                      <span className="text-gray-500"> · {h.user_name} · {fmt.dt(h.at)}</span>
                      {h.reason && <div className="whitespace-pre-wrap text-xs text-gray-600">{h.reason}</div>}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
      </Modal>

      {dialog === 'reject' && (
        <ReasonDialog title="Reject this entry" confirmLabel="Reject" label="Why is it being rejected?"
          intro={`It goes back to ${v.created_by || 'its maker'} as a draft, with your reason.`}
          onSubmit={reject} onClose={() => setDialog(null)} />
      )}
      {dialog === 'reverse' && <ReverseDialog voucher={v} onClose={() => setDialog(null)} onDone={reversed} onFailed={load} />}
      <ConfirmDialog open={dialog === 'discard'} onClose={() => setDialog(null)} onConfirm={discard} danger
        title="Discard this draft?" message="The draft is kept in the trail but never gets a number, and it cannot be brought back." confirmLabel="Discard" />
    </>
  );
}
