// HR → Payroll → Import the month's sheet (spec §9), in one dialog:
//
//   File → Columns → Rows → Missing people → Apply
//
// File      the .xlsx goes up (4 MB at most) and the server reads it — exceljs never runs in the browser.
//           The same file already uploaded for the month answers 409 DUPLICATE_FILE with its batch_id;
//           that is said here with the date, and "Open it" picks that upload up instead.
// Columns   every column of the header row: the field it feeds and, for a number field, whether a blank
//           cell counts as 0. A change goes to the server, which reads the rows again with it and keeps
//           the map for next month (by header signature).
// Rows      one card per sheet row, filtered by status. Nothing is assigned on a guess: a row whose code
//           and name disagree, or whose name fits several people or nobody, waits for "Pick person" (the
//           server's suggestions first, with an optional "remember this spelling") or Ignore. A row with
//           an error can only be ignored — or the sheet fixed and uploaded again. Two rows for one person
//           both wait until one of them is ignored. A row whose person was given advances in the app this
//           month shows both figures and the total / extra switch (§9 item 7).
// Missing   active people with a pay setup and no row each need Include (no OT, no absence) or Leave
//           out this month — never a silent zero.
// Apply     writes the month's inputs and recalculates the draft run. Inputs typed by hand since the last
//           import are kept unless ticked to be overwritten, and the answer's manual_edits_kept comes
//           back with the same tick.
//
// Discard    an upload that will not be used (the wrong file, a sheet started and abandoned) can be set
//           aside from any step while it is unapplied: POST /hr/imports/:id/discard. Nothing from it reaches
//           the payroll, Submit stops waiting for it, and the same file can be uploaded again later.
//
// A refusal is said inline in the step where it happened, in the server's own words (the central toast
// fires too, but sits behind this dialog), and nothing typed or decided is thrown away by it. Amounts
// are only formatted; the one figure worked out here — what the sheet's advance adds over the app's —
// is an exact paise subtraction (diffPaise). Nothing is logged.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, Ban, CheckCircle2, FileSpreadsheet, FileUp, Loader2, RotateCcw, Undo2,
  UserPlus, UserX,
} from 'lucide-react';
import { Button, Checkbox, ConfirmDialog, ExportMenu, Modal, SearchInput, Select, useToast } from '../../components/ui.jsx';
import { FilterChip, FilterGroup, FilterRail } from '../../components/FilterChip.jsx';
import { hrApi, inr2, monthLabel } from '../../lib/hr.js';
import { InlineError, StatusPill, refusalText } from './PersonDrawer.jsx';
import { diffPaise, list, paiseOf, plural, qtyText, whenText } from './RunLineDrawer.jsx';

