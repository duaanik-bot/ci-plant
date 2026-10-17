// HR → Loans & Advances (spec §7 adjustments, §10 advances, §11 loans): three sub-tabs.
//
//   Loans         the register (number, person, principal, outstanding, instalment, next due, status), a
//                 "New loan" dialog, and a loan drawer: the statement, the repayment schedule (projected
//                 months in grey) and the actions — prepay, repayment holiday, change instalment, cancel.
//   Advances      a balance per person, "Give advance", a statement drawer with a running balance, and
//                 waive (approver).
//   Adjustments   earnings and deductions added to a month's pay: list, new, approve (approver), cancel.
//
// Access. Viewer reads everything. Operator: new loan, prepay, holiday, instalment, cancel, give advance,
// new adjustment, cancel adjustment. Approver: waive an advance, approve an adjustment. This only decides
// what to OFFER; the server enforces it.
//
// Refusals. Inside a dialog that submits, the server's message is said inline (refusalText + InlineError)
// and the dialog stays open with what was typed. Elsewhere the central toast is enough.
//
// Money is formatted, never worked out here: balances, outstanding and schedule figures arrive as exact
// strings from the ledgers. Typed amounts are checked for shape (parseNum) and sent as numbers. Nothing is
// logged.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Ban, CalendarOff, HandCoins, Loader2, Pencil, Plus, Undo2, X } from 'lucide-react';
import { Button, Checkbox, DataTable, Field, Input, Modal, Select, SubTabs, Textarea, useToast } from '../../components/ui.jsx';
import { FilterChip, FilterGroup, FilterRail } from '../../components/FilterChip.jsx';
import { hrApi, inr2, levelAtLeast, monthLabel } from '../../lib/hr.js';
import { MONTH_RE, list, paiseOf, plantMonth, plantToday, shiftMonth } from './RunLineDrawer.jsx';
import { InlineError, parseNum, refusalText } from './PersonDrawer.jsx';
import PayStaffModal from './PayStaffModal.jsx';

const SUBS = [{ key: 'loans', label: 'Loans' }, { key: 'advances', label: 'Advances' }, { key: 'adjustments', label: 'Adjustments' }];

const TONE = {
  active: 'bg-emerald-50 text-emerald-700', closed: 'bg-slate-200 text-slate-600', cancelled: 'bg-red-50 text-red-700',
  pending: 'bg-amber-50 text-amber-700', approved: 'bg-emerald-50 text-emerald-700',
};
function Pill({ status }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ring-1 ring-inset ring-[#1D1D1F]/[0.06] ${TONE[status] || 'bg-gray-100 text-gray-600'}`}>
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />{String(status || '—').replace(/_/g, ' ')}
    </span>
  );
}

const sortNum = v => { const p = paiseOf(v); return p === null ? null : Number(p); }; // sorting only
const TH = 'px-2.5 py-2 text-left';
const TD = 'px-2.5 py-2 align-top';
const isPositive = v => (paiseOf(v) ?? 0n) > 0n;

// A typed amount that must be above 0: → { error } | { value }.
function amountCheck(raw, label) {
  const r = parseNum(raw, 2);
  if (r.blank) return { error: `Enter ${label}.` };
  if (r.error) return { error: r.error };
  if (r.value <= 0) return { error: `${label[0].toUpperCase()}${label.slice(1)} must be above 0.` };
  return { value: r.value };
}

// ── Dialog that submits ─────────────────────────────────────────────────────
// onSubmit returns a problem string (shown inline, dialog stays), throws (the server's refusal, shown
// inline), or returns nothing (done → close). Typed input lives in the caller, so it survives a refusal.
function Dialog({ title, confirmLabel, variant = 'primary', onClose, onSubmit, children, wide }) {
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    try {
      const problem = await onSubmit();
      if (problem) { setError(problem); return; }
    } catch (e) {
      setError(refusalText(e));
      return;
    }
    onClose();
  };
  return (
    <Modal open onClose={onClose} title={title} wide={wide}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={variant} onClick={submit}>{confirmLabel}</Button></>}>
      <div data-ci-form className="space-y-3">{children}</div>
      <InlineError message={error} />
    </Modal>
  );
}

function PersonSelect({ people, value, onChange, label = 'Person' }) {
  const options = useMemo(() => [{ value: '', label: 'Choose a person…' }, ...people.map(p => ({
    value: String(p.id), label: `${p.name}${p.code ? ` · ${p.code}` : ''}`, search: `${p.name} ${p.code} ${p.department || ''}`,
  }))], [people]);
  return (
    <Field label={label} required>
      <Select value={value} options={options} placeholder="Choose a person…" onChange={e => onChange(e.target.value)} />
    </Field>
  );
}

