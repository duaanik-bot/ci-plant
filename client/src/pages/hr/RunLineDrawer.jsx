// HR → Payroll → one person's line for the month: what they are paid and how every rupee of it is
// worked out, the inputs behind it, its flags, last month beside it, its payment and its payslip.
// Spec §8 (the engine's fields and flags), §12 (what a draft allows), §13 (the payslip). This file is
// also the home of the small helpers Payroll.jsx and ImportWizard.jsx share: exact money sums, flag
// words, payment words, the plant month.
//
// Access. Inputs are editable only while the run is a draft, and only from operator up; every edit
// carries a reason (the server logs it and recalculates the line). A finalised line takes payment
// marks — paid or failed from operator up, reversed from approver up. The server enforces all of it;
// this only decides what to offer.
//
// Money is formatted, never worked out in floats. Where figures must be added (a merged column, a
// totals row, a channel's total), each amount is read as integer paise from its decimal spelling and
// summed as a BigInt (scaledOf / sumPaise), so the sum is exact; the result is kept as a decimal
// string, never as a BigInt, so a row can still be searched (rowMatches stringifies rows). Nothing is
// logged, and nothing here touches document.title.
//
// A refusal is said inline where the person is working (the Inputs box, the payment box), in the
// server's own words (refusalText). The central toast fires as well, but the drawer stands over the page.
//
// Amendments (the owner's rule: everything editable while the run is a draft, no hard blockers). The
// person's ledger of advances and loans sits in the drawer (PersonLedger, the Pay staff form's panel), with
// a Pay staff button that opens that form for this person. This month's advance and loan recoveries are
// typed in their own box beside the balances they come from; like every other input they are saved with a
// reason, and the engine's warnings (a typed recovery limited, pay short of recoveries) are shown, never a
// refusal of a typed value — only what the server itself refuses is said, inline. After a staff payment or
// an amendment the draft run is recalculated and the line read again.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, Banknote, CheckCircle2, ExternalLink, HandCoins, History, Info, Landmark, Loader2, OctagonAlert, Pencil,
  Receipt, X,
} from 'lucide-react';
import { Button, Checkbox, ConfirmDialog, Field, Input, Select, Textarea, useToast } from '../../components/ui.jsx';
import { fmt } from '../../api.js';
import { hrApi, inr2, levelAtLeast, monthLabel } from '../../lib/hr.js';
import { InlineError, StatusPill, parseNum, refusalText } from './PersonDrawer.jsx';
import PayStaffModal, { PersonLedger } from './PayStaffModal.jsx';

// ── Exact sums ──────────────────────────────────────────────────────────────
// Amounts arrive as JSON numbers (pg turns NUMERIC(12,2) into a float whose shortest spelling is the
// stored decimal) or as exact decimal strings (runs.totals). Either is read here as a BigInt of
// 10^-dp units from its spelling. Blank is 0; anything that is not a plain decimal with at most `dp`
// places is null, and a sum that meets a null is null — shown as '—', never as a wrong figure.
const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

export function scaledOf(v, dp) {
  if (v == null) return 0n;
  const s = String(v).trim();
  if (s === '') return 0n;
  const m = DECIMAL.exec(s);
  if (!m || (m[3] && m[3].length > dp)) return null;
  const units = BigInt(m[2]) * 10n ** BigInt(dp) + BigInt((m[3] || '').padEnd(dp, '0') || '0');
  return m[1] ? -units : units;
}

export function scaledText(units, dp) {
  if (units == null) return null;
  const neg = units < 0n;
  const a = neg ? -units : units;
  const base = 10n ** BigInt(dp);
  const whole = `${neg ? '-' : ''}${a / base}`;
  return dp ? `${whole}.${String(a % base).padStart(dp, '0')}` : whole;
}

export const paiseOf = v => scaledOf(v, 2);

// The exact total of `values` as a 2-dp string ('1234.50'), or null if any of them cannot be read.
export function sumPaise(values) {
  let total = 0n;
  for (const v of values) {
    const p = paiseOf(v);
    if (p === null) return null;
    total += p;
  }
  return scaledText(total, 2);
}

// The same for quantities (OT hours and days carry up to 4 places), trailing zeros dropped.
export function sumQty(values) {
  let total = 0n;
  for (const v of values) {
    const u = scaledOf(v, 4);
    if (u === null) return null;
    total += u;
  }
  return qtyText(scaledText(total, 4));
}

// a − b as a 2-dp string (exact), or null.
export function diffPaise(a, b) {
  const pa = paiseOf(a);
  const pb = paiseOf(b);
  return pa === null || pb === null ? null : scaledText(pa - pb, 2);
}

export const isZeroMoney = v => paiseOf(v) === 0n;
const isZeroQty = v => scaledOf(v, 4) === 0n;

// '+₹1,200.00' / '-₹300.00' / '₹0.00' — a change, said with its sign.
export function signedInr(v) {
  const p = paiseOf(v);
  if (p === null || v == null || v === '') return '—';
  return p > 0n ? `+${inr2(v)}` : inr2(v);
}

// A quantity for reading: '30.0000' → '30', 12.5 → '12.5', nothing → '—'.
export function qtyText(v) {
  if (v == null || (typeof v === 'string' && v.trim() === '')) return '—';
  const s = String(v).trim();
  const m = DECIMAL.exec(s);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? String(n) : '—';
  }
  const frac = (m[3] || '').replace(/0+$/, '');
  return `${m[1] && (m[2] !== '0' || frac) ? '-' : ''}${m[2].replace(/^0+(?=\d)/, '')}${frac ? `.${frac}` : ''}`;
}

