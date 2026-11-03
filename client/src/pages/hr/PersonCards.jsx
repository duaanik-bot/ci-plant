// HR · Payroll register as person cards (owner's request 2026-11-03: "only name, gross, advances and approval on the
// face; everything else inside the person, hide / unhide; once approved the person goes to the approved list").
//
// Face of a card: tick box, chevron, name · code · department (flag dots, payment pill when not unpaid), Gross,
// Advance, Payable, Approval (pill + Approve / Undo for an approver). The chevron (or Enter) opens the full breakdown
// underneath — earnings, deductions, payment, approval, flags — and "Open full record" opens the person's drawer.
// Expand all / Collapse all act on the cards shown.
//
// Sections, once people can be approved (submitted run on): To approve · Approved · Nothing to pay — approving a card
// moves it from the first to the second at once (the run is read again). Before that, one section: People.
//
// Short pay (2026-11-03): the engine never pays below ₹0 — when the deductions are more than the pay it cuts the
// advance recovery first (then loans, then the rest), and what was not recovered stays owing: an advance carries to
// next month as advance, a loan instalment stays on the loan. A short card is tinted red and its Payable shows the
// shortfall as a negative figure (net_before_cap). Once people can be approved, short cards sit first in "Short pay —
// decide" with Carry forward: that approves the line with the note "carried forward to <next month> as advance"
// (audited; nothing is paid on it), and the card moves to Approved marked Carried forward. Undo puts it back.
//
// Loan badge: a person with an active loan shows "Loan ₹outstanding · ₹instalment/mo" under the name (Held when this
// month's instalment is held). Payslip: the slip button on every card opens PayslipModal (screen + PDF).
//
// Loans on the card (2026-11-03): a Loan figure on the face — this month's deduction, and under it the balance after
// it (or "closes" on the last instalment: the engine never takes more than is outstanding, and finalising closes a
// loan that reaches ₹0, so nothing is deducted from the next month on). The details show each loan: amount (or the
// opening balance it was loaded with), instalment, balance before and after this month, and its repayment record
// month by month (GET /hr/loans/:id schedule: what payroll took, held months, and the months still expected).
// Balances: once the month is finalised its recovery is already posted (after = outstanding); before that, after =
// outstanding − this month's deduction.
//
// Edit here (2026-11-03): the pencil on the card face and the "Edit here" links in the details open the person's
// master (PersonDrawer: details, salary & pay setup, bank, loans & advances) over the payroll, and "Give advance /
// loan" opens Pay staff for that person — nothing needs another screen. The month is worked out again after.
//
// Holiday pay / Overtime switches (2026-11-03): at the top of the details (PaySwitches.jsx), on the person's
// pay setup; the open month is worked out again at once.
//
// Change deduction (2026-11-03): each loan panel offers it (operator, month not finalised) — LoanDeductionModal asks
// for the amount and "only this time" or "change the EMI", and the line is worked out again at once.
//
// Keyboard (as the table): Tab to a card, Space ticks it, ↑ ↓ move, Shift + ↑ ↓ tick as they move, Shift + Space or a
// Shift-click on a tick box ticks every card from the last one ticked, Enter opens / closes the details.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, ExternalLink, FileText, Pencil } from 'lucide-react';
import { Button, SearchInput } from '../../components/ui.jsx';
import LoanDeductionModal from './LoanDeductionModal.jsx';
import PaySwitches from './PaySwitches.jsx';
import { hrApi, inr2, monthLabel } from '../../lib/hr.js';
import {
  ApprovalPill, approvalTitle, batchText, flagLabel, FlagDots, LEVEL_META, levelOf, list, paiseOf, PAYMENT_STATUS, PaymentPill,
  plural, qtyText, shiftMonth, sumPaise, whenText,
} from './RunLineDrawer.jsx';

const owes = l => (paiseOf(l?.payable) ?? 0n) > 0n;
const nonZero = v => (paiseOf(v) ?? 0n) !== 0n;
const isShort = r => (paiseOf(r.line?.net_before_cap) ?? 0n) < 0n;
const negInr = v => inr2(v); // inr2 prints a negative as -₹…

