// HrSetup: Setup's HR & payroll tab (Cash & Bank spec §7.2, §7.3, §7.8, §7.9; plan Task 15; ruling R55). Props: { me, book, can }.
//
// How HR's staff money reaches this book, set once by an Admin:
//   Pay channels        each of HR's pay channels and the bank or cash account it pays from, a ledger of either book (§7.3). An
//                       unmapped channel's HR entries wait as exceptions until it is mapped. CASH with no account of its own pays from
//                       office cash by default (cash_default), which is said beside it, "(default)", and is never saved as a choice.
//   Ledger roles        the ledger that plays each role in the book: the staff ledgers HR's money posts to, and the ones the app posts
//                       to by itself (§7.2).
//   Salary expense      where gross pay goes, by HR's person type or department (§7.9); a key with nothing chosen goes to the salary
//                       expense role's ledger.
//   Payroll booking     the month's payroll booked at the month end (the default) or on the day it is paid (§7.8).
//   Create the staff ledgers   makes the ledgers the book lacks for the five staff roles, and gives them their roles; a ledger of the
//                       name the book has already is used instead, and is named as found (Task 15 fix round, F1). What it did (made,
//                       found, and now taking no typed entry) is said in the toast and in a line under the roles that stays until the
//                       next change.
// GET /finance/hr-setup?book= answers all of it, and what the form chooses from (ruling R55): hr_channels, HR's pay channels, and
// expense_keys, the keys the expense map can take. A channel's picker lists the bank and cash ledgers of every book the login reads (a
// channel's bank may be the other book's: "DP Bank · Darbi Print Pack"); the other pickers list this book's ledgers.
//
// What is on screen is the setup as read with the Admin's changes laid over it (`edits`), so a refresh underneath (another login, a
// realtime tick) never wipes a change. Save sends the whole state in one PUT /finance/hr-setup (setup.js finHrSetupBody), which the
// server takes entry by entry and passes over wherever nothing changed. "Create the staff ledgers" is POST /finance/hr-setup/ledgers
// { book_id }; it works from what is saved, so it waits while changes are not saved yet. Both are the shared form write (useFormWrite):
// a refusal is the server's sentence as it comes, under the channel, role or key it names (finHrProblemRow), else at the foot, and a
// write that got no answer is said. Neither mints a number, so neither is joined (writeOnce.js); one guard holds both to one press at a
// time (ruling R57), the shared Button holds each press until its write settles.
//
// Only an Admin edits (capability `admin`); any other login sees the same rows as text. Nothing here is a table: the rows keep HR's
// order, the roles' and the keys'. The whole tab is one form scope to the update bar while it holds changes not saved yet.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Button, useToast } from '../ui.jsx';
import LedgerPicker from './LedgerPicker.jsx';
import { LoadNotice } from './ReportParts.jsx';
import { Chip, FieldError } from './SetupParts.jsx';
import useFormWrite from './useFormWrite.js';
import useReport from './useReport.js';
import useRealtimeRefresh from '../../lib/useRealtimeRefresh.js';
import { newestAnswerGate } from '../../lib/newestAnswer.js';
import { FINANCE_TABLES } from '../../lib/finance/tables.js';
import {
  FIN_PAYROLL_BOOKINGS, finHrAccountChoices, finHrChannelRows, finHrExpenseRows, finHrProblemRow, finHrRoleRows, finHrSetupBody,
  finHrSetupChanges, finStaffLedgersText,
} from '../../lib/finance/setup.js';

const NO_EDITS = Object.freeze({});

