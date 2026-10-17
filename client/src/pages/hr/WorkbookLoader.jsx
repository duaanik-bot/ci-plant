// HR → Settings → Load from salary workbook (admin, spec §15): the one-time go-live tool.
//
//   upload the workbook  →  PREVIEW (nothing written)  →  skip any person  →  Apply
//
// The preview is what the server read from the file, shown whole before anything is stored:
// the people (new, changed or same against the register), their pay setups with the server's
// review notes in amber, the opening loans and the opening advances. A person can be skipped;
// a skip leaves out everything about them (person, pay setup, opening loan, opening advance),
// because that is all the server's `decisions.skip` can say — it is a list of codes.
//
// Apply sends the SAME file again with `decisions` ({ skip:[code], edits:{} }): the server
// parses the file afresh, so nothing the preview showed is trusted back from the browser. A
// workbook with any `error` issue cannot be applied, and the messages are listed here.
//
// The preview and its file are one thing. The preview carries the very File object that produced
// it, and Apply sends THAT object (as the confirm dialog opened over it, which names it), so the
// counts and the clean status on screen are always about the file that gets loaded. A Preview
// answer or refusal that arrives after another file was chosen, or after a newer Preview was
// asked for, belongs to a selection that no longer exists and is dropped unread. The Choose
// button is also held while a Preview is in flight, so that case is not even offered.
//
// Money here is shown, never worked out: the figures arrive as exact 2-dp strings and are only
// formatted. No totals are added up in the browser. Bank numbers appear as their last four
// digits only, and nothing is logged.
//
// A server refusal reaches the central error toast and is ALSO said inline — in the Apply
// dialog, or under the file picker for a refused preview — in the server's own words
// (refusalText), because the toast is brief and a dialog can stand over it. Either way the
// file, the preview and every skip stay exactly as they were, and the dialog stays open, so the
// admin can fix the workbook or the choices and try again.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload } from 'lucide-react';
import { Button, ConfirmDialog, DataTable, useToast } from '../../components/ui.jsx';
import { FilterChip, FilterGroup, FilterRail } from '../../components/FilterChip.jsx';
import { hrApi, inr2, monthLabel } from '../../lib/hr.js';
import { InlineError, WORKER_TYPE, baseText, holidayText, numText, refusalText } from './PersonDrawer.jsx';