const SECTION_META = {
  short: { label: 'Short pay — decide', ink: 'text-red-700', rail: 'border-l-red-500' },
  todo: { label: 'To approve', ink: 'text-[#1D1D1F]', rail: 'border-l-[#86868B]/50' },
  approved: { label: 'Approved', ink: 'text-[#0064D2]', rail: 'border-l-[#0A84FF]' },
  none: { label: 'Nothing to pay', ink: 'text-[#6E6E73]', rail: 'border-l-[#D2D2D7]' },
  all: { label: 'People', ink: 'text-[#1D1D1F]', rail: 'border-l-[#86868B]/50' },
};

function Figure({ label, value, strong = false, tone = '', sub, subTone = 'text-[#86868B]', title }) {
  return (
    <div className="min-w-[92px] text-right" title={title}>
      <div className="text-[10px] font-bold uppercase tracking-[0.06em] text-[#1D1D1F]/40">{label}</div>
      <div className={`whitespace-nowrap tabular-nums ${strong ? 'text-[15px] font-bold text-[#1D1D1F]' : 'text-sm font-semibold text-[#3A3A3C]'} ${tone}`}>{value}</div>
      {sub && <div className={`whitespace-nowrap text-[10px] font-semibold tabular-nums ${subTone}`}>{sub}</div>}
    </div>
  );
}