// ── Drawer shell ────────────────────────────────────────────────────────────
function Drawer({ title, sub, badge, actions, onClose, children }) {
  const rootRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const h = e => {
      if (e.key !== 'Escape') return;
      if ([...document.querySelectorAll('[data-ci-overlay]')].some(el => el !== rootRef.current)) return;
      e.stopPropagation(); e.preventDefault(); closeRef.current();
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);
  return createPortal(
    <div ref={rootRef} data-ci-overlay className="no-print fixed inset-0 z-[45]">
      <div className="absolute inset-0 animate-fadeIn bg-[#1D1D1F]/25 backdrop-blur-[3px]" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label={title} className="absolute inset-y-0 right-0 flex w-full max-w-[820px] p-0 sm:p-3">
        <div className="glass flex h-full w-full animate-scaleIn flex-col overflow-hidden rounded-none sm:rounded-[26px]">
          <div className="flex items-center gap-3 border-b border-[#1D1D1F]/[0.06] bg-white/45 px-4 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0071F0] text-white shadow-[0_6px_16px_rgba(0,113,240,0.35)]"><HandCoins size={16} /></span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2"><p className="truncate text-[15px] font-bold text-[#1D1D1F]">{title}</p>{badge}</div>
              {sub && <p className="truncate text-[11px] text-[#6E6E73]">{sub}</p>}
            </div>
            <button type="button" onClick={onClose} aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1D1D1F]/[0.05] text-[#86868B] hover:bg-[#1D1D1F]/[0.10]"><X size={16} /></button>
          </div>
          {actions && <div className="flex flex-wrap gap-2 border-b border-[#1D1D1F]/[0.06] bg-white/25 px-4 py-2">{actions}</div>}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">{children}</div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function Box({ title, children }) {
  return (
    <section className="rounded-[20px] border border-white/75 bg-white/55 p-3.5">
      <h4 className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[#6E6E73]">{title}</h4>
      {children}
    </section>
  );
}

function Loading() {
  return <div className="flex items-center justify-center gap-2 py-16 text-sm text-[#86868B]"><Loader2 size={16} className="animate-spin" /> Loading…</div>;
}

// Reads a list once and again on demand; a failed read keeps the last list (the central toast says why).
function useList(fetcher) {
  const [rows, setRows] = useState(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try { setRows(list(await fetcher())); setFailed(false); } catch { setFailed(true); }
  }, [fetcher]);
  useEffect(() => { load(); }, [load]);
  return [rows, load, failed];
}

function LoadFailed({ rows, onRetry, what }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700">
      <AlertTriangle size={16} className="shrink-0" />
      <span className="min-w-0 flex-1">Couldn’t reach the server — {rows ? 'showing the last list loaded.' : `${what} can’t load.`}</span>
      <Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button>
    </div>
  );
}

// ═══ Loans ══════════════════════════════════════════════════════════════════

const TXN_KIND = {
  disbursed: 'Issued', opening: 'Opening balance', payroll_recovery: 'Payroll recovery', prepayment: 'Prepayment',
  adjustment: 'Adjustment', waiver: 'Waiver',
};
const OUT_KINDS = new Set(['payroll_recovery', 'prepayment', 'waiver']);
const SCHEDULE_STATUS = { recovered: 'Recovered', partial: 'Part-recovered', holiday: 'Holiday', projected: 'Projected' };

function NewLoanDialog({ people, onClose, onDone }) {
  const toast = useToast();
  const [f, setF] = useState(() => ({
    person_id: '', principal: '', issued_on: plantToday(), purpose: '', instalment: '',
    first_due_month: shiftMonth(plantMonth(), 1), paid_via: '', is_opening: false,
  }));
  const set = (k, v) => setF(c => ({ ...c, [k]: v }));
  const submit = async () => {
    if (!f.person_id) return 'Choose the person.';
    const principal = amountCheck(f.principal, 'the loan amount');
    if (principal.error) return principal.error;
    const instalment = amountCheck(f.instalment, 'the monthly instalment');
    if (instalment.error) return instalment.error;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.issued_on)) return 'Enter the date the loan was issued.';
    if (!MONTH_RE.test(f.first_due_month)) return 'Choose the first month an instalment is due.';
    if (f.first_due_month < f.issued_on.slice(0, 7)) return 'The first instalment cannot fall due before the month the loan was issued.';
    const loan = await hrApi.createLoan({
      person_id: Number(f.person_id), principal: principal.value, issued_on: f.issued_on, purpose: f.purpose.trim() || null,
      instalment: instalment.value, first_due_month: f.first_due_month, paid_via: f.paid_via.trim() || null, is_opening: f.is_opening,
    });
    toast.success(`${loan?.loan_no || 'Loan'} created`);
    onDone();
    return undefined;
  };
  return (
    <Dialog title="New loan" confirmLabel="Create loan" onClose={onClose} onSubmit={submit} wide>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <PersonSelect people={people} value={f.person_id} onChange={v => set('person_id', v)} />
        <Field label="Loan amount (₹)" required><Input inputMode="decimal" autoComplete="off" value={f.principal} onChange={e => set('principal', e.target.value)} /></Field>
        <Field label="Issued on" required><Input type="date" value={f.issued_on} onChange={e => set('issued_on', e.target.value)} /></Field>
        <Field label="Paid out via" hint="e.g. cash, or the bank it went from."><Input autoComplete="off" value={f.paid_via} onChange={e => set('paid_via', e.target.value)} /></Field>
        <Field label="Monthly instalment (₹)" required><Input inputMode="decimal" autoComplete="off" value={f.instalment} onChange={e => set('instalment', e.target.value)} /></Field>
        <Field label="First instalment month" required hint="Taken from that month’s pay."><Input type="month" value={f.first_due_month} onChange={e => set('first_due_month', e.target.value)} /></Field>
        <Field label="Purpose" className="sm:col-span-2"><Input autoComplete="off" value={f.purpose} onChange={e => set('purpose', e.target.value)} /></Field>
        <div className="sm:col-span-2">
          <Checkbox label="This is an opening balance (a loan already running before HR & Payroll)" checked={f.is_opening} onChange={e => set('is_opening', e.target.checked)} />
        </div>
      </div>
      <p className="text-[11px] text-[#86868B]">Loans are interest-free for now. The instalment is taken from pay each month, never more than what is outstanding.</p>
    </Dialog>
  );
}

