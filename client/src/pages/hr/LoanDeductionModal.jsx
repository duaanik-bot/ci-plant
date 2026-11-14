// HR · change one loan's instalment for a month from the payroll card (owner's requests 2026-11-03 and 2026-11-14:
// "the instalment is 3000 but this month we want to deduct 5000 or 2000 — ask whether to change the EMI or only this
// time" · "an easy way to edit the instalment amount for the selected month, keeping the wires intact with the loan,
// the rights to edit given to my accounts person").
//
// The person types the amount and chooses, then PUT /hr/loans/:id/month-instalment does it on the loan itself:
//   * Only this time — that month takes the amount (₹0 holds it); every other month keeps the EMI.
//   * Change the EMI — the loan's instalment is the amount from that month on; open months before it keep the old one.
// The loan stays the one record: the schedule, the payroll line and the finalise posting all read it. The person's open
// months are worked out again at once; when that moves a submitted month or a later one, the approval pop-up asks for an
// approver's remark first (lib/impact.js). Accounts and up. A finalised month is never offered: the card offers the
// next month instead.
import { useState } from 'react';
import { Button, Field, Input, Modal, Textarea } from '../../components/ui.jsx';
import { hrApi, inr2, monthLabel } from '../../lib/hr.js';
import { paiseOf, plural, shiftMonth } from './RunLineDrawer.jsx';

const fromP = p => { const a = p < 0n ? -p : p; return `${p < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };
const toP = v => { const t = String(v ?? '').replace(/[,\s₹]/g, ''); return /^\d+(\.\d{1,2})?$/.test(t) ? paiseOf(Number(t).toFixed(2)) : null; };

// month: the payroll month the change is for. before: what is outstanding going into it. planned: what it takes now.
export default function LoanDeductionModal({ month, person, ln, before, planned, onClose, onDone }) {
  const [amount, setAmount] = useState(fromP(planned));
  const [scope, setScope] = useState('month');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const typed = toP(amount);
  const emi = paiseOf(ln.instalment) ?? 0n;
  const taken = typed === null ? null : typed > before ? before : typed;
  const after = taken === null ? null : before - taken;
  const per = scope === 'emi' ? typed : emi;
  const left = after !== null && after > 0n && per > 0n ? Number((after + per - 1n) / per) : 0;
  const next = shiftMonth(month, 1);
  const problems = [
    typed === null && 'Type the amount to deduct (₹, up to 2 decimals).',
    scope === 'emi' && typed !== null && typed <= 0n && 'A new EMI must be more than ₹0 — for one month off, choose "Only this time" with ₹0.',
  ].filter(Boolean);
  const why = reason.trim() || (scope === 'emi'
    ? `${ln.loan_no}: EMI changed from ${inr2(ln.instalment)} to ${inr2(fromP(typed ?? 0n))} from ${monthLabel(month)}`
    : `${ln.loan_no}: ${inr2(fromP(typed ?? 0n))} deducted in ${monthLabel(month)} only (EMI ${inr2(ln.instalment)} stays)`);

  const apply = async () => {
    setBusy(true); setError('');
    try {
      await hrApi.setMonthInstalment(ln.id, { month, amount: fromP(typed), scope: scope === 'emi' ? 'onward' : 'month', note: why.slice(0, 200) });
      await onDone(scope === 'emi'
        ? `${ln.loan_no}: EMI is now ${inr2(fromP(typed))} from ${monthLabel(month)}`
        : `${ln.loan_no}: ${inr2(fromP(taken))} in ${monthLabel(month)}; EMI ${inr2(ln.instalment)} again from ${monthLabel(next)}`);
    } catch (e) {
      setError(e?.data?.error || e?.message || 'The change could not be saved.');
    } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={`Loan instalment — ${person.name} · ${ln.loan_no}`}
      footer={(
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={apply} disabled={busy || problems.length > 0}>{busy ? 'Saving…' : scope === 'emi' ? `Change the EMI from ${monthLabel(month)}` : `Deduct for ${monthLabel(month)} only`}</Button>
        </div>
      )}>
      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-[#1D1D1F]/[0.04] px-2 py-1.5"><div className="text-[10px] font-bold uppercase text-[#86868B]">Outstanding</div><div className="font-bold tabular-nums">{inr2(fromP(before))}</div></div>
          <div className="rounded-lg bg-[#1D1D1F]/[0.04] px-2 py-1.5"><div className="text-[10px] font-bold uppercase text-[#86868B]">EMI now</div><div className="font-bold tabular-nums">{inr2(ln.instalment)}</div></div>
          <div className="rounded-lg bg-[#1D1D1F]/[0.04] px-2 py-1.5"><div className="text-[10px] font-bold uppercase text-[#86868B]">Planned {monthLabel(month)}</div><div className="font-bold tabular-nums">{inr2(fromP(planned))}</div></div>
        </div>
        <Field label={`Deduct in ${monthLabel(month)} (₹)`}>
          <Input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} autoFocus />
        </Field>
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-xs font-bold text-[#1D1D1F]">Keep this instalment for all the upcoming months, or only this time?</legend>
          <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-[#1D1D1F]/10 px-3 py-2 has-[:checked]:border-[#0A84FF] has-[:checked]:bg-[#E1EFFF]/60">
            <input type="radio" name="scope" className="mt-0.5 accent-[#007AFF]" checked={scope === 'month'} onChange={() => setScope('month')} />
            <span><b>Only this time</b> — deduct this amount in {monthLabel(month)}; the EMI stays {inr2(ln.instalment)} from {monthLabel(next)}.</span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-[#1D1D1F]/10 px-3 py-2 has-[:checked]:border-[#0A84FF] has-[:checked]:bg-[#E1EFFF]/60">
            <input type="radio" name="scope" className="mt-0.5 accent-[#007AFF]" checked={scope === 'emi'} onChange={() => setScope('emi')} />
            <span><b>All upcoming months</b> — deduct {typed !== null ? inr2(fromP(typed)) : 'this amount'} every month from {monthLabel(month)} on (the new EMI).</span>
          </label>
        </fieldset>
        {taken !== null && (
          <p className={`rounded-xl px-3 py-2 text-xs ${after === 0n ? 'bg-emerald-50 text-emerald-900' : 'bg-violet-50 text-violet-900'}`}>
            {typed > before && <>Only {inr2(fromP(before))} is outstanding, so that is all that is deducted. </>}
            Balance after {monthLabel(month)}: <b>{inr2(fromP(after))}</b>
            {after === 0n ? ' — the loan is repaid and closes when the month is finalised.' : <> · then about {plural(left, 'month')} at {inr2(fromP(per))}.</>}
          </p>
        )}
        <Field label="Note" hint="Optional — kept with the change. Left blank, the change is described for you.">
          <Textarea value={reason} onChange={e => setReason(e.target.value)} />
        </Field>
        {problems.length > 0 && <p className="text-[11px] text-[#86868B]">{problems[0]}</p>}
        {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>}
      </div>
    </Modal>
  );
}