// The ledgers of every book the login reads, for the channel pickers: { lists: [{ book: { id, name }, ledgers }] | null, failed, reload }.
// Each book's list is GET /finance/books/:id/ledgers?include_inactive=1 (the picker decides what to offer). Asked again when a Finance
// table changes, like every Finance read; an older answer never lands over a newer one, and a failure keeps the last lists and says so.
function useLedgerLists(books) {
  const key = books.map(b => `${b.id}:${b.name}`).join('|');
  // The books asked for, kept while their ids and names stay the same: the caller may hand a new array at every render.
  const asked = useMemo(() => books.map(b => ({ id: b.id, name: b.name })), [key]);
  const [state, setState] = useState({ key: null, lists: null, failed: false });
  const gate = useRef(null);
  const latest = useRef(0);
  if (!gate.current) gate.current = newestAnswerGate();

  const load = useCallback(async () => {
    const seq = gate.current.begin();
    latest.current = seq;
    let answers;
    try {
      answers = await Promise.all(asked.map(b => api.get(`/finance/books/${b.id}/ledgers?include_inactive=1`)));
    } catch {
      if (seq === latest.current) setState(s => ({ ...s, failed: true }));
      return;
    }
    if (!gate.current.accept(seq)) return;
    setState({ key, lists: asked.map((b, i) => ({ book: b, ledgers: answers[i]?.ledgers ?? [] })), failed: false });
  }, [asked, key]);

  useEffect(() => { load(); }, [load]);
  useRealtimeRefresh(load, FINANCE_TABLES);
  return { lists: state.key === key ? state.lists : null, failed: state.failed, reload: load };
}

// A part of the form: its title, what it is for, and its rows.
function Section({ title, intro, children }) {
  return (
    <section className="glass rounded-[22px] p-4">
      <div className="ci-form-panel-title"><span>{title}</span></div>
      {intro && <p className="mb-2 max-w-3xl text-xs text-slate-500">{intro}</p>}
      <div className="divide-y divide-[#1D1D1F]/[0.06]">{children}</div>
    </section>
  );
}

