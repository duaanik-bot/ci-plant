// CashBank: the Cash & Bank page, /finance/cash (Cash & Bank spec §5). Props: { me, book, can, setBook }.
//
//   /finance/cash                              the tiles, the actions, the header counts, and the book of the account on show
//   ...?account=<ledger id>                    the account whose book is on show (the first tile, office cash, when none is named)
//   ...?from=YYYY-MM-DD&to=YYYY-MM-DD          the book's window: the current month, or the month the books begin in until they do
//   ...?tab=unadjusted                         the party money still on account, each item with Adjust
//   ...?tab=hr                                 HR's staff money: what waits, the exceptions, the control check
//   ...&voucher=<id>                           that voucher, open over the page (Approve, Reverse and the rest are its own)
//   ...?receive_customer=<ERP customer id>     a link in (spec §11 item 4): Receive, from that customer's ledger
//   ...?pay_vendor=<ERP vendor id>             a link in (spec §11 item 6): Pay, to that vendor's ledger
//
// The page is the shell: the tiles (CashTiles), the actions with their keys, the header counts, the tabs, and the book
// (CashBookTable); the forms and dialogs are components of their own (CashEntryForm, AdjustPanel's AdjustDialog, CashCountDialog,
// HrInbox, VoucherDetail). It follows every Finance page: the book switch is the shell's, PageHeader → KpiRow → Tabs → DataTable, a
// realtime refresh on the Finance tables, and what a login cannot do is hidden (the server refuses it regardless).
//
// What it asks the server (ruling R72: as little as it can, every list windowed, every figure counted in SQL):
//   the tiles          GET /finance/cash/accounts?book=   every bank and cash account with its balance as at today, and the party
//                                                         money on account, { count, amount_paise }: the first header count
//   the book           GET /finance/cash/book?ledger=&from=&to=&rows=lean   the account on show, in its window; its lines as their
//                                                         column names once and one array per line (ruling R65), put back as the
//                                                         objects once per response, before the page keeps the answer
//   HR's header line   GET /finance/hr/status?book=       { waiting, exceptions, control }, count-only and never kept by the browser,
//                                                         so it is read when the page opens, after anything this page does, and on a
//                                                         realtime tick at most once a minute (it reads HR's history): a tick inside
//                                                         the minute leaves one read for when the minute is up, so the header catches
//                                                         up with what it was told of (finding F3)
//   the money on account  GET /finance/cash/unadjusted?book=   only while its tab is open
//   for the forms      the book's ledgers (useBookLedgers), its ledger roles (GET /finance/hr-setup: the staff ledgers and Cash
//                      Short & Excess are not offered, and TDS needs its ledger), and whether this login holds an HR level (the HR
//                      nav's own probe, hrApi.me), for the links to HR
// A read that failed is never drawn as an empty one, and an answer for another account, window or book is never shown under this one.
//
// Keys (spec §5.7): r, p and t open Receive, Pay and Transfer while nothing that takes typing has focus (useEntryKeys); Clone opens the
// last entry again with the last date used. Entering is a computer's or a tablet's: a phone reads, as on the Vouchers page.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Calculator, Copy, HandCoins, Inbox, Scale } from 'lucide-react';
import { api, fmt } from '../../api.js';
import { Button, DataTable, KpiCard, KpiRow, PageHeader, Tabs, useToast } from '../../components/ui.jsx';
import CashTiles from '../../components/finance/CashTiles.jsx';
import CashBookTable from '../../components/finance/CashBookTable.jsx';
import CashEntryForm, { useEntryKeys } from '../../components/finance/CashEntryForm.jsx';
import { AdjustDialog } from '../../components/finance/AdjustPanel.jsx';
import CashCountDialog from '../../components/finance/CashCountDialog.jsx';
import HrInbox from '../../components/finance/HrInbox.jsx';
import VoucherDetail from '../../components/finance/VoucherDetail.jsx';
import { useBookLedgers } from '../../components/finance/LedgerPicker.jsx';
import { LoadNotice } from '../../components/finance/ReportParts.jsx';
import useNoAnswer from '../../components/finance/useNoAnswer.js';
import useRealtimeRefresh from '../../lib/useRealtimeRefresh.js';
import { newestAnswerGate } from '../../lib/newestAnswer.js';
import { useTier } from '../../lib/tier.js';
import { dayOf } from '../../lib/dayOf.js';
import { sessionStore } from '../../lib/safeStorage.js';
import { hrApi, levelAtLeast } from '../../lib/hr.js';
import { FINANCE_TABLES } from '../../lib/finance/tables.js';
import { finCan } from '../../lib/finance/caps.js';
import { finIsValidDate } from '../../lib/finance/fy.js';
import { finFormatINR } from '../../lib/finance/money.js';
import { finQueryWith } from '../../lib/finance/page.js';
import { finExportProps, finPeriodText } from '../../lib/finance/reports.js';
import { FIN_PHONE_ENTRY_NOTE, finDateText } from '../../lib/finance/voucher.js';
import {
  finCashLinkIn, finCashWindow, finControlText, finLedgerOfParty, finMonthWindow, finRehydrateBook, finThrottleWait, finUnofferedLedgerIds,
  finWithLeanRows,
} from '../../lib/finance/cash.js';

