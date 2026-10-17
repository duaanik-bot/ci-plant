// HR → People → the person drawer. One person: details, pay-setup history (and the "New
// revision" form), bank, aliases, the ERP-operator link, and the money tab (advance balance,
// loans, and the last six finalised months with what was paid). Also the home of the small
// formatters People.jsx shares.
//
// Access (spec §6). The drawer decides what to OFFER from the HR level it is given; the server
// is what refuses. Viewer: everything reads, nothing edits. Operator and above: Add / Edit
// person, a new pay revision, aliases, the ERP-operator link.
//
// One form, three tabs. Details, Bank and ERP operator are all fields of the SAME person
// record, so they share one form state and one Save bar, and a save always sends the WHOLE
// record. A partial PUT would be read one of two ways on the server (merge, or replace with
// blanks), and the replace reading would wipe the bank account the moment someone fixed a
// phone number. The whole record is right under both.
//
// A server refusal (CODE_EXISTS, SETUP_EXISTS, ALIAS_IS_A_NAME, NAME_IS_AN_ALIAS, a validation
// message …) reaches the app's central error toast (api.js does that before the promise
// rejects), and because that toast is brief and a dialog can stand over it, it is ALSO said
// inline wherever the person is working — the Save bar, the alias box, the revision dialog, a
// confirm dialog — in the server's own words (refusalText). Nothing here draws a dialog of its
// own for a refusal and nothing clears the form: the handlers catch, say it, return, and leave
// exactly what the user typed, with the dialog still open.
//
// Bank numbers. Lists carry bank_last4 only; this drawer shows whatever GET /hr/people/:id
// returned (the full number arrives for operator and above, nothing but the last four for a
// viewer). It is masked until an operator asks to see it. Nothing is ever logged.
//
// Layering. The drawer sits at z-45: over the app chrome (sidebar and bars, z-40 and under),
// under the ordinary dialog layer (z-50) and the toast stack (z-60). Deliberate: a dialog opened
// from here (the revision form, a confirm) is the stock Modal / ConfirmDialog, and the central
// toast that says WHY the server refused something shows on top of it. The `nested` modal layer
// (z-90) would bury that toast under the dialog's backdrop.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, Banknote, Eye, EyeOff, Landmark, Link2, Loader2, Plus, Tag, Trash2, Unlink, UserRound, Wallet, X,
} from 'lucide-react';
import { Button, Checkbox, ConfirmDialog, Field, Input, Modal, Select, Textarea, searchText, useToast } from '../../components/ui.jsx';
import { dayOf } from '../../lib/dayOf.js';
import { hrApi, inr2, levelAtLeast, monthLabel } from '../../lib/hr.js';

// ── Shared words and formatters (People.jsx imports these) ──────────────────

export const PERSON_STATUS = {
  active: { label: 'Active', tone: 'bg-emerald-50 text-emerald-700' },
  on_leave: { label: 'On leave', tone: 'bg-amber-50 text-amber-700' },
  exited: { label: 'Exited', tone: 'bg-slate-200 text-slate-600' },
};
export const WORKER_TYPE = { employee: 'Employee', contractor: 'Contractor' };
export const PAY_BASIS = { monthly: 'Monthly', daily: 'Daily', hourly: 'Hourly', contract: 'Contract' };

// StatusBadge's capsule, in the three colours a person's status needs (StatusBadge has no
// 'active' or 'on_leave' and would paint both grey).
export function StatusPill({ status }) {
  const meta = PERSON_STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ring-[#1D1D1F]/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] ${meta?.tone || 'bg-gray-100 text-gray-600'}`}>
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />
      {meta?.label || String(status || '—').replace(/_/g, ' ')}
    </span>
  );
}

// A quantity for reading: 8 → '8', '30.5000' → '30.5', nothing → '—'. Formatting only.
export function numText(v) {
  if (v == null || (typeof v === 'string' && v.trim() === '')) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '—';
}

// What a pay setup pays, in one phrase. A contract is paid the bill amount typed each month,
// so its stored base is not a pay figure and is not shown as one.
export function baseText(setup) {
  if (!setup) return '—';
  if (setup.pay_basis === 'contract') return 'Bill amount';
  const amount = inr2(setup.base);
  if (amount === '—') return amount;
  if (setup.pay_basis === 'daily') return `${amount} / day`;
  if (setup.pay_basis === 'hourly') return `${amount} / hour`;
  return amount;
}

export function holidayText(setup) {
  if (!setup) return '—';
  if (setup.holiday_mode === 'formula') return `base ÷ ${numText(setup.holiday_divisor)} × ${numText(setup.holiday_multiplier)}`;
  if (setup.holiday_mode === 'fixed') return `${inr2(setup.holiday_fixed)} fixed`;
  return 'None';
}

const hasValue = v => v != null && !(typeof v === 'string' && v.trim() === '');
const otText = s => (hasValue(s.ot_fixed_rate)
  ? `${inr2(s.ot_fixed_rate)} / h fixed`
  : `${numText(s.ot_hours_per_day)} h/day × ${numText(s.ot_multiplier)}`);
const absenceText = s => (s.pay_basis !== 'monthly' ? '—'
  : s.absence_basis === 'fixed_divisor' ? `÷ ${numText(s.absence_divisor)} days` : 'Calendar days');

// The last four characters of an account number, whatever else is in the string.
const last4Of = v => String(v ?? '').replace(/\s+/g, '').slice(-4);

