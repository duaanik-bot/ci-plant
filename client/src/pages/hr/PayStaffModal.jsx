// HR → Pay staff: money handed to someone on the staff, as an advance or a loan, in one form, with that
// person's ledger of advances and loans beside it (POST /hr/staff-payments, GET /hr/people/:id/ledger).
//
//   Giving money to staff?  Yes / No. No explains that this form is only for staff money (it posts to the
//                           HR ledgers, never to Accounts) and closes.
//   Staff                   active people, searchable by name, code or department.
//   Advance / Loan          an advance goes into the advance balance at once (a 'given' row, source manual)
//                           and the payroll of the month containing its date recovers it (the next open month
//                           when that one is already finalised) — an earlier month's payroll never sees it, as
//                           a run reads balances as at its month end; a loan gets a CI-LN number and is taken
//                           back in monthly instalments, never before the month it was given.
//   Amount, date, paid via  the date defaults to today at the plant; paid via is cash or a pay channel.
//   Instalments (loan)      with a live preview: "₹X a month for N months from <Month>". X is the amount over
//                           N rounded UP to the rupee — as the server works it out — so the loan is never
//                           under-recovered, and the last month takes what is left.
//
// The ledger (PersonLedger, exported so the payroll line drawer shows the same panel) lists every advance
// and loan movement by date, newest first, with the advance balance after each and a loan's outstanding
// after each, plus the advance balance and each open loan as they stand. A row opens to its details.
//
// Nothing here refuses on judgement. The server's own refusals are said inline, in its words, and what
// was typed stays; its warnings (a person marked as left, a month payroll already closed) are shown after
// the payment is saved. Money is only formatted: the one figure worked out here, the instalment preview,
// is exact BigInt paise arithmetic. Nothing is logged.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, HandCoins, Landmark, Loader2, RefreshCw, Wallet } from 'lucide-react';
import { Button, Field, Input, Modal, Select, useToast } from '../../components/ui.jsx';
import { fmt } from '../../api.js';
import { hrApi, inr2, monthLabel } from '../../lib/hr.js';
import { InlineError, parseNum, refusalText } from './PersonDrawer.jsx';
import { list, paiseOf, plantToday, scaledText, shiftMonth } from './RunLineDrawer.jsx';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// The instalment the server will set: the amount over n, rounded UP to the whole rupee, and how the
// months fall (min(instalment, outstanding) each month, so the last takes the remainder).
export function instalmentPlan(amount, n) {
  const paise = paiseOf(amount);
  if (paise === null || paise <= 0n || !Number.isInteger(n) || n < 1) return null;
  const per = n * 100;
  const rupees = (paise + BigInt(per) - 1n) / BigInt(per);           // ceiling, in whole rupees
  const each = rupees * 100n;
  const months = Number((paise + each - 1n) / each);
  const last = paise - each * BigInt(months - 1);
  return { each: scaledText(each, 2), months, last: scaledText(last, 2), lastDiffers: last !== each };
}

// The month payroll takes a payment into: the month it was given, unless payroll has already closed that
// month (or a later one), in which case the next open one.
export function openMonthFor(date, closedMonth) {
  const m = String(date || '').slice(0, 7);
  if (!MONTH_RE.test(m)) return null;
  return closedMonth && m <= closedMonth ? shiftMonth(closedMonth, 1) : m;
}

const personLabel = p => [p.display_name || p.name, p.code, p.department].filter(Boolean).join(' · ');

// ── The ledger panel ────────────────────────────────────────────────────────

const SOURCE_WORDS = { manual: 'Given in the app', payroll: 'Payroll', waiver: 'Waiver', loader: 'Loaded from the workbook' };

