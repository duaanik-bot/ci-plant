// Vouchers: the Day Book, what waits for the caller to approve, and the caller's drafts (spec §10). Props: { me, book, can, setBook }.
//
//   /finance                       the Day Book
//   /finance?tab=approvals         Approvals          (a login that can approve)
//   /finance?tab=drafts            Drafts             (a login that can enter vouchers)
//   ...&voucher=<id>               that voucher, open over the list. The Finance bells link here.
//
// The tab and the open voucher live in the URL (`?tab=`, `?voucher=`), so a bell link, a reload and Back all land where they should.
// A bell names a voucher and no book, and the shell may be on the other one: the open voucher asks the shell to switch to its own
// book (VoucherDetail, ruling R47), and this page is drawn afresh on that book.
//
// What it asks the server (GET /finance/vouchers, all through the list endpoint: nothing is added to the server). Ruling R72: the
// ERP is on Vercel's Hobby plan, where an overrun pauses every project, the plant's ERP included, so the page asks for as little as
// it can, and a realtime tick asks again for the list on show and the counts, nothing more:
//   the list on show   the Day Book, view=daybook with its filters (dates, type, status, search), opening on THIS MONTH
//                      (finDayBookWindow; Reset filters comes back to it, and the dates widen it); or the caller's approvals or
//                      drafts, view=approvals / view=drafts, asked for only while that tab is on show. A search is the server's
//                      `q`, so it also reaches past the 5,000 rows a day book is cut at. "Made by" narrows the rows loaded.
//   the counts         the figures and the tab counts, each the same list asked to count (count=1; finVoucherCountAsks): the
//                      caller's drafts and approvals, everything waiting in the book (the caller's own included), and what is
//                      posted dated today and in the page's month (the Day Book's own). These are VOUCHER dates (the list
//                      filters on them), so an entry dated today that was posted yesterday is in "today". "Today" is the
//                      browser's own date; plant devices run on IST.
// A screen refreshes itself when another login changes a Finance table (useRealtimeRefresh).
//
// A list that did not load is never drawn as an empty one. Each list knows whether its answer has ever come (`known`), and each count
// is null until its answer has: until then a figure is a dash and a list says it is loading, or that it could not load, with a Retry;
// once it has, a failed refresh leaves the last figures and says so. A row button that fails reloads the list (another login may
// have moved the row), and one that got no answer at all says so (useNoAnswer).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronDown, FilePenLine, Hourglass, Plus } from 'lucide-react';
import { api, fmt } from '../../api.js';
import {
  ActionMenu, Button, ConfirmDialog, DataTable, Field, Input, KpiCard, KpiRow, PageHeader, ResetFilters, rowMatches, Select, Tabs, useFilterReset,
  useToast,
} from '../../components/ui.jsx';
import VoucherForm from '../../components/finance/VoucherForm.jsx';
import VoucherDetail, { ReasonDialog, VoucherStatus } from '../../components/finance/VoucherDetail.jsx';
import useNoAnswer from '../../components/finance/useNoAnswer.js';
import useRealtimeRefresh from '../../lib/useRealtimeRefresh.js';
import { newestAnswerGate } from '../../lib/newestAnswer.js';
import { useTier } from '../../lib/tier.js';
import { dayOf } from '../../lib/dayOf.js';
import { FINANCE_TABLES } from '../../lib/finance/tables.js';
import { finBookOf } from '../../lib/finance/book.js';
import { finQueryWith, finSearchEmpty } from '../../lib/finance/page.js';
import { finFormatINR } from '../../lib/finance/money.js';
import {
  FIN_ENTRY_TYPES, FIN_PHONE_ENTRY_NOTE, FIN_TRUNCATED_NOTE, FIN_TYPE_LABELS, finDateText, finDayBookWindow, finDraftEditable, finMonthOf,
  finNumberKey, finStatusOf, finTypeLabel, finVoucherCountAsks,
} from '../../lib/finance/voucher.js';