// YYYY-MM of a date-ish value ('' when there is none), and the month after one.
const monthOf = v => (dayOf(v) || '').slice(0, 7);
const currentMonth = () => dayOf(new Date()).slice(0, 7);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function nextMonthOf(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
// Newest first. The server's order is trusted for nothing: the "in force" row is the first
// one whose month has arrived, and that is only right on a list sorted here.
const byEffectiveDesc = (a, b) => monthOf(b.effective_from).localeCompare(monthOf(a.effective_from));

// ── The person form ─────────────────────────────────────────────────────────

const EMPTY_FORM = Object.freeze({
  code: '', name: '', display_name: '', father_name: '', firm: '', department: '', designation: '',
  worker_type: 'employee', status: 'active', joined_on: '', exited_on: '',
  phone: '', address: '', emergency_contact: '', pay_channel: '',
  bank_holder: '', bank_name: '', bank_account: '', bank_ifsc: '',
  esi_applicable: false, esi_no: '', pf_uan: '', pan: '', employee_id: '', notes: '',
});

function formFromPerson(p) {
  const f = { ...EMPTY_FORM };
  if (!p) return f;
  for (const key of Object.keys(EMPTY_FORM)) {
    const v = p[key];
    if (v == null) continue;
    if (key === 'esi_applicable') f[key] = v === true || v === 1 || v === 't' || v === 'true';
    else if (key === 'joined_on' || key === 'exited_on') f[key] = dayOf(v) || '';
    else f[key] = String(v);
  }
  return f;
}
const sameForm = (a, b) => Object.keys(EMPTY_FORM).every(k => a[k] === b[k]);

// The whole record, in the shape the server stores: blank text is null, an account number
// carries no spaces, IFSC and PAN are upper case. (An exact copy of what was typed otherwise.)
function bodyFromForm(f) {
  const text = v => { const t = String(v ?? '').trim(); return t === '' ? null : t; };
  const compact = v => { const t = String(v ?? '').replace(/\s+/g, ''); return t === '' ? null : t; };
  return {
    code: f.code.trim(),
    name: f.name.trim(),
    display_name: text(f.display_name),
    father_name: text(f.father_name),
    firm: text(f.firm),
    department: text(f.department),
    designation: text(f.designation),
    worker_type: f.worker_type,
    status: f.status,
    joined_on: f.joined_on || null,
    exited_on: f.exited_on || null,
    phone: text(f.phone),
    address: text(f.address),
    emergency_contact: text(f.emergency_contact),
    pay_channel: f.pay_channel || null,
    bank_holder: text(f.bank_holder),
    bank_name: text(f.bank_name),
    bank_account: compact(f.bank_account),
    bank_ifsc: compact(f.bank_ifsc)?.toUpperCase() ?? null,
    esi_applicable: Boolean(f.esi_applicable),
    esi_no: text(f.esi_no),
    pf_uan: compact(f.pf_uan),
    pan: compact(f.pan)?.toUpperCase() ?? null,
    employee_id: f.employee_id === '' ? null : Number(f.employee_id),
    notes: text(f.notes),
  };
}

function problemsOf(f) {
  const out = [];
  if (!f.code.trim()) out.push('Enter the payroll code.');
  if (!f.name.trim()) out.push('Enter the name.');
  if (f.joined_on && f.exited_on && f.exited_on < f.joined_on) out.push('The exit date is before the joining date.');
  return out;
}

// ── Typed numbers ───────────────────────────────────────────────────────────
// Money and quantities are typed as plain text and sent as numbers; nothing here adds,
// rounds or compares them. A figure with more decimals than the column keeps is refused
// instead of being quietly rounded by the server — what was typed is what is stored.
// → { blank: true } | { error } | { value }. (Settings.jsx reads its policy numbers the same way.)
export function parseNum(text, dp) {
  const t = String(text ?? '').trim();
  if (t === '') return { blank: true };
  if (/^-/.test(t)) return { error: 'Cannot be negative.' };
  if (!new RegExp(`^(?:\\d+(?:\\.\\d{1,${dp}})?|\\.\\d{1,${dp}})$`).test(t)) {
    return { error: /^\d*\.\d+$/.test(t) ? `At most ${dp} decimal places.` : 'Numbers only — no commas or ₹ sign.' };
  }
  return { value: Number(t) };
}

// ── Small building blocks ───────────────────────────────────────────────────

function Section({ title, right, children }) {
  return (
    <section className="rounded-[20px] border border-white/75 bg-white/55 p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
      {(title || right) && (
        <div className="mb-2.5 flex items-center gap-2">
          {title && <h4 className="min-w-0 flex-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[#6E6E73]">{title}</h4>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

const ErrText = ({ children }) => <span className="font-semibold text-red-600">{children}</span>;

// What the server said, as a sentence: its own message (api.js hangs the response body on the
// error as .data), else the error's. Shared with Settings.jsx and WorkbookLoader.jsx.
export const refusalText = e => e?.data?.error || e?.message || 'That did not work.';

// The optional `warning` string POST /hr/people/:id/setups can return beside the saved revision
// (e.g. it starts in a locked month, which is not changed). A blank one is no warning.
const warningOf = answer => (typeof answer?.warning === 'string' && answer.warning.trim() ? answer.warning.trim() : null);

// A refusal (or a problem with what was typed) said where the person is looking: a red line
// inside the dialog, above its buttons, until the input changes. A <span> so it can also sit in
// ConfirmDialog's message (a <p>). It scrolls itself into view, so a long form never hides it.
export function InlineError({ message, className = 'mt-3' }) {
  const ref = useRef(null);
  useEffect(() => {
    if (message) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [message]);
  if (!message) return null;
  return (
    <span ref={ref} role="alert"
      className={`flex items-start gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 ${className}`}>
      <AlertTriangle size={14} className="mt-px shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </span>
  );
}

const TH = 'px-2.5 py-2 text-left';
const TD = 'px-2.5 py-2.5 align-top';

// ── Tabs ────────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'details', label: 'Details', icon: UserRound },
  { key: 'pay', label: 'Pay setup', icon: Banknote },
  { key: 'bank', label: 'Bank', icon: Landmark },
  { key: 'aliases', label: 'Aliases', icon: Tag },
  { key: 'erp', label: 'ERP operator', icon: Link2 },
  { key: 'money', label: 'Money', icon: Wallet },
];
// The tabs that edit the person record and so share its Save bar.
const FORM_TABS = new Set(['details', 'bank', 'erp']);

function DetailsTab({ form, set, canEdit, channels, person }) {
  const off = !canEdit;
  const text = (key, label, extra = {}) => (
    <Field label={label} required={extra.required} hint={extra.hint} className={extra.className}>
      <Input value={form[key]} disabled={off} onChange={e => set(key, e.target.value)}
        type={extra.type} inputMode={extra.inputMode} autoComplete="off" />
    </Field>
  );
  // A channel the person already has stays pickable even if it has since been switched off.
  const known = channels.some(c => c.code === form.pay_channel);
  const legacy = person?.legacy && typeof person.legacy === 'object' ? Object.entries(person.legacy).filter(([, v]) => hasValue(v)) : [];
  return (
    <div data-ci-form className="space-y-3">
      {off && (
        <p className="rounded-2xl border border-[#1D1D1F]/[0.06] bg-white/55 px-3 py-2 text-xs font-medium text-[#6E6E73]">
          View only — your HR access level can read people but not change them.
        </p>
      )}
      <Section title="Identity">
        <div className="ci-form-grid">
          {text('code', 'Payroll code', { required: true, hint: 'The code used in the monthly sheet.' })}
          {text('name', 'Name', { required: true, hint: 'As on the bank account and the workbook.' })}
          {text('display_name', 'Display name')}
          {text('father_name', "Father's name")}
          {text('firm', 'Firm')}
          {text('department', 'Department')}
          {text('designation', 'Designation')}
          <Field label="Worker type">
            <Select value={form.worker_type} disabled={off} onChange={e => set('worker_type', e.target.value)}>
              <option value="employee">Employee</option>
              <option value="contractor">Contractor</option>
            </Select>
          </Field>
        </div>
      </Section>
      <Section title="Employment">
        <div className="ci-form-grid">
          <Field label="Status">
            <Select value={form.status} disabled={off} onChange={e => set('status', e.target.value)}>
              <option value="active">Active</option>
              <option value="on_leave">On leave</option>
              <option value="exited">Exited</option>
            </Select>
          </Field>
          <Field label="Pay channel" hint="How this person is paid.">
            <Select value={form.pay_channel} disabled={off} onChange={e => set('pay_channel', e.target.value)}>
              <option value="">No channel</option>
              {form.pay_channel && !known && <option value={form.pay_channel}>{form.pay_channel}</option>}
              {channels.filter(c => c.active !== false || c.code === form.pay_channel).map(c => (
                <option key={c.code} value={c.code}>{`${c.label || c.code}${c.kind === 'cash' ? ' (cash)' : ''}`}</option>
              ))}
            </Select>
          </Field>
          {text('joined_on', 'Joined on', { type: 'date' })}
          {text('exited_on', 'Left on', { type: 'date' })}
        </div>
      </Section>
      <Section title="Contact">
        <div className="ci-form-grid">
          {text('phone', 'Phone', { inputMode: 'tel' })}
          {text('emergency_contact', 'Emergency contact')}
          <Field label="Address" className="md:col-span-2">
            <Textarea value={form.address} disabled={off} onChange={e => set('address', e.target.value)} />
          </Field>
        </div>
      </Section>
      <Section title="Statutory">
        <div className="ci-form-grid">
          <div className="flex items-center md:col-span-2">
            <Checkbox label="ESI applicable" checked={form.esi_applicable} disabled={off}
              onChange={e => set('esi_applicable', e.target.checked)} />
          </div>
          {text('esi_no', 'ESI number')}
          {text('pf_uan', 'PF UAN')}
          {text('pan', 'PAN')}
        </div>
        {/* A viewer's copy arrives masked ('••••234F'); it is shown exactly as given. */}
        {off && ['esi_no', 'pf_uan', 'pan'].some(k => form[k].includes('•')) && (
          <p className="mt-2 text-[11px] text-[#86868B]">Shown masked at your access level.</p>
        )}
      </Section>
      <Section title="Notes">
        <Textarea value={form.notes} disabled={off} onChange={e => set('notes', e.target.value)} />
        {legacy.length > 0 && (
          <p className="mt-2 text-[11px] text-[#86868B]">
            From the salary workbook: {legacy.map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ')}
          </p>
        )}
      </Section>
    </div>
  );
}

function PayTab({ setups, canEdit, onNew, notice, onDismissNotice }) {
  const sorted = useMemo(() => [...setups].sort(byEffectiveDesc), [setups]);
  const now = currentMonth();
  const inForce = sorted.find(s => monthOf(s.effective_from) <= now);
  return (
    <div className="space-y-3">
      {/* The server's warning about the revision just saved. Not a toast: it is a sentence someone has
          to read and act on, so it stays until it is dismissed (or the drawer is closed). */}
      {notice && (
        <div role="status" className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words"><b>Revision saved, with a warning.</b> {notice}</span>
          <button type="button" onClick={onDismissNotice}
            className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold underline hover:bg-amber-100">Dismiss</button>
        </div>
      )}
      <Section title="Pay setup history" right={canEdit && (
        <Button size="sm" onClick={onNew}><Plus size={13} /> New revision</Button>
      )}>
        {sorted.length === 0 ? (
          <div className="rounded-2xl bg-amber-50/70 px-3 py-3 text-xs font-medium text-amber-800">
            No pay setup yet. A payroll run cannot be submitted for this person until one is added.
            {canEdit ? ' Use New revision to add the first.' : ''}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-white/75 bg-white/55">
            <table className="w-full text-sm">
              <thead>
                <tr className="ci-table-head">
                  <th className={TH}>Effective from</th>
                  <th className={TH}>Basis</th>
                  <th className={`${TH} text-right`}>Base</th>
                  <th className={TH}>Absence</th>
                  <th className={TH}>Overtime</th>
                  <th className={TH}>Holiday</th>
                  <th className={TH}>Note</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(s => {
                  const future = monthOf(s.effective_from) > now;
                  const current = s === inForce;
                  return (
                    <tr key={s.id ?? s.effective_from} className="ci-table-row">
                      <td className={`${TD} whitespace-nowrap font-semibold text-[#1D1D1F]`}>
                        {monthLabel(dayOf(s.effective_from))}
                        {current && <span className="ml-1.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">In force</span>}
                        {future && <span className="ml-1.5 rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">Scheduled</span>}
                      </td>
                      <td className={TD}>{PAY_BASIS[s.pay_basis] || s.pay_basis}</td>
                      <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>{s.pay_basis === 'contract' ? '—' : inr2(s.base)}</td>
                      <td className={TD}>{absenceText(s)}</td>
                      <td className={TD}>{otText(s)}</td>
                      <td className={TD}>{holidayText(s)}</td>
                      <td className={`${TD} text-[#6E6E73]`}>{s.note || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] text-[#86868B]">
          A pay setup is never edited once a run has used it — a change is a new revision from the 1st of a month.
        </p>
      </Section>
    </div>
  );
}

function BankTab({ form, set, canEdit, person, reveal, setReveal }) {
  const base = formFromPerson(person);
  // Whether the SAVED record had an account number: an operator with nothing on file gets the
  // input straight away, and typing into it must not flip it back to the masked view.
  const hadAccount = base.bank_account !== '';
  const last4 = last4Of(canEdit ? form.bank_account : base.bank_account) || person?.bank_last4 || '';
  const showInput = canEdit && (reveal || !hadAccount);
  const off = !canEdit;
  return (
    <Section title="Bank account">
      <div className="ci-form-grid">
        <Field label="Account holder">
          <Input value={form.bank_holder} disabled={off} autoComplete="off" onChange={e => set('bank_holder', e.target.value)} />
        </Field>
        <Field label="Bank">
          <Input value={form.bank_name} disabled={off} autoComplete="off" onChange={e => set('bank_name', e.target.value)} />
        </Field>
        <div>
          <span className="mb-1 block text-xs font-medium leading-snug text-slate-600">Account number</span>
          {showInput ? (
            <div className="flex items-center gap-2">
              <Input className="font-mono" aria-label="Account number" inputMode="numeric" autoComplete="off" spellCheck={false}
                value={form.bank_account} onChange={e => set('bank_account', e.target.value)} />
              {hadAccount && (
                <Button size="sm" variant="ghost" onClick={() => setReveal(false)}><EyeOff size={13} /> Hide</Button>
              )}
            </div>
          ) : (
            <div className="flex h-10 items-center justify-between gap-2 rounded-xl border border-[#1D1D1F]/[0.10] bg-[#1D1D1F]/[0.04] px-3 text-sm font-semibold text-[#515154]">
              <span className="font-mono">{last4 ? `•••• ${last4}` : '—'}</span>
              {canEdit && last4 && (
                <Button size="sm" variant="ghost" onClick={() => setReveal(true)}><Eye size={13} /> Show</Button>
              )}
            </div>
          )}
          <span className="mt-1 block text-xs text-gray-400">
            {canEdit ? 'Shown in full only to operators and above.' : 'Only the last four digits are shown at your access level.'}
          </span>
        </div>
        <Field label="IFSC">
          <Input className="font-mono uppercase" value={form.bank_ifsc} disabled={off} autoComplete="off" spellCheck={false}
            onChange={e => set('bank_ifsc', e.target.value)} />
        </Field>
      </div>
    </Section>
  );
}

function AliasesTab({ aliases, canEdit, text, setText, error, onAdd, onRemove }) {
  return (
    <Section title="Other spellings of this name">
      <p className="text-xs text-[#6E6E73]">
        A monthly sheet sometimes spells a name differently. A spelling listed here is matched to this person
        automatically when a sheet is imported.
      </p>
      {canEdit && (
        <div className="mt-3 flex items-end gap-2">
          <Field label="New spelling" className="min-w-0 flex-1">
            <Input value={text} autoComplete="off" placeholder="e.g. the name as the sheet writes it"
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onAdd(); } }} />
          </Field>
          <Button onClick={onAdd} disabled={!text.trim()}><Plus size={14} /> Add</Button>
        </div>
      )}
      <InlineError message={error} />
      <ul className="mt-3 divide-y divide-[#1D1D1F]/[0.06] rounded-2xl border border-white/75 bg-white/55">
        {aliases.length === 0 && <li className="px-3 py-3 text-xs text-[#86868B]">No other spellings recorded.</li>}
        {aliases.map(a => (
          <li key={a.id} className="flex items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1 break-words text-sm font-semibold text-[#1D1D1F]">{a.alias ?? a.alias_norm}</span>
            {a.source && a.source !== 'manual' && (
              <span className="rounded-full bg-[#1D1D1F]/[0.07] px-2 py-0.5 text-[10px] font-semibold text-[#6E6E73]">{String(a.source).replace(/_/g, ' ')}</span>
            )}
            {canEdit && (
              <button type="button" aria-label={`Remove ${a.alias ?? a.alias_norm}`} onClick={() => onRemove(a)}
                className="rounded-lg p-1.5 text-[#86868B] hover:bg-red-50 hover:text-red-600">
                <Trash2 size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ErpTab({ form, set, canEdit, operators }) {
  const linkedId = form.employee_id;
  const options = (operators || [])
    .filter(o => !(o.active === 0 || o.active === false) || String(o.id) === String(linkedId))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const linked = (operators || []).find(o => String(o.id) === String(linkedId));
  return (
    <Section title="Link to an ERP operator">
      <p className="text-xs text-[#6E6E73]">
        Ties this person to the operator record the plant floor uses (Masters → Employees). One operator can be
        linked to one person.
      </p>
      {canEdit ? (
        <div className="mt-3 flex items-end gap-2">
          <Field label="ERP operator" className="min-w-0 flex-1" hint={operators == null ? 'Loading operators…' : undefined}>
            <Select value={linkedId} disabled={operators == null} onChange={e => set('employee_id', e.target.value)}>
              <option value="">Not linked</option>
              {linkedId && !linked && <option value={linkedId}>{`Operator #${linkedId}`}</option>}
              {options.map(o => (
                <option key={o.id} value={String(o.id)} data-search={searchText(o)}>
                  {`${o.name}${o.section ? ` · ${o.section}` : ''}${o.active === 0 || o.active === false ? ' (inactive)' : ''}`}
                </option>
              ))}
            </Select>
          </Field>
          {linkedId && <Button variant="secondary" onClick={() => set('employee_id', '')}><Unlink size={14} /> Unlink</Button>}
        </div>
      ) : (
        <p className="mt-3 text-sm font-semibold text-[#1D1D1F]">
          {linkedId ? `Linked to ERP operator #${linkedId}.` : 'Not linked to an ERP operator.'}
        </p>
      )}
    </Section>
  );
}

// A payment line's state (spec §12): pending once the month is finalised, paid when the payment is
// recorded, reversed by an approver.
const PAYMENT_PILL = {
  paid: { label: 'Paid', tone: 'bg-emerald-50 text-emerald-700' },
  pending: { label: 'Pending', tone: 'bg-amber-50 text-amber-700' },
  reversed: { label: 'Reversed', tone: 'bg-red-50 text-red-700' },
};
function PaymentPill({ status }) {
  const meta = PAYMENT_PILL[status];
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${meta?.tone || 'bg-gray-100 text-gray-600'}`}>
      {meta?.label || String(status || '—').replace(/_/g, ' ')}
    </span>
  );
}

// The Money tab reads everything from the person payload GET /hr/people/:id already returned:
// advance_balance, loans[], and recent_lines — the person's last six FINALISED months,
// [{ month, gross, payable, payment_status }]. No further request is made. Newest first whatever
// order the server sent; each month links to its payslip (the print page takes ?person_ids=).
function MoneyTab({ person, pid }) {
  const loans = Array.isArray(person?.loans) ? person.loans : [];
  const lines = (Array.isArray(person?.recent_lines) ? person.recent_lines : [])
    .filter(l => l && l.month != null)
    .sort((a, b) => String(b.month).localeCompare(String(a.month)));
  return (
    <div className="space-y-3">
      <Section title="Advance">
        <div className="text-2xl font-extrabold tracking-[-0.03em] tabular-nums text-[#1D1D1F]">{inr2(person?.advance_balance)}</div>
        <p className="text-xs text-[#6E6E73]">Outstanding advance — recovered from pay month by month. The statement is under Loans &amp; Advances.</p>
      </Section>
      <Section title="Loans">
        {loans.length === 0 ? <p className="text-xs text-[#86868B]">No loans.</p> : (
          <div className="overflow-x-auto rounded-2xl border border-white/75 bg-white/55">
            <table className="w-full text-sm">
              <thead>
                <tr className="ci-table-head">
                  <th className={TH}>Loan</th>
                  <th className={`${TH} text-right`}>Principal</th>
                  <th className={`${TH} text-right`}>Outstanding</th>
                  <th className={`${TH} text-right`}>Instalment</th>
                  <th className={TH}>First due</th>
                  <th className={TH}>Status</th>
                </tr>
              </thead>
              <tbody>
                {loans.map((l, i) => (
                  <tr key={l.id ?? l.loan_no ?? i} className="ci-table-row">
                    <td className={`${TD} whitespace-nowrap font-semibold text-[#1D1D1F]`}>
                      {l.loan_no || `#${l.id ?? i + 1}`}
                      {l.is_opening && <span className="ml-1.5 rounded-full bg-[#1D1D1F]/[0.07] px-1.5 py-0.5 text-[10px] font-bold text-[#6E6E73]">Opening</span>}
                    </td>
                    <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>{inr2(l.principal)}</td>
                    <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>{inr2(l.outstanding)}</td>
                    <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>{inr2(l.instalment)}</td>
                    <td className={TD}>{l.first_due_month ? monthLabel(l.first_due_month) : '—'}</td>
                    <td className={`${TD} capitalize`}>{l.status ? String(l.status).replace(/_/g, ' ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Recent payslips">
        {lines.length === 0 ? <p className="text-xs text-[#86868B]">No payslip yet — they appear once a month is finalised.</p> : (
          <div className="overflow-x-auto rounded-2xl border border-white/75 bg-white/55">
            <table className="w-full text-sm">
              <thead>
                <tr className="ci-table-head">
                  <th className={TH}>Month</th>
                  <th className={`${TH} text-right`}>Gross</th>
                  <th className={`${TH} text-right`}>Payable</th>
                  <th className={TH}>Payment</th>
                </tr>
              </thead>
              <tbody>
                {lines.map(l => {
                  const ym = String(l.month).slice(0, 7);
                  return (
                    <tr key={l.month} className="ci-table-row">
                      <td className={`${TD} whitespace-nowrap font-semibold`}>
                        {MONTH_RE.test(ym) ? (
                          <a href={`/hr/payslips/${ym}?person_ids=${encodeURIComponent(String(pid))}`} target="_blank" rel="noopener noreferrer"
                            title="Open this month's payslip" className="text-[#0064D2] hover:underline">
                            {monthLabel(ym)}
                          </a>
                        ) : <span className="text-[#1D1D1F]">{String(l.month)}</span>}
                      </td>
                      <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>{inr2(l.gross)}</td>
                      <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>{inr2(l.payable)}</td>
                      <td className={TD}><PaymentPill status={l.payment_status} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

// ── New pay revision ────────────────────────────────────────────────────────

const REVISION_BLANK = {
  month: '', pay_basis: 'monthly', base: '', absence_basis: 'calendar_days', absence_divisor: '',
  ot_hours_per_day: '0', ot_multiplier: '1', ot_fixed_rate: '',
  holiday_mode: 'none', holiday_divisor: '', holiday_multiplier: '', holiday_fixed: '', note: '',
};
const BASE_LABEL = {
  monthly: 'Monthly salary (₹)', daily: 'Daily rate (₹)', hourly: 'Hourly rate (₹)', contract: 'Standing base (₹)',
};

// The first month a revision is likely meant for: this month, or the month after the latest
// setup if that one already covers (or passes) it. Only a default — the user picks any month,
// and the server decides what it accepts.
function defaultRevisionMonth(setups) {
  const now = currentMonth();
  const latest = setups.map(s => monthOf(s.effective_from)).filter(Boolean).sort().pop();
  if (!latest) return now;
  const after = nextMonthOf(latest);
  return after > now ? after : now;
}

// A revision usually changes one thing, so the form opens as a copy of the newest setup.
function revisionStart(setups) {
  const f = { ...REVISION_BLANK, month: defaultRevisionMonth(setups) };
  const latest = [...setups].sort(byEffectiveDesc)[0];
  if (!latest) return f;
  const t = v => (hasValue(v) ? String(Number(v)) : '');
  return {
    ...f,
    pay_basis: latest.pay_basis || 'monthly',
    base: t(latest.base),
    absence_basis: latest.absence_basis || 'calendar_days',
    absence_divisor: t(latest.absence_divisor),
    ot_hours_per_day: t(latest.ot_hours_per_day) || '0',
    ot_multiplier: t(latest.ot_multiplier) || '1',
    ot_fixed_rate: t(latest.ot_fixed_rate),
    holiday_mode: latest.holiday_mode || 'none',
    holiday_divisor: t(latest.holiday_divisor),
    holiday_multiplier: t(latest.holiday_multiplier),
    holiday_fixed: t(latest.holiday_fixed),
  };
}

// The way the server will check it (spec §7, the pay_setups constraints): the month; numbers
// not negative; a base; a divisor above 0 wherever one is used; the holiday figures its mode
// needs. Absence is a monthly-pay idea, so it is only checked for monthly pay.
function validateRevision(f) {
  const e = {};
  if (!MONTH_RE.test(f.month)) e.month = 'Choose the month this takes effect.';
  const check = (key, dp, { required = false, positive = false, label = 'a number' } = {}) => {
    const r = parseNum(f[key], dp);
    if (r.blank) { if (required) e[key] = `Enter ${label}.`; return; }
    if (r.error) { e[key] = r.error; return; }
    if (positive && r.value <= 0) e[key] = 'Must be above 0.';
  };
  check('base', 2, { required: true, label: 'the base' });
  if (f.pay_basis === 'monthly' && f.absence_basis === 'fixed_divisor') {
    check('absence_divisor', 4, { required: true, positive: true, label: 'the divisor' });
  }
  check('ot_hours_per_day', 4);
  check('ot_multiplier', 4);
  check('ot_fixed_rate', 2);
  if (f.holiday_mode === 'formula') {
    check('holiday_divisor', 4, { required: true, positive: true, label: 'the divisor' });
    check('holiday_multiplier', 4, { required: true, label: 'the multiplier' });
  }
  if (f.holiday_mode === 'fixed') check('holiday_fixed', 2, { required: true, label: 'the amount' });
  return e;
}

function revisionBody(f) {
  const val = (key, dp) => parseNum(f[key], dp).value;
  const blank = (key, dp) => parseNum(f[key], dp).blank;
  const monthly = f.pay_basis === 'monthly';
  const fixedDivisor = monthly && f.absence_basis === 'fixed_divisor';
  return {
    effective_from: `${f.month}-01`,
    pay_basis: f.pay_basis,
    base: val('base', 2),
    absence_basis: monthly ? f.absence_basis : 'calendar_days',
    absence_divisor: fixedDivisor ? val('absence_divisor', 4) : null,
    // The two columns that cannot be null: a blank keeps the column's own default.
    ot_hours_per_day: blank('ot_hours_per_day', 4) ? 0 : val('ot_hours_per_day', 4),
    ot_multiplier: blank('ot_multiplier', 4) ? 1 : val('ot_multiplier', 4),
    ot_fixed_rate: blank('ot_fixed_rate', 2) ? null : val('ot_fixed_rate', 2),
    holiday_mode: f.holiday_mode,
    holiday_divisor: f.holiday_mode === 'formula' ? val('holiday_divisor', 4) : null,
    holiday_multiplier: f.holiday_mode === 'formula' ? val('holiday_multiplier', 4) : null,
    holiday_fixed: f.holiday_mode === 'fixed' ? val('holiday_fixed', 2) : null,
    note: f.note.trim() || null,
  };
}

function RevisionModal({ pid, setups, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(() => revisionStart(setups));
  const [tried, setTried] = useState(false);
  // What to say above the buttons: the server's refusal, or that the form needs a look. It is
  // cleared the moment the input changes, because it was about the input as it was.
  const [error, setError] = useState(null);
  // The policy's default holiday divisor (Settings), 30.5 until it has been read.
  const [divisorDefault, setDivisorDefault] = useState('30.5');
  useEffect(() => {
    let live = true;
    hrApi.settings().then(s => {
      const v = Number(s?.holiday_divisor_default);
      if (live && Number.isFinite(v) && v > 0) setDivisorDefault(String(v));
    }, () => {});
    return () => { live = false; };
  }, []);

  const errors = useMemo(() => validateRevision(f), [f]);
  const set = (key, value) => { setError(null); setF(cur => ({ ...cur, [key]: value })); };
  const setMode = mode => {
    setError(null);
    setF(cur => ({
      ...cur,
      holiday_mode: mode,
      ...(mode === 'formula' ? { holiday_divisor: cur.holiday_divisor || divisorDefault, holiday_multiplier: cur.holiday_multiplier || '1' } : {}),
    }));
  };
  const shown = key => (tried ? errors[key] : undefined);
  const num = (key, label, hint) => (
    <Field label={label} hint={shown(key) ? <ErrText>{shown(key)}</ErrText> : hint}>
      <Input inputMode="decimal" autoComplete="off" value={f[key]} onChange={e => set(key, e.target.value)} />
    </Field>
  );

  const submit = async () => {
    setTried(true);
    if (Object.keys(errors).length) { setError('Check the highlighted fields.'); return; }
    setError(null);
    let saved;
    try {
      saved = await hrApi.addSetup(pid, revisionBody(f));
    } catch (e) {
      setError(refusalText(e)); // refused — said here, the dialog stays open, the form keeps what was typed
      return;
    }
    // Saved. If the server also has a warning, the dialog closes onto a notice that carries it.
    const warning = warningOf(saved);
    toast.success(`Pay revision added from ${monthLabel(f.month)}${warning ? ' — see the warning' : ''}`);
    onSaved(warning);
  };

  const monthly = f.pay_basis === 'monthly';
  return (
    <Modal open onClose={onClose} title="New pay revision"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={submit}>Add revision</Button>
      </>}>
      <div data-ci-form className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Effective month" required hint={shown('month') ? <ErrText>{shown('month')}</ErrText> : 'Takes effect from the 1st.'}>
            <Input type="month" value={f.month} onChange={e => set('month', e.target.value)} />
          </Field>
          <Field label="Pay basis" required>
            <Select value={f.pay_basis} onChange={e => set('pay_basis', e.target.value)}>
              {Object.entries(PAY_BASIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          {num('base', BASE_LABEL[f.pay_basis], f.pay_basis === 'contract' ? 'A contractor is paid the bill amount typed each month — 0 if there is no standing base.' : undefined)}
          {monthly && (
            <Field label="Absence is worked out over" required>
              <Select value={f.absence_basis} onChange={e => set('absence_basis', e.target.value)}>
                <option value="calendar_days">Calendar days in the month</option>
                <option value="fixed_divisor">A fixed number of days</option>
              </Select>
            </Field>
          )}
          {monthly && f.absence_basis === 'fixed_divisor' && num('absence_divisor', 'Days to divide by', 'e.g. 26')}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {num('ot_hours_per_day', 'OT hours per day', 'Blank = 0 (no OT).')}
          {num('ot_multiplier', 'OT multiplier', 'Blank = 1.')}
          {num('ot_fixed_rate', 'OT fixed rate (₹/hour)', 'Replaces the formula.')}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Holiday pay" required>
            <Select value={f.holiday_mode} onChange={e => setMode(e.target.value)}>
              <option value="none">None</option>
              <option value="formula">Formula — base ÷ divisor × multiplier</option>
              <option value="fixed">A fixed monthly amount</option>
            </Select>
          </Field>
          {f.holiday_mode === 'fixed' && num('holiday_fixed', 'Holiday amount (₹ a month)')}
          {f.holiday_mode === 'formula' && num('holiday_divisor', 'Holiday divisor')}
          {f.holiday_mode === 'formula' && num('holiday_multiplier', 'Holiday multiplier')}
        </div>
        <Field label="Note">
          <Input value={f.note} autoComplete="off" placeholder="Why — e.g. annual increment" onChange={e => set('note', e.target.value)} />
        </Field>
        <InlineError message={error} className="" />
      </div>
    </Modal>
  );
}

// ── The drawer ──────────────────────────────────────────────────────────────

export default function PersonDrawer({ id = null, seed = null, level, channels = [], onClose, onChanged }) {
  const toast = useToast();
  const canEdit = levelAtLeast(level, 'operator');
  // null = a person not yet saved. Saving one promotes the drawer to that person in place.
  const [pid, setPid] = useState(id);
  const isNew = pid == null;
  const [person, setPerson] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [tab, setTab] = useState('details');
  const [reveal, setReveal] = useState(false);
  const [aliasText, setAliasText] = useState('');
  const [operators, setOperators] = useState(null);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [ask, setAsk] = useState(null); // { title, body, label, danger, run, error }
  // What the server (or the form check) last said about a save and about an alias, shown where the
  // person is working. Each is about the input as it was, so editing that input clears it.
  const [saveError, setSaveError] = useState(null);
  const [aliasError, setAliasError] = useState(null);
  const [payNotice, setPayNotice] = useState(null); // the server's warning about the revision just saved

  const baseline = useMemo(() => formFromPerson(person), [person]);
  const dirty = canEdit && !sameForm(form, baseline);
  const set = useCallback((key, value) => {
    setSaveError(null);
    setForm(cur => ({ ...cur, [key]: value }));
  }, []);

  // Loads the person whenever the drawer points at one — first open, and again right after a
  // new person is saved (the id arrives and the full record, with its empty history, follows).
  useEffect(() => {
    if (pid == null) return undefined;
    let live = true;
    setLoadFailed(false);
    hrApi.person(pid).then(p => {
      if (!live) return;
      setPerson(p);
      setForm(formFromPerson(p));
    }, () => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, [pid]);

  // After a pay revision or an alias: new history and aliases, but a form someone is half way
  // through typing in is theirs to keep.
  const refresh = useCallback(async ({ resetForm = false } = {}) => {
    if (pid == null) return;
    try {
      const p = await hrApi.person(pid);
      setPerson(p);
      if (resetForm) setForm(formFromPerson(p));
    } catch { /* the central toast has the reason; what is on screen stays */ }
  }, [pid]);

  // ERP operators are an operator-level list, asked for only when that tab is opened.
  useEffect(() => {
    if (tab !== 'erp' || !canEdit || operators != null) return undefined;
    let live = true;
    hrApi.erpOperators().then(r => { if (live) setOperators(Array.isArray(r) ? r : []); }, () => { if (live) setOperators([]); });
    return () => { live = false; };
  }, [tab, canEdit, operators]);

  const requestClose = useCallback(() => {
    if (dirty) {
      setAsk({
        title: 'Discard your changes?', body: 'What you typed has not been saved.', label: 'Discard', danger: true,
        run: async () => { onClose(); },
      });
    } else onClose();
  }, [dirty, onClose]);

  // Escape closes the drawer only — never a dialog or an open dropdown standing over it. Every
  // layer that exists only while open carries data-ci-overlay (the drawer itself too), so any
  // other one means Escape is theirs.
  const rootRef = useRef(null);
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
  useEffect(() => {
    const h = e => {
      if (e.key !== 'Escape') return;
      if ([...document.querySelectorAll('[data-ci-overlay]')].some(el => el !== rootRef.current)) return;
      e.stopPropagation();
      e.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);

  const save = async () => {
    const problems = problemsOf(form);
    if (problems.length) { setSaveError(problems.join(' ')); return; }
    setSaveError(null);
    let saved;
    try {
      saved = await hrApi.savePerson({ id: pid ?? undefined, ...bodyFromForm(form) });
    } catch (e) {
      setSaveError(refusalText(e)); // refused — said in the Save bar, and the form stays as typed
      return;
    }
    toast.success(isNew ? 'Person added' : 'Person saved');
    setReveal(false);
    onChanged?.();
    const savedId = saved?.id ?? pid;
    if (isNew && savedId != null) {
      // The effect above loads the new person; the pay setup is the next thing it needs.
      setPid(savedId);
      setTab('pay');
    } else {
      await refresh({ resetForm: true });
    }
  };

  const discard = () => { setForm(baseline); setReveal(false); setSaveError(null); };

  // One at a time: Enter in the box bypasses the Add button's own busy guard.
  const aliasBusy = useRef(false);
  const addAlias = async () => {
    const alias = aliasText.trim();
    if (!alias || pid == null || aliasBusy.current) return;
    aliasBusy.current = true;
    setAliasError(null);
    try {
      await hrApi.addAlias(pid, alias);
    } catch (e) {
      setAliasError(refusalText(e)); // refused — said under the box, and the spelling stays in it
      return;
    } finally {
      aliasBusy.current = false;
    }
    setAliasText('');
    toast.success('Alias added');
    await refresh();
  };
  const askRemoveAlias = a => setAsk({
    title: 'Remove this spelling?',
    body: `“${a.alias ?? a.alias_norm}” will no longer be matched to ${person?.name || 'this person'} automatically; a sheet that uses it will need matching by hand.`,
    label: 'Remove', danger: true,
    run: async () => {
      await hrApi.removeAlias(a.id);
      toast.success('Alias removed');
      await refresh();
    },
  });

  // Runs what the confirm dialog stands for. A refusal is said inside the dialog, and rethrown so
  // ConfirmDialog knows the action did not happen and stays open for a retry or a cancel.
  const confirmAsk = async () => {
    setAsk(a => (a ? { ...a, error: null } : a));
    try {
      await ask.run();
    } catch (e) {
      setAsk(a => (a ? { ...a, error: refusalText(e) } : a));
      throw e;
    }
  };
  const goTab = key => { setAliasError(null); setTab(key); };

  const tabs = isNew ? TABS.filter(t => t.key === 'details') : TABS;
  const title = person?.name || seed?.name || form.name.trim() || (isNew ? 'New person' : 'Person');
  const sub = isNew
    ? 'Save the details first — the pay setup, aliases and the rest follow.'
    : [person?.code ?? seed?.code, person?.department ?? seed?.department, person?.designation ?? seed?.designation].filter(Boolean).join(' · ');
  const setups = Array.isArray(person?.setups) ? person.setups : [];
  const aliases = Array.isArray(person?.aliases) ? person.aliases : [];
  const ready = isNew || person != null;

  return createPortal(
    <div ref={rootRef} data-ci-overlay className="no-print fixed inset-0 z-[45]">
      <div className="absolute inset-0 animate-fadeIn bg-[#1D1D1F]/25 backdrop-blur-[3px]" onClick={requestClose} />
      <aside role="dialog" aria-modal="true" aria-label={title} className="absolute inset-y-0 right-0 flex w-full max-w-[880px] p-0 sm:p-3">
        <div className="glass flex h-full w-full animate-scaleIn flex-col overflow-hidden rounded-none sm:rounded-[26px]">
          <div className="flex items-center gap-3 border-b border-[#1D1D1F]/[0.06] bg-white/45 px-4 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0071F0] text-white shadow-[0_6px_16px_rgba(0,113,240,0.35)]">
              <UserRound size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <p className="truncate text-[15px] font-bold tracking-[-0.01em] text-[#1D1D1F]">{title}</p>
                {!isNew && (person?.status || seed?.status) && <StatusPill status={person?.status ?? seed?.status} />}
              </div>
              {sub && <p className="truncate text-[11px] text-[#6E6E73]">{sub}</p>}
            </div>
            <button type="button" onClick={requestClose} aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1D1D1F]/[0.05] text-[#86868B] transition-colors hover:bg-[#1D1D1F]/[0.10] hover:text-[#1D1D1F]">
              <X size={16} />
            </button>
          </div>

          {tabs.length > 1 && (
            <div className="flex gap-1 overflow-x-auto border-b border-[#1D1D1F]/[0.06] bg-white/25 px-4 py-2 scrollbar-none">
              {tabs.map(t => (
                <button key={t.key} type="button" onClick={() => goTab(t.key)} aria-pressed={tab === t.key}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition touch:min-h-[40px] ${tab === t.key ? 'bg-white text-[#1D1D1F] shadow-[0_2px_8px_rgba(29,29,31,0.12)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'}`}>
                  <t.icon size={13} /> {t.label}
                  {t.key === 'pay' && setups.length > 0 && <span className="rounded-full bg-[#1D1D1F]/[0.07] px-1.5 text-[10px]">{setups.length}</span>}
                  {t.key === 'aliases' && aliases.length > 0 && <span className="rounded-full bg-[#1D1D1F]/[0.07] px-1.5 text-[10px]">{aliases.length}</span>}
                </button>
              ))}
            </div>
          )}

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {!ready && !loadFailed && (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-[#86868B]"><Loader2 size={16} className="animate-spin" /> Loading…</div>
            )}
            {loadFailed && (
              <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
                This person could not be loaded. Close the drawer and try again.
              </p>
            )}
            {ready && tab === 'details' && <DetailsTab form={form} set={set} canEdit={canEdit} channels={channels} person={person} />}
            {ready && tab === 'pay' && (
              <PayTab setups={setups} canEdit={canEdit} onNew={() => setRevisionOpen(true)}
                notice={payNotice} onDismissNotice={() => setPayNotice(null)} />
            )}
            {ready && tab === 'bank' && <BankTab form={form} set={set} canEdit={canEdit} person={person} reveal={reveal} setReveal={setReveal} />}
            {ready && tab === 'aliases' && (
              <AliasesTab aliases={aliases} canEdit={canEdit} text={aliasText} error={aliasError} onAdd={addAlias} onRemove={askRemoveAlias}
                setText={v => { setAliasError(null); setAliasText(v); }} />
            )}
            {ready && tab === 'erp' && <ErpTab form={form} set={set} canEdit={canEdit} operators={operators} />}
            {ready && tab === 'money' && <MoneyTab person={person} pid={pid} />}
          </div>

          {ready && canEdit && FORM_TABS.has(tab) && (
            <div className="border-t border-[#1D1D1F]/[0.06] bg-white/45 px-4 py-3">
              <InlineError message={saveError} className="mb-2.5" />
              <div className="flex items-center gap-2">
                <span className={`text-xs font-semibold ${dirty ? 'text-amber-700' : 'text-[#86868B]'}`}>
                  {dirty ? 'Unsaved changes' : isNew ? 'Fill in the details to add this person' : 'All changes saved'}
                </span>
                <span className="ml-auto" />
                <Button variant="secondary" onClick={discard} disabled={!dirty}>Discard</Button>
                <Button onClick={save} disabled={!dirty}>{isNew ? 'Add person' : 'Save changes'}</Button>
              </div>
            </div>
          )}
        </div>
      </aside>
      {revisionOpen && pid != null && (
        <RevisionModal pid={pid} setups={setups} onClose={() => setRevisionOpen(false)}
          onSaved={warning => { setRevisionOpen(false); setPayNotice(warning); onChanged?.(); refresh(); }} />
      )}
      <ConfirmDialog open={Boolean(ask)} onClose={() => setAsk(null)} onConfirm={confirmAsk}
        title={ask?.title} confirmLabel={ask?.label} danger={ask?.danger}
        message={ask && <>{ask.body}<InlineError message={ask.error} /></>} />
    </div>,
    document.body,
  );
}
