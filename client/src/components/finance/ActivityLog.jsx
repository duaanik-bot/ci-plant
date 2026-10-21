// ActivityLog: Setup's last tab (spec §8.3, §10). Props: { book, from, to, onPeriod, user, entity, onFilters }.
//
// GET /finance/activity?book&from&to&user&entity: the book's audit log, newest first. Every Finance write appends one row in the same
// transaction as the write (who, when, what, and the record before and after), and the table is append-only, so this is the trail an
// auditor or the CA reads. It is open to anyone who can read the book (capability `view`, ruling R30). The list is summaries only
// (ruling R71): who, when, what, which (the server's `label`) and why. The record before and after is one row's, read when the row is
// opened (GET /finance/activity/:id): a voucher's record holds every line, and a list of them with a real Opening voucher ran to
// megabytes, past what the ERP's host sends in one answer.
//
// The period is the Reports page's: the page works it out with finReportRange, so the default is the same financial year to date (from the
// day the books begin in their first year, R58), and it lives in the URL (?from&to) with the two filters (?user, ?entity). The person is
// part of a name, typed, and asked for once typing stops. The server sends the newest 500 rows and does not say when it cut the rest, so
// a full answer is taken to have been cut and the screen says so (finActivityCut).
//
// The table is a time order and means nothing sorted, so no column sorts (finUnsorted). A row opens a modal with what was recorded
// before and after, as pretty-printed JSON side by side, asked for then. A log, or a row's record, that did not load is never drawn as
// an empty one (LoadNotice, with a Retry).
//
// The search is the screen's own (controlled, deferred), so a search that finds nothing says "No changes match this search." and never
// "No changes were recorded in this period.": on an audit trail, that would be false assurance (finSearchEmpty, as the Task 16 lists do).
// It reaches who, what was done, to which thing, and why, in the words on the screen; not the record before and after, which the list
// no longer carries (ruling R71), and the box says so.
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../../api.js';
import { Button, DataTable, Field, Input, Modal, rowMatches, Select } from '../ui.jsx';
import { LoadNotice, PeriodFields } from './ReportParts.jsx';
import { ReadOnlyFact } from './SetupParts.jsx';
import useReport from './useReport.js';
import { finSearchEmpty } from '../../lib/finance/page.js';
import { finPeriodText, finRangeProblem, finUnsorted } from '../../lib/finance/reports.js';
import {
  FIN_ACTIVITY_CUT_NOTE, FIN_ENTITY_CHOICES, finActionLabel, finActivityCut, finActivitySearchText, finActivityUrl, finEntityLabel, finJsonText,
  finSetupEmpty, finWhenText,
} from '../../lib/finance/setup.js';