const P = v => paiseOf(v) ?? 0n;
const fromP = p => { const a = p < 0n ? -p : p; return `${p < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };

// This month's position on each loan the person carries (or finished this month).
export function loanPositions(r, loans, final) {
  const recs = list(r.line?.loan_recoveries);
  return loans.map(ln => {
    const rec = P(recs.find(x => String(x?.loan_id) === String(ln.id))?.amount);
    const out = P(ln.outstanding);
    const before = final ? out + rec : out;
    const after = final ? out : out - rec;
    const held = r.held.some(h => h.loan_no === ln.loan_no);
    return { ln, rec, before, after, held, closes: rec > 0n && after <= 0n };
  }).filter(x => x.rec > 0n || (x.ln.status === 'active' && x.before > 0n));
}

function LoanFigure({ pos }) {
  if (!pos.length) return <Figure label="Loan" value="—" tone="!text-[#C7C7CC]" />;
  const rec = pos.reduce((t, x) => t + x.rec, 0n);
  const after = pos.reduce((t, x) => t + (x.after > 0n ? x.after : 0n), 0n);
  const closes = pos.every(x => x.closes);
  const held = pos.some(x => x.held);
  return (
    <Figure label="Loan" value={inr2(fromP(rec))} tone={rec ? '' : 'text-[#86868B]'}
      title={pos.map(x => `${x.ln.loan_no}: ${inr2(fromP(x.before))} before, ${inr2(fromP(x.rec))} this month, ${inr2(fromP(x.after < 0n ? 0n : x.after))} after`).join('\n')}
      sub={closes ? 'Closes · bal ₹0.00' : held ? `Held · bal ${inr2(fromP(after))}` : `Bal ${inr2(fromP(after))}`}
      subTone={closes ? 'text-emerald-700' : held ? 'text-amber-700' : 'text-violet-700'} />
  );
}

const STATUS_WORD = { recovered: 'Deducted', partial: 'Part deducted', holiday: 'Held', projected: 'Expected' };

function LoanPanel({ pos, month, final, change }) {
  const { ln, rec, before, after, held, closes } = pos;
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let live = true;
    hrApi.loan(ln.id).then(d => { if (live) setDetail(d); }, () => { if (live) setDetail({ error: true }); });
    return () => { live = false; };
  }, [ln.id]);
  const schedule = list(detail?.schedule);
  // This month while it is not finalised: the run's own deduction, not the projection.
  const rowsShown = schedule.map(x => (!final && x.month === month
    ? { ...x, recovered: fromP(rec), closing: fromP(after < 0n ? 0n : after), status: held ? 'holiday' : 'this' } : x));
  const past = rowsShown.filter(x => x.month <= month);
  const ahead = rowsShown.filter(x => x.month > month);
  const next = shiftMonth(month, 1);
  const opened = list(detail?.txns).find(t => t.kind === 'disbursed' || t.kind === 'opening');
  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/50 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-xs font-bold text-violet-900">{ln.loan_no}</span>
        <span className="text-xs text-[#3A3A3C]">{ln.is_opening ? 'Opening balance' : 'Loan amount'} <b className="tabular-nums">{inr2(ln.principal)}</b></span>
        <span className="text-xs text-[#3A3A3C]">Instalment <b className="tabular-nums">{inr2(ln.instalment)}</b>/month</span>
        {opened && <span className="text-[11px] text-[#86868B]">{ln.is_opening ? 'Loaded' : 'Given'} {String(opened.txn_date).slice(0, 10).split('-').reverse().join('-')}</span>}
        {change && !final && ln.status === 'active' && (
          <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setEditing(true)}>Change deduction</Button>
        )}
      </div>
      {editing && change && (
        <LoanDeductionModal month={month} status={change.status} canApprove={change.canApprove} person={change.person} pos={pos}
          otherRec={change.otherRec(ln.id)} approvedCount={change.approvedCount}
          onClose={() => setEditing(false)} onDone={async msg => { setEditing(false); await change.onDone(msg); }} />
      )}
      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-white/80 px-2 py-1.5"><div className="text-[10px] font-bold uppercase text-[#86868B]">Before {monthLabel(month)}</div><div className="text-sm font-bold tabular-nums">{inr2(fromP(before))}</div></div>
        <div className="rounded-lg bg-white/80 px-2 py-1.5"><div className="text-[10px] font-bold uppercase text-[#86868B]">Deducted now</div><div className="text-sm font-bold tabular-nums">{held ? 'Held' : inr2(fromP(rec))}</div></div>
        <div className={`rounded-lg px-2 py-1.5 ${closes ? 'bg-emerald-50' : 'bg-white/80'}`}><div className="text-[10px] font-bold uppercase text-[#86868B]">Balance after</div><div className={`text-sm font-bold tabular-nums ${closes ? 'text-emerald-700' : ''}`}>{inr2(fromP(after < 0n ? 0n : after))}</div></div>
      </div>
      {closes && (
        <p className="mt-2 text-xs font-semibold text-emerald-800">
          Last instalment — the loan is fully repaid. It closes when {monthLabel(month)} is finalised, and nothing is deducted from {monthLabel(next)} on.
        </p>
      )}
      <h5 className="mt-3 text-[10px] font-bold uppercase tracking-[0.07em] text-[#1D1D1F]/40">Repayment record</h5>
      {!detail && <p className="text-[11px] text-[#86868B]">Reading the loan…</p>}
      {detail?.error && <p className="text-[11px] text-red-700">The loan's record could not be read.</p>}
      {detail && !detail.error && (
        <table className="mt-1 w-full text-[11px]">
          <thead><tr className="text-left text-[10px] uppercase text-[#86868B]"><th className="py-0.5">Month</th><th className="py-0.5 text-right">Deducted</th><th className="py-0.5 text-right">Balance after</th><th className="py-0.5 pl-2">Status</th></tr></thead>
          <tbody className="divide-y divide-violet-100">
            {past.length === 0 && <tr><td colSpan={4} className="py-1 text-[#86868B]">Nothing deducted yet.</td></tr>}
            {[...past, ...ahead.slice(0, 6)].map(x => (
              <tr key={x.month} className={x.month === month ? 'font-bold text-[#1D1D1F]' : x.status === 'projected' ? 'text-[#86868B]' : 'text-[#3A3A3C]'}>
                <td className="py-0.5">{monthLabel(x.month)}</td>
                <td className="py-0.5 text-right tabular-nums">{x.status === 'projected' ? inr2(x.due) : inr2(x.recovered)}</td>
                <td className="py-0.5 text-right tabular-nums">{inr2(x.closing)}</td>
                <td className="py-0.5 pl-2">{x.status === 'this' ? (final ? 'Deducted' : 'This month') : STATUS_WORD[x.status] || x.status}</td>
              </tr>
            ))}
            {ahead.length > 6 && <tr><td colSpan={4} className="py-1 text-[#86868B]">and {ahead.length - 6} more months expected</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Pair({ label, value, strong = false, hint }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1" title={hint}>
      <dt className="text-xs text-[#6E6E73]">{label}</dt>
      <dd className={`whitespace-nowrap text-right text-xs tabular-nums ${strong ? 'font-bold text-[#1D1D1F]' : 'font-semibold text-[#3A3A3C]'}`}>{value}</dd>
    </div>
  );
}

function Shortfall({ r, carryTo }) {
  const u = r.line.unrecovered && typeof r.line.unrecovered === 'object' ? r.line.unrecovered : {};
  const loans = list(u.loans).filter(x => nonZero(x?.amount));
  return (
    <div className="mx-4 mt-3 rounded-xl border border-red-200 bg-red-50/80 px-3 py-2 text-xs text-red-900">
      <b>Pay falls short by {inr2(String(r.line.net_before_cap).replace('-', ''))}.</b> Nothing is paid this month (payable ₹0.00); what could not
      be recovered stays owing:
      <ul className="mt-1 list-disc pl-5">
        {nonZero(u.advance) && <li>{inr2(u.advance)} of advance carries to {carryTo} as advance, recovered from that month’s pay.</li>}
        {loans.map(x => <li key={x.loan_id}>{inr2(x.amount)} of loan instalment stays on the loan.</li>)}
        {nonZero(u.other) && <li>{inr2(u.other)} of other deductions could not be taken.</li>}
      </ul>
    </div>
  );
}

function Details({ r, showPaidSep, onOpen, onPayslip, pos, month, final, change, switches, onMaster, onPayStaff }) {
  const l = r.line;
  const held = r.held.map(h => `${h.loan_no}${h.note ? ` (${h.note})` : ''}`).join(', ');
  return (
    <>
    {onMaster && (
      <div className="flex flex-wrap items-center gap-1.5 border-t border-[#1D1D1F]/[0.06] px-4 pt-3">
        <span className="mr-1 text-[10px] font-bold uppercase tracking-[0.07em] text-[#1D1D1F]/40">Edit here</span>
        {[['details', 'Details'], ['pay', 'Salary & pay setup'], ['bank', 'Bank'], ['money', 'Loans & advances']].map(([tab, label]) => (
          <button key={tab} type="button" onClick={() => onMaster(r, tab)}
            className="rounded-full border border-[#1D1D1F]/10 bg-white/80 px-2.5 py-0.5 text-[11px] font-semibold text-[#515154] hover:border-[#0A84FF]/40 hover:text-[#007AFF]">
            {label}
          </button>
        ))}
        {onPayStaff && (
          <button type="button" onClick={() => onPayStaff(r)}
            className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 text-[11px] font-semibold text-violet-800 hover:bg-violet-100">
            Give advance / loan
          </button>
        )}
      </div>
    )}
    <div className="border-t border-[#1D1D1F]/[0.06] px-4 pt-3">
      <PaySwitches personId={r.id} setup={r.person?.current_setup} compact {...switches} />
    </div>
    {pos.length > 0 && (
      <div className="grid gap-2 border-t border-[#1D1D1F]/[0.06] px-4 pt-3 lg:grid-cols-2">
        {pos.map(x => <LoanPanel key={x.ln.id} pos={x} month={month} final={final} change={change && {
          ...change, person: r, otherRec: id => pos.filter(o => o.ln.id !== id).reduce((t, o) => t + o.rec, 0n),
        }} />)}
      </div>
    )}
    <div className="grid gap-x-6 gap-y-3 border-t border-[#1D1D1F]/[0.06] px-4 pb-4 pt-3 sm:grid-cols-2 xl:grid-cols-4">
      <section>
        <h4 className="mb-1 text-[10px] font-bold uppercase tracking-[0.07em] text-[#1D1D1F]/40">Attendance</h4>
        <dl className="divide-y divide-[#1D1D1F]/[0.05]">
          <Pair label="Department" value={r.department || '—'} />
          <Pair label="Pay channel" value={r.channelLabel || '—'} />
          <Pair label="Present days" value={qtyText(l.present_days)} />
          <Pair label="OT hours" value={qtyText(r.input?.ot_hours)} />
        </dl>
      </section>
      <section>
        <h4 className="mb-1 text-[10px] font-bold uppercase tracking-[0.07em] text-[#1D1D1F]/40">Earnings</h4>
        <dl className="divide-y divide-[#1D1D1F]/[0.05]">
          <Pair label="Basic" value={inr2(l.basic)} />
          <Pair label="OT" value={inr2(l.ot_amount)} />
          <Pair label="Holiday" value={inr2(l.holiday_amount)} />
          <Pair label="Misc" value={inr2(l.misc_earning)} />
          {nonZero(l.bonus) && <Pair label="Bonus" value={inr2(l.bonus)} />}
          {nonZero(l.adj_earnings) && <Pair label="Adjustments" value={inr2(l.adj_earnings)} />}
          <Pair label="Gross" value={inr2(l.gross)} strong />
        </dl>
      </section>
      <section>
        <h4 className="mb-1 text-[10px] font-bold uppercase tracking-[0.07em] text-[#1D1D1F]/40">Deductions</h4>
        <dl className="divide-y divide-[#1D1D1F]/[0.05]">
          <Pair label="Advance recovered" value={inr2(l.advance_recovery)} />
          <Pair label={r.held.length ? 'Loan recovered (instalment held)' : 'Loan recovered'} value={inr2(l.loan_recovery)}
            hint={held ? `Instalment held this month: ${held}` : undefined} />
          {nonZero(l.misc_deduction) && <Pair label="Misc deduction" value={inr2(l.misc_deduction)} />}
          {nonZero(l.adj_deductions) && <Pair label="Adjustments" value={inr2(l.adj_deductions)} />}
          <Pair label="Total deductions" value={inr2(l.total_deductions)} strong />
          <Pair label="Net" value={inr2(l.net)} />
          {(showPaidSep || nonZero(l.paid_separately)) && <Pair label="Paid separately" value={inr2(l.paid_separately)} />}
          {nonZero(l.rounding) && <Pair label="Rounding" value={inr2(l.rounding)} />}
          {isShort(r) && <Pair label="Final pay (short)" value={negInr(l.net_before_cap)} strong />}
          <Pair label="Payable" value={inr2(l.payable)} strong />
          {nonZero(l.carried_advance) && <Pair label="Advance carried forward" value={inr2(l.carried_advance)} />}
        </dl>
      </section>
      <section>
        <h4 className="mb-1 text-[10px] font-bold uppercase tracking-[0.07em] text-[#1D1D1F]/40">Payment &amp; approval</h4>
        <dl className="divide-y divide-[#1D1D1F]/[0.05]">
          <Pair label="Payment" value={owes(l) || r.payment !== 'pending' ? PAYMENT_STATUS[r.payment].label : 'Nothing to pay'} />
          {r.payment === 'on_hold' && <Pair label="Hold reason" value={l.hold_reason || 'No reason recorded'} />}
          {l.paid_on && <Pair label="Paid on" value={whenText(l.paid_on)} />}
          {l.paid_ref && <Pair label="Reference" value={l.paid_ref} />}
          {r.payment === 'paid' && batchText(l) && <Pair label="Batch" value={batchText(l)} />}
          <Pair label="Approval" value={approvalTitle(l) || 'Not approved yet'} />
        </dl>
        {r.flags.length > 0 && (
          <ul className="mt-2 space-y-1">
            {r.flags.map((f, i) => (
              <li key={`${f.code}-${i}`} className={`flex items-center gap-1.5 text-[11px] font-semibold ${LEVEL_META[levelOf(f)].ink}`}>
                <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${LEVEL_META[levelOf(f)].dot}`} />{flagLabel(f.code)}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => onPayslip(r)}><FileText size={13} /> Payslip</Button>
          <Button size="sm" variant="secondary" onClick={() => onOpen(r.id)}><ExternalLink size={13} /> Open full record</Button>
        </div>
      </section>
    </div>
    </>
  );
}