// HR's header line is read on a realtime tick at most this often (see the header).
const STATUS_EVERY_MS = 60_000;
// The last entry saved here, for Clone, kept for this browser tab and this book.
const lastKey = bookId => `fin_cash_last:${bookId}`;
function readLast(bookId) {
  try {
    const kept = JSON.parse(sessionStore.getItem(lastKey(bookId)) ?? 'null');
    if (!kept || typeof kept !== 'object' || !kept.entry || typeof kept.entry.entry_type !== 'string') return null;
    return { ...kept, warnings: Array.isArray(kept.warnings) ? kept.warnings : [] };
  } catch {
    return null;
  }
}

const ENTRY_WORD = { receive: 'Receipt', pay: 'Payment', transfer: 'Transfer' };
const Kbd = ({ children }) => (
  <kbd className="ml-0.5 rounded-md bg-white/25 px-1.5 py-px text-[10px] font-bold leading-4 ring-1 ring-white/40">{children}</kbd>
);
const dayOrNull = value => (finIsValidDate(value) ? value : null);

export default function CashBank({ me, book, can, setBook }) {
  const toast = useToast();
  const noAnswer = useNoAnswer();
  const tier = useTier();
  const [params, setParams] = useSearchParams();
  const change = useCallback(updates => setParams(previous => finQueryWith(previous, updates), { replace: true }), [setParams]);

  const mayEnter = can('enter');
  // Keying an entry in wants a computer or a tablet, as on the Vouchers page; a phone reads the page.
  const mayKey = tier !== 'phone';

  // ── The reads ────────────────────────────────────────────────────────────────────────────
  // Each read has its own gate, so an older answer never lands over a newer one, and a failure is not an answer: it never pushes a
  // good one aside. An answer is kept with the key it was asked for (the book, the account and window), and drawn only under it.
  const [reads, setReads] = useState({});
  const [failing, setFailing] = useState({});
  const gates = useRef({});
  const latest = useRef({});
  const askedKey = useRef({});
  const read = useCallback(async (name, key, ask) => {
    if (!gates.current[name]) gates.current[name] = newestAnswerGate();
    const gate = gates.current[name];
    const seq = gate.begin();
    latest.current[name] = seq;
    // A read of something else (another account or window) starts with no failure of its own to say.
    if (askedKey.current[name] !== key) {
      askedKey.current[name] = key;
      setFailing(f => (f[name] ? { ...f, [name]: false } : f));
    }
    let answer;
    try {
      answer = await ask();
    } catch {
      if (latest.current[name] === seq) setFailing(f => ({ ...f, [name]: true }));
      return;
    }
    if (!gate.accept(seq)) return;
    setReads(r => ({ ...r, [name]: { key, answer } }));
    setFailing(f => ({ ...f, [name]: false }));
  }, []);
  const answerOf = (name, key) => (key != null && reads[name]?.key === key ? reads[name].answer : null);

  const bookKey = String(book.id);
  const loadAccounts = useCallback(() => read('accounts', bookKey, () => api.get(`/finance/cash/accounts?book=${book.id}`)), [read, bookKey, book.id]);
  const statusAt = useRef(0);
  const statusTimer = useRef(null);   // the one catch-up read of HR's line a throttled tick left (finding F3)
  const loadStatus = useCallback(() => {
    clearTimeout(statusTimer.current);
    statusTimer.current = null;
    statusAt.current = Date.now();
    return read('status', bookKey, () => api.get(`/finance/hr/status?book=${book.id}`));
  }, [read, bookKey, book.id]);
  // A realtime tick reads HR's line now when the minute since the last read is up; inside it, it leaves one read for when it is, so a
  // change the tick told of reaches the header within the minute and never waits for the next tick. One such read waits at a time.
  const loadStatusSoon = useCallback(() => {
    const wait = finThrottleWait(Date.now(), statusAt.current, STATUS_EVERY_MS);
    if (wait === 0) return loadStatus();
    if (statusTimer.current == null) statusTimer.current = setTimeout(() => { statusTimer.current = null; loadStatus(); }, wait);
    return null;
  }, [loadStatus]);
  useEffect(() => () => clearTimeout(statusTimer.current), []);
  const loadUnadjusted = useCallback(() => read('unadjusted', bookKey, () => api.get(`/finance/cash/unadjusted?book=${book.id}`)), [read, bookKey, book.id]);

  const tiles = answerOf('accounts', bookKey);
  const accounts = useMemo(() => tiles?.accounts ?? [], [tiles]);
  const status = answerOf('status', bookKey);
  const unadjusted = answerOf('unadjusted', bookKey);

  // The account on show, and the book's window, from the address.
  const named = Number(params.get('account'));
  const accountId = accounts.some(a => a.ledger_id === named) ? named : accounts[0]?.ledger_id ?? null;
  const selected = accounts.find(a => a.ledger_id === accountId) ?? null;
  const [today] = useState(() => dayOf(new Date()));
  const opening = useMemo(() => finCashWindow(today, book.books_begin), [today, book.books_begin]);
  const askedFrom = dayOrNull(params.get('from'));
  const askedTo = dayOrNull(params.get('to'));
  const from = askedFrom ?? (askedTo ? finMonthWindow(askedTo).from : opening.from);
  const to = askedTo ?? (askedFrom ? finMonthWindow(askedFrom).to : opening.to);
  const windowKey = accountId == null ? null : `${accountId}|${from}|${to}`;
  // The book's lines come lean (ruling R65, lib/finance/cash.js) and go back to objects HERE, once per response, inside the book's own
  // read, so what the page keeps, draws, exports and prints is the book as it always was. api.get hands back the same object for the
  // same bytes, so the rehydrated book is kept per response: a fresh copy on every refresh would redraw the book for nothing.
  const hydratedBook = useRef({ res: null, data: null });
  const loadBook = useCallback(() => (accountId == null || from > to ? null
    : read('book', `${accountId}|${from}|${to}`,
      () => api.get(finWithLeanRows(`/finance/cash/book?${new URLSearchParams({ ledger: String(accountId), from, to })}`)).then(res => {
        if (hydratedBook.current.res !== res) hydratedBook.current = { res, data: finRehydrateBook(res) };
        return hydratedBook.current.data;
      }))), [read, accountId, from, to]);
  const cashBook = answerOf('book', windowKey);

  const tabs = [
    { key: 'book', label: 'Book' },
    { key: 'unadjusted', label: 'Unadjusted money', count: tiles?.unadjusted?.count ?? undefined },
    { key: 'hr', label: 'HR entries', count: status ? status.waiting + status.exceptions : undefined, tone: status?.exceptions ? 'danger' : undefined },
  ];
  const tab = tabs.some(t => t.key === params.get('tab')) ? params.get('tab') : 'book';

  useEffect(() => { loadAccounts(); loadStatus(); }, [loadAccounts, loadStatus]);
  useEffect(() => { loadBook(); }, [loadBook]);
  useEffect(() => { if (tab === 'unadjusted') loadUnadjusted(); }, [tab, loadUnadjusted]);
  // A realtime tick asks again for what is on show; HR's line at most once a minute (loadStatusSoon).
  const load = useCallback(() => Promise.all([
    loadAccounts(), loadBook(), tab === 'unadjusted' ? loadUnadjusted() : null, loadStatusSoon(),
  ]), [loadAccounts, loadBook, loadUnadjusted, loadStatusSoon, tab]);
  useRealtimeRefresh(load, FINANCE_TABLES);
  // After this page has done something: everything it shows, HR's line too.
  const reloadAll = useCallback(() => Promise.all([
    loadAccounts(), loadBook(), loadStatus(), tab === 'unadjusted' ? loadUnadjusted() : null,
  ]), [loadAccounts, loadBook, loadStatus, loadUnadjusted, tab]);

  // What the forms pick from: the ledgers, the roles that keep some of them off the pickers, and whether to link to HR.
  const { ledgers, failed: ledgersFailed, reload: reloadLedgers } = useBookLedgers(book.id);
  const ledgerById = useMemo(() => new Map((ledgers ?? []).map(l => [l.id, l])), [ledgers]);
  const [roles, setRoles] = useState(null);
  useEffect(() => {
    let live = true;
    api.get(`/finance/hr-setup?book=${book.id}`).then(answer => { if (live) setRoles(answer.roles ?? {}); }).catch(() => {});
    return () => { live = false; };
  }, [book.id]);
  const unoffered = useMemo(() => finUnofferedLedgerIds(roles), [roles]);
  const [hrAccess, setHrAccess] = useState(false);
  useEffect(() => {
    let live = true;
    // A login with no HR level is answered 403 here, which is the answer and not a fault (hr.js says no toast for it).
    hrApi.me().then(answer => { if (live) setHrAccess(levelAtLeast(answer?.level, 'viewer')); }).catch(() => {});
    return () => { live = false; };
  }, []);

  // ── What is open over the page ───────────────────────────────────────────────────────────
  const [form, setForm] = useState(null);             // { entryType, start }
  const [counting, setCounting] = useState(null);     // { ledgerId }
  const [adjusting, setAdjusting] = useState(null);   // AdjustDialog's target
  const [last, setLast] = useState(() => readLast(book.id));
  const voucherId = /^\d+$/.test(params.get('voucher') ?? '') ? Number(params.get('voucher')) : null;
  const ready = ledgers != null && tiles != null;

  // A form opens on the account on show unless it is handed another.
  const openEntry = useCallback((entryType, start = {}) => {
    if (!ready) { toast.info('One moment: the accounts are still loading.'); return; }
    setForm({ entryType, start: { account_ledger_id: accountId, ...start } });
  }, [ready, accountId, toast]);
  useEntryKeys(openEntry, mayEnter && mayKey && ready && !form && !counting && !adjusting && voucherId == null);

  // A holder's shortcuts (spec §5.3) are plain transfers, opened ready to save: from office cash to the holder, or back.
  const officeCash = accounts.find(a => a.account_kind === 'cash')?.ledger_id ?? null;
  const shortcut = (kind, holder) => {
    if (kind === 'return') {
      openEntry('transfer', {
        account_ledger_id: holder.ledger_id, other_ledger_id: officeCash, amount_paise: holder.balance_paise > 0 ? holder.balance_paise : null,
        narration: `Return from ${holder.holder_name}`,
      });
      return;
    }
    openEntry('transfer', {
      account_ledger_id: officeCash, other_ledger_id: holder.ledger_id, amount_paise: kind === 'top_up' ? holder.top_up_paise : null,
      narration: kind === 'top_up' ? `To ${holder.holder_name} · top up to the float` : `To ${holder.holder_name}`,
    });
  };
  const clone = () => { if (last) openEntry(last.entry.entry_type, last.entry); };

  const saved = (answer, entry) => {
    const next = {
      entry, voucher_id: answer.voucher?.id ?? null, number: answer.voucher?.number ?? null, status: answer.voucher?.status ?? null,
      warnings: Array.isArray(answer.warnings) ? answer.warnings : [],
    };
    setLast(next);
    sessionStore.setItem(lastKey(book.id), JSON.stringify(next));
    reloadAll();
  };

  // ── Links in (spec §11 items 4 and 6) ────────────────────────────────────────────────────
  // The link names the ERP's customer or vendor and no book: the party's ledger is looked for in this book, then in this login's other
  // books it may enter in, and the page moves to the book that has it (drawn afresh there, link and all). The link is used once.
  const link = finCashLinkIn(params);
  const linkKey = link ? `${link.entry_type}:${link.party_id}` : null;
  const linkSeen = useRef(null);
  useEffect(() => {
    if (!linkKey || !ready || linkSeen.current === linkKey) return undefined;
    linkSeen.current = linkKey;
    const used = () => change({ receive_customer: null, pay_vendor: null });
    const who = link.party_type;
    if (!mayEnter || !mayKey) {
      toast.info(mayEnter ? FIN_PHONE_ENTRY_NOTE : `You can read ${book.name}, but not enter in it.`);
      used();
      return undefined;
    }
    const here = finLedgerOfParty(ledgers, link);
    if (here || link.party_id == null) {
      if (!here) toast.info(`That link names no ${who}. Choose one in the form.`);
      openEntry(link.entry_type, here ? { other_ledger_id: here.id } : {});
      used();
      return undefined;
    }
    let live = true;
    (async () => {
      for (const other of (me?.books ?? []).filter(b => b.id !== book.id && finCan(b.roles, 'enter'))) {
        const answer = await api.get(`/finance/books/${other.id}/ledgers`).catch(() => null);
        if (!live) return;
        if (answer && finLedgerOfParty(answer.ledgers, link)) { setBook(other.id); return; }
      }
      if (!live) return;
      toast.info(`No ledger in ${book.name} is linked to that ${who}. Choose the ${who} in the form.`);
      openEntry(link.entry_type, {});
      used();
    })();
    return () => { live = false; };
  }, [linkKey, ready]); // the rest is read as it stands when the link is first seen

  // ── Redo from a book row, and Adjust on the money on account (spec §6.5) ────────────────
  const redo = async entry => {
    if (ledgers == null) { toast.info('One moment: the ledgers are still loading.'); return; }
    let view;
    try {
      view = await api.get(`/finance/vouchers/${entry.voucher_id}`);
    } catch (e) {
      noAnswer(e);
      return;
    }
    const lines = view.lines.filter(line => ledgerById.get(line.ledger_id)?.is_party);
    if (lines.length !== 1) { toast.info('This entry has no single party line to adjust.'); return; }
    const [line] = lines;
    // A Redo works the whole line again (ruling R71); Adjust, below, only its money on account.
    setAdjusting({
      scope: 'line', line_id: line.id, ledger_id: line.ledger_id, title: `Redo the adjustment · ${entry.number || 'entry'}`,
      sub: `${line.ledger_name} · ${finFormatINR(line.debit_paise + line.credit_paise)} · ${finDateText(entry.date)} · now: ${entry.adjustment}`,
    });
  };
  const adjust = item => setAdjusting({
    scope: 'open', line_id: item.line_id, ledger_id: item.ledger_id, title: `Adjust · ${item.party}`,
    sub: `${item.label} · ${finDateText(item.date)} · ${finFormatINR(item.open_paise)} on account, of ${finFormatINR(item.amount_paise)}`,
  });

  // ── What is drawn ────────────────────────────────────────────────────────────────────────
  const unadjustedRows = useMemo(() => (unadjusted?.items ?? []).map((item, _order) => ({ ...item, _order })), [unadjusted]);
  const unadjustedColumns = [
    { key: 'party', label: 'Party', card: 'title', render: r => <span className="font-semibold">{r.party}</span> },
    { key: 'label', label: 'Entry', card: 'subtitle',
      render: r => <span>{r.label}{r.number && r.number !== r.label ? <span className="text-[#86868B]"> · {r.number}</span> : null}</span> },
    { key: 'date', label: 'Date', card: 'metric', render: r => <span className="whitespace-nowrap">{finDateText(r.date)}</span> },
    { key: 'amount_paise', label: 'Amount', align: 'right', card: 'metric', render: r => finFormatINR(r.amount_paise) },
    { key: 'open_paise', label: 'On account', align: 'right', card: 'metric',
      render: r => <span className="font-semibold text-amber-700">{finFormatINR(r.open_paise)}</span> },
    { key: '_adjust', label: '', sortable: false, card: 'actions',
      render: r => (mayEnter && mayKey ? <Button size="sm" onClick={() => adjust(r)}>Adjust</Button> : null) },
  ];

  const onAccount = tiles?.unadjusted ?? null;
  const control = finControlText(status?.control ?? null);
  const exportProps = cashBook ? finExportProps(book, {
    name: `Cash book ${cashBook.ledger.name}`,
    subtitle: `${book.name} · ${finPeriodText(cashBook.from, cashBook.to)}`,
    meta: [`Group: ${cashBook.ledger.group_name}`,
      ...(cashBook.pending.length ? [`${cashBook.pending.length} waiting for approval, not in the balance`] : [])],
    summary: [
      { label: 'Opening', value: finFormatINR(cashBook.opening_paise) }, { label: 'In', value: finFormatINR(cashBook.total_in_paise) },
      { label: 'Out', value: finFormatINR(cashBook.total_out_paise) }, { label: 'Closing', value: finFormatINR(cashBook.closing_paise) },
    ],
  }) : {};
  const selectedIsCash = selected?.account_kind === 'cash' || selected?.account_kind === 'holder';

  return (
    <div>
      <PageHeader title="Cash & Bank" subtitle={`${book.name} · every rupee into and out of cash and bank`} />

      <LoadNotice failed={failing.accounts} shown={Boolean(tiles)} what="the accounts" onRetry={loadAccounts} />
      <LoadNotice failed={ledgersFailed} shown={false} what="the ledgers, so no entry can be made" onRetry={reloadLedgers} />
      {tiles && (
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#86868B]">Balances as at {finDateText(tiles.as_at)}</div>
      )}
      {tiles && accounts.length === 0 && (
        <p className="mb-3 rounded-xl bg-white/60 px-3 py-2 text-sm text-[#515154]">
          {book.name} has no bank or cash account yet. Add one in Finance Setup → Chart of Accounts, under Bank Accounts or Cash-in-Hand.
        </p>
      )}
      <CashTiles accounts={accounts} selectedId={accountId} onSelect={id => change({ account: id, tab: null })}
        mayEnter={mayEnter && mayKey} onShortcut={shortcut} onCount={a => setCounting({ ledgerId: a.ledger_id })} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {mayEnter && mayKey && (
          <>
            <Button onClick={() => openEntry('receive')} disabled={!ready} title="Receive (R)"><ArrowDownLeft size={15} /> Receive <Kbd>R</Kbd></Button>
            <Button onClick={() => openEntry('pay')} disabled={!ready} title="Pay (P)"><ArrowUpRight size={15} /> Pay <Kbd>P</Kbd></Button>
            <Button onClick={() => openEntry('transfer')} disabled={!ready} title="Transfer (T)"><ArrowLeftRight size={15} /> Transfer <Kbd>T</Kbd></Button>
            {last && <Button variant="secondary" onClick={clone} disabled={!ready} title="The last entry again, on the last date used"><Copy size={14} /> Clone</Button>}
            <Button variant="secondary" onClick={() => setCounting({ ledgerId: selectedIsCash ? accountId : null })} disabled={!tiles}>
              <Calculator size={14} /> Count cash
            </Button>
          </>
        )}
        {mayEnter && !mayKey && <p className="text-sm text-[#6E6E73]">{FIN_PHONE_ENTRY_NOTE}</p>}
      </div>

      <KpiRow cols={3}>
        <KpiCard compact icon={HandCoins} tone={onAccount?.count ? 'warn' : 'neutral'} label="Unadjusted money"
          value={onAccount ? finFormatINR(onAccount.amount_paise) : '—'}
          sub={onAccount ? `${fmt.num(onAccount.count)} on account, waiting for Adjust` : ''}
          title="Open the party money on account" onClick={() => change({ tab: 'unadjusted' })} />
        <KpiCard compact icon={Inbox} tone={status?.exceptions ? 'bad' : status?.waiting ? 'warn' : 'neutral'} label="HR entries waiting"
          value={status ? fmt.num(status.waiting) : '—'}
          sub={status ? `Exceptions: ${fmt.num(status.exceptions)}` : failing.status ? 'couldn’t load' : ''}
          title="Open HR's entries" onClick={() => change({ tab: 'hr' })} />
        <KpiCard compact icon={Scale} tone={control.tone} label="Staff advances vs HR"
          value={control.tone === 'good' ? 'Matches' : control.tone === 'warn' ? 'Differs' : '—'}
          sub={control.tone === 'warn' ? control.text : status ? `as at ${finDateText(status.control.as_at)}` : ''}
          title="Open the control check" onClick={() => change({ tab: 'hr' })} />
      </KpiRow>

      {last && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-white/60 px-3 py-2 text-sm">
          <span className="font-semibold text-[#515154]">Last saved:</span>
          <span className="font-semibold text-[#1D1D1F]">{ENTRY_WORD[last.entry.entry_type] ?? 'Entry'} {last.number ?? '(waiting for approval)'}</span>
          <span className="tabular-nums text-[#515154]">{finFormatINR(last.entry.amount_paise)}</span>
          {last.voucher_id != null && (
            <button type="button" className="text-xs font-semibold text-[#0064D2] hover:underline" onClick={() => change({ voucher: last.voucher_id })}>Open</button>
          )}
          {last.warnings.map(w => (
            <span key={w.code} className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800">{w.sentence}</span>
          ))}
        </div>
      )}

      <Tabs tabs={tabs} active={tab} onChange={key => change({ tab: key === 'book' ? null : key })} />

      {tab === 'book' && accountId != null && (
        <CashBookTable book={cashBook} failed={Boolean(failing.book)} onRetry={loadBook} from={from} to={to}
          onPeriod={period => change({ from: period.from, to: period.to })} mayEnter={mayEnter && mayKey} exportProps={exportProps}
          onOpen={id => change({ voucher: id })} onRedo={redo} />
      )}
      {tab === 'book' && accountId == null && !tiles && <p className="py-16 text-center text-sm text-gray-400">Loading…</p>}

      {tab === 'unadjusted' && (
        <div>
          <p className="mb-2 text-sm text-[#515154]">
            Party money still on account: a receipt with no bill left to settle, or one paid ahead. Each waits for its own Adjust, Auto or
            Pick; Auto on a new receipt spends only the new money.
          </p>
          <LoadNotice failed={failing.unadjusted} shown={Boolean(unadjusted)} what="the money on account" onRetry={loadUnadjusted} />
          {unadjusted?.truncated && (
            <p className="mb-2 rounded-xl bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">The list stops at 1,000 entries, oldest first.</p>
          )}
          <DataTable rows={unadjustedRows} columns={unadjustedColumns} getRowId={r => r.line_id} defaultSort={{ key: '_order', dir: 'asc' }}
            onRowClick={r => change({ voucher: r.voucher_id })}
            empty={unadjusted ? 'No party money is on account.' : failing.unadjusted ? 'The list couldn’t load.' : 'Loading…'} />
        </div>
      )}

      {tab === 'hr' && (
        <HrInbox book={book} mayEnter={mayEnter && mayKey} hrAccess={hrAccess} status={status} statusFailed={Boolean(failing.status)}
          onRetryStatus={loadStatus} onChanged={reloadAll} />
      )}

      {form && (
        <CashEntryForm book={book} entryType={form.entryType} start={form.start} ledgers={ledgers} accounts={accounts} unoffered={unoffered}
          roles={roles} hrAccess={hrAccess} onClose={() => setForm(null)} onSaved={saved} />
      )}
      {counting && (
        <CashCountDialog book={book} accounts={accounts} ledgerId={counting.ledgerId} mayEnter={mayEnter && mayKey}
          onClose={() => setCounting(null)} onChanged={reloadAll} />
      )}
      {adjusting && <AdjustDialog target={adjusting} onClose={() => setAdjusting(null)} onDone={reloadAll} />}
      {voucherId != null && (
        <VoucherDetail id={voucherId} me={me} book={book} setBook={setBook} onClose={() => change({ voucher: null })} onChanged={reloadAll}
          onOpen={id => change({ voucher: id })} />
      )}
    </div>
  );
}