function PrepayDialog({ loan, onClose, onDone }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(plantToday());
  const [note, setNote] = useState('');
  const submit = async () => {
    const a = amountCheck(amount, 'the amount repaid');
    if (a.error) return a.error;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Enter the date it was repaid.';
    await hrApi.prepayLoan(loan.id, { amount: a.value, date, note: note.trim() || null });
    toast.success('Prepayment recorded');
    onDone();
    return undefined;
  };
  return (
    <Dialog title={`Prepay ${loan.loan_no}`} confirmLabel="Record prepayment" onClose={onClose} onSubmit={submit}>
      <p className="text-xs text-[#515154]">Money repaid ahead of payroll. It cannot be more than the {inr2(loan.outstanding)} outstanding; paying it all closes the loan.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Amount (₹)" required><Input inputMode="decimal" autoComplete="off" value={amount} onChange={e => setAmount(e.target.value)} /></Field>
        <Field label="Repaid on" required><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
      </div>
      <Field label="Note"><Input autoComplete="off" value={note} onChange={e => setNote(e.target.value)} /></Field>
    </Dialog>
  );
}

function HolidayDialog({ loan, onClose, onDone }) {
  const toast = useToast();
  const [month, setMonth] = useState(plantMonth());
  const submit = async () => {
    if (!MONTH_RE.test(month)) return 'Choose the month to skip.';
    await hrApi.loanHoliday(loan.id, month);
    toast.success(`No instalment in ${monthLabel(month)}`);
    onDone();
    return undefined;
  };
  return (
    <Dialog title={`Repayment holiday — ${loan.loan_no}`} confirmLabel="Skip that month" onClose={onClose} onSubmit={submit}>
      <p className="text-xs text-[#515154]">No instalment is taken in the month you pick; the schedule runs one month longer.</p>
      <Field label="Month to skip" required><Input type="month" min={plantMonth()} value={month} onChange={e => setMonth(e.target.value)} /></Field>
    </Dialog>
  );
}