const MAX_BYTES = 4 * 1024 * 1024; // the server's upload cap
const mb = b => (b / 1024 / 1024).toFixed(1);
const sizeText = b => (b < 100 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${mb(b)} MB`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ── Reading the preview ─────────────────────────────────────────────────────
// POST /hr/loader/preview answers what parseSalaryWorkbook (server/src/hr/workbook-loader.js)
// returns, plus a `diff` of its people against the register. EXACTLY these fields are read;
// everything else in the answer (the month's inputs, the workbook's own results) is ignored:
//
//   month               'YYYY-MM', the workbook's month (any other value is not shown)
//   daysInMonth         number (also read as days_in_month)
//   people[]            code · name (else display_name) · firm · department · worker_type ·
//                       pay_channel_label (else pay_channel) · bank.account OR bank_last4
//                       (only the last four characters are ever kept or shown, so the route may
//                       send bank_last4 instead of the full account)
//   setups[]            code · pay_basis · base · ot_hours_per_day · holiday_mode ·
//                       holiday_divisor · holiday_multiplier · holiday_fixed · review[]
//   openingLoans[]      code · outstanding · instalment · review[]      (also opening_loans)
//   openingAdvances[]   code · amount                                   (also opening_advances)
//   issues[]            { level, message } — level 'error' stops Apply; any other level, or a
//                       bare string, is a warning
//   diff                { new, changed, same } — each a list of person codes, or of
//                       { code, fields } where `fields` names (never values) what changed
//
// Rows are joined to their person by `code`. Amounts are exact decimal strings (or numbers) and
// are only formatted. With no `diff` every row still shows, just without New / Changed / Same.
const list = v => (Array.isArray(v) ? v : []);
const text = v => (v == null ? '' : String(v).trim());
const first = (obj, ...keys) => {
  for (const k of keys) if (obj && obj[k] != null) return obj[k];
  return undefined;
};
const STATES = ['new', 'changed', 'same'];

// The field NAMES that changed, as words.
const fieldNames = e => (e && typeof e === 'object'
  ? list(e.fields).filter(f => typeof f === 'string' && f).map(f => f.replace(/_/g, ' '))
  : []);

function diffStates(raw) {
  const out = new Map();
  const d = raw?.diff && typeof raw.diff === 'object' ? raw.diff : {};
  for (const state of STATES) {
    for (const e of list(d[state])) {
      const code = typeof e === 'string' ? e : e?.code;
      if (code != null) out.set(String(code), { state, fields: fieldNames(e) });
    }
  }
  return out;
}

const last4 = v => String(v ?? '').replace(/\s+/g, '').slice(-4);

export function normalisePreview(raw) {
  const states = diffStates(raw);
  const people = list(raw?.people).map((p, i) => {
    const code = text(p?.code);
    const d = states.get(code);
    return {
      rowId: `${code}:${i}`,
      code,
      name: text(p?.name) || text(p?.display_name),
      firm: text(p?.firm),
      department: text(p?.department),
      worker_type: p?.worker_type,
      channel: text(first(p, 'pay_channel_label', 'pay_channel')),
      // The workbook's own account number never leaves this function: only its last four do.
      bank_last4: last4(p?.bank && typeof p.bank === 'object' ? p.bank.account : p?.bank_last4),
      state: d?.state || null,
      fields: d?.fields || [],
    };
  });
  const nameOf = new Map(people.map(p => [p.code, p.name]));
  const keyed = (row, i, extra) => {
    const code = text(row?.code);
    return { ...extra, rowId: `${code}:${i}`, code, name: nameOf.get(code) || '' };
  };
  const reviewOf = row => list(row?.review).map(String).filter(Boolean);
  const issues = list(raw?.issues)
    .map(i => (typeof i === 'string'
      ? { level: 'warn', message: i }
      : { level: i?.level === 'error' ? 'error' : 'warn', message: text(i?.message) }))
    .filter(i => i.message);
  const days = Number(first(raw, 'daysInMonth', 'days_in_month'));
  return {
    month: /^\d{4}-(0[1-9]|1[0-2])$/.test(text(raw?.month)) ? text(raw.month) : '',
    days: Number.isFinite(days) && days > 0 ? days : null,
    people,
    setups: list(raw?.setups).map((s, i) => keyed(s, i, { ...s, review: reviewOf(s) })),
    loans: list(first(raw, 'openingLoans', 'opening_loans')).map((l, i) => keyed(l, i, { ...l, review: reviewOf(l) })),
    advances: list(first(raw, 'openingAdvances', 'opening_advances')).map((a, i) => keyed(a, i, { ...a })),
    errors: issues.filter(i => i.level === 'error').map(i => i.message),
    warnings: issues.filter(i => i.level !== 'error').map(i => i.message),
  };
}

// The apply answer's counts, whether the server sends numbers or the lists they count.
const countOf = v => (Array.isArray(v) ? v.length : Number(v) || 0);

function nextMonthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return monthLabel(m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`);
}

// ── Pieces ──────────────────────────────────────────────────────────────────

const STATE_PILL = {
  new: { label: 'New', cls: 'bg-emerald-50 text-emerald-700' },
  changed: { label: 'Changed', cls: 'bg-amber-50 text-amber-700' },
  same: { label: 'Same', cls: 'bg-[#1D1D1F]/[0.07] text-[#6E6E73]' },
};

const Dash = () => <span className="text-[#C7C7CC]">—</span>;

// Whose row this is — the first two columns of every table below.
const WHO = [
  { key: 'code', label: 'Code', render: r => <span className="font-mono text-xs font-semibold text-[#515154]">{r.code}</span> },
  { key: 'name', label: 'Name', card: 'title', render: r => <span className="font-semibold text-[#1D1D1F]">{r.name || '—'}</span> },
];

// The server's review notes, as amber lines.
const reviewCell = r => (r.review.length ? (
  <ul className="space-y-1">
    {r.review.map(m => <li key={m} className="rounded-lg bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-800">{m}</li>)}
  </ul>
) : <Dash />);

function Block({ title, count, note, children }) {
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-bold tracking-[-0.01em] text-[#1D1D1F]">{title}</h3>
        <span className="rounded-full bg-[#1D1D1F]/[0.07] px-2 py-0.5 text-xs font-semibold tabular-nums text-[#6E6E73]">{count}</span>
        {note}
      </div>
      {children}
    </section>
  );
}