function LedgerRow({ row, open, onToggle }) {
  const more = row.effect === 'owes_more';
  const Icon = more ? ArrowUpRight : ArrowDownLeft;
  const details = [
    row.loan_no && ['Loan', row.loan_no],
    row.run_month && ['Payroll month', monthLabel(row.run_month)],
    row.source && ['Source', SOURCE_WORDS[row.source] || row.source],
    row.note && ['Note', row.note],
    (row.created_by_name || row.created_at) && ['Entered', [row.created_by_name, row.created_at ? fmt.dt(row.created_at) : ''].filter(Boolean).join(' · ')],
  ].filter(Boolean);
  return (
    <li className="border-b border-[#1D1D1F]/[0.05] last:border-b-0">
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left text-xs hover:bg-white/70">
        {open ? <ChevronDown size={13} className="mt-0.5 shrink-0 text-[#86868B]" /> : <ChevronRight size={13} className="mt-0.5 shrink-0 text-[#86868B]" />}
        <span className="w-[74px] shrink-0 tabular-nums text-[#515154]">{fmt.date(row.date)}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 font-semibold text-[#1D1D1F]">
            <Icon size={12} className={`shrink-0 ${more ? 'text-amber-600' : 'text-emerald-600'}`} />
            <span className="truncate">{row.label}{row.loan_no ? ` · ${row.loan_no}` : ''}</span>
          </span>
          <span className="block text-[11px] text-[#6E6E73]">
            Advance balance {inr2(row.advance_balance)}
            {row.ledger === 'loan' && row.loan_outstanding != null ? ` · loan left ${inr2(row.loan_outstanding)}` : ''}
          </span>
        </span>
        <span className={`shrink-0 whitespace-nowrap font-bold tabular-nums ${more ? 'text-[#1D1D1F]' : 'text-emerald-700'}`}>
          {more ? '+' : '−'}{inr2(row.amount)}
        </span>
      </button>
      {open && (
        <dl className="mx-2.5 mb-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-xl bg-white/70 px-3 py-2 text-[11px]">
          {details.length ? details.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-semibold text-[#6E6E73]">{k}</dt>
              <dd className="min-w-0 break-words text-[#1D1D1F]">{v}</dd>
            </div>
          )) : <dd className="col-span-2 text-[#86868B]">No more details.</dd>}
        </dl>
      )}
    </li>
  );
}

