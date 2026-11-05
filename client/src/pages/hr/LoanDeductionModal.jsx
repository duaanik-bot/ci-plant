// HR · change one loan's deduction for the month from the payroll card (owner's request 2026-11-03: "the instalment is
// 3000 but this month we want to deduct 5000 or 2000 — ask whether to change the EMI or only this time, and settle the
// loan accordingly").
//
// The person types the amount, then chooses:
//   * Only this month — the run input loan_recovery_override for this person (PUT /hr/runs/:month/inputs/:personId),
//     which recalculates the line at once. The override is the person's TOTAL for the month, so another loan's
//     deduction is added to the typed figure. Next month the EMI applies again, untouched.
//   * Make it the new EMI — PUT /hr/loans/:id/instalment {instalment, from_month}, then this month's line is worked out
//     again (a typed override for the month is cleared so the new EMI applies; otherwise the run is recalculated).
// Either way the engine settles it: never more than the loan's outstanding, the balance after follows, and the months
// left come from the new figure. A month that is not a draft cannot change; the dialog offers to send it back to
// draft first (approver only — it undoes the people's approvals, which the dialog says).
import { useState } from 'react';
import { Button, Field, Input, Modal, Textarea } from '../../components/ui.jsx';
import { hrApi, inr2, monthLabel } from '../../lib/hr.js';
import { paiseOf, plural, shiftMonth } from './RunLineDrawer.jsx';

