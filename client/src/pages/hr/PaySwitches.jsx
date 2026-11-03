// HR · Holiday pay and Overtime on / off for one person (owner's request 2026-11-03: "a toggle whether the person
// has holiday payment — if not, keep it at zero; a toggle whether they have overtime — contractors and some staff
// don't; off means overtime is zero; on asks the overtime figure").
//
// Reads the person's newest pay setup (the one the open months use) and switches it through
// POST /hr/people/:id/setups/:setupId/switches. Holiday on brings back the figures it had (or base ÷ 30.5 × 1.5);
// Overtime on asks how many OT hours make a day (6 and 8 are the sheet's), off pays no OT whatever hours are typed.
// The open draft month is worked out again at once. When the payroll month the card is in is not a draft
// (`month` + `status` given), the switch first offers to send it back to draft (approver; it undoes the approvals).
import { useState } from 'react';
import { Button, Input } from '../../components/ui.jsx';
import { hrApi, monthLabel } from '../../lib/hr.js';
const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;

const n = v => (v == null || v === '' ? 0 : Number(v));
export const holidayOn = s => Boolean(s) && s.holiday_mode !== 'none';
export const overtimeOn = s => Boolean(s) && (n(s.ot_hours_per_day) > 0 || n(s.ot_fixed_rate) > 0);

function Switch({ on, disabled, onClick, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onClick}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-[#34C759]' : 'bg-[#1D1D1F]/20'}`}>
      <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
    </button>
  );
}

export default function PaySwitches({ personId, setup, canEdit, month, status, canApprove, approvedCount = 0, onChanged, compact = false }) {
  const [asking, setAsking] = useState(null);   // { kind:'overtime-on' } | { kind, value } waiting for the send-back tick
  const [hours, setHours] = useState('8');
  const [sendBack, setSendBack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!setup) return <p className="text-xs text-[#86868B]">No pay setup yet — add one under People › Pay setup.</p>;
  const hol = holidayOn(setup);
  const ot = overtimeOn(setup);
  const locked = Boolean(month) && status && status !== 'draft' && status !== 'none';

  const apply = async change => {
    setBusy(true); setError('');
    try {
      if (locked) {
        if (!sendBack) { setAsking(change); setBusy(false); return; }
        await hrApi.sendBackRun(month, `To switch ${change.holiday !== undefined ? 'holiday pay' : 'overtime'} ${change.holiday ?? change.overtime ? 'on' : 'off'} for a person`);
      }
      const res = await hrApi.setPaySwitches(personId, setup.id, change);
      setAsking(null); setSendBack(false);
      await onChanged?.(res, change);
    } catch (e) {
      setError(e?.data?.error || e?.message || 'The switch could not be saved.');
    } finally { setBusy(false); }
  };
  const flip = kind => {
    if (!canEdit || busy) return;
    if (kind === 'holiday') apply({ holiday: !hol });
    else if (ot) apply({ overtime: false });
    else setAsking({ kind: 'overtime-on' });
  };

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <div className={`grid gap-2 ${compact ? 'sm:grid-cols-2' : ''}`}>
        <div className="flex items-center gap-3 rounded-xl bg-white/70 px-3 py-2">
          <Switch on={hol} disabled={!canEdit || busy} onClick={() => flip('holiday')} label="Holiday pay" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[#1D1D1F]">Holiday pay {hol ? 'on' : 'off'}</div>
            <div className="text-[11px] text-[#6E6E73]">
              {!hol ? 'Holiday pay is ₹0.'
                : setup.holiday_mode === 'fixed' ? 'A fixed amount every month.'
                  : `Base ÷ ${n(setup.holiday_divisor) || 30.5} × ${n(setup.holiday_multiplier) || 1}.`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl bg-white/70 px-3 py-2">
          <Switch on={ot} disabled={!canEdit || busy} onClick={() => flip('overtime')} label="Overtime" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[#1D1D1F]">Overtime {ot ? 'on' : 'off'}</div>
            <div className="text-[11px] text-[#6E6E73]">
              {!ot ? 'No overtime — OT is ₹0 whatever hours the sheet has.'
                : n(setup.ot_fixed_rate) > 0 ? `₹${setup.ot_fixed_rate} an hour (fixed).`
                  : `OT hours ÷ ${n(setup.ot_hours_per_day)} h a day × the daily rate.`}
            </div>
          </div>
        </div>
      </div>

      {asking?.kind === 'overtime-on' && (
        <div className="flex flex-wrap items-end gap-2 rounded-xl border border-[#0A84FF]/30 bg-[#E1EFFF]/60 px-3 py-2">
          <label className="text-xs text-[#1D1D1F]">
            <span className="mb-1 block font-semibold">How many OT hours make a day?</span>
            <Input inputMode="decimal" value={hours} onChange={e => setHours(e.target.value)} className="!w-24" />
          </label>
          {['6', '8'].map(h => (
            <button key={h} type="button" onClick={() => setHours(h)}
              className={`rounded-full px-2.5 py-1 text-xs font-bold ${hours === h ? 'bg-[#007AFF] text-white' : 'bg-white text-[#515154]'}`}>{h} h</button>
          ))}
          <Button size="sm" disabled={busy || !(Number(hours) > 0) || (locked && !sendBack)}
            onClick={() => apply({ overtime: true, ot_hours_per_day: Number(hours) })}>Switch overtime on</Button>
          <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>Cancel</Button>
        </div>
      )}

      {asking && locked && (
        <label className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <input type="checkbox" className="mt-0.5 accent-[#007AFF]" checked={sendBack} onChange={e => setSendBack(e.target.checked)} />
          <span>
            {monthLabel(month)} is <b>{status}</b>, so its figures are fixed. <b>Send it back to draft</b> and apply the switch — it must
            then be submitted and approved again{approvedCount ? `, and the ${plural(approvedCount, 'person', 'people')} approved for payment go back to unapproved` : ''}.
            {!canApprove && ' (Needs HR approver access.)'}
          </span>
        </label>
      )}
      {asking && asking.kind !== 'overtime-on' && locked && (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy || !sendBack || !canApprove} onClick={() => apply(asking)}>Send back and switch</Button>
          <Button size="sm" variant="ghost" onClick={() => { setAsking(null); setSendBack(false); }}>Cancel</Button>
        </div>
      )}
      {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>}
    </div>
  );
}