// One person's advances and loans. Loads itself; `version` bumps make it read again, and `ledger` (an
// answer the caller already has, e.g. from a staff payment) is shown without another read.
export function PersonLedger({ personId, version = 0, ledger: given = null, compact = false }) {
  const [state, setState] = useState({ status: 'idle', data: null, error: '' });
  const [openKey, setOpenKey] = useState(null);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    if (personId == null || personId === '') { setState({ status: 'idle', data: null, error: '' }); return undefined; }
    if (given && String(given.person?.id) === String(personId) && again === 0) {
      setState({ status: 'ready', data: given, error: '' });
      return undefined;
    }
    let live = true;
    setState(s => ({ status: 'loading', data: String(s.data?.person?.id) === String(personId) ? s.data : null, error: '' }));
    hrApi.personLedger(personId).then(d => { if (live) setState({ status: 'ready', data: d, error: '' }); },
      e => { if (live) setState({ status: 'failed', data: null, error: refusalText(e) }); });
    return () => { live = false; };
  }, [personId, version, given, again]);

  if (personId == null || personId === '') {
    return <p className="text-xs text-[#86868B]">Choose a person to see their advances and loans.</p>;
  }
  const d = state.data;
  if (!d) {
    return state.status === 'failed'
      ? <InlineError message={`The ledger could not be read: ${state.error}`} className="" />
      : <p className="flex items-center gap-2 text-xs text-[#86868B]"><Loader2 size={13} className="animate-spin" /> Reading the ledger…</p>;
  }
  const totals = d.totals || {};
  const open = list(totals.loans).filter(l => l.status === 'active' && (paiseOf(l.outstanding) ?? 0n) !== 0n);
  const rows = list(d.rows);
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-2xl border border-white/75 bg-white/65 px-3 py-2">
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#6E6E73]">Advance balance</p>
          <p className="text-base font-extrabold tabular-nums text-[#1D1D1F]">{inr2(totals.advance_balance)}</p>
        </div>
        <div className="rounded-2xl border border-white/75 bg-white/65 px-3 py-2">
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#6E6E73]">Loans outstanding</p>
          <p className="text-base font-extrabold tabular-nums text-[#1D1D1F]">{inr2(totals.loans_outstanding)}</p>
        </div>
      </div>
      {open.length > 0 && (
        <ul className="space-y-1">
          {open.map(l => (
            <li key={l.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl bg-[#1D1D1F]/[0.03] px-3 py-1.5 text-[11px] text-[#515154]">
              <Landmark size={12} className="shrink-0 text-[#6E6E73]" />
              <span className="font-bold text-[#1D1D1F]">{l.loan_no}</span>
              <span>left {inr2(l.outstanding)}</span>
              <span>· {inr2(l.instalment)} a month</span>
              {l.next_due_month && <span>· next {monthLabel(l.next_due_month)}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <p className="flex-1 text-[11px] font-bold uppercase tracking-[0.1em] text-[#6E6E73]">By date, newest first</p>
        {state.status === 'loading' && <Loader2 size={12} className="animate-spin text-[#86868B]" />}
        <button type="button" aria-label="Read the ledger again" title="Read again" onClick={() => setAgain(n => n + 1)}
          className="flex h-6 w-6 items-center justify-center rounded-full text-[#86868B] hover:bg-[#1D1D1F]/[0.05] hover:text-[#1D1D1F]">
          <RefreshCw size={12} />
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-xl bg-white/55 px-3 py-2 text-xs text-[#86868B]">No advances or loans yet.</p>
      ) : (
        <ul className={`overflow-y-auto rounded-2xl border border-white/75 bg-white/55 ${compact ? 'max-h-[260px]' : 'max-h-[420px]'}`}>
          {rows.map(row => (
            <LedgerRow key={row.key} row={row} open={openKey === row.key} onToggle={() => setOpenKey(k => (k === row.key ? null : row.key))} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ── The form ────────────────────────────────────────────────────────────────

function Choice({ on, onClick, children, disabled }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={on}
      className={`h-10 flex-1 rounded-xl border px-3 text-sm font-semibold transition-colors ${on
        ? 'border-[#007AFF] bg-[#E1EFFF] text-[#0064D2]'
        : 'border-[#1D1D1F]/10 bg-white/70 text-[#515154] hover:bg-white'} disabled:opacity-50`}>
      {children}
    </button>
  );
}

const blankForm = personId => ({
  staff: personId != null ? 'yes' : null, person: personId != null ? String(personId) : '', kind: 'advance',
  amount: '', date: plantToday(), via: 'cash', instalments: '', firstDue: '', note: '',
});

export default function PayStaffModal({ personId = null, people: givenPeople = null, channels: givenChannels = null, onClose, onDone }) {
  const toast = useToast();
  const [people, setPeople] = useState(givenPeople || []);
  const [channels, setChannels] = useState(givenChannels || []);
  const [closedMonth, setClosedMonth] = useState(null);
  useEffect(() => {
    let live = true;
    Promise.allSettled([
      givenPeople ? Promise.resolve(givenPeople) : hrApi.people(),
      givenChannels ? Promise.resolve(givenChannels) : hrApi.payChannels(),
      hrApi.runs(),
    ]).then(([p, c, r]) => {
      if (!live) return;
      if (p.status === 'fulfilled' && Array.isArray(p.value)) setPeople(p.value);
      if (c.status === 'fulfilled' && Array.isArray(c.value)) setChannels(c.value);
      if (r.status === 'fulfilled') {
        const runs = Array.isArray(r.value) ? r.value : list(r.value?.runs);
        setClosedMonth(runs.filter(x => x?.status === 'finalised').map(x => String(x.month).slice(0, 7)).sort().pop() || null);
      }
    });
    return () => { live = false; };
  }, [givenPeople, givenChannels]);

  const [form, setForm] = useState(() => blankForm(personId));
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);        // the server's answer to the last payment
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setError(''); };

  const staffOptions = useMemo(() => list(people)
    .filter(p => p.status === 'active' || String(p.id) === String(form.person))
    .slice().sort((a, b) => String(a.display_name || a.name).localeCompare(String(b.display_name || b.name)))
    .map(p => ({ value: String(p.id), label: personLabel(p), search: [p.name, p.display_name, p.code, p.department].filter(Boolean).join(' ') })),
  [people, form.person]);
  const viaOptions = useMemo(() => [
    { value: 'cash', label: 'Cash' },
    ...list(channels).filter(c => c && c.active !== false && String(c.code).toLowerCase() !== 'cash')
      .map(c => ({ value: c.code, label: c.label ? `${c.label} (${c.code})` : c.code })),
  ], [channels]);

  const amount = parseNum(form.amount, 2);
  const nText = String(form.instalments).trim();
  const n = /^\d{1,4}$/.test(nText) ? Number(nText) : NaN;
  const errors = {};
  if (amount.error) errors.amount = amount.error;
  else if (amount.blank || amount.value <= 0) errors.amount = 'Type the amount given.';
  if (!form.person) errors.person = 'Choose who the money was given to.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) errors.date = 'Choose the date it was given.';
  if (form.kind === 'loan') {
    if (!(n >= 1)) errors.instalments = 'How many monthly instalments — 1 or more, a whole number.';
    if (form.firstDue && !MONTH_RE.test(form.firstDue)) errors.firstDue = 'A month like 2026-11.';
  }
  const open = openMonthFor(form.date, closedMonth);
  const firstDue = form.kind === 'loan' ? (form.firstDue || open) : null;
  const plan = form.kind === 'loan' && !errors.amount && n >= 1 ? instalmentPlan(String(form.amount).trim(), n) : null;

  const submit = async () => {
    setTried(true);
    setError('');
    if (Object.keys(errors).length) { setError('Check the highlighted fields.'); return; }
    const body = {
      person_id: Number(form.person), kind: form.kind, amount: String(form.amount).trim(), paid_on: form.date,
      paid_via: form.via || 'cash', note: form.note.trim() || null,
    };
    if (form.kind === 'loan') {
      body.instalments = n;
      if (form.firstDue) body.first_due_month = form.firstDue;
    }
    setBusy(true);
    let res;
    try {
      res = await hrApi.staffPayment(body);
    } catch (e) {
      setError(refusalText(e)); // refused — said here; everything typed stays
      return;
    } finally {
      setBusy(false);
    }
    setDone(res);
    toast.success(res?.kind === 'loan' ? `Loan ${res?.loan?.loan_no || ''} given`.trim() : 'Advance given');
    onDone?.(res);
  };

  const another = () => {
    setForm(f => ({ ...blankForm(f.person || null), kind: f.kind, via: f.via, date: f.date }));
    setDone(null);
    setTried(false);
    setError('');
  };

  const err = k => (tried && errors[k] ? <span className="font-semibold text-red-600">{errors[k]}</span> : null);
  const warnings = list(done?.warnings).filter(w => typeof w === 'string' && w);

  let footer;
  if (form.staff !== 'yes') {
    footer = <Button variant="secondary" onClick={onClose}>Close</Button>;
  } else if (done) {
    footer = (
      <>
        <Button variant="secondary" onClick={another}>Give another</Button>
        <Button onClick={onClose}>Done</Button>
      </>
    );
  } else {
    footer = (
      <>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} disabled={busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <HandCoins size={14} />} {form.kind === 'loan' ? 'Give loan' : 'Give advance'}
        </Button>
      </>
    );
  }

  return (
    <Modal open onClose={onClose} wide title="Pay staff — advance or loan" footer={footer}>
      <div className="space-y-3">
        <Field label="Giving money to staff?">
          <div className="flex gap-2">
            <Choice on={form.staff === 'yes'} onClick={() => set('staff', 'yes')} disabled={Boolean(done)}>Yes</Choice>
            <Choice on={form.staff === 'no'} onClick={() => set('staff', 'no')} disabled={Boolean(done)}>No</Choice>
          </div>
        </Field>

        {form.staff === 'no' && (
          <p className="rounded-2xl border border-[#1D1D1F]/[0.06] bg-white/65 px-4 py-3 text-sm text-[#3A3A3C]">
            This form is only for money given to someone on the staff — an advance or a loan that payroll takes back.
            It writes to the HR ledgers and does not touch Accounts. Record any other payment where it belongs.
          </p>
        )}

        {form.staff === null && (
          <p className="text-xs text-[#86868B]">Answer the question above to begin.</p>
        )}

        {form.staff === 'yes' && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
            <div data-ci-form className="space-y-3">
              <Field label="Staff" required hint={err('person')}>
                <Select value={form.person} options={staffOptions} placeholder="Choose a person…" disabled={Boolean(done)}
                  onChange={e => set('person', e.target.value || '')} />
              </Field>
              <Field label="Advance or loan" required>
                <div className="flex gap-2">
                  <Choice on={form.kind === 'advance'} onClick={() => set('kind', 'advance')} disabled={Boolean(done)}>Advance</Choice>
                  <Choice on={form.kind === 'loan'} onClick={() => set('kind', 'loan')} disabled={Boolean(done)}>Loan</Choice>
                </div>
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Amount (₹)" required hint={err('amount')}>
                  <Input inputMode="decimal" autoComplete="off" value={form.amount} disabled={Boolean(done)}
                    onChange={e => set('amount', e.target.value)} />
                </Field>
                <Field label="Date given" required hint={err('date')}>
                  <Input type="date" value={form.date} disabled={Boolean(done)} onChange={e => set('date', e.target.value)} />
                </Field>
              </div>
              <Field label="Paid via">
                <Select value={form.via} options={viaOptions} disabled={Boolean(done)} onChange={e => set('via', e.target.value || 'cash')} />
              </Field>
              {form.kind === 'loan' && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Monthly instalments" required hint={err('instalments')}>
                    <Input inputMode="numeric" autoComplete="off" value={form.instalments} disabled={Boolean(done)}
                      onChange={e => set('instalments', e.target.value)} />
                  </Field>
                  <Field label="First instalment" hint={err('firstDue') || (open ? `Blank = ${monthLabel(open)}` : null)}>
                    <Input type="month" value={form.firstDue} disabled={Boolean(done)} onChange={e => set('firstDue', e.target.value)} />
                  </Field>
                </div>
              )}
              {form.kind === 'loan' && plan && firstDue && (
                <p className="rounded-xl bg-[#E1EFFF]/70 px-3 py-2 text-sm font-semibold text-[#0064D2]">
                  {inr2(plan.each)} a month for {plan.months} {plan.months === 1 ? 'month' : 'months'} from {monthLabel(firstDue)}
                  {plan.lastDiffers && <span className="block text-xs font-medium">The last month takes what is left: {inr2(plan.last)}.</span>}
                  <span className="block text-xs font-medium">
                    No payroll before the month it was given takes an instalment; if {monthLabel(firstDue)} is already finalised, the first comes from the next open month.
                  </span>
                </p>
              )}
              {form.kind === 'advance' && open && (
                <p className="rounded-xl bg-[#1D1D1F]/[0.04] px-3 py-2 text-xs text-[#515154]">
                  Goes into the advance balance straight away. It is recovered from the payroll of the month it was given
                  — {monthLabel(open)}{open !== String(form.date || '').slice(0, 7) ? ', the next open month, as that one is already finalised' : ''} —
                  with the rest of the balance; an earlier month’s payroll does not take it. The recovery can be changed on
                  that month’s payroll line.
                </p>
              )}
              <Field label="Note">
                <Input value={form.note} autoComplete="off" disabled={Boolean(done)} onChange={e => set('note', e.target.value)} />
              </Field>
              <InlineError message={error} className="" />
              {done && (
                <div className="space-y-1.5 rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                  <p className="flex items-center gap-1.5 font-bold">
                    <Wallet size={13} />
                    {done.kind === 'loan'
                      ? `Loan ${done.loan?.loan_no || ''} saved: ${inr2(done.loan?.instalment)} a month from ${monthLabel(done.loan?.first_due_month)}.`
                      : `Advance saved. Balance now ${inr2(done.ledger?.totals?.advance_balance)}.`}
                  </p>
                  {warnings.map(w => <p key={w} className="font-medium text-amber-800">{w}.</p>)}
                </div>
              )}
            </div>
            <div className="rounded-[20px] border border-white/75 bg-white/45 p-3">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[#6E6E73]">
                Advances and loans{form.person ? ` — ${staffOptions.find(o => o.value === form.person)?.label?.split(' · ')[0] || ''}` : ''}
              </p>
              <PersonLedger personId={form.person || null} ledger={done?.ledger ?? null} />
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