// An exact figure as rupees with every place it has: '108.3333' → '₹108.3333'. For rates, which the
// engine cuts at four places (the formula beside it holds the exact sum); inr2 would round them.
const GROUP = new Intl.NumberFormat('en-IN');
export function exactInr(text) {
  const m = DECIMAL.exec(String(text ?? '').trim());
  if (!m) return text == null || text === '' ? '—' : String(text);
  return `${m[1] ? '-' : ''}₹${GROUP.format(BigInt(m[2]))}${m[3] ? `.${m[3]}` : ''}`;
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const list = v => (Array.isArray(v) ? v : []);

// ── Months, in plant time ───────────────────────────────────────────────────

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function istParts(withDay) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', ...(withDay ? { day: '2-digit' } : {}),
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type)?.value ?? '';
  return { year: get('year'), month: get('month'), day: get('day') };
}

// The month it is now at the plant ('2026-10'), whatever the browser's own time zone.
export function plantMonth() {
  const { year, month } = istParts(false);
  return `${year}-${month}`;
}

// Today at the plant ('2026-10-17').
export function plantToday() {
  const { year, month, day } = istParts(true);
  return `${year}-${month}-${day}`;
}

// '2026-01' shifted by n months: shiftMonth('2026-01', -1) → '2025-12'.
export function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

export const whenText = at => (at ? fmt.dt(at) : '');

// ── Flags ───────────────────────────────────────────────────────────────────
// The engine's flag codes (server/src/hr/engine.js header, plus ENGINE_ERROR and
// ADVANCE_BELOW_RECORDED from runs.js) in plain words. A code this build does not know still shows,
// in its own spelling; a level this build does not know reads as a warning, never as nothing.

export const FLAG_LABEL = {
  NO_SETUP: 'No pay setup',
  ABSENT_EXCEEDS_DAYS: 'Absent days above the month',
  BILL_AMOUNT_MISSING: 'No bill amount',
  HOURS_WORKED_MISSING: 'No hours worked',
  PAID_SEPARATELY_EXCEEDS: 'Paid separately above pay',
  ENGINE_ERROR: 'Could not be worked out',
  INSUFFICIENT_PAY: 'Pay short of recoveries',
  DEDUCTIONS_OVER_PCT: 'Deductions above the limit',
  HIGH_OT: 'High overtime',
  OT_NO_RATE: 'OT with no OT rate',
  NO_BANK_DETAILS: 'No bank details',
  OVERRIDE_CLAMPED: 'Typed recovery limited',
  PERSON_EXITED: 'Marked as left',
  NOT_EMPLOYED_THIS_MONTH: 'Not employed this month',
  ADVANCE_BELOW_RECORDED: 'Sheet advance below the app',
  JOINED_MID_MONTH: 'Joined mid-month',
  LEFT_MID_MONTH: 'Left mid-month',
  VARIANCE: 'Changed against last month',
};