function InstalmentDialog({ loan, onClose, onDone }) {
  const toast = useToast();
  const [value, setValue] = useState(String(Number(loan.instalment)));
  const [from, setFrom] = useState(plantMonth());
  const submit = async () => {
    const a = amountCheck(value, 'the new instalment');
    if (a.error) return a.error;
    if (!MONTH_RE.test(from)) return 'Choose the month the change starts from.';
    const res = await hrApi.setLoanInstalment(loan.id, { instalment: a.value, from_month: from });
    toast.success('Instalment changed');
    if (res?.warning) toast.info(res.warning);
    onDone();
    return undefined;
  };
  return (
    <Dialog title={`Change instalment — ${loan.loan_no}`} confirmLabel="Change instalment" onClose={onClose} onSubmit={submit}>
      <p className="text-xs text-[#515154]">Now {inr2(loan.instalment)} a month. The change is recorded in the audit log.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="New instalment (₹)" required><Input inputMode="decimal" autoComplete="off" value={value} onChange={e => setValue(e.target.value)} /></Field>
        <Field label="From month" required><Input type="month" value={from} onChange={e => setFrom(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

function CancelLoanDialog({ loan, onClose, onDone }) {
  const toast = useToast();
  const submit = async () => {
    await hrApi.cancelLoan(loan.id);
    toast.success(`${loan.loan_no} cancelled`);
    onDone();
    return undefined;
  };
  return (
    <Dialog title={`Cancel ${loan.loan_no}?`} confirmLabel="Cancel the loan" variant="danger" onClose={onClose} onSubmit={submit}>
      <p className="text-sm text-[#3A3A3C]">
        The loan is written off the books as if it had not been lent. This is only possible while nothing has been taken back
        against it (no payroll recovery, no prepayment).
      </p>
    </Dialog>
  );
}

function LoanDrawer({ id, level, onClose, onChanged }) {
  const canOperate = levelAtLeast(level, 'operator');
  const [d, setD] = useState(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState(null);
  const reload = useCallback(async () => {
    try { setD(await hrApi.loan(id)); setFailed(false); } catch { setFailed(true); }
  }, [id]);
  useEffect(() => { reload(); }, [reload]);
  const changed = () => { reload(); onChanged(); };

  const loan = d?.loan;
  const active = loan?.status === 'active';
  const schedule = list(d?.schedule);
  const txns = list(d?.txns);
  const close = () => setDialog(null);
  return (
    <Drawer title={loan ? `${loan.loan_no} · ${loan.person_name}` : 'Loan'} onClose={onClose}
      sub={loan ? [loan.person_code, loan.purpose, loan.paid_via && `paid via ${loan.paid_via}`].filter(Boolean).join(' · ') : ''}
      badge={loan && <Pill status={loan.status} />}
      actions={loan && canOperate && active && (
        <>
          <Button size="sm" variant="secondary" onClick={() => setDialog('prepay')}><Undo2 size={13} /> Prepay</Button>
          <Button size="sm" variant="secondary" onClick={() => setDialog('holiday')}><CalendarOff size={13} /> Repayment holiday</Button>
          <Button size="sm" variant="secondary" onClick={() => setDialog('instalment')}><Pencil size={13} /> Change instalment</Button>
          <Button size="sm" variant="ghost" className="!text-red-600" onClick={() => setDialog('cancel')}><Ban size={13} /> Cancel loan</Button>
        </>
      )}>
      {!loan && !failed && <Loading />}
      {failed && !loan && <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">This loan could not be loaded.</p>}
      {loan && (
        <>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[['Principal', inr2(loan.principal)], ['Outstanding', inr2(loan.outstanding)], ['Instalment', inr2(loan.instalment)],
              ['Due this month', inr2(loan.due_this_month)]].map(([k, v]) => (
              <div key={k} className="rounded-xl bg-[#1D1D1F]/[0.04] px-3 py-2">
                <dt className="text-[10px] font-bold uppercase tracking-wide text-[#86868B]">{k}</dt>
                <dd className="text-sm font-extrabold tabular-nums text-[#1D1D1F]">{v}</dd>
              </div>
            ))}
          </dl>
          <Box title="Repayment schedule">
            {schedule.length === 0 ? <p className="text-xs text-[#86868B]">{active ? 'Nothing left to schedule.' : 'No schedule for a loan that is not active.'}</p> : (
              <div className="overflow-x-auto rounded-2xl border border-white/75 bg-white/55">
                <table className="w-full text-xs">
                  <thead><tr className="ci-table-head">
                    <th className={TH}>Month</th><th className={`${TH} text-right`}>Opening</th><th className={`${TH} text-right`}>Due</th>
                    <th className={`${TH} text-right`}>Recovered</th><th className={`${TH} text-right`}>Closing</th><th className={TH}>Status</th>
                  </tr></thead>
                  <tbody>
                    {schedule.map(s => (
                      <tr key={s.month} className={`ci-table-row ${s.status === 'projected' ? 'bg-[#1D1D1F]/[0.03] text-[#86868B]' : ''}`}>
                        <td className={`${TD} whitespace-nowrap font-semibold`}>{monthLabel(s.month)}</td>
                        <td className={`${TD} text-right tabular-nums`}>{inr2(s.opening)}</td>
                        <td className={`${TD} text-right tabular-nums`}>{inr2(s.due)}</td>
                        <td className={`${TD} text-right tabular-nums`}>{inr2(s.recovered)}</td>
                        <td className={`${TD} text-right tabular-nums`}>{inr2(s.closing)}</td>
                        <td className={`${TD} ${s.status === 'projected' ? 'italic' : ''}`}>{SCHEDULE_STATUS[s.status] || s.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {list(d.holidays).length > 0 && (
              <p className="mt-2 text-[11px] text-[#6E6E73]">Repayment holidays: {list(d.holidays).map(monthLabel).join(', ')}.</p>
            )}
          </Box>
          <Box title="Statement">
            <div className="overflow-x-auto rounded-2xl border border-white/75 bg-white/55">
              <table className="w-full text-xs">
                <thead><tr className="ci-table-head">
                  <th className={TH}>Date</th><th className={TH}>What</th><th className={TH}>Note</th>
                  <th className={`${TH} text-right`}>Amount</th><th className={`${TH} text-right`}>Balance</th>
                </tr></thead>
                <tbody>
                  {txns.map(t => (
                    <tr key={t.id} className="ci-table-row">
                      <td className={`${TD} whitespace-nowrap`}>{t.txn_date}</td>
                      <td className={`${TD} font-semibold text-[#1D1D1F]`}>{TXN_KIND[t.kind] || t.kind}{t.run_month ? ` · ${monthLabel(t.run_month)}` : ''}</td>
                      <td className={`${TD} text-[#6E6E73]`}>{t.note || '—'}</td>
                      <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>{OUT_KINDS.has(t.kind) ? '-' : ''}{inr2(t.principal_amount)}</td>
                      <td className={`${TD} whitespace-nowrap text-right font-semibold tabular-nums`}>{inr2(t.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Box>
        </>
      )}
      {dialog === 'prepay' && <PrepayDialog loan={loan} onClose={close} onDone={changed} />}
      {dialog === 'holiday' && <HolidayDialog loan={loan} onClose={close} onDone={changed} />}
      {dialog === 'instalment' && <InstalmentDialog loan={loan} onClose={close} onDone={changed} />}
      {dialog === 'cancel' && <CancelLoanDialog loan={loan} onClose={close} onDone={changed} />}
    </Drawer>
  );
}

const loansFetch = () => hrApi.loans();

function LoansTab({ level, people }) {
  const canOperate = levelAtLeast(level, 'operator');
  const [rows, load, failed] = useList(loansFetch);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const all = rows || [];
  const shown = useMemo(() => all.filter(l => !status || l.status === status), [all, status]);
  const count = s => all.filter(l => l.status === s).length;
  const columns = useMemo(() => [
    { key: 'loan_no', label: 'Loan', card: 'subtitle', render: l => <span className="whitespace-nowrap font-mono text-xs font-semibold text-[#515154]">{l.loan_no}</span>, export: l => l.loan_no },
    { key: 'person_name', label: 'Person', card: 'title', export: l => l.person_name,
      render: l => (
        <button type="button" onClick={() => setOpen(l.id)} className="block max-w-[240px] text-left">
          <span className="block truncate text-sm font-semibold text-[#1D1D1F] hover:text-[#007AFF]">{l.person_name}</span>
          <span className="block truncate font-mono text-[11px] text-[#86868B]">{l.person_code}</span>
        </button>
      ) },
    { key: 'principal', label: 'Principal', align: 'right', card: 'metric', sortValue: l => sortNum(l.principal), render: l => inr2(l.principal), export: l => inr2(l.principal) },
    { key: 'outstanding', label: 'Outstanding', align: 'right', card: 'metric', sortValue: l => sortNum(l.outstanding),
      render: l => <b className="tabular-nums">{inr2(l.outstanding)}</b>, export: l => inr2(l.outstanding) },
    { key: 'instalment', label: 'Instalment', align: 'right', card: 'metric', sortValue: l => sortNum(l.instalment), render: l => inr2(l.instalment), export: l => inr2(l.instalment) },
    { key: 'next_due', label: 'Next due', card: 'detail', sortValue: l => l.next_due_month || '',
      render: l => (l.next_due_month ? <span className="whitespace-nowrap">{monthLabel(l.next_due_month)} · {inr2(l.next_due)}</span> : '—'),
      export: l => (l.next_due_month ? `${monthLabel(l.next_due_month)} ${inr2(l.next_due)}` : '') },
    { key: 'status', label: 'Status', card: 'status', render: l => <Pill status={l.status} />, export: l => l.status },
  ], []);
  return (
    <div>
      <FilterRail className="mb-2">
        <FilterGroup label="Status" divider={false}>
          <FilterChip label="All" count={all.length} on={!status} onClick={() => setStatus('')} />
          {['active', 'closed', 'cancelled'].map(s => (
            <FilterChip key={s} label={s[0].toUpperCase() + s.slice(1)} count={count(s)} on={status === s} onClick={() => setStatus(c => (c === s ? '' : s))} />
          ))}
        </FilterGroup>
        {canOperate && <div className="ml-auto"><Button size="sm" onClick={() => setCreating(true)}><Plus size={14} /> New loan</Button></div>}
      </FilterRail>
      {failed && <LoadFailed rows={rows} onRetry={load} what="the loans" />}
      {rows == null && !failed ? <div className="p-8 text-sm text-slate-400">Loading loans…</div> : (
        <DataTable columns={columns} rows={shown} getRowId={l => l.id} onRowClick={l => setOpen(l.id)}
          searchValue={q} onSearchChange={setQ} searchPlaceholder="Search loan, person or code…"
          defaultSort={{ key: 'loan_no', dir: 'desc' }} exportName="HR Loans" exportSubtitle="HR & Payroll · Loans"
          exportMeta={() => [status && `Status: ${status}`]} empty="No loans." />
      )}
      {open != null && <LoanDrawer id={open} level={level} onClose={() => setOpen(null)} onChanged={load} />}
      {creating && <NewLoanDialog people={people} onClose={() => setCreating(false)} onDone={load} />}
    </div>
  );
}

// ═══ Advances ═══════════════════════════════════════════════════════════════

const ADV_KIND = { opening: 'Opening balance', given: 'Given', recovered: 'Recovered from pay', waived: 'Waived', adjustment: 'Adjustment' };
const ADV_OUT = new Set(['recovered', 'waived']);

function GiveAdvanceDialog({ people, personId = '', onClose, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({ person_id: personId ? String(personId) : '', amount: '', txn_date: plantToday(), note: '' });
  const set = (k, v) => setF(c => ({ ...c, [k]: v }));
  const submit = async () => {
    if (!f.person_id) return 'Choose the person.';
    const a = amountCheck(f.amount, 'the advance');
    if (a.error) return a.error;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.txn_date)) return 'Enter the date it was given.';
    await hrApi.giveAdvance({ person_id: Number(f.person_id), amount: a.value, txn_date: f.txn_date, note: f.note.trim() || null });
    toast.success('Advance recorded');
    onDone();
    return undefined;
  };
  return (
    <Dialog title="Give advance" confirmLabel="Give advance" onClose={onClose} onSubmit={submit}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><PersonSelect people={people} value={f.person_id} onChange={v => set('person_id', v)} /></div>
        <Field label="Amount (₹)" required><Input inputMode="decimal" autoComplete="off" value={f.amount} onChange={e => set('amount', e.target.value)} /></Field>
        <Field label="Given on" required><Input type="date" value={f.txn_date} onChange={e => set('txn_date', e.target.value)} /></Field>
        <Field label="Note" className="sm:col-span-2"><Input autoComplete="off" value={f.note} onChange={e => set('note', e.target.value)} /></Field>
      </div>
      <p className="text-[11px] text-[#86868B]">It counts in the balance straight away and is recovered from the payroll of the month it is dated in (the next open month if that one is already finalised); an earlier month’s payroll does not take it.</p>
    </Dialog>
  );
}

function WaiveDialog({ personId, name, balance, onClose, onDone }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const submit = async () => {
    const a = amountCheck(amount, 'the amount to waive');
    if (a.error) return a.error;
    await hrApi.waiveAdvance(personId, { amount: a.value, note: note.trim() || null });
    toast.success('Advance waived');
    onDone();
    return undefined;
  };
  return (
    <Dialog title={`Waive advance — ${name}`} confirmLabel="Waive" variant="danger" onClose={onClose} onSubmit={submit}>
      <p className="text-xs text-[#515154]">Writes off some or all of the {inr2(balance)} this person owes. It cannot be more than the balance.</p>
      <Field label="Amount to waive (₹)" required><Input inputMode="decimal" autoComplete="off" value={amount} onChange={e => setAmount(e.target.value)} /></Field>
      <Field label="Why"><Input autoComplete="off" value={note} onChange={e => setNote(e.target.value)} /></Field>
    </Dialog>
  );
}

function AdvanceDrawer({ personId, level, people, onClose, onChanged }) {
  const canOperate = levelAtLeast(level, 'operator');
  const canApprove = levelAtLeast(level, 'approver');
  const [d, setD] = useState(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState(null);
  const reload = useCallback(async () => {
    try { setD(await hrApi.advanceStatement(personId)); setFailed(false); } catch { setFailed(true); }
  }, [personId]);
  useEffect(() => { reload(); }, [reload]);
  const changed = () => { reload(); onChanged(); };
  const txns = list(d?.txns);
  return (
    <Drawer title={d?.person ? `${d.person.name} · advance` : 'Advance'} onClose={onClose}
      sub={d?.person ? [d.person.code, d.person.department].filter(Boolean).join(' · ') : ''}
      actions={d && (canOperate || canApprove) && (
        <>
          {canOperate && <Button size="sm" variant="secondary" onClick={() => setDialog('give')}><Plus size={13} /> Give advance</Button>}
          {canApprove && isPositive(d.balance) && <Button size="sm" variant="ghost" className="!text-red-600" onClick={() => setDialog('waive')}><Ban size={13} /> Waive</Button>}
        </>
      )}>
      {!d && !failed && <Loading />}
      {failed && !d && <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">The statement could not be loaded.</p>}
      {d && (
        <>
          <div className="rounded-xl bg-[#1D1D1F]/[0.04] px-3 py-2">
            <div className="text-[10px] font-bold uppercase tracking-wide text-[#86868B]">Owes now</div>
            <div className="text-2xl font-extrabold tabular-nums text-[#1D1D1F]">{inr2(d.balance)}</div>
          </div>
          <Box title="Statement">
            <div className="overflow-x-auto rounded-2xl border border-white/75 bg-white/55">
              <table className="w-full text-xs">
                <thead><tr className="ci-table-head">
                  <th className={TH}>Date</th><th className={TH}>What</th><th className={TH}>Note</th>
                  <th className={`${TH} text-right`}>Amount</th><th className={`${TH} text-right`}>Balance</th>
                </tr></thead>
                <tbody>
                  {txns.length === 0 && <tr><td colSpan={5} className="px-3 py-3 text-[#86868B]">No entries.</td></tr>}
                  {txns.map(t => (
                    <tr key={t.id} className="ci-table-row">
                      <td className={`${TD} whitespace-nowrap`}>{t.txn_date}</td>
                      <td className={`${TD} font-semibold text-[#1D1D1F]`}>{ADV_KIND[t.kind] || t.kind}{t.run_month ? ` · ${monthLabel(t.run_month)}` : ''}</td>
                      <td className={`${TD} text-[#6E6E73]`}>{t.note || '—'}</td>
                      <td className={`${TD} whitespace-nowrap text-right tabular-nums`}>{ADV_OUT.has(t.kind) ? '-' : ''}{inr2(t.amount)}</td>
                      <td className={`${TD} whitespace-nowrap text-right font-semibold tabular-nums`}>{inr2(t.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Box>
        </>
      )}
      {dialog === 'give' && <GiveAdvanceDialog people={people} personId={personId} onClose={() => setDialog(null)} onDone={changed} />}
      {dialog === 'waive' && d && <WaiveDialog personId={personId} name={d.person?.name || 'this person'} balance={d.balance} onClose={() => setDialog(null)} onDone={changed} />}
    </Drawer>
  );
}

const advancesFetch = () => hrApi.advances();

function AdvancesTab({ level, people }) {
  const canOperate = levelAtLeast(level, 'operator');
  const [rows, load, failed] = useList(advancesFetch);
  const [q, setQ] = useState('');
  const [owing, setOwing] = useState(true);
  const [open, setOpen] = useState(null);
  const [giving, setGiving] = useState(false);
  const all = rows || [];
  const shown = useMemo(() => all.filter(a => !owing || (paiseOf(a.balance) ?? 0n) !== 0n), [all, owing]);
  const columns = useMemo(() => [
    { key: 'person_name', label: 'Person', card: 'title', export: a => a.person_name,
      render: a => (
        <button type="button" onClick={() => setOpen(a.person_id)} className="block max-w-[240px] text-left">
          <span className="block truncate text-sm font-semibold text-[#1D1D1F] hover:text-[#007AFF]">{a.person_name}</span>
          <span className="block truncate font-mono text-[11px] text-[#86868B]">{a.person_code}</span>
        </button>
      ) },
    { key: 'department', label: 'Department', card: 'subtitle', render: a => a.department || '—', export: a => a.department || '' },
    { key: 'balance', label: 'Balance', align: 'right', card: 'metric', sortValue: a => sortNum(a.balance),
      render: a => <b className="tabular-nums">{inr2(a.balance)}</b>, export: a => inr2(a.balance) },
    { key: 'last_txn_date', label: 'Last entry', card: 'detail', render: a => a.last_txn_date || '—', export: a => a.last_txn_date || '' },
  ], []);
  return (
    <div>
      <FilterRail className="mb-2">
        <FilterGroup label="Show" divider={false}>
          <FilterChip label="Owing" count={all.filter(a => (paiseOf(a.balance) ?? 0n) !== 0n).length} on={owing} onClick={() => setOwing(true)} />
          <FilterChip label="Everyone with a history" count={all.length} on={!owing} onClick={() => setOwing(false)} />
        </FilterGroup>
        {canOperate && <div className="ml-auto"><Button size="sm" onClick={() => setGiving(true)}><Plus size={14} /> Give advance</Button></div>}
      </FilterRail>
      {failed && <LoadFailed rows={rows} onRetry={load} what="the advances" />}
      {rows == null && !failed ? <div className="p-8 text-sm text-slate-400">Loading advances…</div> : (
        <DataTable columns={columns} rows={shown} getRowId={a => a.person_id} onRowClick={a => setOpen(a.person_id)}
          searchValue={q} onSearchChange={setQ} searchPlaceholder="Search person, code or department…"
          defaultSort={{ key: 'person_name', dir: 'asc' }} exportName="HR Advances" exportSubtitle="HR & Payroll · Advance balances"
          exportMeta={() => [owing && 'Only people who owe']} empty="No advances." />
      )}
      {open != null && <AdvanceDrawer personId={open} level={level} people={people} onClose={() => setOpen(null)} onChanged={load} />}
      {giving && <GiveAdvanceDialog people={people} onClose={() => setGiving(false)} onDone={load} />}
    </div>
  );
}

// ═══ Adjustments ════════════════════════════════════════════════════════════

function NewAdjustmentDialog({ people, onClose, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({
    person_id: '', kind: 'earning', amount: '', recurrence: 'one_time', start_month: plantMonth(), end_month: '',
    category: '', description: '', reference: '',
  });
  const set = (k, v) => setF(c => ({ ...c, [k]: v }));
  const recurring = f.recurrence === 'recurring';
  const submit = async () => {
    if (!f.person_id) return 'Choose the person.';
    const a = amountCheck(f.amount, 'the amount');
    if (a.error) return a.error;
    if (!MONTH_RE.test(f.start_month)) return 'Choose the month it applies to.';
    if (recurring && !MONTH_RE.test(f.end_month)) return 'A recurring adjustment needs an end month.';
    if (recurring && f.end_month < f.start_month) return 'The end month is before the start month.';
    await hrApi.createAdjustment({
      person_id: Number(f.person_id), kind: f.kind, amount: a.value, recurrence: f.recurrence, start_month: f.start_month,
      end_month: recurring ? f.end_month : null, category: f.category.trim() || null,
      description: f.description.trim() || null, reference: f.reference.trim() || null,
    });
    toast.success('Adjustment added — it counts once an approver approves it');
    onDone();
    return undefined;
  };
  return (
    <Dialog title="New adjustment" confirmLabel="Add adjustment" onClose={onClose} onSubmit={submit} wide>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><PersonSelect people={people} value={f.person_id} onChange={v => set('person_id', v)} /></div>
        <Field label="Type" required>
          <Select value={f.kind} options={[{ value: 'earning', label: 'Earning (added to pay)' }, { value: 'deduction', label: 'Deduction (taken from pay)' }]}
            onChange={e => set('kind', e.target.value || 'earning')} />
        </Field>
        <Field label="Amount (₹)" required><Input inputMode="decimal" autoComplete="off" value={f.amount} onChange={e => set('amount', e.target.value)} /></Field>
        <Field label="How often" required>
          <Select value={f.recurrence} options={[{ value: 'one_time', label: 'Once' }, { value: 'recurring', label: 'Every month in a range' }]}
            onChange={e => set('recurrence', e.target.value || 'one_time')} />
        </Field>
        <Field label={recurring ? 'From month' : 'Month'} required><Input type="month" value={f.start_month} onChange={e => set('start_month', e.target.value)} /></Field>
        {recurring && <Field label="Until month" required><Input type="month" value={f.end_month} onChange={e => set('end_month', e.target.value)} /></Field>}
        <Field label="Category"><Input autoComplete="off" value={f.category} onChange={e => set('category', e.target.value)} /></Field>
        <Field label="Reference" hint="e.g. the month it corrects."><Input autoComplete="off" value={f.reference} onChange={e => set('reference', e.target.value)} /></Field>
        <Field label="Description" className="sm:col-span-2"><Textarea value={f.description} onChange={e => set('description', e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

function AdjustmentActionDialog({ adjustment, action, onClose, onDone }) {
  const toast = useToast();
  const approve = action === 'approve';
  const submit = async () => {
    await (approve ? hrApi.approveAdjustment(adjustment.id) : hrApi.cancelAdjustment(adjustment.id));
    toast.success(approve ? 'Adjustment approved' : 'Adjustment cancelled');
    onDone();
    return undefined;
  };
  return (
    <Dialog title={approve ? 'Approve this adjustment?' : 'Cancel this adjustment?'} confirmLabel={approve ? 'Approve' : 'Cancel adjustment'}
      variant={approve ? 'primary' : 'danger'} onClose={onClose} onSubmit={submit}>
      <p className="text-sm text-[#3A3A3C]">
        {adjustment.person_name}: {adjustment.kind} of {inr2(adjustment.amount)}{adjustment.category ? ` (${adjustment.category})` : ''},{' '}
        {adjustment.recurrence === 'recurring' ? `${monthLabel(adjustment.start_month)} to ${monthLabel(adjustment.end_month)}` : monthLabel(adjustment.start_month)}.
        {approve ? ' Once approved it is included in that month’s payroll.' : ' It will no longer be included in payroll.'}
      </p>
    </Dialog>
  );
}

function AdjustmentsTab({ level, people }) {
  const canOperate = levelAtLeast(level, 'operator');
  const canApprove = levelAtLeast(level, 'approver');
  const [month, setMonth] = useState('');
  const fetcher = useCallback(() => hrApi.adjustments(month || undefined), [month]);
  const [rows, load, failed] = useList(fetcher);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [act, setAct] = useState(null); // { adjustment, action }
  const all = rows || [];
  const shown = useMemo(() => all.filter(a => !status || a.status === status), [all, status]);
  const columns = useMemo(() => [
    { key: 'person_name', label: 'Person', card: 'title', export: a => a.person_name,
      render: a => <span className="block max-w-[220px]"><span className="block truncate text-sm font-semibold text-[#1D1D1F]">{a.person_name}</span><span className="block font-mono text-[11px] text-[#86868B]">{a.person_code}</span></span> },
    { key: 'kind', label: 'Type', card: 'subtitle', render: a => (a.kind === 'earning' ? 'Earning' : 'Deduction'), export: a => a.kind },
    { key: 'category', label: 'What', card: 'detail', render: a => (a.category || a.description ? `${a.category || ''}${a.category && a.description ? ' — ' : ''}${a.description || ''}` : '—'),
      export: a => [a.category, a.description].filter(Boolean).join(' — ') },
    { key: 'amount', label: 'Amount', align: 'right', card: 'metric', sortValue: a => sortNum(a.amount), render: a => inr2(a.amount), export: a => inr2(a.amount) },
    { key: 'period', label: 'Applies to', card: 'detail', sortValue: a => a.start_month,
      render: a => (a.recurrence === 'recurring' ? `${monthLabel(a.start_month)} – ${monthLabel(a.end_month)}` : monthLabel(a.start_month)),
      export: a => (a.recurrence === 'recurring' ? `${monthLabel(a.start_month)} - ${monthLabel(a.end_month)}` : monthLabel(a.start_month)) },
    { key: 'status', label: 'Status', card: 'status', render: a => <Pill status={a.status} />, export: a => a.status },
    { key: '_actions', label: '', card: 'actions', exportable: false,
      render: a => (
        <span className="flex gap-1.5" onClick={e => e.stopPropagation()}>
          {canApprove && a.status === 'pending' && <Button size="sm" onClick={() => setAct({ adjustment: a, action: 'approve' })}>Approve</Button>}
          {canOperate && a.status !== 'cancelled' && <Button size="sm" variant="ghost" onClick={() => setAct({ adjustment: a, action: 'cancel' })}>Cancel</Button>}
        </span>
      ) },
  ], [canApprove, canOperate]);
  return (
    <div>
      <FilterRail className="mb-2">
        <FilterGroup label="Status" divider={false}>
          <FilterChip label="All" count={all.length} on={!status} onClick={() => setStatus('')} />
          {['pending', 'approved', 'cancelled'].map(s => (
            <FilterChip key={s} label={s[0].toUpperCase() + s.slice(1)} count={all.filter(a => a.status === s).length} on={status === s} onClick={() => setStatus(c => (c === s ? '' : s))} />
          ))}
        </FilterGroup>
        <FilterGroup label="Month">
          <Input type="month" aria-label="Adjustments for month" value={month} className="!h-8 !w-[150px] !py-1 text-xs" onChange={e => setMonth(e.target.value)} />
          {month && <FilterChip label="All months ×" on onClick={() => setMonth('')} />}
        </FilterGroup>
        {canOperate && <div className="ml-auto"><Button size="sm" onClick={() => setCreating(true)}><Plus size={14} /> New adjustment</Button></div>}
      </FilterRail>
      {failed && <LoadFailed rows={rows} onRetry={load} what="the adjustments" />}
      {rows == null && !failed ? <div className="p-8 text-sm text-slate-400">Loading adjustments…</div> : (
        <DataTable columns={columns} rows={shown} getRowId={a => a.id}
          searchValue={q} onSearchChange={setQ} searchPlaceholder="Search person, category or description…"
          defaultSort={{ key: 'period', dir: 'desc' }} exportName="HR Adjustments" exportSubtitle="HR & Payroll · Adjustments"
          exportMeta={() => [month && `Month: ${monthLabel(month)}`, status && `Status: ${status}`]} empty="No adjustments." />
      )}
      {creating && <NewAdjustmentDialog people={people} onClose={() => setCreating(false)} onDone={load} />}
      {act && <AdjustmentActionDialog adjustment={act.adjustment} action={act.action} onClose={() => setAct(null)} onDone={load} />}
    </div>
  );
}

// ═══ The tab ════════════════════════════════════════════════════════════════

export default function LoansAdvances({ level }) {
  const [params, setParams] = useSearchParams();
  const asked = params.get('sub');
  const sub = SUBS.some(s => s.key === asked) ? asked : 'loans';
  const setSub = useCallback(key => setParams(p => { const n = new URLSearchParams(p); n.set('sub', key); return n; }, { replace: true }), [setParams]);

  // People for the pickers (anyone not marked as left).
  const [people, setPeople] = useState([]);
  useEffect(() => {
    let live = true;
    hrApi.people().then(p => { if (live && Array.isArray(p)) setPeople(p.filter(x => x.status !== 'exited')); }, () => {});
    return () => { live = false; };
  }, []);

  // Pay channels for the Pay staff form; read once, only when the form is offered.
  const canOperate = levelAtLeast(level, 'operator');
  const [channels, setChannels] = useState([]);
  useEffect(() => {
    if (!canOperate) return undefined;
    let live = true;
    hrApi.payChannels().then(c => { if (live && Array.isArray(list(c))) setChannels(list(c)); }, () => {});
    return () => { live = false; };
  }, [canOperate]);
  const [paying, setPaying] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);   // remounts the tabs so they re-read after a payment

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SubTabs views={SUBS} active={sub} onChange={setSub} />
        {canOperate && <div className="ml-auto"><Button size="sm" onClick={() => setPaying(true)}><HandCoins size={14} /> Pay staff</Button></div>}
      </div>
      <div key={reloadKey}>
        {sub === 'loans' && <LoansTab level={level} people={people} />}
        {sub === 'advances' && <AdvancesTab level={level} people={people} />}
        {sub === 'adjustments' && <AdjustmentsTab level={level} people={people} />}
      </div>
      {paying && <PayStaffModal people={people} channels={channels} onClose={() => setPaying(false)} onDone={() => setReloadKey(k => k + 1)} />}
    </div>
  );
}
