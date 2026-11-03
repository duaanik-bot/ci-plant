// HR · Holiday pay and Overtime on / off for one person (owner's request 2026-11-03: "a toggle whether the person
// has holiday payment — if not, keep it at zero; a toggle whether they have overtime — contractors and some staff
// don't; off means overtime is zero; on asks the overtime figure").
//
// Reads the person's newest pay setup (the one the open months use) and switches it through
// POST /hr/people/:id/setups/:setupId/switches. Holiday on brings back the figures it had (or base ÷ 30.5 × 1.5);
// Overtime is one picker — Off · 6 h · 8 h · Other (the OT hours that make a day; the sheet uses 6 and 8) — with the
// rate it gives worked out underneath (daily rate ÷ hours = the pay for one OT hour). Off pays no OT whatever hours
// are typed. OtDayPicker is also used inline in the People list.
// The open draft month is worked out again at once. When the payroll month the card is in is not a draft
// (`month` + `status` given), the switch first offers to send it back to draft (approver; it undoes the approvals).
import { useState } from 'react';
import { Button } from '../../components/ui.jsx';
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

// What an OT hour pays, worked out the engine's way for a monthly or daily setup: the daily rate (monthly base ÷ the
// month's days) ÷ the OT hours that make a day × the OT multiplier. A fixed OT rate is shown as it is.
const DAYS = m => (/^\d{4}-\d{2}$/.test(m || '') ? new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate() : 30);
const rupees = v => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export function otRateText(setup, perDay, month) {
  if (!setup) return '';
  if (n(setup.ot_fixed_rate) > 0) return `${rupees(setup.ot_fixed_rate)} per OT hour (fixed rate)`;
  if (!(n(perDay) > 0)) return 'No overtime — OT is ₹0 whatever hours the sheet has.';
  const times = n(setup.ot_multiplier) || 1;
  const x = times === 1 ? '' : ` × ${times}`;
  if (setup.pay_basis === 'monthly') {
    const days = DAYS(month);
    const daily = n(setup.base) / days;
    return `${rupees(setup.base)} ÷ ${days} days = ${rupees(daily)} a day ÷ ${n(perDay)} h${x} = ${rupees((daily / n(perDay)) * times)} per OT hour`;
  }
  if (setup.pay_basis === 'daily') return `${rupees(setup.base)} a day ÷ ${n(perDay)} h${x} = ${rupees((n(setup.base) / n(perDay)) * times)} per OT hour`;
  if (setup.pay_basis === 'hourly') return `${rupees(setup.base)} an hour${x} per OT hour`;
  return `OT hours ÷ ${n(perDay)} h a day × the daily rate`;
}

// Off · 6 h · 8 h · Other — the OT hours that make a day, one tap each. `value` is the setup's ot_hours_per_day
// (0 = no overtime); onPick(hours) gets 0 for Off.
export function OtDayPicker({ value, disabled, onPick, size = 'md' }) {
  const v = n(value);
  const [other, setOther] = useState(v > 0 && v !== 6 && v !== 8 ? String(v) : '');
  const [typing, setTyping] = useState(false);
  const pad = size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs';
  const seg = (on, label, pick, title) => (
    <button key={label} type="button" disabled={disabled} title={title} onClick={pick}
      className={`${pad} rounded-full font-bold transition-colors disabled:opacity-50 ${on ? (label === 'Off' ? 'bg-[#1D1D1F]/70 text-white' : 'bg-[#007AFF] text-white') : 'text-[#515154] hover:bg-white'}`}>
      {label}
    </button>
  );
  const custom = v > 0 && v !== 6 && v !== 8;
  return (
    <span className="inline-flex flex-wrap items-center gap-0.5 rounded-full bg-[#1D1D1F]/[0.06] p-0.5" role="group" aria-label="OT hours that make a day">
      {seg(v === 0, 'Off', () => onPick(0), 'No overtime')}
      {seg(v === 6, '6 h', () => onPick(6), '6 OT hours make a day')}
      {seg(v === 8, '8 h', () => onPick(8), '8 OT hours make a day')}
      {typing ? (
        <span className="inline-flex items-center gap-1 px-1">
          <input autoFocus inputMode="decimal" value={other} onChange={e => setOther(e.target.value)} aria-label="Other OT hours a day"
            onKeyDown={e => { if (e.key === 'Enter' && Number(other) > 0) { setTyping(false); onPick(Number(other)); } if (e.key === 'Escape') setTyping(false); }}
            className="w-12 rounded-full border border-[#0A84FF]/40 bg-white px-2 py-0.5 text-xs" />
          <button type="button" disabled={!(Number(other) > 0 && Number(other) <= 24)} onClick={() => { setTyping(false); onPick(Number(other)); }}
            className="rounded-full bg-[#007AFF] px-2 py-0.5 text-[11px] font-bold text-white disabled:opacity-40">Set</button>
        </span>
      ) : seg(custom, custom ? `${v} h` : 'Other', () => setTyping(true), 'Another number of OT hours a day')}
    </span>
  );
}