export default function PersonCards({
  rows, approvable, canApprove, canOperate, selected, onToggle, onRange, onApprove, onUndo, busyId, onOpen,
  showPaidSep, search, onSearch, toolbar, loansBy = new Map(), carryTo = 'next month', onCarry, onPayslip,
  month = '', final = false, status = 'draft', onLoanChanged, onSwitched, onMaster, onPayStaff,
}) {
  const approvedCount = rows.filter(x => x.approval === 'approved').length;
  const change = canOperate && onLoanChanged ? { status, canApprove, approvedCount, onDone: onLoanChanged } : null;
  const switches = { canEdit: canOperate && !final && Boolean(onSwitched), month, status, canApprove, approvedCount, onChanged: onSwitched };
  const [open, setOpen] = useState(() => new Set());
  const anchor = useRef(null);
  const listRef = useRef(null);

  const sections = useMemo(() => {
    const byName = (a, b) => String(a.name).localeCompare(String(b.name));
    if (!approvable) return [{ key: 'all', rows: [...rows].sort(byName) }];
    const short = []; const todo = []; const approved = []; const none = [];
    for (const r of rows) (r.approval === 'approved' ? approved : isShort(r) ? short : owes(r.line) ? todo : none).push(r);
    return [{ key: 'short', rows: short.sort(byName) }, { key: 'todo', rows: todo.sort(byName) },
      { key: 'approved', rows: approved.sort(byName) }, { key: 'none', rows: none.sort(byName) }]
      .filter(s => s.rows.length || (s.key !== 'none' && s.key !== 'short'));
  }, [rows, approvable]);
  const ordered = useMemo(() => sections.flatMap(s => s.rows), [sections]);

  const toggleOpen = id => setOpen(cur => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const tickOne = (r, on) => { onToggle(r, on); anchor.current = r.id; };
  const tickRange = r => {
    const at = ordered.findIndex(x => x.id === r.id);
    const from = anchor.current == null ? -1 : ordered.findIndex(x => x.id === anchor.current);
    onRange(from < 0 ? [r] : ordered.slice(Math.min(from, at), Math.max(from, at) + 1), true);
    anchor.current = r.id;
  };
  const onKey = (e, r) => {
    if (e.target !== e.currentTarget) return;
    const cards = [...(listRef.current?.querySelectorAll('[data-card]') ?? [])];
    const here = cards.indexOf(e.currentTarget);
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      if (!canOperate) return;
      if (e.shiftKey) tickRange(r); else tickOne(r, !selected.has(r.id));
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = cards[here + (e.key === 'ArrowDown' ? 1 : -1)];
      if (!next) return;
      next.focus();
      if (e.shiftKey && canOperate) {
        const nr = ordered.find(x => x.id === next.getAttribute('data-card'));
        if (!selected.has(r.id)) tickOne(r, true);
        if (nr) tickOne(nr, true);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      toggleOpen(r.id);
    }
  };

  const allOpen = rows.length > 0 && rows.every(r => open.has(r.id));
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={onSearch} placeholder="Search name, code, department, channel or flag…" className="w-full max-w-md" />
        <Button size="sm" variant="ghost" onClick={() => setOpen(allOpen ? new Set() : new Set(rows.map(r => r.id)))}>
          {allOpen ? <><ChevronsDownUp size={13} /> Collapse all</> : <><ChevronsUpDown size={13} /> Expand all</>}
        </Button>
        <span className="ml-auto">{toolbar}</span>
      </div>
      <div ref={listRef} className="space-y-4">
        {sections.map(s => {
          const meta = SECTION_META[s.key];
          const shownTicked = s.rows.length > 0 && s.rows.every(r => selected.has(r.id));
          return (
            <section key={s.key}>
              <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
                {canOperate && s.rows.length > 0 && (
                  <input type="checkbox" aria-label={`Tick everyone in ${meta.label}`} className="h-4 w-4 accent-[#007AFF]"
                    checked={shownTicked} onChange={e => onRange(s.rows, e.target.checked)} />
                )}
                <h3 className={`text-sm font-bold tracking-[-0.01em] ${meta.ink}`}>{meta.label}</h3>
                <span className="text-xs text-[#6E6E73]">{plural(s.rows.length, 'person', 'people')}</span>
                {s.key === 'short' && (
                  <span className="text-xs font-semibold text-red-700">
                    Short by {inr2(String(sumPaise(s.rows.map(r => r.line.net_before_cap))).replace('-', ''))} in all — carry each forward to {carryTo} as advance
                  </span>
                )}
                {s.rows.length > 0 && s.key !== 'short' && (
                  <span className="text-xs text-[#6E6E73]">
                    Gross <b className="tabular-nums text-[#1D1D1F]">{inr2(sumPaise(s.rows.map(r => r.line.gross)))}</b>
                    {' · '}Payable <b className="tabular-nums text-[#1D1D1F]">{inr2(sumPaise(s.rows.map(r => r.line.payable)))}</b>
                  </span>
                )}
              </div>
              {s.rows.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-[#1D1D1F]/10 px-4 py-3 text-xs text-[#86868B]">
                  {s.key === 'approved' ? 'Nobody approved yet — approve a person and they move here.' : s.key === 'todo' ? 'Everyone is approved.' : 'Nobody here.'}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {s.rows.map(r => {
                    const isOpen = open.has(r.id);
                    const ticked = selected.has(r.id);
                    const short = isShort(r);
                    const carried = short && r.approval === 'approved';
                    const pos = loanPositions(r, loansBy.get(r.id) ?? [], final);
                    return (
                      <li key={r.id} data-card={r.id} tabIndex={0} aria-selected={ticked} aria-expanded={isOpen} onKeyDown={e => onKey(e, r)}
                        className={`overflow-hidden rounded-2xl border border-l-[3px] bg-white/70 shadow-[0_1px_2px_rgba(29,29,31,0.04)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#0A84FF]
                          ${short && !carried ? 'border-l-red-500' : meta.rail} ${ticked ? 'border-[#0A84FF]/40 bg-[#E1EFFF]/70' : short ? 'border-red-200' : 'border-white/80'} ${r.blocked || (short && !ticked) ? '!bg-red-50/70' : ''}`}>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
                          {canOperate && (
                            <input type="checkbox" aria-label={`Tick ${r.name}`} className="h-4 w-4 accent-[#007AFF]" checked={ticked}
                              onClick={e => { if (e.shiftKey) { e.preventDefault(); tickRange(r); } }}
                              onChange={e => tickOne(r, e.target.checked)} />
                          )}
                          <button type="button" onClick={() => toggleOpen(r.id)} aria-label={isOpen ? `Hide ${r.name}'s details` : `Show ${r.name}'s details`}
                            className="flex min-w-[180px] flex-1 items-center gap-2 text-left">
                            {isOpen ? <ChevronDown size={15} className="shrink-0 text-[#007AFF]" /> : <ChevronRight size={15} className="shrink-0 text-[#86868B]" />}
                            <span className="min-w-0">
                              <span className="flex items-center gap-2">
                                <span className="truncate text-sm font-semibold text-[#1D1D1F]">{r.name}</span>
                                {r.flags.length > 0 && <FlagDots flags={r.flags} />}
                              </span>
                              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-[#86868B]">
                                <span className="truncate">{[r.code, r.department, r.channelLabel].filter(Boolean).join(' · ')}</span>
                                {pos.map(x => (
                                  <span key={x.ln.id} title={`${x.ln.loan_no}: ${x.ln.is_opening ? 'opening balance' : 'loan'} ${inr2(x.ln.principal)}, instalment ${inr2(x.ln.instalment)} a month`}
                                    className="rounded-full bg-violet-100 px-1.5 py-px text-[10px] font-bold text-violet-800">
                                    Loan {inr2(x.ln.principal)}
                                  </span>
                                ))}
                                {short && <span className="rounded-full bg-red-100 px-1.5 py-px text-[10px] font-bold text-red-700">Short pay</span>}
                              </span>
                            </span>
                          </button>
                          <Figure label="Gross" value={inr2(r.line.gross)} />
                          <Figure label="Advance" value={inr2(r.line.advance_recovery)} tone={nonZero(r.line.advance_recovery) ? '' : 'text-[#86868B]'} />
                          <LoanFigure pos={pos} />
                          <Figure label="Payable" value={short ? negInr(r.line.net_before_cap) : inr2(r.line.payable)} strong tone={short ? '!text-red-700' : ''} />
                          <div className="flex w-[290px] shrink-0 items-center justify-end gap-1.5">
                            {r.payment !== 'pending' && <PaymentPill status={r.payment} reason={r.payment === 'on_hold' ? r.line.hold_reason || 'No reason recorded' : null} />}
                            {carried
                              ? <span title={approvalTitle(r.line)} className="whitespace-nowrap rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-900">Carried forward</span>
                              : <ApprovalPill line={r.line} />}
                            {approvable && canApprove && short && !carried && (
                              <button type="button" disabled={busyId === r.id} onClick={() => onCarry(r)}
                                title={`Carry ${r.name}'s shortfall forward to ${carryTo} as advance`}
                                className="whitespace-nowrap rounded-full bg-red-600 px-2.5 py-0.5 text-[11px] font-bold text-white hover:bg-red-700 disabled:opacity-50">
                                {busyId === r.id ? '…' : 'Carry forward'}
                              </button>
                            )}
                            {approvable && canApprove && r.approval !== 'approved' && owes(r.line) && (
                              <button type="button" disabled={busyId === r.id} onClick={() => onApprove(r)} title={`Approve ${r.name} for payment`}
                                className="rounded-full bg-[#007AFF] px-2.5 py-0.5 text-[11px] font-bold text-white hover:bg-[#0064D2] disabled:opacity-50">
                                {busyId === r.id ? '…' : 'Approve'}
                              </button>
                            )}
                            {onMaster && (
                              <button type="button" onClick={() => onMaster(r, 'details')} title={`Edit ${r.name} — details, salary, bank, loans`} aria-label={`Edit ${r.name}`}
                                className="rounded-full p-1 text-[#86868B] hover:bg-[#1D1D1F]/[0.05] hover:text-[#007AFF]">
                                <Pencil size={14} />
                              </button>
                            )}
                            <button type="button" onClick={() => onPayslip(r)} title={`${r.name}'s payslip`} aria-label={`${r.name}'s payslip`}
                              className="rounded-full p-1 text-[#86868B] hover:bg-[#1D1D1F]/[0.05] hover:text-[#007AFF]">
                              <FileText size={15} />
                            </button>
                            {approvable && canApprove && r.approval === 'approved' && r.payment !== 'paid' && (
                              <button type="button" onClick={() => onUndo(r)} title={`Undo the approval of ${r.name}`}
                                className="rounded-full border border-[#1D1D1F]/15 bg-white/80 px-2.5 py-0.5 text-[11px] font-bold text-[#515154] hover:text-red-700">
                                Undo
                              </button>
                            )}
                          </div>
                        </div>
                        {isOpen && short && <Shortfall r={r} carryTo={carryTo} />}
                        {isOpen && <Details r={r} showPaidSep={showPaidSep} onOpen={onOpen} onPayslip={onPayslip} pos={pos} month={month} final={final} change={change} switches={switches} onMaster={onMaster} onPayStaff={onPayStaff} />}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
        {rows.length === 0 && <p className="px-1 py-8 text-center text-sm text-[#86868B]">No person matches these filters.</p>}
      </div>
    </div>
  );
}
