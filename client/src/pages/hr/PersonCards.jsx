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
// Keyboard (as the table): Tab to a card, Space ticks it, ↑ ↓ move, Shift + ↑ ↓ tick as they move, Shift + Space or a
// Shift-click on a tick box ticks every card from the last one ticked, Enter opens / closes the details.
import { useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, ExternalLink } from 'lucide-react';
import { Button, SearchInput } from '../../components/ui.jsx';
import { inr2 } from '../../lib/hr.js';
import {
  ApprovalPill, approvalTitle, batchText, flagLabel, FlagDots, LEVEL_META, levelOf, paiseOf, PAYMENT_STATUS, PaymentPill,
  plural, qtyText, sumPaise, whenText,
} from './RunLineDrawer.jsx';

const owes = l => (paiseOf(l?.payable) ?? 0n) > 0n;
const nonZero = v => (paiseOf(v) ?? 0n) !== 0n;

const SECTION_META = {
  todo: { label: 'To approve', ink: 'text-[#1D1D1F]', rail: 'border-l-[#86868B]/50' },
  approved: { label: 'Approved', ink: 'text-[#0064D2]', rail: 'border-l-[#0A84FF]' },
  none: { label: 'Nothing to pay', ink: 'text-[#6E6E73]', rail: 'border-l-[#D2D2D7]' },
  all: { label: 'People', ink: 'text-[#1D1D1F]', rail: 'border-l-[#86868B]/50' },
};

function Figure({ label, value, strong = false, tone = '' }) {
  return (
    <div className="min-w-[92px] text-right">
      <div className="text-[10px] font-bold uppercase tracking-[0.06em] text-[#1D1D1F]/40">{label}</div>
      <div className={`whitespace-nowrap tabular-nums ${strong ? 'text-[15px] font-bold text-[#1D1D1F]' : 'text-sm font-semibold text-[#3A3A3C]'} ${tone}`}>{value}</div>
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

function Details({ r, showPaidSep, onOpen }) {
  const l = r.line;
  const held = r.held.map(h => `${h.loan_no}${h.note ? ` (${h.note})` : ''}`).join(', ');
  return (
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
        <Button size="sm" variant="secondary" className="mt-3" onClick={() => onOpen(r.id)}>
          <ExternalLink size={13} /> Open full record
        </Button>
      </section>
    </div>
  );
}

export default function PersonCards({
  rows, approvable, canApprove, canOperate, selected, onToggle, onRange, onApprove, onUndo, busyId, onOpen,
  showPaidSep, search, onSearch, toolbar,
}) {
  const [open, setOpen] = useState(() => new Set());
  const anchor = useRef(null);
  const listRef = useRef(null);

  const sections = useMemo(() => {
    const byName = (a, b) => String(a.name).localeCompare(String(b.name));
    if (!approvable) return [{ key: 'all', rows: [...rows].sort(byName) }];
    const todo = []; const approved = []; const none = [];
    for (const r of rows) (r.approval === 'approved' ? approved : owes(r.line) ? todo : none).push(r);
    return [{ key: 'todo', rows: todo.sort(byName) }, { key: 'approved', rows: approved.sort(byName) }, { key: 'none', rows: none.sort(byName) }]
      .filter(s => s.rows.length || s.key !== 'none');
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
                {s.rows.length > 0 && (
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
                    return (
                      <li key={r.id} data-card={r.id} tabIndex={0} aria-selected={ticked} aria-expanded={isOpen} onKeyDown={e => onKey(e, r)}
                        className={`overflow-hidden rounded-2xl border border-l-[3px] bg-white/70 shadow-[0_1px_2px_rgba(29,29,31,0.04)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#0A84FF]
                          ${meta.rail} ${ticked ? 'border-[#0A84FF]/40 bg-[#E1EFFF]/70' : 'border-white/80'} ${r.blocked ? '!bg-red-50/70' : ''}`}>
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
                              <span className="block truncate text-[11px] text-[#86868B]">
                                {[r.code, r.department, r.channelLabel].filter(Boolean).join(' · ')}
                              </span>
                            </span>
                          </button>
                          <Figure label="Gross" value={inr2(r.line.gross)} />
                          <Figure label="Advance" value={inr2(r.line.advance_recovery)} tone={nonZero(r.line.advance_recovery) ? '' : 'text-[#86868B]'} />
                          <Figure label="Payable" value={inr2(r.line.payable)} strong />
                          <div className="flex w-[230px] shrink-0 items-center justify-end gap-1.5">
                            {r.payment !== 'pending' && <PaymentPill status={r.payment} reason={r.payment === 'on_hold' ? r.line.hold_reason || 'No reason recorded' : null} />}
                            <ApprovalPill line={r.line} />
                            {approvable && canApprove && r.approval !== 'approved' && owes(r.line) && (
                              <button type="button" disabled={busyId === r.id} onClick={() => onApprove(r)} title={`Approve ${r.name} for payment`}
                                className="rounded-full bg-[#007AFF] px-2.5 py-0.5 text-[11px] font-bold text-white hover:bg-[#0064D2] disabled:opacity-50">
                                {busyId === r.id ? '…' : 'Approve'}
                              </button>
                            )}
                            {approvable && canApprove && r.approval === 'approved' && r.payment !== 'paid' && (
                              <button type="button" onClick={() => onUndo(r)} title={`Undo the approval of ${r.name}`}
                                className="rounded-full border border-[#1D1D1F]/15 bg-white/80 px-2.5 py-0.5 text-[11px] font-bold text-[#515154] hover:text-red-700">
                                Undo
                              </button>
                            )}
                          </div>
                        </div>
                        {isOpen && <Details r={r} showPaidSep={showPaidSep} onOpen={onOpen} />}
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