export default function PaySwitches({ personId, setup, canEdit, month, status, canApprove, approvedCount = 0, onChanged, compact = false }) {
  const [asking, setAsking] = useState(null);   // a change waiting for the send-back tick (a month that is not a draft)
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
        await hrApi.sendBackRun(month, change.holiday !== undefined
          ? `To switch holiday pay ${change.holiday ? 'on' : 'off'} for a person`
          : `To set a person's overtime to ${change.overtime ? `${change.ot_hours_per_day} h a day` : 'off'}`);
      }
      const res = await hrApi.setPaySwitches(personId, setup.id, change);
      setAsking(null); setSendBack(false);
      await onChanged?.(res, change);
    } catch (e) {
      setError(e?.data?.error || e?.message || 'The switch could not be saved.');
    } finally { setBusy(false); }
  };
  const flip = () => { if (canEdit && !busy) apply({ holiday: !hol }); };
  const pickOt = h => {
    if (!canEdit || busy) return;
    if (h === n(setup.ot_hours_per_day) && !(h === 0 && n(setup.ot_fixed_rate) > 0)) return;
    apply(h > 0 ? { overtime: true, ot_hours_per_day: h } : { overtime: false });
  };

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <div className={`grid gap-2 ${compact ? 'sm:grid-cols-2' : ''}`}>
        <div className="flex items-center gap-3 rounded-xl bg-white/70 px-3 py-2">
          <Switch on={hol} disabled={!canEdit || busy} onClick={flip} label="Holiday pay" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[#1D1D1F]">Holiday pay {hol ? 'on' : 'off'}</div>
            <div className="text-[11px] text-[#6E6E73]">
              {!hol ? 'Holiday pay is ₹0.'
                : setup.holiday_mode === 'fixed' ? 'A fixed amount every month.'
                  : `Base ÷ ${n(setup.holiday_divisor) || 30.5} × ${n(setup.holiday_multiplier) || 1}.`}
            </div>
          </div>
        </div>
        <div className="rounded-xl bg-white/70 px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-sm font-semibold text-[#1D1D1F]">Overtime {ot ? 'on' : 'off'}</span>
            {canEdit
              ? <OtDayPicker value={setup.ot_hours_per_day} disabled={busy} onPick={pickOt} />
              : <span className="text-xs font-semibold text-[#515154]">{ot ? `${n(setup.ot_hours_per_day)} h a day` : 'Off'}</span>}
          </div>
          <div className="mt-1 text-[11px] text-[#6E6E73]">{otRateText(setup, setup.ot_hours_per_day, month)}</div>
        </div>
      </div>

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
      {asking && locked && (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy || !sendBack || !canApprove} onClick={() => apply(asking)}>Send back and switch</Button>
          <Button size="sm" variant="ghost" onClick={() => { setAsking(null); setSendBack(false); }}>Cancel</Button>
        </div>
      )}
      {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>}
    </div>
  );
}