function JsonPane({ label, value, none }) {
  const shown = finJsonText(value);
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-[#86868B]">{label}</div>
      {shown
        ? <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-[#1D1D1F]/[0.04] p-3 font-mono text-xs leading-relaxed text-[#1D1D1F]">{shown}</pre>
        : <p className="rounded-xl bg-[#1D1D1F]/[0.03] p-3 text-sm italic text-slate-400">{none}</p>}
    </div>
  );
}

// One row of the log, opened: who did what and when (the list's own summary, shown at once), and the record before and after, which the
// list does not carry. It is asked for once, when the row is opened: an audit row never changes, so no refresh asks again. A read that
// failed says so, with a Retry that stays busy until the new one settles, and is never drawn as "nothing was recorded".
function ActivityDetail({ row, onClose }) {
  const [detail, setDetail] = useState(null);
  const [failed, setFailed] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const load = useCallback(async () => {
    setFailed(false);
    try {
      const answer = await api.get(`/finance/activity/${row.id}`);
      if (live.current) setDetail(answer.row);
    } catch {
      if (live.current) setFailed(true);
    }
  }, [row.id]);
  useEffect(() => { load(); }, [load]);
  const nothing = detail != null && detail.before == null && detail.after == null;
  return (
    <Modal open wide onClose={onClose} title={`${finActionLabel(row.entity, row.action)} · ${finEntityLabel(row.entity)}`}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          <ReadOnlyFact label="When">{finWhenText(row.at)}</ReadOnlyFact>
          <ReadOnlyFact label="Who">{row.user_name}</ReadOnlyFact>
          <ReadOnlyFact label="About">{row.label}</ReadOnlyFact>
          <ReadOnlyFact label="Reason">{row.reason}</ReadOnlyFact>
        </div>
        <LoadNotice failed={failed} shown={false} what="what was recorded for this change" onRetry={load} />
        {detail == null ? (
          !failed && <p className="text-sm text-gray-400">Loading what was recorded…</p>
        ) : nothing ? (
          <p className="text-sm text-slate-500">Nothing more was recorded for this change.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <JsonPane label="Before" value={detail.before} none="Nothing before: this was new." />
            <JsonPane label="After" value={detail.after} none="Nothing after: this was removed." />
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function ActivityLog({ book, from, to, onPeriod, user, entity, onFilters }) {
  const problem = finRangeProblem(from, to);
  const url = problem ? null : finActivityUrl({ bookId: book.id, from, to, user, entity });
  const { data, failed, reload } = useReport(url);
  const [open, setOpen] = useState(null);
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search);

  // The person is typed: the box keeps what is being typed and the page hears it once typing stops (and when it changes elsewhere, as
  // Back does, the box follows). The page's callback is held in a ref, so a render never restarts the wait.
  const [userText, setUserText] = useState(user);
  const hear = useRef(onFilters);
  useEffect(() => { hear.current = onFilters; });
  useEffect(() => { setUserText(user); }, [user]);
  useEffect(() => {
    if (userText.trim() === user) return undefined;
    const timer = setTimeout(() => hear.current({ user: userText.trim() }), 350);
    return () => clearTimeout(timer);
  }, [userText, user]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  // The search is held here and not by the table, so the empty line below can tell a search that hid every row from a period with none.
  // The rows carry the server's keys; the words they are shown in are searched as well (finActivitySearchText).
  const shown = useMemo(() => (query.trim() ? rows.filter(r => rowMatches(r, query, finActivitySearchText(r))) : rows), [rows, query]);
  const filtered = user !== '' || entity !== '';

  const columns = finUnsorted([
    { key: 'at', label: 'When', card: 'metric', render: r => <span className="whitespace-nowrap">{finWhenText(r.at)}</span> },
    { key: 'user_name', label: 'Who', card: 'metric', render: r => r.user_name },
    { key: 'action', label: 'Action', card: 'title', render: r => <span className="font-semibold">{finActionLabel(r.entity, r.action)}</span> },
    { key: 'entity', label: 'Entity', card: 'subtitle', render: r => (
      <div className="min-w-0">
        <div>{finEntityLabel(r.entity)}</div>
        <div className="max-w-[16rem] truncate text-xs text-slate-500" title={r.label || ''}>{r.label}</div>
      </div>) },
    { key: 'reason', label: 'Reason', card: 'detail', render: r => (
      <span className="block max-w-[22rem] truncate" title={r.reason || ''}>{r.reason || <span className="text-gray-300">—</span>}</span>) },
  ]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <PeriodFields from={from} to={to} onChange={onPeriod} />
        <Field label="Person" className="w-52">
          <Input value={userText} maxLength={100} placeholder="Any person" onChange={e => setUserText(e.target.value)} />
        </Field>
        <Field label="Kind of change" className="w-48">
          <Select value={entity} placeholder="Anything" onChange={e => onFilters({ entity: e.target.value })}>
            <option value="">Anything</option>
            {FIN_ENTITY_CHOICES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
          </Select>
        </Field>
      </div>
      {!problem && <p className="mb-3 text-xs text-slate-500">Every change made in {book.name}, {finPeriodText(from, to)}, newest first. Open a row to see the record before and after.</p>}

      <LoadNotice failed={failed} shown={Boolean(data)} what="the activity log" onRetry={reload} />
      {finActivityCut(data?.rows) && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-800">
          <AlertTriangle size={16} className="shrink-0" />
          <span>{FIN_ACTIVITY_CUT_NOTE}</span>
        </div>
      )}

      <DataTable rows={shown} columns={columns} getRowId={r => r.id} serialNumber={false} onRowClick={setOpen}
        searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search by person, change, entity or reason…"
        empty={finSetupEmpty({
          known: Boolean(data), failed,
          none: finSearchEmpty({
            searching: query.trim() !== '', total: rows.length,
            none: filtered ? 'No changes match these filters.' : 'No changes were recorded in this period.', noun: 'changes',
          }),
          blocked: problem && 'Choose a period that ends after it starts.',
        })} />

      {open && <ActivityDetail key={open.id} row={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