// GET /finance/vouchers?view=…&book=…&…  Empty filters are left off; the rows keep the server's order in `_order`, which is the
// order the Drafts and Approvals tabs are kept in (the table sorts by something, and a row has nothing else to say "last touched").
function listUrl(bookId, view, filters = {}) {
  const params = new URLSearchParams({ view, book: String(bookId) });
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  return `/finance/vouchers?${params}`;
}
const numbered = rows => rows.map((row, _order) => ({ ...row, _order }));

const STATUS_CHOICES = [['draft', 'Draft'], ['submitted', 'Waiting approval'], ['posted', 'Posted']];

export default function Vouchers({ me, book, can, setBook }) {
  const toast = useToast();
  const noAnswer = useNoAnswer();
  const tier = useTier();
  const [params, setParams] = useSearchParams();

  // ── What is open: the tab, the voucher, the form, the dialogs ────────────────────────────
  const [form, setForm] = useState(null);             // { type, voucher? }
  const [rejecting, setRejecting] = useState(null);   // an Approvals row
  const [discarding, setDiscarding] = useState(null); // a Drafts row
  const [acting, setActing] = useState(() => new Set()); // rows with a write on the wire

  const change = updates => setParams(previous => finQueryWith(previous, updates), { replace: true });
  const voucherId = /^\d+$/.test(params.get('voucher') ?? '') ? Number(params.get('voucher')) : null;
  const openVoucher = id => change({ voucher: id });
  const closeVoucher = () => change({ voucher: null });

  // ── The lists and the figures ────────────────────────────────────────────────────────────
  // The Day Book opens on this month (ruling R72). The month is the one the page was opened in, and stays its default while it is open.
  const [monthNow] = useState(() => finDayBookWindow(dayOf(new Date())));
  const monthLabel = finDateText(monthNow.from).slice(3);
  const [from, setFrom] = useState(monthNow.from);
  const [to, setTo] = useState(monthNow.to);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [person, setPerson] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const [lists, setLists] = useState({ daybook: [], approvals: [], drafts: [] });
  const [truncated, setTruncated] = useState(false);
  const [counts, setCounts] = useState({ drafts: null, approvals: null, waiting: null, today: null, month: null });
  // Which lists have ever come, and which loads are failing now. A count that has never come is null, not zero.
  const [known, setKnown] = useState({ daybook: false, approvals: false, drafts: false });
  const [failing, setFailing] = useState({ daybook: false, approvals: false, drafts: false, counts: false });

  const mayApprove = can('approve');
  const mayEnter = can('enter');
  // Keying a voucher in, or editing a draft, wants a computer or a tablet: the entry grid does not fit a phone (the New Voucher menu
  // says so). A phone approves, rejects, submits and discards, and reads.
  const mayKey = tier !== 'phone';
  const tabs = useMemo(() => [
    { key: 'daybook', label: 'Day Book' },
    ...(mayApprove ? [{ key: 'approvals', label: 'Approvals', count: counts.approvals ?? undefined }] : []),
    ...(mayEnter ? [{ key: 'drafts', label: 'Drafts', count: counts.drafts ?? undefined, tone: 'draft' }] : []),
  ], [mayApprove, mayEnter, counts.approvals, counts.drafts]);
  const wantedTab = params.get('tab');
  const tab = tabs.some(t => t.key === wantedTab) ? wantedTab : 'daybook';
  // The search of the Approvals or Drafts tab is held here, as the Day Book's is, and not by the table: the empty line has to know when
  // it is the search that hid every row. A search typed on one tab is not carried to another.
  const [listSearch, setListSearch] = useState('');
  useEffect(() => { setListSearch(''); }, [tab]);
  const listQuery = tab === 'daybook' ? '' : listSearch.trim();

  // The list on show, and only that one: the Day Book with its filters, or the caller's approvals or drafts. Each list has its own gate,
  // so an answer lands on the list it was asked for, and an older answer never lands over a newer one; a failure is not an answer, so it
  // never pushes a good one aside, and only the newest request's failure is news.
  const gates = useRef({});
  const latest = useRef({});
  const loadList = useCallback(async () => {
    const view = tab;
    if (!gates.current[view]) gates.current[view] = newestAnswerGate();
    const gate = gates.current[view];
    const seq = gate.begin();
    latest.current[view] = seq;
    const answer = await api.get(listUrl(book.id, view, view === 'daybook' ? { from, to, type, status, q } : {})).catch(() => null);
    if (!answer) { if (seq === latest.current[view]) setFailing(f => ({ ...f, [view]: true })); return; }
    if (!gate.accept(seq)) return;
    setLists(l => ({ ...l, [view]: numbered(answer.vouchers) }));
    if (view === 'daybook') setTruncated(Boolean(answer.truncated));
    setKnown(k => ({ ...k, [view]: true }));
    setFailing(f => ({ ...f, [view]: false }));
  }, [book.id, tab, from, to, type, status, q]);

  // The figures and the tab counts: the server's counts (finVoucherCountAsks), which the filters do not touch. Each count lands on its
  // own, so one that fails keeps its last figure and the rest still land.
  const countGate = useRef(null);
  const countLatest = useRef(0);
  if (!countGate.current) countGate.current = newestAnswerGate();
  const loadCounts = useCallback(async () => {
    const seq = countGate.current.begin();
    countLatest.current = seq;
    const asks = finVoucherCountAsks({ today: dayOf(new Date()), month: monthNow, mayApprove, mayEnter });
    const answers = await Promise.all(asks.map(ask => api.get(listUrl(book.id, ask.view, ask.filters)).catch(() => null)));
    const missed = answers.some(answer => !answer);
    if (seq === countLatest.current) setFailing(f => ({ ...f, counts: missed }));
    if (answers.every(answer => !answer) || !countGate.current.accept(seq)) return;
    setCounts(c => {
      const next = { ...c };
      asks.forEach((ask, i) => { if (answers[i]) next[ask.key] = answers[i].count; });
      return next;
    });
  }, [book.id, mayApprove, mayEnter, monthNow]);

  const load = useCallback(() => Promise.all([loadList(), loadCounts()]), [loadList, loadCounts]);
  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { loadCounts(); }, [loadCounts]);
  useRealtimeRefresh(load, FINANCE_TABLES);

  // ── Filters ──────────────────────────────────────────────────────────────────────────────
  const filters = useFilterReset([
    [from, setFrom, monthNow.from, 'from date'], [to, setTo, monthNow.to, 'to date'], [type, setType, '', 'type'],
    [status, setStatus, '', 'status'], [person, setPerson, '', 'person'], [search, setSearch, '', 'search'],
  ]);
  const dayRows = lists.daybook;
  const approvals = lists.approvals;
  const drafts = lists.drafts;
  const people = useMemo(() => [...new Set(dayRows.map(r => r.created_by).filter(Boolean))].sort(), [dayRows]);
  const shownDay = useMemo(() => (person ? dayRows.filter(r => r.created_by === person) : dayRows), [dayRows, person]);

  // A figure above the list opens the Day Book narrowed to what it counts.
  const showInDayBook = narrowing => {
    setFrom(narrowing.from ?? ''); setTo(narrowing.to ?? ''); setType(''); setStatus(narrowing.status ?? ''); setPerson(''); setSearch('');
    change({ tab: null });
  };

  // ── Writes from a row ────────────────────────────────────────────────────────────────────
  const busyWith = id => acting.has(id);
  // A write that fails says so when nothing answered, reloads the list (another login may have moved the row), and lets the failure
  // through: a dialog that asked for it stays open.
  const failedWrite = async e => { noAnswer(e); await load(); throw e; };
  const withRow = async (id, run) => {
    setActing(set => new Set(set).add(id));
    try { await run(); } catch (e) { await failedWrite(e); } finally {
      setActing(set => { const next = new Set(set); next.delete(id); return next; });
    }
  };
  const approve = row => withRow(row.id, async () => {
    const out = (await api.post(`/finance/vouchers/${row.id}/approve`)).voucher;
    toast.success(`Approved and posted ${out.number}`);
    await load();
  });
  const reject = async reason => {
    try { await api.post(`/finance/vouchers/${rejecting.id}/reject`, { reason }); } catch (e) { await failedWrite(e); }
    toast.success('Sent back to its maker');
    setRejecting(null);
    await load();
  };
  const submitDraft = row => withRow(row.id, async () => {
    const out = (await api.post(`/finance/vouchers/${row.id}/submit`)).voucher;
    toast.success(out.status === 'posted' ? `Posted ${out.number}` : 'Sent for approval');
    await load();
  });
  const discard = async () => {
    try { await api.post(`/finance/vouchers/${discarding.id}/discard`); } catch (e) { await failedWrite(e); }
    toast.success('Draft discarded');
    await load();
  };

  // ── The form ─────────────────────────────────────────────────────────────────────────────
  // Editing needs the lines, which a list row does not carry; the voucher view's `can` has the last word on whether it may be edited.
  const openEdit = view => {
    if (!view.can.edit) { toast.info("This draft can't be edited."); return; }
    change({ voucher: null });
    setForm({ type: view.voucher.voucher_type, voucher: { ...view.voucher, lines: view.lines } });
  };
  const startEdit = row => withRow(row.id, async () => openEdit(await api.get(`/finance/vouchers/${row.id}`)));
  const closeForm = () => { setForm(null); load(); };
  const formBook = form?.voucher ? finBookOf(me.books, form.voucher.book_id) ?? book : book;

  // ── What is drawn ────────────────────────────────────────────────────────────────────────
  const typeCell = r => (
    <span>
      {finTypeLabel(r.voucher_type)}
      {r.reversal_of_id != null && (
        <span className="ml-1.5 rounded-full bg-red-50 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-red-600">Reversal</span>
      )}
    </span>
  );
  const narrationCell = r => (
    <span className="block max-w-[26rem]">
      <span className="block truncate" title={r.narration || ''}>{r.narration || <span className="text-gray-300">—</span>}</span>
      {r.status === 'draft' && r.last_reject_reason && <span className="block text-xs text-red-600">Sent back: {r.last_reject_reason}</span>}
    </span>
  );
  const amountCell = r => <span className="font-semibold tabular-nums">{finFormatINR(r.total_paise)}</span>;
  const dateColumn = { key: 'voucher_date', label: 'Date', card: 'metric', render: r => <span className="whitespace-nowrap">{finDateText(r.voucher_date)}</span> };
  const typeColumn = { key: 'voucher_type', label: 'Type', sortValue: r => finTypeLabel(r.voucher_type), render: typeCell };
  const narrationColumn = { key: 'narration', label: 'Narration', sortable: false, card: 'subtitle', render: narrationCell };
  const amountColumn = { key: 'total_paise', label: 'Amount', align: 'right', card: 'metric', render: amountCell };
  const madeByColumn = { key: 'created_by', label: 'Made by', card: 'metric', render: r => r.created_by || '—' };

  const columns = {
    daybook: [
      dateColumn,
      { key: 'number', label: 'Number', card: 'title', sortValue: r => finNumberKey(r.number), render: r => <span className="whitespace-nowrap font-semibold">{r.number || '—'}</span> },
      { ...typeColumn, card: 'metric' },
      narrationColumn,
      amountColumn,
      { key: 'status', label: 'Status', card: 'status', sortValue: r => finStatusOf(r).label, render: r => <VoucherStatus voucher={r} /> },
      madeByColumn,
    ],
    approvals: [
      { ...typeColumn, card: 'title' },
      narrationColumn,
      dateColumn,
      amountColumn,
      madeByColumn,
      { key: 'submitted_at', label: 'Waiting since', card: 'metric', render: r => <span className="whitespace-nowrap">{fmt.dt(r.submitted_at)}</span> },
      { key: '_actions', label: '', sortable: false, card: 'actions', render: r => (
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="success" disabled={busyWith(r.id)} onClick={() => approve(r)}>Approve</Button>
          <Button size="sm" variant="danger" disabled={busyWith(r.id)} onClick={() => setRejecting(r)}>Reject</Button>
        </div>) },
    ],
    drafts: [
      { ...typeColumn, card: 'title' },
      narrationColumn,
      dateColumn,
      amountColumn,
      { key: '_actions', label: '', sortable: false, card: 'actions', render: r => (
        <div className="flex flex-wrap justify-end gap-1.5">
          {finDraftEditable(r) && mayKey && <Button size="sm" variant="secondary" disabled={busyWith(r.id)} onClick={() => startEdit(r)}>Edit</Button>}
          <Button size="sm" disabled={busyWith(r.id)} onClick={() => submitDraft(r)}>Submit</Button>
          <Button size="sm" variant="ghost" disabled={busyWith(r.id)} onClick={() => setDiscarding(r)}>Discard</Button>
        </div>) },
    ],
  };
  const sorts = {
    daybook: { key: 'voucher_date', dir: 'desc' },
    approvals: { key: '_order', dir: 'asc' },     // longest waiting first, as the server lists them
    drafts: { key: '_order', dir: 'asc' },        // last touched first, as the server lists them
  };
  const narrowed = useMemo(() => {
    const narrow = rows => (listQuery ? rows.filter(r => rowMatches(r, listQuery)) : rows);
    return { approvals: narrow(approvals), drafts: narrow(drafts) };
  }, [approvals, drafts, listQuery]);
  const shown = { daybook: shownDay, approvals: narrowed.approvals, drafts: narrowed.drafts }[tab];
  const trouble = failing[tab] || failing.counts;
  const empty = !known[tab]
    ? (failing[tab] ? 'The list couldn’t load' : 'Loading…')
    : {
      daybook: filters.dirty ? 'No vouchers match these filters' : `No vouchers are dated in ${monthLabel}. Widen the dates to see others.`,
      approvals: finSearchEmpty({ searching: Boolean(listQuery), total: approvals.length, none: 'Nothing is waiting for your approval', noun: 'waiting vouchers' }),
      drafts: finSearchEmpty({ searching: Boolean(listQuery), total: drafts.length, none: 'You have no drafts', noun: 'drafts' }),
    }[tab];

  const newVoucher = mayEnter && (
    <ActionMenu label="New voucher"
      items={!mayKey
        ? [{ key: 'phone', label: FIN_PHONE_ENTRY_NOTE }]
        : FIN_ENTRY_TYPES.map(t => ({ key: t, label: FIN_TYPE_LABELS[t], onClick: () => setForm({ type: t }) }))}
      trigger={({ toggle }) => <Button onClick={toggle}><Plus size={15} /> New Voucher <ChevronDown size={13} className="opacity-70" /></Button>} />
  );

  return (
    <div>
      <PageHeader title="Vouchers" subtitle={`${book.name} · the Day Book, what waits for approval, and your drafts`} actions={newVoucher || undefined} />

      {/* Drafts are the caller's own, so a login that cannot enter vouchers has none to count. */}
      <KpiRow cols={mayEnter ? 4 : 3}>
        {mayEnter && (
          <KpiCard compact icon={FilePenLine} tone={counts.drafts ? 'warn' : 'neutral'} label="Drafts"
            value={counts.drafts != null ? fmt.num(counts.drafts) : '—'}
            sub="yours, not yet submitted" onClick={() => change({ tab: 'drafts' })} />
        )}
        <KpiCard compact icon={Hourglass} tone={counts.waiting ? 'warn' : 'neutral'} label="Waiting approval"
          value={counts.waiting != null ? fmt.num(counts.waiting) : '—'}
          sub={mayApprove ? (counts.approvals != null ? `${fmt.num(counts.approvals)} for you to approve` : '') : 'in this book'}
          onClick={() => showInDayBook({ status: 'submitted' })} />
        <KpiCard compact icon={CheckCircle2} tone={counts.today != null ? 'good' : 'neutral'} label="Posted today"
          value={counts.today != null ? fmt.num(counts.today) : '—'}
          sub="dated today" onClick={() => showInDayBook({ status: 'posted', from: dayOf(new Date()), to: dayOf(new Date()) })} />
        <KpiCard compact icon={CalendarDays} tone={counts.month != null ? 'info' : 'neutral'} label="Posted this month"
          value={counts.month != null ? fmt.num(counts.month) : '—'}
          sub={`dated in ${monthLabel}`}
          onClick={() => showInDayBook({ status: 'posted', ...finMonthOf(monthNow.from) })} />
      </KpiRow>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Tabs tabs={tabs} active={tab} onChange={key => change({ tab: key === 'daybook' ? null : key })} />
        {tab === 'daybook' && <ResetFilters filters={filters} />}
      </div>

      {trouble && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" />
          <span>Couldn't load the vouchers{known[tab] ? ' just now — showing the last ones loaded' : ''}.</span>
          <Button size="sm" variant="secondary" className="ml-auto" onClick={() => load()}>Retry</Button>
        </div>
      )}

      {tab === 'daybook' && (
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Field label="From" className="w-40"><Input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} /></Field>
          <Field label="To" className="w-40"><Input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} /></Field>
          <Field label="Type" className="w-40">
            <Select value={type} onChange={e => setType(e.target.value)} placeholder="All types">
              <option value="">All types</option>
              {Object.entries(FIN_TYPE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </Select>
          </Field>
          <Field label="Status" className="w-52">
            <Select value={status} onChange={e => setStatus(e.target.value)} placeholder="Any status">
              <option value="">Any status</option>
              {STATUS_CHOICES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </Select>
          </Field>
          <Field label="Made by" className="w-48">
            <Select value={person} onChange={e => setPerson(e.target.value)} placeholder="Anyone">
              <option value="">Anyone</option>
              {(person && !people.includes(person) ? [person, ...people] : people).map(name => <option key={name} value={name}>{name}</option>)}
            </Select>
          </Field>
        </div>
      )}
      {tab === 'daybook' && truncated && (
        <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">{FIN_TRUNCATED_NOTE}</p>
      )}

      <DataTable key={tab} rows={shown} columns={columns[tab]} getRowId={r => r.id} defaultSort={sorts[tab]} empty={empty}
        onRowClick={r => openVoucher(r.id)}
        {...(tab === 'daybook'
          ? { searchValue: search, onSearchChange: setSearch, searchPlaceholder: tier === 'phone' ? 'Search vouchers…' : 'Search number, narration, reference or maker…' }
          : { searchValue: listSearch, onSearchChange: setListSearch, searchPlaceholder: 'Search…' })} />

      {form && <VoucherForm book={formBook} type={form.type} voucher={form.voucher} onClose={closeForm} />}
      {voucherId != null && (
        <VoucherDetail id={voucherId} me={me} book={book} setBook={setBook} onClose={closeVoucher} onChanged={load}
          onOpen={openVoucher} onEdit={mayKey ? openEdit : undefined} />
      )}
      {rejecting && (
        <ReasonDialog title="Reject this entry" confirmLabel="Reject" label="Why is it being rejected?"
          intro={`It goes back to ${rejecting.created_by || 'its maker'} as a draft, with your reason.`}
          onSubmit={reject} onClose={() => setRejecting(null)} />
      )}
      <ConfirmDialog open={Boolean(discarding)} onClose={() => setDiscarding(null)} onConfirm={discard} danger
        title="Discard this draft?" confirmLabel="Discard"
        message={discarding ? `${finTypeLabel(discarding.voucher_type)} of ${finFormatINR(discarding.total_paise)}${discarding.narration ? ` (${discarding.narration})` : ''} is kept in the trail but never gets a number, and cannot be brought back.` : ''} />
    </div>
  );
}