// One row: what it is on the left, the choice on the right.
function Row({ label, sub, children }) {
  return (
    <div className="grid gap-x-4 gap-y-1 py-2.5 sm:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] sm:items-start">
      <div className="min-w-0">
        <div className="break-words text-sm font-semibold text-[#1D1D1F]">{label}</div>
        {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const Said = ({ children, muted = false }) => <span className={`block break-words pt-1 text-sm ${muted ? 'text-slate-400' : 'text-[#1D1D1F]'}`}>{children}</span>;

export default function HrSetup({ me, book, can }) {
  const toast = useToast();
  const mayEdit = can('admin');
  const setupRead = useReport(`/finance/hr-setup?book=${book.id}`);
  const setup = setupRead.data;
  const { lists, failed: listsFailed, reload: reloadLedgers } = useLedgerLists(me?.books?.length ? me.books : [book]);
  const [edits, setEdits] = useState(NO_EDITS);
  const { problems, attempt } = useFormWrite();
  const [staffNote, setStaffNote] = useState('');   // what "Create the staff ledgers" did, until the next change
  const busyRef = useRef(false);   // one write at a time, the save and "Create the staff ledgers" alike (ruling R57)
  const sentRef = useRef(null);    // the body a save sent, so the entry a refusal names can be turned back into its row

  const channelRows = useMemo(() => finHrChannelRows(setup, edits), [setup, edits]);
  const roleRows = useMemo(() => finHrRoleRows(setup, edits), [setup, edits]);
  const expenseRows = useMemo(() => finHrExpenseRows(setup, edits), [setup, edits]);
  const changes = setup ? finHrSetupChanges(setup, edits) : 0;
  const booking = edits.payroll_booking ?? setup?.payroll_booking ?? 'month_end';

  // The ledgers: every book's, by id, for the names; this book's, for the role and expense pickers; and the channels' choices, which keep
  // whatever a channel pays from now so the picker can show it.
  const ledgerById = useMemo(() => new Map((lists ?? []).flatMap(l => l.ledgers.map(x => [x.id, x]))), [lists]);
  const own = lists ? lists.find(l => l.book.id === book.id)?.ledgers ?? [] : null;
  const accounts = useMemo(
    () => (lists ? finHrAccountChoices(lists, book.id, channelRows.map(r => r.value).filter(id => id != null)) : null),
    [lists, book.id, channelRows]);
  const accountName = id => accounts?.find(a => a.id === id)?.name ?? ledgerById.get(id)?.name ?? (lists ? `Ledger #${id}` : '…');
  const ledgerName = id => ledgerById.get(id)?.name ?? (lists ? `Ledger #${id}` : '…');
  const salary = roleRows.find(r => r.key === 'salary_expense')?.value ?? null;
  const salaryText = salary != null ? `As salary expense: ${ledgerName(salary)}` : 'As salary expense (no ledger set yet)';

  const setPart = (part, key, value) => {
    setStaffNote('');
    setEdits(e => ({ ...e, [part]: { ...(e[part] ?? {}), [key]: value } }));
  };

  // The server's refusal, under the row it names, else at the foot.
  const [problemField, problemText] = Object.entries(problems)[0] ?? [];
  const at = problemField === 'form' ? null : finHrProblemRow(problemField, sentRef.current);
  const atFoot = at ? '' : problemText ?? '';
  const problemFor = (part, key) => (at && at.part === part && at.key === key ? problemText : '');

  const save = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const body = finHrSetupBody({ bookId: book.id, setup, edits });
      sentRef.current = body;
      setStaffNote('');
      const done = await attempt(() => api.put('/finance/hr-setup', body), { onFail: setupRead.reload });
      if (!done) return;
      await setupRead.reload();
      setEdits(NO_EDITS);
      toast.success('HR & payroll setup saved');
    } finally {
      busyRef.current = false;
    }
  };

  const makeStaffLedgers = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      sentRef.current = null;
      setStaffNote('');
      let made = null;
      const done = await attempt(async () => { made = await api.post('/finance/hr-setup/ledgers', { book_id: book.id }); }, { onFail: setupRead.reload });
      if (!done) return;
      await Promise.all([setupRead.reload(), reloadLedgers()]);
      const said = finStaffLedgersText(made);
      toast.success(said);
      setStaffNote(said);
    } finally {
      busyRef.current = false;
    }
  };

  // A picker for the Admin, the ledger's name for anyone else.
  const choice = ({ value, ledgers, label, none, onChange, nameOf }) => (mayEdit ? (
    <LedgerPicker bookId={book.id} ledgers={ledgers} value={value} placeholder={none} aria-label={label} onChange={id => onChange(id)} />
  ) : (
    <Said muted={value == null}>{value == null ? none : nameOf(value)}</Said>
  ));

  return (
    <div data-ci-form>
      <p className="mb-3 max-w-3xl text-xs text-slate-500">
        How HR&apos;s staff money reaches {book.name}: the account each HR pay channel pays from, the ledger of each role, where the salary
        expense goes, and when the payroll month is booked.{mayEdit ? '' : ' Only an Admin can change it.'}
      </p>
      <LoadNotice failed={setupRead.failed} shown={Boolean(setup)} what="the HR & payroll setup" onRetry={setupRead.reload} />
      <LoadNotice failed={listsFailed} shown={Boolean(lists)} what="the ledgers, so none can be picked" onRetry={reloadLedgers} />

      {!setup ? (!setupRead.failed && <p className="py-12 text-center text-sm text-gray-400">Loading…</p>) : (
        <div className="space-y-4">
          <Section title="Pay channels"
            intro="Each HR pay channel pays from one bank or cash account, of either book. HR's entries from a channel with no account wait as exceptions until it has one.">
            {channelRows.length === 0 && <p className="py-2 text-sm text-slate-500">HR has no pay channels yet. They are added in HR.</p>}
            {channelRows.map(r => (
              <Row key={r.code} label={r.name}
                sub={<span className="inline-flex flex-wrap items-center gap-1.5">{r.code}{r.kind && <Chip tone={r.kind === 'cash' ? 'good' : 'info'}>{r.kind === 'cash' ? 'Cash' : 'Bank'}</Chip>}</span>}>
                {r.stale ? (
                  <Said>{accountName(r.value)} <span className="text-xs text-amber-700">HR no longer has this channel.</span></Said>
                ) : choice({
                  value: r.value, ledgers: accounts, label: `The account ${r.name} pays from`, nameOf: accountName, onChange: id => setPart('channels', r.code, id),
                  none: r.default_ledger_id != null ? `${accountName(r.default_ledger_id)} (default)` : 'No account yet',
                })}
                {r.value == null && r.default_ledger_id != null && (
                  <span className="mt-0.5 block text-[11px] text-slate-500">Office cash, by default, while the cash channel pays from no account of its own. Choosing an account saves it.</span>
                )}
                <FieldError>{problemFor('channel', r.code)}</FieldError>
              </Row>
            ))}
          </Section>

          <Section title="Ledger roles"
            intro={mayEdit
              ? "The ledger that plays each role in this book. Create the staff ledgers makes Staff Advances, Staff Loans, Salary Payable, Salaries & Wages and MD's Account for the roles that have none (a ledger already of that name is used), and gives them their roles."
              : 'The ledger that plays each role in this book.'}>
            {staffNote && <p className="my-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">{staffNote}</p>}
            {roleRows.map(r => (
              <Row key={r.key} label={r.label} sub={r.hint}>
                {choice({ value: r.value, ledgers: own, label: `The ${r.label} ledger`, none: 'No ledger yet', nameOf: ledgerName, onChange: id => setPart('roles', r.key, id) })}
                <FieldError>{problemFor('role', r.key)}</FieldError>
              </Row>
            ))}
          </Section>

          <Section title="Salary expense by person type or department"
            intro="Where the payroll month's gross pay goes, when Tally splits salary expense. A person's type is looked at first, then their department; one with neither mapped goes to the salary expense ledger.">
            {expenseRows.length === 0 && <p className="py-2 text-sm text-slate-500">HR has no people yet, so there is nothing to split by.</p>}
            {expenseRows.map(r => (
              <Row key={r.key} label={r.label} sub={r.gone ? 'No one in HR has this now.' : null}>
                {choice({ value: r.value, ledgers: own, label: `The expense ledger for ${r.label}`, none: salaryText, nameOf: ledgerName, onChange: id => setPart('expense', r.key, id) })}
                <FieldError>{problemFor('expense', r.key)}</FieldError>
              </Row>
            ))}
          </Section>

          <Section title="When the payroll month is booked"
            intro="As the accountant books salary in Tally, so the months line up in the parallel run.">
            <div role="radiogroup" aria-label="When the payroll month is booked" className="grid gap-2 py-2 sm:grid-cols-2">
              {FIN_PAYROLL_BOOKINGS.map(b => (
                <label key={b.key}
                  className={`flex items-start gap-3 rounded-2xl border px-3 py-2.5 transition ${mayEdit ? 'cursor-pointer' : 'cursor-default'} ${booking === b.key
                    ? 'border-[#0A84FF]/50 bg-[#E1EFFF]/50' : 'border-[#1D1D1F]/10 bg-white/50'}`}>
                  <input type="radio" name={`payroll-booking-${book.id}`} className="mt-1 h-4 w-4 accent-[#007AFF]" checked={booking === b.key}
                    disabled={!mayEdit} onChange={() => { setStaffNote(''); setEdits(e => ({ ...e, payroll_booking: b.key })); }} />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-[#1D1D1F]">{b.label}</span>
                    <span className="block text-xs text-slate-500">{b.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <FieldError>{problemFor('booking', 'payroll_booking')}</FieldError>
          </Section>
        </div>
      )}

      {mayEdit && (
        <div className="sticky bottom-[calc(68px+var(--sab))] z-30 mt-4 flex flex-wrap items-center justify-end gap-x-4 gap-y-2 rounded-2xl border border-white/70 bg-white/85 px-4 py-2.5 shadow-[0_8px_30px_rgba(29,29,31,0.15)] backdrop-blur-xl md:bottom-3">
          <div className="basis-full text-right empty:hidden"><FieldError>{atFoot}</FieldError></div>
          {changes > 0 && <span className="text-xs font-medium text-slate-500">{changes} {changes === 1 ? 'change' : 'changes'} not saved yet</span>}
          <Button variant="secondary" onClick={makeStaffLedgers} disabled={!setup || changes > 0}>Create the staff ledgers</Button>
          {changes > 0 && <Button variant="ghost" onClick={() => { setStaffNote(''); setEdits(NO_EDITS); }}>Discard changes</Button>}
          <Button onClick={save} disabled={!setup || changes === 0}>Save</Button>
        </div>
      )}
    </div>
  );
}