const MAX_BYTES = 4 * 1024 * 1024; // the server's upload cap
const sizeText = b => (b < 100 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const text = v => (v == null ? '' : String(v).trim());
const norm = v => text(v).replace(/\s+/g, ' ').toUpperCase();
// People ids are integers; a numeric string goes back as the number it is.
const toId = id => (/^\d+$/.test(String(id)) ? Number(id) : id);

// ── What a sheet column can feed (server/src/hr/import-parse.js FIELDS) ─────
// `blankZero` is the default of the "blank counts as 0" tick when a column is newly given that field.
export const IMPORT_FIELDS = [
  { key: 'name', label: 'Name', kind: 'text' },
  { key: 'code', label: 'Payroll code', kind: 'text' },
  { key: 'ot_hours', label: 'OT hours', short: 'OT', kind: 'number', qty: true, blankZero: true },
  { key: 'absent_days', label: 'Absent days', short: 'Absent', kind: 'number', qty: true, blankZero: true },
  { key: 'paid_leave_days', label: 'Paid leave days', short: 'Paid leave', kind: 'number', qty: true },
  { key: 'hours_worked', label: 'Hours worked', short: 'Hours', kind: 'number', qty: true },
  { key: 'misc_earning', label: 'Misc (an earning)', short: 'Misc', kind: 'number', blankZero: true },
  { key: 'misc_deduction', label: 'Misc deduction', short: 'Misc ded.', kind: 'number' },
  { key: 'bonus', label: 'Bonus', short: 'Bonus', kind: 'number' },
  { key: 'advance_given', label: 'Advance given', short: 'Advance', kind: 'number', blankZero: true },
  { key: 'bill_amount', label: 'Bill amount', short: 'Bill', kind: 'number', blankZero: true },
  { key: 'holiday_override', label: 'Holiday pay (typed)', short: 'Holiday', kind: 'number' },
  { key: 'loan_recovery_override', label: 'Loan repayment (typed)', short: 'Loan', kind: 'number' },
  { key: 'advance_recovery_override', label: 'Advance recovery (typed)', short: 'Adv. recovery', kind: 'number' },
  { key: 'paid_separately', label: 'Paid separately', short: 'Paid sep.', kind: 'number' },
  { key: 'remarks', label: 'Remarks', kind: 'text' },
  { key: 'department', label: 'Department (cross-check only)', kind: 'text', info: true },
  { key: 'firm', label: 'Firm (cross-check only)', kind: 'text', info: true },
  { key: 'pay_channel', label: 'Pay channel (cross-check only)', kind: 'text', info: true },
];
const FIELD = Object.fromEntries(IMPORT_FIELDS.map(f => [f.key, f]));
const NUMBER_FIELDS = IMPORT_FIELDS.filter(f => f.kind === 'number');

// ── Match statuses and issue codes ──────────────────────────────────────────

const MATCHED = new Set(['code', 'exact_name', 'alias', 'manual']);
const UNRESOLVED = ['conflict', 'ambiguous', 'unmatched', 'unknown_code'];
const MATCH_META = {
  code: { label: 'Matched by code', tone: 'bg-emerald-50 text-emerald-700' },
  exact_name: { label: 'Matched by name', tone: 'bg-emerald-50 text-emerald-700' },
  alias: { label: 'Matched by a saved spelling', tone: 'bg-emerald-50 text-emerald-700' },
  manual: { label: 'Picked by hand', tone: 'bg-sky-50 text-sky-700' },
  conflict: { label: 'Code and name disagree', tone: 'bg-red-50 text-red-700' },
  ambiguous: { label: 'Fits more than one person', tone: 'bg-amber-50 text-amber-800' },
  unmatched: { label: 'No match', tone: 'bg-amber-50 text-amber-800' },
  unknown_code: { label: 'Unknown code', tone: 'bg-red-50 text-red-700' },
};
const matchMeta = m => MATCH_META[m] || { label: m ? String(m).replace(/_/g, ' ') : 'Not matched', tone: 'bg-gray-100 text-gray-600' };

const ISSUE_LABEL = {
  NOT_A_NUMBER: 'Not a number',
  NEGATIVE: 'Below zero',
  ABSENT_EXCEEDS_DAYS: 'Absent days above the month',
  ABSENT_NOT_HALF: 'Not a whole or half day',
  NO_NAME_OR_CODE: 'No name or code',
  TOO_LARGE: 'Too large',
  MORE_DECIMALS_THAN_STORED: 'More decimals than stored',
  PERSON_EXITED: 'Marked as left',
};

// ── Reading a batch ─────────────────────────────────────────────────────────
// { batch, rows, missing } — a re-read (PUT …/map) may leave `missing` out; the last one is kept.

function normalise(d, prev) {
  return {
    batch: d?.batch && typeof d.batch === 'object' ? d.batch : (prev?.batch ?? {}),
    rows: Array.isArray(d?.rows) ? d.rows : (prev?.rows ?? []),
    missing: Array.isArray(d?.missing) ? d.missing : (prev?.missing ?? []),
  };
}

const rowKey = r => String(r?.id ?? `row-${r?.row_no}`);
const issuesOf = r => list(r?.issues).filter(i => i && typeof i === 'object');
const isIgnored = r => r?.decision === 'ignore';
const isMatched = r => MATCHED.has(r?.match) && r?.person_id != null;

// Rows (not ignored) that resolve to the same person: row key → the other rows' numbers.
function duplicateIds(rows) {
  const by = new Map();
  for (const r of rows) {
    if (isIgnored(r) || !isMatched(r)) continue;
    const k = String(r.person_id);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const out = new Map();
  for (const group of by.values()) {
    if (group.length < 2) continue;
    for (const r of group) out.set(rowKey(r), group.filter(x => x !== r).map(x => x.row_no));
  }
  return out;
}

// What a row still needs. A row is settled when it is ignored, or matched with no error and no twin.
function stateOf(r, dups) {
  const issues = issuesOf(r);
  const errors = issues.filter(i => i.level === 'error');
  const ignored = isIgnored(r);
  const matched = isMatched(r);
  const dupWith = ignored ? null : dups.get(rowKey(r)) || null;
  return {
    issues, errors, warns: issues.filter(i => i.level !== 'error'),
    ignored, matched, dupWith,
    todo: !ignored && (!matched || errors.length > 0 || Boolean(dupWith)),
  };
}

function summarise(rows, states) {
  const c = { all: rows.length, todo: 0, matched: 0, conflict: 0, ambiguous: 0, unmatched: 0, unknown_code: 0, errors: 0, dups: 0, ignored: 0 };
  for (const r of rows) {
    const s = states.get(rowKey(r));
    if (s.todo) c.todo += 1;
    if (s.ignored) { c.ignored += 1; continue; }
    if (s.matched) c.matched += 1;
    else if (UNRESOLVED.includes(r.match)) c[r.match] += 1;
    if (s.errors.length) c.errors += 1;
    if (s.dupWith) c.dups += 1;
  }
  return c;
}

// The counts Payroll.jsx shows for an upload that is not applied yet.
export function batchSummary(data) {
  const rows = list(data?.rows);
  const dups = duplicateIds(rows);
  return summarise(rows, new Map(rows.map(r => [rowKey(r), stateOf(r, dups)])));
}

// People who need an explicit include / leave-out: the server's `missing` (less anyone a row now names),
// plus anyone active whose every row is ignored — without a choice they would end up with no input row
// at all, and Submit would refuse.
function missingView(data, peopleById) {
  const rows = list(data?.rows);
  const live = new Set(rows.filter(r => !isIgnored(r) && isMatched(r)).map(r => String(r.person_id)));
  const out = [];
  const seen = new Set();
  for (const m of list(data?.missing)) {
    const id = text(m?.person_id ?? m?.id);
    if (!id || seen.has(id) || live.has(id)) continue;
    seen.add(id);
    const p = peopleById.get(id);
    out.push({
      id, name: text(m.name) || text(m.display_name) || p?.name || `Person #${id}`,
      code: text(m.code) || p?.code || '', department: text(m.department) || p?.department || '', why: 'Not in the sheet',
    });
  }
  for (const r of rows) {
    if (!isIgnored(r) || r.person_id == null) continue;
    const id = String(r.person_id);
    const p = peopleById.get(id);
    if (seen.has(id) || live.has(id) || (p && p.status !== 'active')) continue;
    seen.add(id);
    out.push({ id, name: p?.name || `Person #${id}`, code: p?.code || '', department: p?.department || '', why: `Their row (${r.row_no}) is ignored` });
  }
  return out;
}

// ── Columns ─────────────────────────────────────────────────────────────────

const colLetter = i => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const objectOr = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const mapOf = batch => objectOr(batch?.column_map ?? batch?.field_map ?? batch?.map);
const blankOf = batch => objectOr(batch?.blank_zero ?? batch?.blank_as_zero);
const headersOf = batch => list(batch?.headers).map(h => (h == null ? '' : String(h)));
const isCol = c => Number.isInteger(c) && c >= 0;

function draftOf(batch) {
  const cols = headersOf(batch).map(() => '');
  for (const [field, col] of Object.entries(mapOf(batch))) {
    if (FIELD[field] && isCol(col) && col < cols.length && !cols[col]) cols[col] = field;
  }
  const blank = {};
  for (const [k, v] of Object.entries(blankOf(batch))) if (FIELD[k]) blank[k] = v === true;
  return { cols, blank, note: '' };
}

function sameDraft(a, b) {
  if (a.cols.length !== b.cols.length || a.cols.some((c, i) => c !== b.cols[i])) return false;
  return a.cols.filter(f => FIELD[f]?.kind === 'number').every(f => Boolean(a.blank[f]) === Boolean(b.blank[f]));
}

// The sheet lands on Columns only when no column names a person (neither Name nor Code mapped); a
// sheet whose map was saved last month goes straight to its rows.
function firstStep(n) {
  const m = mapOf(n.batch);
  return headersOf(n.batch).length && !isCol(m.name) && !isCol(m.code) ? 'columns' : 'rows';
}

// ── Pieces ──────────────────────────────────────────────────────────────────

const STEPS = [
  { key: 'file', label: 'File' },
  { key: 'columns', label: 'Columns' },
  { key: 'rows', label: 'Rows' },
  { key: 'missing', label: 'Missing people' },
  { key: 'apply', label: 'Apply' },
];

function StepBar({ step, hasData, onStep, counts }) {
  const at = STEPS.findIndex(s => s.key === (step === 'done' ? 'apply' : step));
  return (
    <ol className="mb-4 flex flex-wrap items-center gap-1.5">
      {STEPS.map((s, i) => {
        const here = i === at;
        const past = step === 'done' || i < at;
        const reachable = hasData && s.key !== 'file' && step !== 'done' && !here;
        return (
          <li key={s.key} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden className="h-px w-3 bg-[#1D1D1F]/15 sm:w-5" />}
            <button type="button" disabled={!reachable} onClick={() => onStep(s.key)} aria-current={here ? 'step' : undefined}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold transition disabled:cursor-default ${here ? 'bg-[#0A84FF] text-white shadow-[0_4px_12px_rgba(10,132,255,0.3)]' : past ? 'bg-emerald-50 text-emerald-700' : 'bg-[#1D1D1F]/[0.05] text-[#6E6E73]'} ${reachable ? 'hover:bg-white hover:text-[#007AFF]' : ''}`}>
              <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${here ? 'bg-white/25' : 'bg-white/80'}`}>
                {past && !here ? <CheckCircle2 size={11} /> : i + 1}
              </span>
              {s.label}
              {counts?.[s.key] > 0 && <span className="rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">{counts[s.key]}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Banner({ tone = 'info', icon: Icon = AlertTriangle, children }) {
  const cls = tone === 'error' ? 'border-red-200 bg-red-50 text-red-700'
    : tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-800'
    : tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : 'border-[#0A84FF]/20 bg-[#E1EFFF]/60 text-[#0064D2]';
  return (
    <div role={tone === 'error' ? 'alert' : undefined} className={`flex items-start gap-2 rounded-2xl border px-3.5 py-2.5 text-xs font-semibold ${cls}`}>
      <Icon size={15} className="mt-px shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const Pill = ({ tone, children, title }) => (
  <span title={title} className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold ${tone}`}>{children}</span>
);

function ChoiceButton({ on, icon: Icon, onClick, disabled, children }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={on}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 touch:min-h-[40px] ${on ? 'border-transparent bg-[#1D1D1F]/[0.88] text-white' : 'border-[#1D1D1F]/[0.18] bg-white text-[#3A3A3C] hover:border-[#1D1D1F]/40'}`}>
      {Icon && <Icon size={13} className="shrink-0" />}{children}
    </button>
  );
}

const personLabel = p => [
  p.name, p.code, p.department,
].filter(Boolean).join(' · ') + (p.status === 'exited' ? ' (left)' : p.status === 'on_leave' ? ' (on leave)' : '');

// ── Step: columns ───────────────────────────────────────────────────────────

function ColumnsStep({ batch, rows, draft, setDraft, editable }) {
  const headers = headersOf(batch);
  // Up to three values from each column, so a mapping can be checked against what it would read.
  const samples = useMemo(() => headers.map((_, i) => {
    const out = [];
    for (const r of rows) {
      const v = text(list(r.raw)[i]);
      if (v) out.push(v);
      if (out.length === 3) break;
    }
    return out;
  }), [headers, rows]);
  const options = useMemo(() => [{ value: '', label: '— Not used —' }, ...IMPORT_FIELDS.map(f => ({ value: f.key, label: f.label }))], []);
  const setCol = (i, field) => setDraft(d => {
    const cols = [...d.cols];
    const from = field ? cols.findIndex((c, j) => c === field && j !== i) : -1;
    if (from !== -1) cols[from] = '';
    cols[i] = field;
    const blank = { ...d.blank };
    if (field && FIELD[field]?.kind === 'number' && blank[field] === undefined) blank[field] = Boolean(FIELD[field].blankZero);
    return { cols, blank, note: from !== -1 ? `${FIELD[field].label} was on column ${colLetter(from)}; it is on column ${colLetter(i)} now.` : '' };
  });
  const named = draft.cols.includes('name') || draft.cols.includes('code');
  if (!headers.length) {
    return <Banner tone="warn">The server did not send this sheet’s header row, so its columns cannot be shown. Go on to the rows.</Banner>;
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-[#515154]">
        {batch.sheet ? <>Sheet <b className="text-[#1D1D1F]">“{batch.sheet}”</b>. </> : null}
        Say what each column holds. A blank cell is read as blank — never as 0 — unless its column is ticked
        “blank counts as 0”. The map is remembered for next month’s sheet.
      </p>
      {!named && <Banner tone="error">Map the Name or the Payroll code column — without one of them no row can be matched to a person.</Banner>}
      {draft.note && <Banner>{draft.note}</Banner>}
      <div className="overflow-x-auto rounded-2xl border border-white/75 bg-white/55">
        <table className="w-full text-xs">
          <thead>
            <tr className="ci-table-head">
              <th className="px-2.5 py-2 text-left">Col</th>
              <th className="px-2.5 py-2 text-left">Header in the sheet</th>
              <th className="px-2.5 py-2 text-left">First values</th>
              <th className="min-w-[220px] px-2.5 py-2 text-left">Feeds</th>
              <th className="px-2.5 py-2 text-left">Blank counts as 0</th>
            </tr>
          </thead>
          <tbody>
            {headers.map((h, i) => {
              const field = draft.cols[i] || '';
              const number = FIELD[field]?.kind === 'number';
              return (
                <tr key={i} className="ci-table-row">
                  <td className="px-2.5 py-2 align-top font-mono font-semibold text-[#6E6E73]">{colLetter(i)}</td>
                  <td className="px-2.5 py-2 align-top font-semibold text-[#1D1D1F]">{text(h) || <span className="italic text-[#86868B]">no header</span>}</td>
                  <td className="max-w-[220px] px-2.5 py-2 align-top text-[#515154]">
                    <span className="block truncate" title={samples[i].join(' · ')}>{samples[i].join(' · ') || '—'}</span>
                  </td>
                  <td className="px-2.5 py-1.5 align-top">
                    <Select value={field} disabled={!editable} options={options} onChange={e => setCol(i, e.target.value || '')} />
                  </td>
                  <td className="px-2.5 py-2 align-top">
                    {number ? (
                      <input type="checkbox" className="mt-1 h-4 w-4 rounded border-[#1D1D1F]/20 accent-[#007AFF]" disabled={!editable}
                        aria-label={`Blank counts as 0 for ${FIELD[field].label}`} checked={Boolean(draft.blank[field])}
                        onChange={e => setDraft(d => ({ ...d, blank: { ...d.blank, [field]: e.target.checked }, note: '' }))} />
                    ) : <span className="text-[#C7C7CC]">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Step: rows ──────────────────────────────────────────────────────────────

function RowCard({ r, s, person, options, canEdit, error, onDecide, cols, blank, channelLabel }) {
  const [pick, setPick] = useState('');
  const [remember, setRemember] = useState(false);
  const [changing, setChanging] = useState(false);
  const f = objectOr(r.fields);
  const sheetName = text(f.name);
  const sheetCode = text(f.code);
  const meta = matchMeta(r.match);
  const suggested = useMemo(() => new Set(list(r.candidates)
    .map(c => text(c && typeof c === 'object' ? (c.id ?? c.person_id) : c)).filter(Boolean)), [r.candidates]);
  const ordered = useMemo(() => {
    const top = [];
    const rest = [];
    for (const o of options) {
      if (suggested.has(o.value)) top.push({ ...o, suggested: true });
      else rest.push(o);
    }
    return [...top, ...rest];
  }, [options, suggested]);
  const hasErrors = s.errors.length > 0;
  const picking = canEdit && !s.ignored && !hasErrors && (!s.matched || changing);

  const assign = async () => {
    const ok = await onDecide(r, { person_id: toId(pick), decision: 'include', save_alias: Boolean(remember && sheetName) });
    if (ok) { setPick(''); setRemember(false); setChanging(false); }
  };

  // The figures the row carries. A blank read as 0 (its column ticked) is named once, apart.
  const typed = [];
  const blanks = [];
  for (const x of NUMBER_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(f, x.key) || f[x.key] == null) continue;
    const col = cols[x.key];
    const rawBlank = isCol(col) && text(list(r.raw)[col]) === '';
    if (f[x.key] === '0' && rawBlank && blank[x.key]) blanks.push(x.short);
    else typed.push(`${x.short} ${x.qty ? qtyText(f[x.key]) : inr2(f[x.key])}`);
  }

  // The sheet's own department / pay channel, against the record (read to cross-check only).
  const checks = [];
  if (person && text(f.department) && text(person.department) && norm(f.department) !== norm(person.department)) {
    checks.push(`The sheet says department “${f.department}”; on file: ${person.department}.`);
  }
  if (person && text(f.pay_channel)) {
    const label = channelLabel(person.pay_channel);
    if (![person.pay_channel, label].some(x => text(x) && norm(x) === norm(f.pay_channel))) {
      checks.push(`The sheet says pay by “${f.pay_channel}”; on file: ${label || 'no pay channel'}.`);
    }
  }

  // Advances already given in the app this month (spec §9 item 7).
  const inApp = r.in_app_advance;
  const appP = paiseOf(inApp);
  const sheetP = f.advance_given == null ? null : paiseOf(f.advance_given);
  const mode = r.advance_mode === 'extra' ? 'extra' : 'total';
  const showAdvance = inApp != null && appP !== null && appP > 0n;
  const addsInTotal = sheetP !== null && appP !== null && sheetP > appP ? diffPaise(f.advance_given, inApp) : '0.00';

  const tone = s.ignored ? 'border-dashed border-[#1D1D1F]/15 bg-white/40'
    : hasErrors || r.match === 'conflict' || r.match === 'unknown_code' ? 'border-red-200 bg-red-50/40'
    : s.todo ? 'border-amber-200 bg-amber-50/40' : 'border-white/75 bg-white/70';

  return (
    <li className={`rounded-2xl border p-3 ${tone}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="rounded-md bg-[#1D1D1F]/[0.06] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[#515154]">Row {r.row_no}</span>
        <span className="min-w-0 break-words text-sm font-bold text-[#1D1D1F]">{sheetName || <span className="italic text-[#86868B]">no name</span>}</span>
        {sheetCode && <span className="font-mono text-xs font-semibold text-[#515154]">code {sheetCode}</span>}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {s.ignored ? <Pill tone="bg-[#1D1D1F]/[0.07] text-[#515154]">Ignored</Pill> : <Pill tone={meta.tone}>{meta.label}</Pill>}
          {s.dupWith && <Pill tone="bg-red-50 text-red-700">Same person as row {s.dupWith.join(', ')}</Pill>}
          {!s.ignored && hasErrors && <Pill tone="bg-red-50 text-red-700">{plural(s.errors.length, 'error')}</Pill>}
        </span>
      </div>

      {s.matched && person && (
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[#515154]">
          <span aria-hidden>→</span>
          <span className="font-semibold text-[#1D1D1F]">{person.name}</span>
          {[person.code, person.department, channelLabel(person.pay_channel)].filter(Boolean).map(x => <span key={x}>· {x}</span>)}
          {person.status && person.status !== 'active' && <StatusPill status={person.status} />}
        </p>
      )}
      {!s.matched && r.note && <p className="mt-1 text-xs text-[#515154]">{r.note}</p>}

      {(typed.length > 0 || blanks.length > 0 || text(f.remarks)) && (
        <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[#3A3A3C]">
          {typed.map(t => <span key={t} className="tabular-nums">{t}</span>)}
          {blanks.length > 0 && (
            <span className="text-[#86868B]" title="These cells are blank in the sheet; their columns are ticked “blank counts as 0”">
              Blank, read as 0: {blanks.join(', ')}
            </span>
          )}
          {text(f.remarks) && <span className="italic text-[#6E6E73]">“{f.remarks}”</span>}
        </p>
      )}

      {s.issues.length > 0 && (
        <ul className="mt-2 space-y-1">
          {s.issues.map((i, n) => (
            <li key={`${i.code}-${n}`} className={`flex items-start gap-1.5 text-xs font-semibold ${i.level === 'error' ? 'text-red-700' : 'text-amber-800'}`}>
              <AlertTriangle size={13} className="mt-px shrink-0" />
              <span className="min-w-0 break-words">{i.message || ISSUE_LABEL[i.code] || i.code}</span>
            </li>
          ))}
        </ul>
      )}

      {checks.map(c => <p key={c} className="mt-1 text-[11px] text-[#6E6E73]">{c}</p>)}

      {showAdvance && !s.ignored && (
        <div className="mt-2 rounded-xl border border-sky-200 bg-sky-50/70 px-3 py-2 text-xs text-sky-900">
          <p>
            Advance — the sheet: <b>{sheetP === null ? 'blank' : inr2(f.advance_given)}</b> · already given in the app
            this month: <b>{inr2(inApp)}</b>.
            {sheetP === null && ' The app’s advances are recovered from the balance; the sheet adds nothing.'}
          </p>
          {sheetP !== null && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <ChoiceButton on={mode === 'total'} disabled={!canEdit} onClick={() => mode !== 'total' && onDecide(r, { advance_mode: 'total' })}>
                The sheet is the month’s total — adds {inr2(addsInTotal)}
              </ChoiceButton>
              <ChoiceButton on={mode === 'extra'} disabled={!canEdit} onClick={() => mode !== 'extra' && onDecide(r, { advance_mode: 'extra' })}>
                The sheet is extra — adds {inr2(f.advance_given)}
              </ChoiceButton>
            </div>
          )}
          {mode === 'total' && sheetP !== null && sheetP < appP && (
            <p className="mt-1.5 font-semibold text-amber-800">
              The sheet is below what the app already recorded, so nothing more is added. The app’s advances are still recovered.
            </p>
          )}
        </div>
      )}

      {canEdit && (
        <div className="mt-2.5 flex flex-wrap items-end gap-2">
          {s.ignored && (
            <Button size="sm" variant="secondary" onClick={() => onDecide(r, { decision: s.matched ? 'include' : null })}>
              <Undo2 size={13} /> Undo ignore
            </Button>
          )}
          {!s.ignored && hasErrors && (
            <>
              <Button size="sm" variant="secondary" onClick={() => onDecide(r, { decision: 'ignore' })}><Ban size={13} /> Ignore this row</Button>
              <span className="text-[11px] text-[#6E6E73]">or fix the sheet and upload it again</span>
            </>
          )}
          {picking && (
            <>
              <div className="min-w-[240px] flex-1">
                <Select value={pick} options={ordered} placeholder={suggested.size ? 'Pick person — suggestions first' : 'Pick person'}
                  onChange={e => setPick(e.target.value || '')}
                  renderOption={o => (
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{o.label}</span>
                      {o.suggested && <span className="shrink-0 rounded-full bg-amber-100 px-1.5 text-[10px] font-bold text-amber-800">Suggested</span>}
                    </span>
                  )} />
              </div>
              {sheetName && (
                <Checkbox label={`Remember “${sheetName}” as their spelling`} checked={remember}
                  onChange={e => setRemember(e.target.checked)} />
              )}
              <Button size="sm" onClick={assign} disabled={!pick}>Assign</Button>
              {changing && <Button size="sm" variant="ghost" onClick={() => { setChanging(false); setPick(''); }}>Cancel</Button>}
              <Button size="sm" variant="secondary" onClick={() => onDecide(r, { decision: 'ignore' })}><Ban size={13} /> Ignore</Button>
            </>
          )}
          {!s.ignored && !hasErrors && s.matched && !changing && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setChanging(true)}>Change person</Button>
              <Button size="sm" variant="secondary" onClick={() => onDecide(r, { decision: 'ignore' })}><Ban size={13} /> Ignore</Button>
            </>
          )}
        </div>
      )}
      <InlineError message={error} className="mt-2" />
    </li>
  );
}

// ── The wizard ──────────────────────────────────────────────────────────────

export default function ImportWizard({
  month, run = null, inputs = [], people = [], channelLabel = c => c || '', canEdit = false,
  resumeBatchId = null, onClose, onApplied, onPending,
}) {
  const runStatus = run?.status || null;
  const editable = canEdit && (runStatus === null || runStatus === 'draft');
  const peopleById = useMemo(() => new Map(list(people).map(p => [String(p.id), p])), [people]);
  const nameOf = useCallback(id => peopleById.get(String(id))?.name || `Person #${id}`, [peopleById]);
  const personOptions = useMemo(() => list(people)
    .slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map(p => ({
      value: String(p.id), label: personLabel(p),
      // Who they are, never what they earn: a typed number must not find a salary.
      search: [p.name, p.display_name, p.code, p.department, p.designation].filter(Boolean).join(' '),
    })), [people]);

  const [step, setStep] = useState(resumeBatchId != null ? 'loading' : 'file');
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({ cols: [], blank: {}, note: '' });
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState('');
  const [dup, setDup] = useState(null); // { id, batch, data, message }
  const [stepError, setStepError] = useState('');
  const [rowErrors, setRowErrors] = useState({});
  const [filter, setFilter] = useState(null);
  const [q, setQ] = useState('');
  const [choices, setChoices] = useState({});
  const [overwrite, setOverwrite] = useState(() => new Set());
  const [result, setResult] = useState(null);
  const [keptTicks, setKeptTicks] = useState(() => new Set());
  const inputRef = useRef(null);
  const mutations = useRef(0);
  const toast = useToast();
  const [askDiscard, setAskDiscard] = useState(false);

  const batch = data?.batch || {};
  const batchId = batch.id ?? null;
  const parsed = !batch.status || batch.status === 'parsed';
  const rows = useMemo(() => list(data?.rows), [data]);
  const dups = useMemo(() => duplicateIds(rows), [rows]);
  const states = useMemo(() => new Map(rows.map(r => [rowKey(r), stateOf(r, dups)])), [rows, dups]);
  const counts = useMemo(() => summarise(rows, states), [rows, states]);
  const missing = useMemo(() => missingView(data, peopleById), [data, peopleById]);
  const undecided = missing.filter(m => !choices[m.id]).length;
  const baseDraft = useMemo(() => draftOf(batch), [batch]);
  const mapDirty = Boolean(data) && !sameDraft(draft, baseDraft);
  const liveIds = useMemo(() => new Set(rows.filter(r => !isIgnored(r) && isMatched(r)).map(r => String(r.person_id))), [rows]);

  useEffect(() => { if (data && filter === null) setFilter(counts.todo > 0 ? 'todo' : 'all'); }, [data, filter, counts.todo]);

  const take = useCallback((d, { keepDraft = false } = {}) => {
    const n = normalise(d);
    setData(n);
    if (!keepDraft) setDraft(draftOf(n.batch));
    return n;
  }, []);

  // A resumed upload (the Payroll screen remembered it, or "Open it" on a duplicate).
  useEffect(() => {
    if (resumeBatchId == null) return undefined;
    let live = true;
    hrApi.importBatch(resumeBatchId).then(d => {
      if (!live) return;
      const n = take(d);
      onPending?.(n.batch?.status && n.batch.status !== 'parsed' ? null : (n.batch?.id ?? resumeBatchId));
      setStep(firstStep(n));
    }, e => {
      if (!live) return;
      setFileError(`The earlier upload could not be opened: ${refusalText(e)}`);
      onPending?.(null);
      setStep('file');
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeBatchId]);

  // After a decision: the batch read again (missing people and duplicates can move), unless another
  // decision has started since — its own read will follow.
  const refresh = useCallback(async id => {
    const at = mutations.current;
    try {
      const d = await hrApi.importBatch(id);
      if (at === mutations.current) setData(prev => normalise(d, prev));
    } catch { /* the central toast has the reason; the cards stay as they are */ }
  }, []);

  // ── File ──
  const chooseFile = f => {
    setFile(f || null);
    setFileError('');
    setDup(null);
    if (f && !/\.xlsx$/i.test(f.name)) setFileError('Choose the Excel sheet itself (.xlsx).');
    else if (f && f.size > MAX_BYTES) setFileError(`This file is ${sizeText(f.size)}; the limit is 4 MB.`);
  };

  const upload = async () => {
    if (!file || fileError) return;
    setDup(null);
    let d;
    try {
      d = await hrApi.uploadImport(file, month);
    } catch (e) {
      if (e?.data?.code === 'DUPLICATE_FILE' && e.data.batch_id != null) {
        const id = e.data.batch_id;
        setDup({ id, batch: null, data: null, message: refusalText(e), at: e.data.uploaded_at ?? null });
        hrApi.importBatch(id).then(b => setDup(cur => (cur && String(cur.id) === String(id) ? { ...cur, data: b, batch: b?.batch ?? null } : cur)), () => {});
        return;
      }
      setFileError(refusalText(e)); // refused — said here; the chosen file stays chosen
      return;
    }
    const n = take(d);
    setFilter(null);
    onPending?.(n.batch?.id ?? null);
    setStep(firstStep(n));
  };

  const openBatch = async (id, preloaded) => {
    let d = preloaded;
    if (!d) {
      try { d = await hrApi.importBatch(id); } catch (e) { setFileError(refusalText(e)); return; }
    }
    const n = take(d);
    setDup(null);
    setFile(null);
    setFilter(null);
    onPending?.(n.batch?.status && n.batch.status !== 'parsed' ? null : (n.batch?.id ?? id));
    setStep(firstStep(n));
  };

  // ── Columns ──
  const saveMap = async () => {
    setStepError('');
    if (!draft.cols.includes('name') && !draft.cols.includes('code')) {
      setStepError('Map the Name or the Payroll code column first.');
      return false;
    }
    const column_map = {};
    draft.cols.forEach((f, i) => { if (f) column_map[f] = i; });
    const blank_as_zero = {};
    for (const f of Object.keys(column_map)) if (FIELD[f].kind === 'number') blank_as_zero[f] = Boolean(draft.blank[f]);
    mutations.current += 1;
    let d;
    try {
      d = await hrApi.saveImportMap(batchId, { column_map, blank_as_zero });
    } catch (e) {
      setStepError(refusalText(e)); // refused — the choices on screen stay as they are
      return false;
    }
    setData(prev => normalise(d, prev));
    setDraft(draftOf(normalise(d, data).batch));
    return true;
  };

  // ── Rows ──
  const decide = useCallback(async (r, body) => {
    const key = rowKey(r);
    if (r.id == null) {
      setRowErrors(m => ({ ...m, [key]: 'This row came without an id from the server, so it cannot be changed here.' }));
      return false;
    }
    mutations.current += 1;
    setRowErrors(m => ({ ...m, [key]: '' }));
    let saved;
    try {
      saved = await hrApi.saveImportRow(batchId, r.id, body);
    } catch (e) {
      setRowErrors(m => ({ ...m, [key]: refusalText(e) }));
      refresh(batchId);
      return false;
    }
    const row = saved?.row && typeof saved.row === 'object' ? saved.row : saved;
    setData(prev => prev && ({
      ...prev,
      rows: prev.rows.map(x => (rowKey(x) === key ? { ...x, ...(row && typeof row === 'object' ? row : body) } : x)),
    }));
    refresh(batchId);
    return true;
  }, [batchId, refresh]);

  const visible = useMemo(() => {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(r => {
      const s = states.get(rowKey(r));
      const f = filter || 'all';
      const ok = f === 'todo' ? s.todo
        : f === 'matched' ? !s.ignored && s.matched
        : f === 'errors' ? !s.ignored && s.errors.length > 0
        : f === 'dups' ? Boolean(s.dupWith)
        : f === 'ignored' ? s.ignored
        : f === 'all' ? true
        : !s.ignored && !s.matched && r.match === f;
      if (!ok) return false;
      if (!terms.length) return true;
      const hay = `${r.row_no} ${text(r.fields?.name)} ${text(r.fields?.code)} ${isMatched(r) ? nameOf(r.person_id) : ''}`.toLowerCase();
      return terms.every(t => hay.includes(t));
    });
  }, [rows, states, filter, q, nameOf]);

  // ── Apply ──
  const manualEdits = useMemo(() => {
    const touched = new Set([...liveIds, ...Object.keys(choices)]);
    return list(inputs).filter(i => i?.source === 'manual' && touched.has(String(i.person_id)))
      .map(i => ({ id: String(i.person_id), name: nameOf(i.person_id), at: i.updated_at }));
  }, [inputs, liveIds, choices, nameOf]);

  const blockers = [
    !editable && (runStatus && runStatus !== 'draft'
      ? `The ${monthLabel(month)} run is ${runStatus}. Imports are refused until it is sent back to draft.`
      : 'Your HR access level cannot apply an import.'),
    counts.todo > 0 && `${plural(counts.todo, 'row')} still need${counts.todo === 1 ? 's' : ''} a decision.`,
    undecided > 0 && `${plural(undecided, 'missing person', 'missing people')} need${undecided === 1 ? 's' : ''} Include or Leave out.`,
    mapDirty && 'The column changes have not been read yet — go back to Columns and read the sheet again.',
  ].filter(Boolean);

  const apply = async overwriteIds => {
    setStepError('');
    const body = {
      missing: missing.filter(m => choices[m.id]).map(m => ({ person_id: toId(m.id), choice: choices[m.id] })),
      overwrite_manual: [...overwriteIds].map(toId),
    };
    mutations.current += 1;
    let res;
    try {
      res = await hrApi.applyImport(batchId, body);
    } catch (e) {
      setStepError(refusalText(e)); // refused — every decision stays as it is
      return;
    }
    setResult(res && typeof res === 'object' ? res : {});
    setKeptTicks(new Set());
    setStep('done');
    onPending?.(null);
    onApplied?.(res);
  };

  // ── Export issues ──
  const buildIssues = () => {
    const out = [];
    for (const r of rows) {
      const s = states.get(rowKey(r));
      const base = {
        row_no: r.row_no, name: text(r.fields?.name), code: text(r.fields?.code),
        match: s.ignored ? 'Ignored' : matchMeta(r.match).label, person: isMatched(r) ? nameOf(r.person_id) : '',
      };
      if (!s.ignored && !s.matched) out.push({ ...base, level: 'Needs a decision', issue: matchMeta(r.match).label, message: text(r.note) });
      if (s.dupWith) out.push({ ...base, level: 'Needs a decision', issue: 'Duplicate', message: `Same person as row ${s.dupWith.join(', ')}` });
      for (const i of s.issues) {
        out.push({ ...base, level: i.level === 'error' ? 'Error' : 'Warning', issue: ISSUE_LABEL[i.code] || text(i.code), message: text(i.message) });
      }
    }
    return {
      name: `HR import issues ${month}`,
      title: `Import issues — ${monthLabel(month)}`,
      subtitle: text(batch.file_name) || 'Monthly sheet',
      meta: [batch.sheet ? `Sheet: ${batch.sheet}` : null, `${plural(rows.length, 'row')} read`, `${counts.todo} to resolve`].filter(Boolean),
      columns: [
        { key: 'row_no', label: 'Row' }, { key: 'name', label: 'Name in the sheet' }, { key: 'code', label: 'Code' },
        { key: 'match', label: 'Match' }, { key: 'person', label: 'Person' }, { key: 'level', label: 'Level' },
        { key: 'issue', label: 'Issue' }, { key: 'message', label: 'Detail' },
      ],
      rows: out.map((x, i) => ({ id: i, ...x })),
    };
  };

  // ── Rendering ──
  const cols = mapOf(batch);
  const blank = blankOf(batch);
  const headers = headersOf(batch);
  const used = headers.map((h, i) => ({ h: text(h), i, f: baseDraft.cols[i] })).filter(x => x.f);
  const unused = headers.map((h, i) => ({ h: text(h), i, f: baseDraft.cols[i] })).filter(x => !x.f && x.h);
  const go = s => { setStepError(''); setStep(s); };

  const statusBanner = data && !parsed && (
    <Banner tone="warn">
      This upload is {batch.status}{batch.applied_at ? ` (applied ${whenText(batch.applied_at)})` : ''}.
      {batch.status === 'applied' ? ' Applying it again writes the month’s inputs from it once more.' : ' The server may refuse to apply it.'}
    </Banner>
  );

  let body = null;
  if (step === 'loading') {
    body = <div className="flex items-center justify-center gap-2 py-16 text-sm text-[#86868B]"><Loader2 size={16} className="animate-spin" /> Opening the upload…</div>;
  } else if (step === 'file') {
    body = (
      <div className="space-y-3">
        {!editable && (
          <Banner tone="error">
            {runStatus && runStatus !== 'draft'
              ? `The ${monthLabel(month)} run is ${runStatus}. A sheet can be imported only while the run is a draft.`
              : 'Your HR access level cannot import a sheet.'}
          </Banner>
        )}
        <label
          className={`flex min-h-[200px] cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-8 text-center ${editable ? 'border-slate-200 bg-slate-50/60 hover:border-blue-300 hover:bg-blue-50/40' : 'pointer-events-none border-slate-200 bg-slate-50/40 opacity-60'}`}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); if (editable) chooseFile(e.dataTransfer.files?.[0]); }}>
          {file ? <FileSpreadsheet size={28} className="text-emerald-600" /> : <FileUp size={28} className="text-slate-400" />}
          <div className="text-sm font-semibold text-slate-600">
            {file ? <>{file.name} <span className="font-normal text-slate-400">· {sizeText(file.size)}</span></> : `Drop ${monthLabel(month)}’s sheet here, or click to choose`}
          </div>
          <div className="max-w-md text-xs text-slate-400">
            The Excel workbook (.xlsx), up to 4 MB. It is read on the server; nothing reaches the payroll until the
            last step, Apply.
          </div>
          <input ref={inputRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden"
            disabled={!editable} onChange={e => { chooseFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        <InlineError message={fileError} className="" />
        {dup && (
          <Banner tone="warn">
            <p>
              This exact file was already uploaded{dup.batch?.uploaded_at || dup.at ? ` on ${whenText(dup.batch?.uploaded_at || dup.at)}` : ''}
              {dup.batch?.status && dup.batch.status !== 'parsed' ? ` (now ${dup.batch.status})` : ''} — open it.
            </p>
            <div className="mt-2">
              <Button size="sm" variant="secondary" onClick={() => openBatch(dup.id, dup.data)}>Open it</Button>
            </div>
          </Banner>
        )}
      </div>
    );
  } else if (step === 'columns') {
    body = (
      <div className="space-y-3">
        {statusBanner}
        <ColumnsStep batch={batch} rows={rows} draft={draft} setDraft={setDraft} editable={editable && parsed} />
        <InlineError message={stepError} className="" />
      </div>
    );
  } else if (step === 'rows') {
    const chip = (key, label, n, tone) => (n > 0 || filter === key || key === 'all' || key === 'todo') && (
      <FilterChip key={key} label={label} count={n} on={filter === key} tone={tone} onClick={() => setFilter(key)} />
    );
    body = (
      <div className="space-y-3">
        {statusBanner}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-[#1D1D1F]/[0.04] px-3 py-2 text-xs text-[#515154]">
          <span className="min-w-0 flex-1">
            <b className="text-[#1D1D1F]">{text(batch.file_name) || 'The sheet'}</b>
            {batch.uploaded_at ? ` · uploaded ${whenText(batch.uploaded_at)}` : ''} · reading {plural(used.length, 'column')}
            {used.length > 0 && `: ${used.map(x => FIELD[x.f]?.short || FIELD[x.f]?.label).join(', ')}`}
            {unused.length > 0 && <span className="text-[#86868B]"> · not used: {unused.map(x => x.h).join(', ')}</span>}
          </span>
          <Button size="sm" variant="ghost" onClick={() => go('columns')}>Check columns</Button>
        </div>
        <FilterRail>
          <FilterGroup label="Rows" divider={false} className="!shrink min-w-0">
            {chip('todo', 'To resolve', counts.todo, 'border-transparent bg-red-600 text-white')}
            {chip('all', 'All', counts.all)}
            {chip('matched', 'Matched', counts.matched, 'border-emerald-300 bg-emerald-100 text-emerald-800')}
            {chip('conflict', 'Conflict', counts.conflict, 'border-red-300 bg-red-100 text-red-800')}
            {chip('ambiguous', 'Ambiguous', counts.ambiguous, 'border-amber-300 bg-amber-100 text-amber-800')}
            {chip('unmatched', 'Unmatched', counts.unmatched, 'border-amber-300 bg-amber-100 text-amber-800')}
            {chip('unknown_code', 'Unknown code', counts.unknown_code, 'border-red-300 bg-red-100 text-red-800')}
            {chip('errors', 'Errors', counts.errors, 'border-red-300 bg-red-100 text-red-800')}
            {chip('dups', 'Duplicates', counts.dups, 'border-red-300 bg-red-100 text-red-800')}
            {chip('ignored', 'Ignored', counts.ignored)}
          </FilterGroup>
          <div className="ml-auto flex items-center gap-2">
            <SearchInput value={q} onChange={setQ} placeholder="Find a row, name or code" className="w-56" />
            <ExportMenu build={buildIssues} label="Export issues" />
          </div>
        </FilterRail>
        {visible.length === 0 ? (
          <div className="rounded-2xl border border-white/75 bg-white/55 px-4 py-10 text-center text-sm text-[#6E6E73]">
            {filter === 'todo'
              ? <span className="inline-flex items-center gap-2 font-semibold text-emerald-700"><CheckCircle2 size={16} /> Every row is settled — on to the missing people.</span>
              : 'No row matches this filter.'}
          </div>
        ) : (
          <ul className="space-y-2">
            {visible.map(r => (
              <RowCard key={rowKey(r)} r={r} s={states.get(rowKey(r))} person={isMatched(r) ? peopleById.get(String(r.person_id)) : null}
                options={personOptions} canEdit={editable && parsed} error={rowErrors[rowKey(r)]} onDecide={decide}
                cols={cols} blank={blank} channelLabel={channelLabel} />
            ))}
          </ul>
        )}
      </div>
    );
  } else if (step === 'missing') {
    body = (
      <div className="space-y-3">
        <p className="text-xs text-[#515154]">
          People on the payroll with a pay setup who have no row in the sheet. Each needs a choice — nobody is
          paid a silent zero, and nobody is dropped without a word.
        </p>
        {missing.length === 0 ? (
          <Banner tone="ok" icon={CheckCircle2}>Everyone active with a pay setup is in the sheet.</Banner>
        ) : (
          <ul className="space-y-2">
            {missing.map(m => (
              <li key={m.id} className={`flex flex-wrap items-center gap-2 rounded-2xl border p-3 ${choices[m.id] ? 'border-white/75 bg-white/70' : 'border-amber-200 bg-amber-50/40'}`}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-[#1D1D1F]">{m.name}</p>
                  <p className="text-[11px] text-[#6E6E73]">{[m.code, m.department, m.why].filter(Boolean).join(' · ')}</p>
                </div>
                <ChoiceButton icon={UserPlus} on={choices[m.id] === 'include'} disabled={!editable}
                  onClick={() => setChoices(c => ({ ...c, [m.id]: 'include' }))}>Include — no OT, no absence</ChoiceButton>
                <ChoiceButton icon={UserX} on={choices[m.id] === 'exclude'} disabled={!editable}
                  onClick={() => setChoices(c => ({ ...c, [m.id]: 'exclude' }))}>Leave out this month</ChoiceButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  } else if (step === 'apply') {
    const check = (ok, label) => (
      <li className={`flex items-start gap-2 text-xs font-semibold ${ok ? 'text-emerald-700' : 'text-red-700'}`}>
        {ok ? <CheckCircle2 size={14} className="mt-px shrink-0" /> : <AlertTriangle size={14} className="mt-px shrink-0" />}
        <span>{label}</span>
      </li>
    );
    const includes = Object.values(choices).filter(c => c === 'include').length;
    const excludes = Object.values(choices).filter(c => c === 'exclude').length;
    body = (
      <div className="space-y-3">
        {statusBanner}
        <ul className="space-y-1.5 rounded-2xl border border-white/75 bg-white/55 p-3">
          {check(counts.todo === 0, counts.todo === 0
            ? `Every row is settled: ${plural(liveIds.size, 'person', 'people')} from the sheet, ${plural(counts.ignored, 'row')} ignored.`
            : `${plural(counts.todo, 'row')} still need${counts.todo === 1 ? 's' : ''} a decision (Rows).`)}
          {check(undecided === 0, undecided === 0
            ? (missing.length ? `Missing people decided: ${includes} included, ${excludes} left out.` : 'Nobody is missing from the sheet.')
            : `${plural(undecided, 'missing person', 'missing people')} still need${undecided === 1 ? 's' : ''} a choice (Missing people).`)}
          {check(editable, editable ? `The ${monthLabel(month)} run is ${runStatus || 'not started yet — applying starts it as a draft'}.`
            : blockers[0])}
          {mapDirty && check(false, 'Column changes have not been read yet (Columns).')}
        </ul>
        {manualEdits.length > 0 && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-3">
            <p className="text-xs font-bold text-amber-900">Typed by hand since the last import</p>
            <p className="mt-0.5 text-[11px] text-amber-800">
              These people’s inputs were changed by hand. They are kept as they are unless ticked — a tick replaces
              them with the sheet’s figures.
            </p>
            <ul className="mt-2 space-y-1">
              {manualEdits.map(m => (
                <li key={m.id}>
                  <Checkbox label={<span><b>{m.name}</b>{m.at ? <span className="text-[#6E6E73]"> · changed {whenText(m.at)}</span> : null} — overwrite with the sheet</span>}
                    checked={overwrite.has(m.id)} disabled={!editable}
                    onChange={e => setOverwrite(s => { const n = new Set(s); if (e.target.checked) n.add(m.id); else n.delete(m.id); return n; })} />
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-[#515154]">
          Apply writes {monthLabel(month)}’s inputs for everyone above and recalculates the draft run. Nothing is
          posted to an advance or loan balance until the month is finalised.
        </p>
        <InlineError message={stepError} className="" />
      </div>
    );
  } else if (step === 'done') {
    const appliedN = typeof result?.applied === 'number' ? result.applied : Array.isArray(result?.applied) ? result.applied.length : null;
    const kept = list(result?.manual_edits_kept).map(x => {
      const id = text(x && typeof x === 'object' ? (x.person_id ?? x.id) : x);
      return { id, name: text(x?.name) || nameOf(id) };
    }).filter(x => x.id);
    body = (
      <div className="space-y-3">
        <Banner tone="ok" icon={CheckCircle2}>
          Applied to the {monthLabel(month)} payroll{appliedN != null ? ` — ${plural(appliedN, 'person', 'people')}’s inputs written` : ''}, and
          the run was recalculated.
        </Banner>
        {kept.length > 0 && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-3">
            <p className="text-xs font-bold text-amber-900">Kept as typed by hand ({kept.length})</p>
            <p className="mt-0.5 text-[11px] text-amber-800">
              The sheet did not overwrite these. Tick any that should take the sheet’s figures, then overwrite them.
            </p>
            <ul className="mt-2 space-y-1">
              {kept.map(k => (
                <li key={k.id}>
                  <Checkbox label={<span><b>{k.name}</b> — overwrite with the sheet</span>} checked={keptTicks.has(k.id)}
                    onChange={e => setKeptTicks(s => { const n = new Set(s); if (e.target.checked) n.add(k.id); else n.delete(k.id); return n; })} />
                </li>
              ))}
            </ul>
            <div className="mt-2">
              <Button size="sm" variant="secondary" disabled={keptTicks.size === 0} onClick={() => apply(keptTicks)}>
                <RotateCcw size={13} /> Overwrite {keptTicks.size ? plural(keptTicks.size, 'person', 'people') : 'the ticked'}
              </Button>
            </div>
          </div>
        )}
        <InlineError message={stepError} className="" />
      </div>
    );
  }

  // Set this upload aside. A refusal is said in the step (the dialog closes so it can be read); success
  // closes the wizard, and the Payroll screen reads the month again.
  const discard = async () => {
    setStepError('');
    try {
      await hrApi.discardImport(batchId);
    } catch (e) {
      setStepError(refusalText(e));
      return;
    }
    onPending?.(null);
    toast.success('Upload discarded');
    onClose();
  };
  const canDiscard = Boolean(data) && parsed && editable && batchId != null;

  const order = ['columns', 'rows', 'missing', 'apply'];
  const nextOf = s => order[order.indexOf(s) + 1];
  const prevOf = s => order[order.indexOf(s) - 1];
  let footer;
  if (step === 'file' || step === 'loading') {
    footer = (
      <>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={upload} disabled={!file || Boolean(fileError) || !editable}>Upload and read</Button>
      </>
    );
  } else if (step === 'done') {
    footer = <Button onClick={onClose}>Close and review the register</Button>;
  } else {
    footer = (
      <>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {canDiscard && <Button variant="ghost" onClick={() => setAskDiscard(true)}>Discard this upload</Button>}
        {step === 'columns' && (
          <Button variant="secondary" onClick={() => { setData(null); setFile(null); setDup(null); setStepError(''); setStep('file'); }}>
            Upload a different file
          </Button>
        )}
        {prevOf(step) && <Button variant="secondary" onClick={() => go(prevOf(step))}><ArrowLeft size={14} /> Back</Button>}
        {step === 'columns' && mapDirty && editable && parsed && (
          <Button variant="secondary" onClick={saveMap}>Read the sheet again with these columns</Button>
        )}
        {step === 'columns' && (
          <Button onClick={async () => { if (mapDirty && editable && parsed) { if (!(await saveMap())) return; } go('rows'); }}>
            Next: rows <ArrowRight size={14} />
          </Button>
        )}
        {(step === 'rows' || step === 'missing') && (
          <Button onClick={() => go(nextOf(step))}>Next: {step === 'rows' ? 'missing people' : 'apply'} <ArrowRight size={14} /></Button>
        )}
        {step === 'apply' && (
          <Button onClick={() => apply(overwrite)} disabled={blockers.length > 0}>Apply to {monthLabel(month)}</Button>
        )}
      </>
    );
  }

  return (
    <Modal open onClose={onClose} size="xl" title={`Import the monthly sheet — ${monthLabel(month)}`} footer={footer}>
      <StepBar step={step} hasData={Boolean(data)} onStep={go}
        counts={{ rows: counts.todo, missing: undecided }} />
      {body}
      {step === 'apply' && blockers.length > 0 && (
        <p className="mt-3 text-xs font-semibold text-red-700">Apply waits for: {blockers.join(' ')}</p>
      )}
      {(step === 'rows' || step === 'missing') && <InlineError message={stepError} />}
      <ConfirmDialog open={askDiscard} onClose={() => setAskDiscard(false)} onConfirm={discard}
        title="Discard this upload?" confirmLabel="Discard upload" danger
        message="Nothing from this sheet reaches the payroll, and Submit stops waiting for it. The same file can be uploaded again later. Inputs already applied from an earlier sheet are not touched." />
    </Modal>
  );
}