export function flagLabel(code) {
  if (FLAG_LABEL[code]) return FLAG_LABEL[code];
  const words = String(code || 'flag').replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const LEVEL_META = {
  block: { label: 'Blocking', plural: 'blocking', dot: 'bg-red-500', ink: 'text-red-700', box: 'border-red-200 bg-red-50', icon: OctagonAlert },
  warn: { label: 'Warning', plural: 'warnings', dot: 'bg-amber-500', ink: 'text-amber-800', box: 'border-amber-200 bg-amber-50', icon: AlertTriangle },
  info: { label: 'Note', plural: 'notes', dot: 'bg-sky-500', ink: 'text-sky-800', box: 'border-sky-200 bg-sky-50/70', icon: Info },
};
const LEVEL_RANK = { block: 0, warn: 1, info: 2 };

export const levelOf = f => (LEVEL_META[f?.level] ? f.level : 'warn');
export const flagsOf = line => list(line?.flags).filter(f => f && typeof f === 'object');
export const isBlocked = line => flagsOf(line).some(f => levelOf(f) === 'block');
const byLevel = flags => [...flags].sort((a, b) => LEVEL_RANK[levelOf(a)] - LEVEL_RANK[levelOf(b)]);

export function FlagList({ flags }) {
  return (
    <ul className="space-y-1.5">
      {byLevel(flags).map((f, i) => {
        const meta = LEVEL_META[levelOf(f)];
        const Icon = meta.icon;
        return (
          <li key={`${f.code}-${i}`} className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${meta.box}`}>
            <Icon size={14} className={`mt-px shrink-0 ${meta.ink}`} />
            <span className="min-w-0 break-words">
              <span className={`font-bold ${meta.ink}`}>{flagLabel(f.code)}</span>
              {f.message && <span className="text-[#3A3A3C]"> — {f.message}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// Red and amber dots with their counts, for a register row. Notes alone show a quiet blue dot; a line
// with nothing at all shows a tick. The messages ride in the title and the label says the counts.
export function FlagDots({ flags }) {
  const n = { block: 0, warn: 0, info: 0 };
  for (const f of flags) n[levelOf(f)] += 1;
  const said = [n.block && `${n.block} blocking`, n.warn && plural(n.warn, 'warning'), n.info && plural(n.info, 'note')].filter(Boolean);
  const title = byLevel(flags).map(f => `${flagLabel(f.code)}${f.message ? ` — ${f.message}` : ''}`).join('\n');
  if (!flags.length) {
    return <span aria-label="No flags" title="No flags" className="inline-flex text-emerald-600"><CheckCircle2 size={14} /></span>;
  }
  return (
    <span aria-label={said.join(', ')} title={title} className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {n.block > 0 && <Dot tone="block" count={n.block} />}
      {n.warn > 0 && <Dot tone="warn" count={n.warn} />}
      {n.block + n.warn === 0 && <Dot tone="info" count={n.info} />}
    </span>
  );
}

function Dot({ tone, count }) {
  const meta = LEVEL_META[tone];
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-bold tabular-nums ${meta.ink}`}>
      <span aria-hidden className={`h-2 w-2 rounded-full ${meta.dot}`} />{count}
    </span>
  );
}

// ── Payment words ───────────────────────────────────────────────────────────

// pending is what the owner calls Unpaid; on_hold is not to be paid until released (it carries a reason).
export const PAYMENT_STATUS = {
  pending: { label: 'Unpaid', tone: 'bg-gray-100 text-gray-600' },
  paid: { label: 'Paid', tone: 'bg-emerald-50 text-emerald-700' },
  on_hold: { label: 'On hold', tone: 'bg-amber-50 text-amber-800' },
  failed: { label: 'Payment failed', tone: 'bg-red-50 text-red-700' },
  reversed: { label: 'Reversed', tone: 'bg-red-50 text-red-700' },
};

// `reason` (an on-hold line's hold_reason) shows on hover, and on a tap: the pill is then a button that opens it.
export function PaymentPill({ status, reason }) {
  const meta = PAYMENT_STATUS[status] || PAYMENT_STATUS.pending;
  const [open, setOpen] = useState(false);
  const cls = `inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ring-[#1D1D1F]/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] ${meta.tone}`;
  const body = (
    <>
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />
      {meta.label}
    </>
  );
  if (!reason) return <span className={cls}>{body}</span>;
  return (
    <span className="relative inline-flex">
      <button type="button" className={cls} title={reason} aria-expanded={open}
        aria-label={`${meta.label}: ${reason}`}
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        onBlur={() => setOpen(false)}>
        {body}
      </button>
      {open && (
        <span role="tooltip" className="absolute left-0 top-full z-20 mt-1 w-56 whitespace-normal rounded-xl border border-amber-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-[#3A3A3C] shadow-card">
          {reason}
        </span>
      )}
    </span>
  );
}

// ── The inputs form ─────────────────────────────────────────────────────────
// Exactly the run_inputs columns (spec §7). Blank is "not given" and is sent as null — for a typed
// holiday or a typed recovery, blank and 0 mean different things, so the text is kept as typed.

const INPUT_NUMBERS = [
  { key: 'ot_hours', label: 'OT hours', dp: 4 },
  { key: 'absent_days', label: 'Absent days', dp: 4, hint: 'Half days are allowed, e.g. 2.5.' },
  { key: 'paid_leave_days', label: 'Paid leave days', dp: 4, hint: 'Recorded only — paid leave is paid.' },
  { key: 'hours_worked', label: 'Hours worked', dp: 4, hint: 'Hourly pay only.' },
  { key: 'bill_amount', label: 'Bill amount (₹)', dp: 2, hint: 'Contract pay only.' },
  { key: 'misc_earning', label: 'Misc earning (₹)', dp: 2 },
  { key: 'bonus', label: 'Bonus (₹)', dp: 2 },
  { key: 'holiday_override', label: 'Holiday pay, typed (₹)', dp: 2, hint: 'Blank = from the pay setup. 0 = none this month.' },
  { key: 'misc_deduction', label: 'Misc deduction (₹)', dp: 2 },
  { key: 'advance_given', label: 'Advance given this month (₹)', dp: 2 },
  { key: 'advance_recovery_override', label: 'Advance to recover (₹)', dp: 2, hint: 'Blank = the whole balance.' },
  { key: 'loan_recovery_override', label: 'Loan instalments to recover (₹)', dp: 2, hint: 'Blank = what is due.' },
  { key: 'paid_separately', label: 'Paid separately (₹)', dp: 2, hint: 'Already paid outside payroll; taken off payable.' },
];
const TEXT_KEYS = ['remarks', 'paid_separately_note'];
// The two recoveries get their own box, next to the balances they are taken from.
const RECOVERY_KEYS = new Set(['advance_recovery_override', 'loan_recovery_override']);

function formFromInput(input) {
  const f = {};
  for (const { key } of INPUT_NUMBERS) f[key] = input?.[key] == null ? '' : String(input[key]);
  for (const key of TEXT_KEYS) f[key] = input?.[key] == null ? '' : String(input[key]);
  f.advance_mode = input?.advance_mode === 'extra' ? 'extra' : 'total';
  f.include = input ? input.include !== false : true;
  return f;
}

const sameForm = (a, b) => Object.keys(a).every(k => a[k] === b[k]);

function validateForm(f) {
  const e = {};
  for (const { key, dp } of INPUT_NUMBERS) {
    const r = parseNum(f[key], dp);
    if (r.error) e[key] = r.error;
  }
  return e;
}

function bodyFromForm(f) {
  const body = {};
  for (const { key, dp } of INPUT_NUMBERS) {
    const r = parseNum(f[key], dp);
    body[key] = r.blank ? null : r.value;
  }
  for (const key of TEXT_KEYS) body[key] = f[key].trim() === '' ? null : f[key].trim();
  body.advance_mode = f.advance_mode;
  body.include = Boolean(f.include);
  return body;
}

// ── Small pieces ────────────────────────────────────────────────────────────

function Section({ title, icon: Icon, right, children }) {
  return (
    <section className="rounded-[20px] border border-white/75 bg-white/55 p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        {Icon && <Icon size={14} className="shrink-0 text-[#6E6E73]" />}
        <h4 className="min-w-0 flex-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[#6E6E73]">{title}</h4>
        {right}
      </div>
      {children}
    </section>
  );
}

const Note = ({ tone = 'amber', children }) => (
  <p className={`mt-2 rounded-xl px-3 py-2 text-xs font-medium ${tone === 'amber' ? 'bg-amber-50 text-amber-800' : tone === 'red' ? 'bg-red-50 text-red-700' : 'bg-[#1D1D1F]/[0.04] text-[#515154]'}`}>
    {children}
  </p>
);

const TH = 'px-2.5 py-2 text-left';
const TD = 'px-2.5 py-2 align-top';

// ── The breakdown ───────────────────────────────────────────────────────────
// The engine's components exactly as stored ({code, label, kind, qty, rate, formula, amount}), with
// the line's own totals between them. Deductions read with a minus; nothing is recomputed here.

function Breakdown({ line }) {
  const comps = list(line?.breakdown).filter(c => c && typeof c === 'object');
  const earnings = comps.filter(c => c.kind === 'earning');
  const deductions = comps.filter(c => c.kind === 'deduction');
  const info = comps.filter(c => c.kind !== 'earning' && c.kind !== 'deduction');
  if (!comps.length) {
    return <p className="text-xs text-[#6E6E73]">Nothing could be worked out for this line — the flags above say why.</p>;
  }
  const flat = c => String(c.qty) === '1' && String(c.rate) === String(c.amount);
  const item = (c, sign = '') => (
    <tr key={`${c.code}-${c.label}`} className="ci-table-row">
      <td className={`${TD} font-semibold text-[#1D1D1F]`}>{c.label || c.code}</td>
      <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>{flat(c) ? '—' : qtyText(c.qty)}</td>
      <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>{flat(c) ? '—' : exactInr(c.rate)}</td>
      <td className={`${TD} text-[11px] text-[#515154]`}>{c.formula || '—'}</td>
      <td className={`${TD} whitespace-nowrap text-right font-semibold tabular-nums`}>{sign}{inr2(c.amount)}</td>
    </tr>
  );
  const total = (label, value, strong) => (
    <tr className="border-t border-[#1D1D1F]/[0.08] bg-white/60">
      <td colSpan={4} className={`${TD} ${strong ? 'text-sm font-extrabold' : 'font-bold'} text-[#1D1D1F]`}>{label}</td>
      <td className={`${TD} whitespace-nowrap text-right tabular-nums ${strong ? 'text-sm font-extrabold' : 'font-bold'} text-[#1D1D1F]`}>{inr2(value)}</td>
    </tr>
  );
  const infoRow = c => {
    const sign = c.code === 'PAID_SEPARATELY' ? '-' : c.code === 'ROUNDING' && paiseOf(c.amount) > 0n ? '+' : '';
    return (
      <tr key={`${c.code}-${c.label}`} className="ci-table-row">
        <td className={`${TD} font-semibold text-[#1D1D1F]`}>{c.label || c.code}</td>
        <td className={TD} />
        <td className={TD} />
        <td className={`${TD} text-[11px] text-[#515154]`}>{c.formula || '—'}</td>
        <td className={`${TD} whitespace-nowrap text-right font-semibold tabular-nums`}>{sign}{inr2(c.amount)}</td>
      </tr>
    );
  };
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/75 bg-white/55">
      <table className="w-full text-xs">
        <thead>
          <tr className="ci-table-head">
            <th className={TH}>Item</th>
            <th className={`${TH} text-right`}>Qty</th>
            <th className={`${TH} text-right`}>Rate</th>
            <th className={TH}>How it is worked out</th>
            <th className={`${TH} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {earnings.map(c => item(c))}
          {total('Gross', line.gross)}
          {deductions.map(c => item(c, '-'))}
          {deductions.length > 0 && total('Total deductions', line.total_deductions)}
          {total('Net pay', line.net)}
          {info.map(infoRow)}
          {total('Payable', line.payable, true)}
        </tbody>
      </table>
    </div>
  );
}

// What the cap did, what is left owing, and the advance carried into next month (spec §8).
function AfterTheCap({ line }) {
  const unrec = line?.unrecovered && typeof line.unrecovered === 'object' ? line.unrecovered : {};
  const loanLeft = sumPaise(list(unrec.loans).map(l => l?.amount));
  const owing = [
    ['advance', unrec.advance], ['loans', loanLeft], ['other deductions', unrec.other],
  ].filter(([, v]) => v != null && !isZeroMoney(v) && paiseOf(v) !== null);
  const negative = paiseOf(line?.net_before_cap);
  return (
    <>
      {negative !== null && negative < 0n && (
        <Note>
          Before the cap this came to {inr2(line.net_before_cap)} (the workbook’s “Final Payment”). Recoveries were
          cut so pay does not go below zero; what was not recovered stays in its balance.
        </Note>
      )}
      {owing.length > 0 && (
        <Note>Left owing after this month: {owing.map(([k, v]) => `${k} ${inr2(v)}`).join(' · ')}.</Note>
      )}
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#6E6E73]">
        <span>Days in month <b className="text-[#1D1D1F]">{qtyText(line?.days)}</b></span>
        <span>Present <b className="text-[#1D1D1F]">{qtyText(line?.present_days)}</b></span>
        {line?.days_not_employed != null && !isZeroQty(line.days_not_employed) && (
          <span>Not employed <b className="text-[#1D1D1F]">{qtyText(line.days_not_employed)}</b></span>
        )}
        {line?.daily_rate != null && !isZeroMoney(line.daily_rate) && (
          <span>Daily rate <b className="text-[#1D1D1F]">{inr2(line.daily_rate)}</b></span>
        )}
        <span>Advance balance after this month <b className="text-[#1D1D1F]">{inr2(line?.carried_advance)}</b></span>
      </p>
    </>
  );
}

// ── Last month ──────────────────────────────────────────────────────────────

const VARIANCE_PARTS = [
  ['revision', 'Pay revision'], ['attendance', 'Attendance'], ['ot', 'Overtime'], ['holiday', 'Holiday'],
  ['misc', 'Misc'], ['advance', 'Advance'], ['loan', 'Loan'], ['other', 'Other'],
];

function LastMonth({ prevMonth, loadPrevious, personId, line, input, variance }) {
  const [state, setState] = useState({ status: prevMonth ? 'loading' : 'none' });
  useEffect(() => {
    if (!prevMonth || !loadPrevious) { setState({ status: 'none' }); return undefined; }
    let live = true;
    setState({ status: 'loading' });
    loadPrevious().then(d => {
      if (!live) return;
      const same = x => String(x?.person_id) === String(personId);
      setState({ status: 'ready', line: list(d?.lines).find(same) || null, input: list(d?.inputs).find(same) || null });
    }, () => { if (live) setState({ status: 'failed' }); });
    return () => { live = false; };
  }, [prevMonth, loadPrevious, personId]);

  if (state.status === 'none') {
    return <p className="text-xs text-[#86868B]">No earlier finalised month to compare with.</p>;
  }
  if (state.status === 'loading') {
    return <p className="flex items-center gap-2 text-xs text-[#86868B]"><Loader2 size={13} className="animate-spin" /> Reading {monthLabel(prevMonth)}…</p>;
  }
  if (state.status === 'failed') return <p className="text-xs text-red-700">{monthLabel(prevMonth)} could not be read.</p>;
  const prev = state.line;
  const parts = variance?.parts && typeof variance.parts === 'object' ? variance.parts : {};
  const moved = VARIANCE_PARTS.filter(([k]) => parts[k] != null && !isZeroMoney(parts[k]) && paiseOf(parts[k]) !== null);
  const unexplained = variance?.unexplained;
  const row = (label, was, now, money = true) => (
    <tr key={label} className="ci-table-row">
      <td className={`${TD} font-semibold text-[#1D1D1F]`}>{label}</td>
      <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>{money ? inr2(was) : qtyText(was)}</td>
      <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>{money ? inr2(now) : qtyText(now)}</td>
      <td className={`${TD} whitespace-nowrap text-right tabular-nums text-[#515154]`}>
        {money && was != null && now != null ? signedInr(diffPaise(now, was)) : ''}
      </td>
    </tr>
  );
  return (
    <div className="space-y-2">
      {!prev ? (
        <p className="text-xs text-[#86868B]">Not on the {monthLabel(prevMonth)} payroll.</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/75 bg-white/55">
          <table className="w-full text-xs">
            <thead>
              <tr className="ci-table-head">
                <th className={TH} />
                <th className={`${TH} text-right`}>{monthLabel(prevMonth)}</th>
                <th className={`${TH} text-right`}>This month</th>
                <th className={`${TH} text-right`}>Change</th>
              </tr>
            </thead>
            <tbody>
              {row('Gross', prev.gross, line?.gross)}
              {row('Deductions', prev.total_deductions, line?.total_deductions)}
              {row('Payable', prev.payable, line?.payable)}
              {row('Present days', prev.present_days, line?.present_days, false)}
              {row('OT hours', state.input?.ot_hours, input?.ot_hours, false)}
            </tbody>
          </table>
        </div>
      )}
      {variance && (
        <p className="text-xs text-[#515154]">
          {moved.length
            ? <>What moved it: {moved.map(([k, label]) => `${label} ${signedInr(parts[k])}`).join(' · ')}.</>
            : 'No part of the pay moved against last month.'}
        </p>
      )}
      {variance && unexplained != null && !isZeroMoney(unexplained) && (
        <Note>Not explained by the split: {signedInr(unexplained)}. Check this line before it is approved.</Note>
      )}
    </div>
  );
}

// ── Payment marks (a finalised line) ────────────────────────────────────────

function PaymentBox({ month, personId, line, level, onChanged }) {
  const toast = useToast();
  const status = line?.payment_status || 'pending';
  const canMark = levelAtLeast(level, 'operator');
  const canReverse = levelAtLeast(level, 'approver');
  const [act, setAct] = useState(null); // 'paid' | 'failed' | 'reversed'
  const [ref, setRef] = useState('');
  const [error, setError] = useState('');
  const held = status === 'on_hold';
  const offers = held ? [] : [
    status !== 'paid' && { key: 'paid', label: 'Mark paid' },
    (status === 'pending' || status === 'paid') && { key: 'failed', label: 'Mark failed' },
    status === 'paid' && canReverse && { key: 'reversed', label: 'Reverse payment' },
  ].filter(Boolean);
  const save = async () => {
    setError('');
    try {
      await hrApi.setLinePayment(month, personId, { status: act, reference: ref.trim() || null });
    } catch (e) {
      setError(refusalText(e));
      return;
    }
    toast.success(act === 'paid' ? 'Marked paid' : act === 'failed' ? 'Marked as failed' : 'Payment reversed');
    setAct(null);
    setRef('');
    onChanged?.();
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-[#515154]">
        <PaymentPill status={status} />
        {line?.paid_on && <span>on {fmt.date(line.paid_on)}</span>}
        {line?.paid_ref && <span>· ref <span className="font-mono">{line.paid_ref}</span></span>}
        {line?.paid_amount != null && status === 'paid' && <span>· {inr2(line.paid_amount)}</span>}
      </div>
      {held && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          On hold{line?.hold_reason ? `: “${line.hold_reason}”` : ''}
          {(line?.held_by_name || line?.held_at) && <span className="block text-[11px] opacity-80">
            {[line.held_by_name && `by ${line.held_by_name}`, line.held_at && fmt.dt(line.held_at)].filter(Boolean).join(' · ')}
          </span>}
          <span className="mt-1 block text-[11px]">A line on hold is not paid. To release it, tick it in the register and choose Mark unpaid.</span>
        </p>
      )}
      {canMark && !act && offers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {offers.map(o => (
            <Button key={o.key} size="sm" variant={o.key === 'reversed' ? 'danger' : 'secondary'} onClick={() => { setAct(o.key); setError(''); }}>
              {o.label}
            </Button>
          ))}
        </div>
      )}
      {act && (
        <div className="rounded-2xl border border-white/75 bg-white/70 p-3">
          <Field label={act === 'paid' ? 'Reference (UTR, cheque or cash note)' : 'Reference or reason'}>
            <Input value={ref} autoComplete="off" onChange={e => setRef(e.target.value)} />
          </Field>
          <InlineError message={error} />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => { setAct(null); setError(''); }}>Cancel</Button>
            <Button size="sm" variant={act === 'reversed' ? 'danger' : 'primary'} onClick={save}>
              {act === 'paid' ? 'Mark paid' : act === 'failed' ? 'Mark failed' : 'Reverse'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── This month's recoveries (amendable) ─────────────────────────────────────
// The balances they come from (the ledger, as it stands) and what the line takes now, beside the two typed
// overrides. Blank takes the default (the whole advance balance; each loan's instalment due); a typed figure
// is the engine's to honour or limit — it says so in the flags, it is never refused here.

function RecoveriesBox({ line, ledger, form, errors, tried, canEdit, set }) {
  const totals = ledger?.totals || {};
  const loans = list(totals.loans).filter(l => l.status === 'active');
  const dueNow = sumPaise(loans.map(l => l.due_this_month));
  const field = (key, label, hint) => (
    <Field label={label} hint={tried && errors[key] ? <span className="font-semibold text-red-600">{errors[key]}</span> : hint}>
      <Input inputMode="decimal" autoComplete="off" value={form[key]} disabled={!canEdit} placeholder="Blank = default"
        onChange={e => set(key, e.target.value)} />
    </Field>
  );
  return (
    <div className="mb-3 rounded-2xl border border-[#0A84FF]/15 bg-[#E1EFFF]/35 p-3">
      <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-[#0064D2]">This month’s recoveries</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          {field('advance_recovery_override', 'Advance to recover (₹)', 'Blank = the whole balance.')}
          <p className="mt-1 text-[11px] text-[#515154]">
            Balance {inr2(totals.advance_balance)}{line ? ` · this line takes ${inr2(line.advance_recovery)}` : ''}
          </p>
        </div>
        <div>
          {field('loan_recovery_override', 'Loan instalments to recover (₹)', 'Blank = what is due.')}
          <p className="mt-1 text-[11px] text-[#515154]">
            {loans.length
              ? `${loans.map(l => `${l.loan_no} left ${inr2(l.outstanding)}`).join(' · ')} · due now ${inr2(dueNow)}`
              : 'No open loan.'}
            {line ? ` · this line takes ${inr2(line.loan_recovery)}` : ''}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── The drawer ──────────────────────────────────────────────────────────────

export default function RunLineDrawer({
  month, run, personId, person = null, line = null, input = null, channelLabel = c => c || '',
  level, variance = null, prevMonth = null, loadPrevious = null, people = null, channels = null, onClose, onChanged,
}) {
  const toast = useToast();
  const status = run?.status || 'draft';
  const canEdit = levelAtLeast(level, 'operator') && status === 'draft';
  const canPay = levelAtLeast(level, 'operator');
  const [ledgerVersion, setLedgerVersion] = useState(0);
  const [ledger, setLedger] = useState(null);
  const [paying, setPaying] = useState(false);
  useEffect(() => {
    let live = true;
    hrApi.personLedger(personId).then(d => { if (live) setLedger(d); }, () => { if (live) setLedger(null); });
    return () => { live = false; };
  }, [personId, ledgerVersion]);

  // A staff payment moves the balances this line recovers: a draft run is worked out again, then the page
  // reads the run again so the line shows the new figures.
  const afterPayment = async () => {
    setLedgerVersion(v => v + 1);
    if (run && status === 'draft' && canEdit) {
      try {
        await hrApi.recalcRun(month);
        toast.success('Run recalculated with the payment');
      } catch { /* refused — the central toast says why */ }
    }
    onChanged?.();
  };

  // The line the last save answered with, shown until the page has reloaded the run.
  const [saved, setSaved] = useState(null);
  useEffect(() => { setSaved(null); }, [line]);
  const shown = saved ? saved.line : line;

  const baseline = useMemo(() => formFromInput(input), [input]);
  const [form, setForm] = useState(baseline);
  // A reload after a save brings the stored inputs back; a form someone is typing in is theirs to keep.
  const lastBaseline = useRef(baseline);
  useEffect(() => {
    setForm(f => (sameForm(f, lastBaseline.current) ? baseline : f));
    lastBaseline.current = baseline;
  }, [baseline]);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [ask, setAsk] = useState(false);
  const errors = useMemo(() => validateForm(form), [form]);
  const dirty = canEdit && !sameForm(form, baseline);
  const set = (key, value) => { setForm(f => ({ ...f, [key]: value })); setSaveError(''); };

  const save = async () => {
    setTried(true);
    setSaveError('');
    if (Object.keys(errors).length) { setSaveError('Check the highlighted figures.'); return; }
    if (!reason.trim()) { setSaveError('Say why this is being changed — the reason is kept with the change.'); return; }
    let res;
    try {
      res = await hrApi.saveRunInput(month, personId, { ...bodyFromForm(form), reason: reason.trim() });
    } catch (e) {
      setSaveError(refusalText(e)); // refused — said here; the form keeps what was typed
      return;
    }
    setSaved({ line: res?.line ?? null });
    setReason('');
    setTried(false);
    setLedgerVersion(v => v + 1);
    toast.success(input ? 'Inputs saved — the line is recalculated' : 'Added to this month’s run');
    onChanged?.();
  };

  const requestClose = () => { if (dirty) setAsk(true); else onClose(); };

  // Escape closes the drawer only when nothing stands over it (a dialog, an open dropdown).
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

  const flags = flagsOf(shown);
  const name = line?.name ?? line?.person_name ?? person?.name ?? `Person #${personId}`;
  const code = line?.code ?? line?.person_code ?? person?.code;
  const channel = shown?.pay_channel ?? person?.pay_channel ?? null;
  const sub = [code, person?.department, channel ? channelLabel(channel) : null].filter(Boolean).join(' · ');
  const leftOut = input && input.include === false;
  const notInRun = !input && !line;
  const final = status === 'finalised';
  const slipHref = `/hr/payslips/${month}?person_ids=${encodeURIComponent(String(personId))}`;

  return createPortal(
    <div ref={rootRef} data-ci-overlay className="no-print fixed inset-0 z-[45]">
      <div className="absolute inset-0 animate-fadeIn bg-[#1D1D1F]/25 backdrop-blur-[3px]" onClick={requestClose} />
      <aside role="dialog" aria-modal="true" aria-label={name} className="absolute inset-y-0 right-0 flex w-full max-w-[900px] p-0 sm:p-3">
        <div className="glass flex h-full w-full animate-scaleIn flex-col overflow-hidden rounded-none sm:rounded-[26px]">
          <div className="flex items-center gap-3 border-b border-[#1D1D1F]/[0.06] bg-white/45 px-4 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0071F0] text-white shadow-[0_6px_16px_rgba(0,113,240,0.35)]">
              <Receipt size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <p className="truncate text-[15px] font-bold tracking-[-0.01em] text-[#1D1D1F]">{name}</p>
                {person?.status && person.status !== 'active' && <StatusPill status={person.status} />}
                {leftOut && <span className="rounded-full bg-[#1D1D1F]/[0.07] px-2 py-0.5 text-[11px] font-bold text-[#515154]">Left out this month</span>}
                {notInRun && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700">Not in this run</span>}
                {(final || shown?.payment_status === 'on_hold') && shown && <PaymentPill status={shown.payment_status || 'pending'} reason={shown.hold_reason} />}
              </div>
              <p className="truncate text-[11px] text-[#6E6E73]">{monthLabel(month)}{sub ? ` · ${sub}` : ''}</p>
            </div>
            <button type="button" onClick={requestClose} aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1D1D1F]/[0.05] text-[#86868B] transition-colors hover:bg-[#1D1D1F]/[0.10] hover:text-[#1D1D1F]">
              <X size={16} />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {flags.length > 0 && (
              <Section title="Flags" icon={AlertTriangle}>
                <FlagList flags={flags} />
              </Section>
            )}

            <Section title="Pay" icon={Banknote} right={shown && (
              <a href={slipHref} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-[#0A84FF]/25 bg-[#E1EFFF]/60 px-2.5 py-1 text-[11px] font-bold text-[#0064D2] hover:bg-[#E1EFFF]">
                <ExternalLink size={12} /> {final ? 'Payslip' : 'Payslip preview (not final)'}
              </a>
            )}>
              {shown ? (
                <>
                  <Breakdown line={shown} />
                  <AfterTheCap line={shown} />
                </>
              ) : (
                <p className="text-xs text-[#6E6E73]">
                  {notInRun ? 'Not in this month’s run. Add the month’s figures below to include them.'
                    : leftOut ? 'Left out of this month’s payroll — nothing is paid. Tick “Include” below to bring them back.'
                    : 'Not worked out yet — recalculate the run.'}
                </p>
              )}
            </Section>

            <Section title={notInRun ? 'Add to this month' : 'Inputs'} icon={Pencil} right={input && (
              <span className="rounded-full bg-[#1D1D1F]/[0.07] px-2 py-0.5 text-[10px] font-bold text-[#515154]">
                {input.source === 'manual' ? 'Typed by hand' : 'From the sheet'}
              </span>
            )}>
              {!canEdit && (
                <p className="mb-2.5 rounded-2xl border border-[#1D1D1F]/[0.06] bg-white/55 px-3 py-2 text-xs font-medium text-[#6E6E73]">
                  {status !== 'draft'
                    ? `Inputs are frozen — the run is ${status}. A change needs the run sent back to draft.`
                    : 'View only — your HR access level can read the run but not change it.'}
                </p>
              )}
              <RecoveriesBox line={shown} ledger={ledger} form={form} errors={errors} tried={tried} canEdit={canEdit} set={set} />
              <div data-ci-form className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {INPUT_NUMBERS.filter(({ key }) => !RECOVERY_KEYS.has(key)).map(({ key, label, hint }) => (
                  <Field key={key} label={label}
                    hint={tried && errors[key] ? <span className="font-semibold text-red-600">{errors[key]}</span> : hint}>
                    <Input inputMode="decimal" autoComplete="off" value={form[key]} disabled={!canEdit}
                      onChange={e => set(key, e.target.value)} />
                  </Field>
                ))}
                <Field label="The sheet’s advance is"
                  hint={form.advance_mode === 'extra' ? 'Added on top of advances already given in the app this month.' : 'Includes advances already given in the app this month; only the difference is added.'}>
                  <Select value={form.advance_mode} disabled={!canEdit} onChange={e => set('advance_mode', e.target.value || 'total')}
                    options={[{ value: 'total', label: 'The month’s total' }, { value: 'extra', label: 'Extra' }]} />
                </Field>
                <Field label="Paid separately — note">
                  <Input value={form.paid_separately_note} disabled={!canEdit} autoComplete="off"
                    onChange={e => set('paid_separately_note', e.target.value)} />
                </Field>
                <Field label="Remarks" className="sm:col-span-2 lg:col-span-3">
                  <Input value={form.remarks} disabled={!canEdit} autoComplete="off" onChange={e => set('remarks', e.target.value)} />
                </Field>
                <div className="sm:col-span-2 lg:col-span-3">
                  <Checkbox label="Include in this month’s payroll" checked={form.include} disabled={!canEdit}
                    onChange={e => set('include', e.target.checked)} />
                </div>
              </div>
              {canEdit && (
                <div className="mt-3 space-y-2 border-t border-[#1D1D1F]/[0.06] pt-3">
                  <Field label="Why the change" required hint="Kept with the change in the HR audit log.">
                    <Textarea value={reason} onChange={e => { setReason(e.target.value); setSaveError(''); }} />
                  </Field>
                  <InlineError message={saveError} className="" />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-xs font-semibold ${dirty ? 'text-amber-700' : 'text-[#86868B]'}`}>
                      {dirty ? 'Unsaved changes' : notInRun ? 'Fill in the month’s figures to add them' : 'No changes'}
                    </span>
                    <span className="ml-auto" />
                    <Button variant="secondary" onClick={() => { setForm(baseline); setSaveError(''); setTried(false); }} disabled={!dirty}>Discard</Button>
                    <Button onClick={save} disabled={!dirty && !notInRun}>{notInRun ? 'Add to the run' : 'Save and recalculate'}</Button>
                  </div>
                </div>
              )}
            </Section>

            <Section title="Advances and loans" icon={Landmark} right={canPay && (
              <Button size="sm" variant="secondary" onClick={() => setPaying(true)}><HandCoins size={13} /> Pay staff</Button>
            )}>
              <PersonLedger personId={personId} version={ledgerVersion} ledger={ledger} compact />
              {canPay && status !== 'draft' && (
                <p className="mt-2 text-[11px] text-[#86868B]">
                  This run is {status}: a payment made now is recovered by the next open payroll.
                </p>
              )}
            </Section>

            <Section title="Compared with last month" icon={History}>
              <LastMonth prevMonth={prevMonth} loadPrevious={loadPrevious} personId={personId}
                line={shown} input={input} variance={variance} />
            </Section>

            {(final || shown?.payment_status === 'on_hold') && shown && (
              <Section title="Payment" icon={CheckCircle2}>
                <PaymentBox month={month} personId={personId} line={shown} level={level} onChanged={onChanged} />
              </Section>
            )}
          </div>
        </div>
      </aside>
      {paying && (
        <PayStaffModal personId={personId} people={people} channels={channels}
          onClose={() => setPaying(false)} onDone={afterPayment} />
      )}
      <ConfirmDialog open={ask} onClose={() => setAsk(false)} onConfirm={() => onClose()}
        title="Discard your changes?" message="What you typed has not been saved." confirmLabel="Discard" danger />
    </div>,
    document.body,
  );
}