const fromP = p => { const a = p < 0n ? -p : p; return `${p < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };
const toP = v => { const t = String(v ?? '').replace(/[,\s₹]/g, ''); return /^\d+(\.\d{1,2})?$/.test(t) ? paiseOf(Number(t).toFixed(2)) : null; };

export default function LoanDeductionModal({ month, status, canApprove, person, pos, otherRec, approvedCount, onClose, onDone }) {
  const { ln, rec, before } = pos;
  const [amount, setAmount] = useState(fromP(rec));
  const [scope, setScope] = useState('month');
  const [reason, setReason] = useState('');
  const [sendBack, setSendBack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const typed = toP(amount);
  const emi = paiseOf(ln.instalment) ?? 0n;
  const taken = typed === null ? null : typed > before ? before : typed;
  const after = taken === null ? null : before - taken;
  const left = after !== null && after > 0n && (scope === 'emi' ? typed : emi) > 0n
    ? Number((after + (scope === 'emi' ? typed : emi) - 1n) / (scope === 'emi' ? typed : emi)) : 0;
  const next = shiftMonth(month, 1);
  const draft = status === 'draft';
  // "Only this month" in a submitted month is one person's input: it is saved in place (2026-11-04), no send-back.
  const locked = !draft && !(status === 'submitted' && scope === 'month');
  const problems = [
    typed === null && 'Type the amount to deduct (₹, up to 2 decimals).',
    scope === 'emi' && typed !== null && typed <= 0n && 'A new EMI must be more than ₹0 — for one month off, use "Only this month" with ₹0, or hold the instalment.',
    locked && !sendBack && `${monthLabel(month)} is ${status}: tick "Send it back to draft" to change it.`,
    locked && sendBack && !canApprove && 'Sending a month back to draft needs HR approver access.',
  ].filter(Boolean);
  const why = reason.trim() || (scope === 'emi'
    ? `${ln.loan_no}: EMI changed from ${inr2(ln.instalment)} to ${inr2(fromP(typed ?? 0n))} from ${monthLabel(month)}`
    : `${ln.loan_no}: ${inr2(fromP(typed ?? 0n))} deducted in ${monthLabel(month)} only (EMI ${inr2(ln.instalment)} stays)`);

  const apply = async () => {
    setBusy(true); setError('');
    try {
      if (locked) await hrApi.sendBackRun(month, `To change ${person.name}'s loan deduction — ${why}`);
      if (scope === 'month') {
        await hrApi.saveRunInput(month, person.id, { loan_recovery_override: fromP(typed + otherRec), reason: why });
      } else {
        await hrApi.setLoanInstalment(ln.id, { instalment: fromP(typed), from_month: month });
        if (person.input?.loan_recovery_override != null && person.input.loan_recovery_override !== '') {
          await hrApi.saveRunInput(month, person.id, { loan_recovery_override: null, reason: why });
        } else {
          await hrApi.recalcRun(month);
        }
      }
      await onDone(scope === 'emi'
        ? `${ln.loan_no}: EMI is now ${inr2(fromP(typed))} from ${monthLabel(month)}`
        : `${ln.loan_no}: ${inr2(fromP(taken))} deducted in ${monthLabel(month)}; EMI ${inr2(ln.instalment)} again from ${monthLabel(next)}`);
    } catch (e) {
      setError(e?.data?.error || e?.message || 'The change could not be saved.');
    } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={`Loan deduction — ${person.name} · ${ln.loan_no}`}
      footer={(
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={apply} disabled={busy || problems.length > 0}>{busy ? 'Saving…' : scope === 'emi' ? 'Change the EMI' : `Deduct for ${monthLabel(month)} only`}</Button>
        </div>
      )}>
      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-[#1D1D1F]/[0.04] px-2 py-1.5"><div className="text-[10px] font-bold uppercase text-[#86868B]">Outstanding</div><div className="font-bold tabular-nums">{inr2(fromP(before))}</div></div>
          <div className="rounded-lg bg-[#1D1D1F]/[0.04] px-2 py-1.5"><div className="text-[10px] font-bold uppercase text-[#86868B]">EMI now</div><div className="font-bold tabular-nums">{inr2(ln.instalment)}</div></div>
          <div className="rounded-lg bg-[#1D1D1F]/[0.04] px-2 py-1.5"><div className="text-[10px] font-bold uppercase text-[#86868B]">Planned this month</div><div className="font-bold tabular-nums">{inr2(fromP(rec))}</div></div>
        </div>
        <Field label={`Deduct in ${monthLabel(month)} (₹)`}>
          <Input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} autoFocus />
        </Field>
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-xs font-bold text-[#1D1D1F]">Is this only for {monthLabel(month)}, or the new EMI?</legend>
          <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-[#1D1D1F]/10 px-3 py-2 has-[:checked]:border-[#0A84FF] has-[:checked]:bg-[#E1EFFF]/60">
            <input type="radio" name="scope" className="mt-0.5 accent-[#007AFF]" checked={scope === 'month'} onChange={() => setScope('month')} />
            <span><b>Only this time</b> — deduct this amount in {monthLabel(month)}; the EMI stays {inr2(ln.instalment)} from {monthLabel(next)}.</span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-[#1D1D1F]/10 px-3 py-2 has-[:checked]:border-[#0A84FF] has-[:checked]:bg-[#E1EFFF]/60">
            <input type="radio" name="scope" className="mt-0.5 accent-[#007AFF]" checked={scope === 'emi'} onChange={() => setScope('emi')} />
            <span><b>Change the EMI</b> — deduct {typed !== null ? inr2(fromP(typed)) : 'this amount'} every month from {monthLabel(month)} on.</span>
          </label>
        </fieldset>
        {taken !== null && (
          <p className={`rounded-xl px-3 py-2 text-xs ${after === 0n ? 'bg-emerald-50 text-emerald-900' : 'bg-violet-50 text-violet-900'}`}>
            {typed > before && <>Only {inr2(fromP(before))} is outstanding, so that is all that is deducted. </>}
            Balance after {monthLabel(month)}: <b>{inr2(fromP(after))}</b>
            {after === 0n ? ' — the loan is repaid and closes when the month is finalised.' : <> · then about {plural(left, 'month')} at {inr2(fromP(scope === 'emi' ? typed : emi))}.</>}
            {otherRec > 0n && <> The person's other loan deductions ({inr2(fromP(otherRec))}) stay as they are.</>}
          </p>
        )}
        {locked && (
          <label className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <input type="checkbox" className="mt-0.5 accent-[#007AFF]" checked={sendBack} onChange={e => setSendBack(e.target.checked)} />
            <span>
              {monthLabel(month)} is <b>{status}</b>, so its figures are fixed. <b>Send it back to draft</b> and make the change — it must then
              be submitted and approved again{approvedCount ? `, and the ${plural(approvedCount, 'person', 'people')} approved for payment go back to unapproved` : ''}.
            </span>
          </label>
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