function Notice({ tone, title, items }) {
  const cls = tone === 'error'
    ? { box: 'border-red-200 bg-red-50', ink: 'text-red-700' }
    : { box: 'border-amber-200 bg-amber-50', ink: 'text-amber-800' };
  return (
    <div role={tone === 'error' ? 'alert' : undefined} className={`rounded-2xl border px-4 py-3 ${cls.box}`}>
      <p className={`flex items-center gap-2 text-sm font-bold ${cls.ink}`}><AlertTriangle size={15} className="shrink-0" /> {title}</p>
      <ul className={`mt-1.5 max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs font-medium ${cls.ink}`}>
        {items.map((m, i) => <li key={i}>{m}</li>)}
      </ul>
    </div>
  );
}

function Count({ label, value, sub }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-[#86868B]">{label}</div>
      <div className="text-2xl font-extrabold tracking-[-0.03em] tabular-nums text-[#1D1D1F]">{value}</div>
      {sub && <div className="text-[11px] text-[#6E6E73]">{sub}</div>}
    </div>
  );
}

export default function WorkbookLoader() {
  const toast = useToast();
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState('');
  const [preview, setPreview] = useState(null); // normalisePreview(answer) plus `file`: the File that produced it
  const [previewing, setPreviewing] = useState(false); // a Preview request is in flight
  const [skip, setSkip] = useState(() => new Set());
  const [state, setState] = useState(''); // the People table's New / Changed / Same chip
  // What the Apply dialog is about, fixed when it opened and sent as it stood:
  // { file, month, skip: [code], willLoad, skipped }. Null while the dialog is closed.
  const [confirm, setConfirm] = useState(null);
  // The server's own words when it refuses: for Apply, said inside the confirm dialog; for a
  // preview, under the file picker. Each is cleared the next time the same thing is tried.
  const [applyError, setApplyError] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [done, setDone] = useState(null);

  const toggle = code => setSkip(cur => {
    const next = new Set(cur);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });
  const clearPreview = () => { setPreview(null); setSkip(new Set()); setState(''); };

  // Which Preview request is the live one. Each press takes the next number; choosing a file takes
  // one too, and so does leaving the screen. An answer is acted on only if its number is still the
  // current one — anything else was asked for a selection that has since gone.
  const previewSeq = useRef(0);
  useEffect(() => () => { previewSeq.current += 1; }, []);

  const choose = e => {
    const f = e.target.files?.[0] || null;
    e.target.value = ''; // so the same file can be chosen again once it has been fixed
    previewSeq.current += 1; // whatever Preview is still in flight was for the previous choice
    setPreviewing(false);
    clearPreview();
    setPreviewError(null);
    setDone(null);
    if (!f) { setFile(null); setFileError(''); return; }
    if (!/\.xlsx$/i.test(f.name)) { setFile(null); setFileError('Choose an Excel workbook (.xlsx).'); return; }
    if (f.size > MAX_BYTES) { setFile(null); setFileError(`That file is ${mb(f.size)} MB; the limit is ${mb(MAX_BYTES)} MB.`); return; }
    setFileError('');
    setFile(f);
  };

  const runPreview = async () => {
    if (!file) return;
    const mine = ++previewSeq.current;
    const forFile = file; // the very object sent now, and the one the preview will carry
    clearPreview(); // what is on screen is not the answer to THIS press
    setPreviewError(null);
    setPreviewing(true);
    let raw;
    try {
      raw = await hrApi.loaderPreview(forFile);
    } catch (e) {
      // Refused — said under the picker, and the file stays chosen. Unless another file has been
      // chosen meanwhile: then this refusal is about a file that is no longer selected.
      if (previewSeq.current === mine) setPreviewError(refusalText(e));
      return;
    } finally {
      if (previewSeq.current === mine) setPreviewing(false);
    }
    if (previewSeq.current !== mine) return; // a late answer for a file that is no longer the selected one
    setPreview({ ...normalisePreview(raw), file: forFile });
  };

  const counts = useMemo(() => {
    const c = { new: 0, changed: 0, same: 0 };
    for (const p of preview?.people || []) if (p.state) c[p.state] += 1;
    return c;
  }, [preview]);
  const hasStates = counts.new + counts.changed + counts.same > 0;
  const shownPeople = useMemo(() => (preview?.people || []).filter(p => !state || p.state === state), [preview, state]);
  const toReview = useMemo(() => (preview?.setups || []).filter(s => s.review.length).length, [preview]);

  // How many of the workbook's people will actually be loaded.
  const skippedPeople = (preview?.people || []).filter(p => skip.has(p.code)).length;
  const willLoad = (preview?.people.length || 0) - skippedPeople;
  const blocked = Boolean(preview && preview.errors.length);
  const loadWords = `${willLoad} ${willLoad === 1 ? 'person' : 'people'} will be loaded${skippedPeople > 0 ? ` · ${skippedPeople} skipped` : ''}`;

  // The dialog is about THIS preview: its file, its month, the skips as they stand. All of it is
  // fixed here, and `apply` sends exactly what the dialog describes.
  const openConfirm = () => {
    setApplyError(null);
    setConfirm({ file: preview.file, month: preview.month, skip: [...skip].sort(), willLoad, skipped: skippedPeople });
  };

  // Rejects when the server refuses, which keeps the confirm dialog open for a retry; the reason
  // is said inside the dialog.
  const apply = async () => {
    const { file: sent, skip: skipCodes } = confirm;
    setApplyError(null);
    let out;
    try {
      out = await hrApi.loaderApply(sent, { skip: skipCodes, edits: {} });
    } catch (e) {
      setApplyError(refusalText(e));
      throw e;
    }
    const result = {
      created: countOf(out?.created),
      updated: countOf(out?.updated),
      loans: countOf(out?.opening_loans),
      advances: countOf(out?.opening_advances),
    };
    toast.success(`Loaded ${result.created} new and ${result.updated} updated ${result.created + result.updated === 1 ? 'person' : 'people'}, ${plural(result.loans, 'opening loan', 'opening loans')}, ${plural(result.advances, 'opening advance', 'opening advances')}`);
    setFile(null);
    clearPreview();
    setDone(result);
  };

  const skipCol = useMemo(() => ({
    key: 'skip', label: 'Skip', sortable: false, card: 'actions',
    render: r => (
      <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-[#515154]"
        title="Leave this person out: their record, pay setup, opening loan and opening advance">
        <input type="checkbox" className="h-4 w-4 rounded border-[#1D1D1F]/20 accent-[#007AFF]"
          checked={skip.has(r.code)} onChange={() => toggle(r.code)} aria-label={`Skip ${r.name || r.code}`} />
        <span className="hidden ph:inline tp:inline">Skip</span>
      </label>
    ),
  }), [skip]);

  const peopleCols = useMemo(() => [
    skipCol,
    ...WHO,
    { key: 'department', label: 'Department', render: r => r.department || <Dash /> },
    { key: 'firm', label: 'Firm', render: r => r.firm || <Dash /> },
    { key: 'channel', label: 'Channel', render: r => r.channel || <Dash /> },
    { key: 'worker_type', label: 'Type', render: r => WORKER_TYPE[r.worker_type] || r.worker_type || <Dash /> },
    { key: 'bank_last4', label: 'Bank', render: r => (r.bank_last4 ? <span className="whitespace-nowrap font-mono text-xs">•••• {r.bank_last4}</span> : <Dash />) },
    ...(hasStates ? [{
      key: 'state', label: 'Against register', card: 'status', sortValue: r => r.state || '',
      render: r => (r.state ? (
        <div>
          <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATE_PILL[r.state].cls}`}>{STATE_PILL[r.state].label}</span>
          {r.fields.length > 0 && <span className="mt-0.5 block text-[11px] text-[#86868B]">{r.fields.join(', ')}</span>}
        </div>
      ) : <Dash />),
    }] : []),
  ], [skipCol, hasStates]);

  const setupCols = useMemo(() => [
    skipCol,
    ...WHO,
    { key: 'pay_basis', label: 'Basis', render: r => ({ contract: 'Contract', daily: 'Daily', hourly: 'Hourly' }[r.pay_basis] || 'Monthly') },
    { key: 'base', label: 'Base', align: 'right', card: 'metric',
      sortValue: r => (r.pay_basis === 'contract' ? null : Number(r.base)), render: r => baseText(r) },
    { key: 'ot_hours_per_day', label: 'OT h/day', align: 'right', card: 'metric',
      sortValue: r => Number(r.ot_hours_per_day), render: r => numText(r.ot_hours_per_day) },
    { key: 'holiday', label: 'Holiday', sortValue: r => holidayText(r), render: r => holidayText(r) },
    { key: 'review', label: 'Review', card: 'detail', sortValue: r => r.review.length, render: reviewCell },
  ], [skipCol]);

  const loanCols = useMemo(() => [
    skipCol,
    ...WHO,
    { key: 'outstanding', label: 'Outstanding', align: 'right', card: 'metric',
      sortValue: r => Number(r.outstanding), render: r => inr2(r.outstanding) },
    { key: 'instalment', label: 'Instalment', align: 'right', card: 'metric',
      sortValue: r => (r.instalment == null ? null : Number(r.instalment)), render: r => inr2(r.instalment) },
    { key: 'review', label: 'Review', card: 'detail', sortValue: r => r.review.length, render: reviewCell },
  ], [skipCol]);

  const advanceCols = useMemo(() => [
    skipCol,
    ...WHO,
    { key: 'amount', label: 'Opening advance', align: 'right', card: 'metric',
      sortValue: r => Number(r.amount), render: r => inr2(r.amount) },
  ], [skipCol]);

  // A skipped person's rows fade in every table; a row the server wants looked at turns amber.
  const rowClass = r => (skip.has(r.code) ? 'opacity-45' : r.review?.length ? '!bg-amber-50/80' : '');

  const picker = (
    <div className="ci-form-panel">
      <div className="ci-form-panel-title"><span className="flex items-center gap-1.5"><FileSpreadsheet size={13} /> Load from salary workbook</span></div>
      <p className="max-w-3xl text-sm text-[#515154]">
        Reads a monthly salary workbook in the July layout and loads the people, their pay setups and the opening
        balances — each loan outstanding becomes an opening loan, each negative final payment an opening advance.
        You see everything first; nothing is written until you press Apply.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input ref={inputRef} type="file" className="hidden" onChange={choose}
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
        <Button variant="secondary" onClick={() => inputRef.current?.click()} disabled={previewing}
          title={previewing ? 'Wait for the preview to finish' : undefined}>
          <Upload size={14} /> {file ? 'Choose another file' : 'Choose workbook'}
        </Button>
        {file && (
          <span className="min-w-0 truncate text-sm font-semibold text-[#1D1D1F]">
            {file.name} <span className="font-normal text-[#86868B]">· {sizeText(file.size)}</span>
          </span>
        )}
        <Button className="ml-auto" onClick={runPreview} disabled={!file}>Preview</Button>
      </div>
      {fileError && <p role="alert" className="mt-2 text-xs font-semibold text-red-600">{fileError}</p>}
      <InlineError message={previewError} className="mt-2" />
    </div>
  );

  const finished = done && (
    <div className="ci-form-panel">
      <div className="ci-form-panel-title"><span className="flex items-center gap-1.5 text-emerald-700"><CheckCircle2 size={13} /> Loaded</span></div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Count label="New people" value={done.created} />
        <Count label="Updated people" value={done.updated} />
        <Count label="Opening loans" value={done.loans} />
        <Count label="Opening advances" value={done.advances} />
      </div>
      <p className="mt-3 text-xs text-[#6E6E73]">Everyone is now in People; check each person&rsquo;s pay setup there.</p>
      <div className="mt-3"><Button variant="secondary" onClick={() => setDone(null)}>Load another workbook</Button></div>
    </div>
  );

  const applyBar = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-semibold text-[#1D1D1F]">{loadWords}</span>
      <Button className="ml-auto" onClick={openConfirm} disabled={blocked || willLoad === 0}>Apply</Button>
    </div>
  );

  return (
    <div className="space-y-4">
      {finished || picker}

      {!done && preview && (
        // data-ci-form: the skip ticks are choices worth keeping, so an idle auto-reload waits.
        <div data-ci-form className="space-y-4">
          <div className="ci-form-panel">
            <div className="ci-form-panel-title">
              <span className="min-w-0 break-words">
                Preview · <span className="normal-case tracking-normal text-[#515154]">{preview.file.name}</span>
                {preview.month ? ` · ${monthLabel(preview.month)}` : ''}{preview.days ? ` · ${preview.days} days` : ''}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Count label="People" value={preview.people.length}
                sub={hasStates ? `${counts.new} new · ${counts.changed} changed · ${counts.same} same` : null} />
              <Count label="Pay setups" value={preview.setups.length} sub={toReview ? `${toReview} to review` : null} />
              <Count label="Opening loans" value={preview.loans.length} />
              <Count label="Opening advances" value={preview.advances.length} />
            </div>
            {preview.month && (
              <p className="mt-3 text-xs text-[#6E6E73]">
                Pay setups take effect from {nextMonthLabel(preview.month)}, the month after the workbook&rsquo;s.
                Opening balances are as at the end of {monthLabel(preview.month)}.
              </p>
            )}
            {(preview.errors.length > 0 || preview.warnings.length > 0) && (
              <div className="mt-3 space-y-2">
                {preview.errors.length > 0 && (
                  <Notice tone="error" items={preview.errors}
                    title={`${preview.errors.length} ${preview.errors.length === 1 ? 'error' : 'errors'} — nothing can be loaded until the workbook is fixed`} />
                )}
                {preview.warnings.length > 0 && (
                  <Notice tone="warn" items={preview.warnings}
                    title={`${preview.warnings.length} ${preview.warnings.length === 1 ? 'warning' : 'warnings'} — worth a look; they do not stop the load`} />
                )}
              </div>
            )}
            <div className="mt-4 border-t border-[#1D1D1F]/[0.06] pt-3">{applyBar}</div>
          </div>

          <Block title="People" count={preview.people.length}
            note={hasStates && (
              <FilterRail className="ml-2">
                <FilterGroup divider={false} className="!shrink min-w-0">
                  <FilterChip label="All" count={preview.people.length} on={!state} onClick={() => setState('')} />
                  {STATES.map(k => (
                    <FilterChip key={k} label={STATE_PILL[k].label} count={counts[k]} on={state === k}
                      onClick={() => setState(cur => (cur === k ? '' : k))} />
                  ))}
                </FilterGroup>
              </FilterRail>
            )}>
            <DataTable columns={peopleCols} rows={shownPeople} getRowId={r => r.rowId} serialNumber={false} searchable
              searchPlaceholder="Search the workbook’s people…" rowClass={rowClass}
              defaultSort={{ key: 'name', dir: 'asc' }} empty="No people in this workbook." />
          </Block>

          <Block title="Pay setups" count={preview.setups.length}
            note={toReview > 0 && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">{toReview} to review</span>
            )}>
            <DataTable columns={setupCols} rows={preview.setups} getRowId={r => r.rowId} serialNumber={false} searchable
              searchPlaceholder="Search pay setups…" rowClass={rowClass} pinTop={r => r.review.length > 0}
              defaultSort={{ key: 'name', dir: 'asc' }} empty="No pay setups in this workbook." />
          </Block>

          <Block title="Opening loans" count={preview.loans.length}>
            <DataTable columns={loanCols} rows={preview.loans} getRowId={r => r.rowId} serialNumber={false}
              rowClass={rowClass} pinTop={r => r.review.length > 0}
              defaultSort={{ key: 'name', dir: 'asc' }} empty="No opening loans in this workbook." />
          </Block>

          <Block title="Opening advances" count={preview.advances.length}>
            <DataTable columns={advanceCols} rows={preview.advances} getRowId={r => r.rowId} serialNumber={false}
              rowClass={rowClass} defaultSort={{ key: 'name', dir: 'asc' }} empty="No opening advances in this workbook." />
          </Block>

          <div className="pb-2">{applyBar}</div>
        </div>
      )}

      <ConfirmDialog open={Boolean(confirm)} onClose={() => setConfirm(null)} onConfirm={apply}
        title="Load from the workbook?" confirmLabel="Apply"
        message={confirm && (
          <>
            <span className="block font-semibold text-[#1D1D1F]">
              {confirm.file.name} · {confirm.month ? `the ${monthLabel(confirm.month)} workbook` : 'the workbook does not say its month'}
            </span>
            <span className="mt-1.5 block">
              {`This creates or updates ${confirm.willLoad} ${confirm.willLoad === 1 ? 'person' : 'people'}${confirm.skipped > 0 ? ` (${confirm.skipped} skipped)` : ''}, their pay setups and the opening loans and advances shown. Nothing is paid or posted to a payroll run.`}
            </span>
            <InlineError message={applyError} />
          </>
        )} />
    </div>
  );
}
