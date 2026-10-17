// HR → Payroll: one month's payroll, from the sheet to the money leaving (spec §9, §12, §13).
//
//   month bar      the month (default: the month it is now at the plant), its run's status, and the
//                  steps Upload → Review → Check → Submit → Approve → Finalise → Pay with who and when
//   actions        by status and HR level: Import sheet / Recalculate / Submit (operator, draft);
//                  Send back / Approve (approver, submitted); Finalise (approver, approved); Payments
//                  (finalised). Submit stays disabled while a line is blocked or the month's upload
//                  still has rows to resolve, and says why right beside it.
//   exceptions     every block and warn flag on the lines with how many people carry it (a click
//                  narrows the register), the people left out this month, and active people with a pay
//                  setup who are not in the run at all.
//   register       one row per person, with a totals row, grouping by department or pay channel, and
//                  PDF / Excel through the exporter. A row opens its line drawer (RunLineDrawer.jsx).
//   payments       a finalised run, per pay channel: Mark paid with reference and date, line by line.
//
// Refusals. Inside a dialog (submit, approve, send back, finalise, mark paid) the server's message is
// said inline and the dialog stays open with what was typed; codes that carry people (RUN_BLOCKED,
// RUN_CHANGED_SINCE_APPROVAL) name them and can narrow the register to them, and codes that name a
// month (PREVIOUS_MONTH_OPEN, MONTH_BEFORE_FINALISED) offer to open it. Outside a dialog (Recalculate)
// the central toast is enough.
//
// Money is only formatted. The figures added up here (totals row, group subtotals, a channel's total)
// are exact paise sums (RunLineDrawer.jsx sumPaise), and the run's own stored totals are shown beside
// them; if the two ever disagree, that is said, not hidden. Nothing is logged, and no amount goes near
// document.title.
//
// A month with no run is not an error: GET /hr/runs/:month answers run: null (and creates nothing), so it is
// always read — it also carries the month's pending upload (pending_import), whether or not a run exists.
//
// Pay staff (month bar, operator): the advance / loan form (PayStaffModal.jsx) with the person's ledger beside
// it. A payment while the month is a draft recalculates the run, so the recovery shows on the line at once.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, Calculator, Check, ChevronLeft, ChevronRight, CornerUpLeft, FileUp, HandCoins, Lock, RefreshCw, Send,
  ShieldCheck, Wallet,
} from 'lucide-react';
import {
  Button, ConfirmDialog, DataTable, Field, Input, KpiCard, KpiRow, Modal, SubTabs, Textarea, rowMatches, useToast,
} from '../../components/ui.jsx';
import { FilterChip, FilterGroup, FilterRail } from '../../components/FilterChip.jsx';
import { hrApi, inr2, levelAtLeast, monthLabel } from '../../lib/hr.js';
import { storage } from '../../lib/safeStorage.js';
import ImportWizard, { batchSummary } from './ImportWizard.jsx';
import PayStaffModal from './PayStaffModal.jsx';
import RunLineDrawer, {
  FlagDots, LEVEL_META, MONTH_RE, PAYMENT_STATUS, PaymentPill, flagLabel, flagsOf, levelOf, list, paiseOf, plantMonth,
  plantToday, plural, qtyText, shiftMonth, sumPaise, sumQty, whenText,
} from './RunLineDrawer.jsx';
import { InlineError, refusalText } from './PersonDrawer.jsx';

const RUN_STATUS = {
  none: { label: 'Not started', tone: 'bg-gray-100 text-gray-600' },
  draft: { label: 'Draft', tone: 'bg-sky-50 text-sky-700' },
  submitted: { label: 'Submitted', tone: 'bg-amber-50 text-amber-700' },
  approved: { label: 'Approved', tone: 'bg-violet-50 text-violet-700' },
  finalised: { label: 'Finalised', tone: 'bg-emerald-50 text-emerald-700' },
};
const RANK = { none: 0, draft: 1, submitted: 2, approved: 3, finalised: 4 };
const BY_FIELDS = ['prepared_by', 'submitted_by', 'approved_by', 'finalised_by', 'sent_back_by'];

const toId = id => (/^\d+$/.test(String(id)) ? Number(id) : id);
const sortNum = v => { const p = paiseOf(v); return p === null ? null : Number(p); };
const owes = l => (paiseOf(l?.payable) ?? 0n) > 0n;
const payStatus = l => (PAYMENT_STATUS[l?.payment_status] ? l.payment_status : 'pending');

// ── The upload this browser left unapplied, per month ───────────────────────
// A fallback only. GET /hr/runs/:month carries pending_import (the month's latest parsed upload, made
// anywhere); when the server sends that field this reminder is neither read nor written. Against a server
// that does not send it, this per-viewer note (a batch id, nothing else) still lets "Resume import" work.
const PENDING_KEY = 'ci.hr.pendingImports';
function readPending() {
  try {
    const v = JSON.parse(storage.getItem(PENDING_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function writePending(month, id) {
  try {
    const all = readPending();
    if (id == null) delete all[month]; else all[month] = id;
    storage.setItem(PENDING_KEY, JSON.stringify(all));
  } catch { /* a browser that keeps nothing still works; it just cannot offer Resume */ }
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function RunChip({ status }) {
  const meta = RUN_STATUS[status] || { label: String(status), tone: 'bg-gray-100 text-gray-600' };
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ring-[#1D1D1F]/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] ${meta.tone}`}>
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" />
      {meta.label}
    </span>
  );
}

const STEP_TONE = {
  done: { dot: 'bg-emerald-500 text-white', label: 'text-[#1D1D1F]' },
  current: { dot: 'bg-[#0A84FF] text-white ring-4 ring-[#0A84FF]/20', label: 'text-[#0064D2]' },
  blocked: { dot: 'bg-red-500 text-white ring-4 ring-red-500/20', label: 'text-red-700' },
  todo: { dot: 'bg-[#1D1D1F]/[0.08] text-[#86868B]', label: 'text-[#86868B]' },
};

function Stepper({ steps }) {
  return (
    <ol className="grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-4 lg:grid-cols-7">
      {steps.map((s, i) => {
        const t = STEP_TONE[s.state] || STEP_TONE.todo;
        return (
          <li key={s.key} className="flex min-w-0 items-start gap-2" aria-current={s.state === 'current' ? 'step' : undefined}>
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${t.dot}`}>
              {s.state === 'done' ? <Check size={13} /> : s.state === 'blocked' ? <AlertTriangle size={12} /> : i + 1}
            </span>
            <span className="min-w-0">
              <span className={`block text-xs font-bold ${t.label}`}>{s.label}</span>
              {s.sub.filter(Boolean).map(x => <span key={x} className="block break-words text-[11px] leading-snug text-[#6E6E73]">{x}</span>)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// One line under the month bar: why Submit waits, or where the run stands.
function Reason({ tone, children, actions }) {
  const cls = tone === 'red' ? 'border-red-200 bg-red-50 text-red-700'
    : tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-800'
    : tone === 'green' ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : 'border-[#1D1D1F]/[0.06] bg-white/60 text-[#515154]';
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl border px-3 py-2 text-xs font-semibold ${cls}`}>
      <span className="min-w-0 flex-1">{children}</span>
      {actions}
    </div>
  );
}

function MiniTotals({ items }) {
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.filter(Boolean).map(([label, value]) => (
        <div key={label} className="rounded-xl bg-[#1D1D1F]/[0.04] px-3 py-2">
          <dt className="text-[10px] font-bold uppercase tracking-wide text-[#86868B]">{label}</dt>
          <dd className="text-sm font-extrabold tabular-nums text-[#1D1D1F]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// A dialog that waits for what it starts and, when the server refuses, says why inside itself and
// stays open — the central toast sits behind it.
function ActionDialog({ title, confirmLabel, variant = 'primary', disabled = false, onConfirm, onClose, refusal, children }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(e);
      setBusy(false);
      return;
    }
    setBusy(false);
    onClose();
  };
  return (
    <Modal open onClose={busy ? () => {} : onClose} title={title}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant={variant} onClick={confirm} disabled={disabled}>{confirmLabel}</Button>
      </>}>
      <div className="space-y-3 text-sm text-[#3A3A3C]">{children}</div>
      {error && refusal(error)}
    </Modal>
  );
}

function PeopleLine({ label, tone, people, onOpen, hint }) {
  const [all, setAll] = useState(false);
  const shown = all ? people : people.slice(0, 12);
  return (
    <div className={`mt-2 rounded-xl px-3 py-2 text-xs ${tone === 'amber' ? 'bg-amber-50 text-amber-900' : 'bg-[#1D1D1F]/[0.04] text-[#3A3A3C]'}`}>
      <span className="font-bold">{label} ({people.length}):</span>{' '}
      {shown.map((p, i) => (
        <span key={p.id}>
          {i > 0 && ', '}
          <button type="button" onClick={() => onOpen(p.id)} className="font-semibold underline decoration-dotted underline-offset-2 hover:text-[#007AFF]">{p.name}</button>
        </span>
      ))}
      {people.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="ml-1 font-bold text-[#007AFF]">+{people.length - shown.length} more</button>
      )}
      {hint && <span className="mt-0.5 block text-[11px] opacity-80">{hint}</span>}
    </div>
  );
}

// ── Payments (a finalised run) ──────────────────────────────────────────────

function PayDialog({ month, group, label, kind, nameOf, onClose, onDone }) {
  const unpaid = group.due.filter(l => payStatus(l) !== 'paid');
  const today = plantToday();
  const [ref, setRef] = useState('');
  const [date, setDate] = useState(today);
  const [picked, setPicked] = useState(() => new Set(unpaid.filter(l => payStatus(l) === 'pending').map(l => String(l.person_id))));
  const [error, setError] = useState('');
  const chosen = unpaid.filter(l => picked.has(String(l.person_id)));
  const save = async () => {
    const problems = [
      !chosen.length && 'Tick at least one person.',
      kind === 'bank' && !ref.trim() && 'Enter the bank reference (UTR) of this transfer.',
      !/^\d{4}-\d{2}-\d{2}$/.test(date) && 'Enter the date it was paid.',
      date > today && 'The payment date is after today.',
    ].filter(Boolean);
    setError(problems[0] || '');
    if (problems.length) return;
    try {
      await hrApi.recordPayments(month, {
        pay_channel: group.code, reference: ref.trim() || null, paid_on: date, person_ids: chosen.map(l => toId(l.person_id)),
      });
    } catch (e) {
      setError(refusalText(e)); // refused — said here; the reference, date and ticks stay
      return;
    }
    onDone(chosen.length);
  };
  const toggle = (id, on) => setPicked(s => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  return (
    <Modal open onClose={onClose} title={`Mark paid — ${label}`} wide
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={!chosen.length}>Mark {plural(chosen.length, 'person', 'people')} paid</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-xs text-[#515154]">
          Record the payment once the money has actually gone. Finalising a month is not proof of payment.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={kind === 'bank' ? 'Bank reference (UTR)' : 'Reference'} required={kind === 'bank'}
            hint={kind === 'bank' ? 'The transfer’s UTR or cheque number.' : 'Optional — e.g. the cash register page.'}>
            <Input value={ref} autoComplete="off" onChange={e => { setRef(e.target.value); setError(''); }} />
          </Field>
          <Field label="Paid on" required>
            <Input type="date" value={date} max={today} onChange={e => { setDate(e.target.value); setError(''); }} />
          </Field>
        </div>
        <div className="overflow-x-auto rounded-2xl border border-white/75 bg-white/55">
          <table className="w-full text-xs">
            <thead>
              <tr className="ci-table-head">
                <th className="w-8 px-2.5 py-2">
                  <input type="checkbox" aria-label="Tick everyone" className="h-4 w-4 accent-[#007AFF]"
                    checked={unpaid.length > 0 && chosen.length === unpaid.length}
                    onChange={e => setPicked(e.target.checked ? new Set(unpaid.map(l => String(l.person_id))) : new Set())} />
                </th>
                <th className="px-2.5 py-2 text-left">Person</th>
                <th className="px-2.5 py-2 text-left">Status</th>
                <th className="px-2.5 py-2 text-right">Payable</th>
              </tr>
            </thead>
            <tbody>
              {unpaid.map(l => (
                <tr key={l.person_id} className="ci-table-row">
                  <td className="px-2.5 py-2">
                    <input type="checkbox" aria-label={`Pay ${nameOf(l.person_id)}`} className="h-4 w-4 accent-[#007AFF]"
                      checked={picked.has(String(l.person_id))} onChange={e => toggle(String(l.person_id), e.target.checked)} />
                  </td>
                  <td className="px-2.5 py-2 font-semibold text-[#1D1D1F]">{nameOf(l.person_id)}</td>
                  <td className="px-2.5 py-2"><PaymentPill status={payStatus(l)} /></td>
                  <td className="px-2.5 py-2 text-right tabular-nums">{inr2(l.payable)}</td>
                </tr>
              ))}
              <tr className="border-t border-[#1D1D1F]/[0.08] bg-white/60">
                <td />
                <td colSpan={2} className="px-2.5 py-2 font-bold text-[#1D1D1F]">Ticked: {plural(chosen.length, 'person', 'people')}</td>
                <td className="px-2.5 py-2 text-right font-bold tabular-nums text-[#1D1D1F]">{inr2(sumPaise(chosen.map(l => l.payable)))}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <InlineError message={error} className="" />
      </div>
    </Modal>
  );
}

function PaymentsPanel({ lines, channelLabel, canOperate, nameOf, onPay, onOpen }) {
  const [open, setOpen] = useState(null);
  const groups = useMemo(() => {
    const by = new Map();
    for (const l of lines) {
      const k = l.pay_channel ?? '';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(l);
    }
    return [...by.entries()]
      .sort((a, b) => (a[0] === '') - (b[0] === '') || String(channelLabel(a[0])).localeCompare(String(channelLabel(b[0]))))
      .map(([code, ls]) => {
        const due = ls.filter(owes);
        const n = s => due.filter(l => payStatus(l) === s).length;
        return { code, lines: ls, due, payable: sumPaise(ls.map(l => l.payable)), paid: n('paid'), pending: n('pending'), failed: n('failed'), reversed: n('reversed') };
      });
  }, [lines, channelLabel]);
  const due = groups.reduce((t, g) => t + g.due.length, 0);
  const paid = groups.reduce((t, g) => t + g.paid, 0);
  return (
    <section className="glass mb-3 rounded-[22px] border border-white/70 p-4 shadow-card">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Wallet size={15} className="text-[#6E6E73]" />
        <h3 className="text-sm font-bold tracking-[-0.01em] text-[#1D1D1F]">Payments</h3>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${paid === due ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>
          {paid} of {plural(due, 'person', 'people')} paid
        </span>
        <span className="text-[11px] text-[#86868B]">Finalising is not proof of payment — mark each channel when the money has gone.</span>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-white/75 bg-white/55">
        <table className="w-full text-xs">
          <thead>
            <tr className="ci-table-head">
              <th className="px-2.5 py-2 text-left">Channel</th>
              <th className="px-2.5 py-2 text-right">People</th>
              <th className="px-2.5 py-2 text-right">Payable</th>
              <th className="px-2.5 py-2 text-right">Paid</th>
              <th className="px-2.5 py-2 text-right">Not paid</th>
              <th className="px-2.5 py-2 text-right">Failed / reversed</th>
              <th className="px-2.5 py-2" />
            </tr>
          </thead>
          <tbody>
            {groups.map(g => {
              const waiting = g.pending + g.failed + g.reversed;
              const isOpen = open === g.code;
              return [
                <tr key={`g-${g.code}`} className="ci-table-row">
                  <td className="px-2.5 py-2 font-semibold text-[#1D1D1F]">
                    <button type="button" onClick={() => setOpen(isOpen ? null : g.code)} className="inline-flex items-center gap-1 hover:text-[#007AFF]">
                      <ChevronRight size={13} className={`transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                      {g.code ? channelLabel(g.code) : <span className="text-amber-700">No pay channel</span>}
                    </button>
                  </td>
                  <td className="px-2.5 py-2 text-right tabular-nums">{g.lines.length}</td>
                  <td className="px-2.5 py-2 text-right font-semibold tabular-nums">{inr2(g.payable)}</td>
                  <td className="px-2.5 py-2 text-right tabular-nums text-emerald-700">{g.paid}</td>
                  <td className="px-2.5 py-2 text-right tabular-nums">{g.pending}</td>
                  <td className={`px-2.5 py-2 text-right tabular-nums ${g.failed + g.reversed ? 'font-bold text-red-700' : ''}`}>{g.failed + g.reversed}</td>
                  <td className="px-2.5 py-2 text-right">
                    {canOperate && g.code && waiting > 0 && <Button size="sm" onClick={() => onPay(g)}>Mark paid</Button>}
                    {!g.code && waiting > 0 && <span className="text-[11px] text-amber-700">Mark each person from their line</span>}
                    {waiting === 0 && g.due.length > 0 && <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700"><Check size={12} /> All paid</span>}
                  </td>
                </tr>,
                isOpen && (
                  <tr key={`l-${g.code}`}>
                    <td colSpan={7} className="bg-white/40 px-2.5 py-2">
                      <ul className="divide-y divide-[#1D1D1F]/[0.05]">
                        {g.lines.map(l => (
                          <li key={l.person_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                            <button type="button" onClick={() => onOpen(l.person_id)} className="min-w-[160px] flex-1 text-left font-semibold text-[#1D1D1F] hover:text-[#007AFF]">
                              {nameOf(l.person_id)}
                            </button>
                            <span className="tabular-nums">{inr2(l.payable)}</span>
                            {owes(l) ? <PaymentPill status={payStatus(l)} /> : <span className="text-[11px] text-[#86868B]">Nothing to pay</span>}
                            {l.paid_on && <span className="text-[11px] text-[#6E6E73]">{whenText(l.paid_on)}</span>}
                            {l.paid_ref && <span className="font-mono text-[11px] text-[#6E6E73]">{l.paid_ref}</span>}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── The screen ──────────────────────────────────────────────────────────────

export default function Payroll({ level }) {
  const toast = useToast();
  const canOperate = levelAtLeast(level, 'operator');
  const canApprove = levelAtLeast(level, 'approver');
  const [params, setParams] = useSearchParams();
  const thisMonth = plantMonth();
  const asked = params.get('month');
  const month = MONTH_RE.test(asked || '') ? asked : thisMonth;
  const setMonth = useCallback(m => {
    if (!MONTH_RE.test(m || '')) return;
    setParams(p => { const n = new URLSearchParams(p); n.set('month', m); return n; }, { replace: true });
  }, [setParams]);

  // ── Reference data: people (names, departments), pay channels, policy, who I am ──
  const [people, setPeople] = useState([]);
  const [channels, setChannels] = useState([]);
  const [settings, setSettings] = useState(null);
  const [me, setMe] = useState(null);
  useEffect(() => {
    let live = true;
    Promise.allSettled([hrApi.people(), hrApi.payChannels(), hrApi.settings(), hrApi.me()]).then(([p, c, s, m]) => {
      if (!live) return;
      if (p.status === 'fulfilled' && Array.isArray(p.value)) setPeople(p.value);
      if (c.status === 'fulfilled' && Array.isArray(c.value)) setChannels(c.value);
      if (s.status === 'fulfilled') setSettings(s.value || {});
      if (m.status === 'fulfilled') setMe(m.value || null);
    });
    return () => { live = false; };
  }, []);
  const peopleById = useMemo(() => new Map(people.map(p => [String(p.id), p])), [people]);
  const channelBy = useMemo(() => new Map(channels.map(c => [c.code, c])), [channels]);
  const channelLabel = useCallback(code => (code ? (channelBy.get(code)?.label || code) : ''), [channelBy]);

  // ── The month: the runs list, then the run (only if there is one), and the server's count of
  //    undecided import rows for the month ──
  const [runs, setRuns] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [version, setVersion] = useState(0);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoadError('');
    try {
      const raw = await hrApi.runs();
      const all = Array.isArray(raw) ? raw : list(raw?.runs);
      if (mine !== seq.current) return;
      setRuns(all);
      const [d, dash] = await Promise.all([
        hrApi.run(month),
        hrApi.dashboard(month).catch(() => null),
      ]);
      if (mine !== seq.current) return;
      const hasServerPending = Boolean(d) && typeof d === 'object' && Object.prototype.hasOwnProperty.call(d, 'pending_import');
      if (hasServerPending) writePending(month, null);   // the server speaks for it now; drop the browser's note
      setDetail({
        month,
        run: d?.run && typeof d.run === 'object' ? d.run : null,
        lines: list(d?.lines),
        inputs: list(d?.inputs),
        hasServerPending,
        missing: Array.isArray(d?.missing) ? d.missing : null,
        serverPending: d?.pending_import && typeof d.pending_import === 'object' ? d.pending_import : null,
        unresolved: Number(dash?.exceptions?.unresolved_import_rows) || 0,
      });
      setVersion(v => v + 1);
    } catch (e) {
      if (mine === seq.current) setLoadError(refusalText(e));
    }
  }, [month]);
  useEffect(() => { load(); }, [load]);

  const here = detail?.month === month ? detail : null;
  const run = here?.run ?? null;
  const lines = useMemo(() => (here ? here.lines : []), [here]);
  const inputs = useMemo(() => (here ? here.inputs : []), [here]);
  const status = run ? (run.status || 'draft') : 'none';
  const rank = RANK[status] ?? 0;
  const final = status === 'finalised';
  const linesById = useMemo(() => new Map(lines.map(l => [String(l.person_id), l])), [lines]);
  const inputsById = useMemo(() => new Map(inputs.map(i => [String(i.person_id), i])), [inputs]);
  const nameOf = useCallback(id => {
    const k = String(id);
    const l = linesById.get(k);
    return l?.name ?? l?.person_name ?? peopleById.get(k)?.name ?? `Person #${k}`;
  }, [linesById, peopleById]);

  // ── An upload of this month's sheet that is not applied yet ──
  const [pending, setPending] = useState(null);
  const checkPending = useCallback(async () => {
    const id = readPending()[month];
    if (id == null) { setPending(null); return; }
    try {
      const d = await hrApi.importBatch(id);
      const st = d?.batch?.status;
      if (st && st !== 'parsed') { writePending(month, null); setPending(null); return; }
      setPending({ month, id, batch: d?.batch || {}, summary: batchSummary(d) });
    } catch {
      writePending(month, null);
      setPending(null);
    }
  }, [month]);
  useEffect(() => { checkPending(); }, [checkPending]);
  const sp = here?.serverPending;
  const fromServer = sp ? {
    month, id: sp.batch_id ?? sp.id ?? null, batch: sp,
    summary: { todo: Number(sp.unresolved ?? sp.unresolved_rows ?? sp.todo) || 0 },
    earlier: Math.max(0, (Number(sp.parsed_uploads) || 1) - 1),
  } : null;
  const pend = here?.hasServerPending ? fromServer : ((pending?.month === month ? pending : null) || fromServer);
  const [ackUploads, setAckUploads] = useState(false);
  useEffect(() => { setAckUploads(false); }, [month]);

  // ── Who did what: the run's own names, else the HR audit log (approver and up), else "you" ──
  const [auditNames, setAuditNames] = useState({ key: null, map: new Map() });
  const auditKey = run?.id != null ? `${run.id}:${run.status}` : null;
  useEffect(() => {
    if (!run || !canApprove || auditNames.key === auditKey) return undefined;
    const missing = BY_FIELDS.some(k => run[k] != null && !run[`${k}_name`]);
    if (!missing) return undefined;
    let live = true;
    hrApi.audit('run', run.id).then(rows => {
      if (!live) return;
      const map = new Map();
      for (const a of list(rows)) if (a?.user_id != null && a.user_name) map.set(String(a.user_id), a.user_name);
      setAuditNames({ key: auditKey, map });
    }, () => { if (live) setAuditNames({ key: auditKey, map: new Map() }); });
    return () => { live = false; };
  }, [run, canApprove, auditKey, auditNames.key]);
  const who = useCallback((id, explicit) => {
    if (id == null && !explicit) return '';
    if (id != null && me?.user?.id != null && String(me.user.id) === String(id)) return 'you';
    if (explicit) return explicit;
    return auditNames.map.get(String(id)) || `user #${id}`;
  }, [me, auditNames]);
  const by = (field, at) => [run?.[field] != null || run?.[`${field}_name`] ? `by ${who(run[field], run[`${field}_name`])}` : '', whenText(run?.[at])].filter(Boolean).join(' · ');

  // ── Previous finalised month: compared in the drawer ──
  const prevMonth = useMemo(() => list(runs)
    .filter(r => r?.status === 'finalised' && String(r.month).slice(0, 7) < month)
    .map(r => String(r.month).slice(0, 7)).sort().pop() || null, [runs, month]);
  const prevCache = useRef(new Map());
  const loadPrevious = useCallback(() => {
    if (!prevMonth) return Promise.resolve(null);
    if (!prevCache.current.has(prevMonth)) {
      prevCache.current.set(prevMonth, hrApi.run(prevMonth).catch(e => { prevCache.current.delete(prevMonth); throw e; }));
    }
    return prevCache.current.get(prevMonth);
  }, [prevMonth]);
  const laterFinal = list(runs).some(r => r?.status === 'finalised' && String(r.month).slice(0, 7) > month);
  const monthClosed = !run && laterFinal;

  // ── Register rows ──
  const rows = useMemo(() => lines.map(l => {
    const id = String(l.person_id);
    const p = peopleById.get(id);
    const flags = flagsOf(l);
    return {
      id, line: l, person: p, input: inputsById.get(id), flags,
      name: l.name ?? l.person_name ?? p?.name ?? `Person #${id}`,
      code: l.code ?? l.person_code ?? p?.code ?? '',
      department: l.department ?? p?.department ?? '',
      channel: l.pay_channel ?? null,
      channelLabel: channelLabel(l.pay_channel),
      blocked: flags.some(f => levelOf(f) === 'block'),
      warned: flags.some(f => levelOf(f) === 'warn'),
      // Merged on screen so the columns add up to gross and to the deductions; split in the export.
      misc: sumPaise([l.misc_earning, l.bonus, l.adj_earnings]),
      other: sumPaise([l.misc_deduction, l.adj_deductions]),
      payment: payStatus(l),
    };
  }), [lines, peopleById, inputsById, channelLabel]);
  const blockedCount = rows.filter(r => r.blocked).length;
  const warnCount = rows.filter(r => !r.blocked && r.warned).length;

  // Every flag on the lines, by level and code, with the people who carry it.
  const exceptions = useMemo(() => {
    const levels = { block: new Map(), warn: new Map(), info: new Map() };
    for (const r of rows) {
      for (const f of r.flags) {
        const m = levels[levelOf(f)];
        const code = f.code || 'FLAG';
        if (!m.has(code)) m.set(code, { code, ids: [] });
        const e = m.get(code);
        if (!e.ids.includes(r.id)) e.ids.push(r.id);
      }
    }
    const out = {};
    for (const [lvl, m] of Object.entries(levels)) out[lvl] = [...m.values()].sort((a, b) => b.ids.length - a.ids.length);
    return out;
  }, [rows]);
  const peopleWith = lvl => new Set(exceptions[lvl].flatMap(e => e.ids)).size;

  const leftOut = useMemo(() => inputs.filter(i => i.include === false)
    .map(i => ({ id: String(i.person_id), name: nameOf(i.person_id) })), [inputs, nameOf]);
  // Active people with a pay setup in force who have no input row and no line. people[].current_setup is
  // the setup in force this calendar month, so for an earlier month this is a hint, not a verdict; the
  // server decides at Submit.
  // The server's own list when it sends one (people due this month — active, or leaving inside it — with a
  // setup and no input row: exactly what Submit checks); else worked out from the people list.
  const serverMissing = here?.missing ?? null;
  const notInRun = useMemo(() => {
    if (!run) return [];
    if (serverMissing) return serverMissing.map(p => ({ id: String(p.person_id ?? p.id), name: p.name }));
    const inRun = new Set([...inputs.map(i => String(i.person_id)), ...lines.map(l => String(l.person_id))]);
    return people.filter(p => p.status === 'active' && p.current_setup && !inRun.has(String(p.id))
      && String(p.current_setup.effective_from ?? '').slice(0, 7) <= month
      && (!p.joined_on || String(p.joined_on).slice(0, 7) <= month))
      .map(p => ({ id: String(p.id), name: p.name }));
  }, [run, inputs, lines, people, month, serverMissing]);

  // ── Filters ──
  const [q, setQ] = useState('');
  const [view, setView] = useState('all');
  const [focus, setFocus] = useState(null); // Set of person ids named by a refusal
  const [groupBy, setGroupBy] = useState('none');
  useEffect(() => { setView('all'); setFocus(null); setQ(''); }, [month]);
  const filtered = useMemo(() => rows.filter(r => {
    if (focus && !focus.has(r.id)) return false;
    if (view === 'blocked' && !r.blocked) return false;
    if (view === 'warn' && !(r.warned && !r.blocked)) return false;
    if (view === 'clean' && (r.blocked || r.warned)) return false;
    if (view.startsWith('flag:') && !r.flags.some(f => (f.code || 'FLAG') === view.slice(5))) return false;
    if (view.startsWith('pay:') && !(owes(r.line) && r.payment === view.slice(4))) return false;
    if (!q.trim()) return true;
    return rowMatches({ name: r.name, code: r.code, department: r.department, channel: r.channelLabel },
      q, r.flags.map(f => flagLabel(f.code)).join(' '));
  }), [rows, view, focus, q]);

  const totalRow = useMemo(() => {
    const sum = pick => sumPaise(filtered.map(pick));
    return {
      id: '__total', _total: true, count: filtered.length, name: 'Total', code: '', department: '', channelLabel: '',
      sums: {
        basic: sum(r => r.line.basic), ot: sum(r => r.line.ot_amount), holiday: sum(r => r.line.holiday_amount),
        misc: sum(r => r.misc), gross: sum(r => r.line.gross), advance: sum(r => r.line.advance_recovery),
        loan: sum(r => r.line.loan_recovery), other: sum(r => r.other), net: sum(r => r.line.net),
        paid_sep: sum(r => r.line.paid_separately), payable: sum(r => r.line.payable),
      },
      otHours: sumQty(filtered.map(r => r.input?.ot_hours)),
      blockedN: filtered.filter(r => r.blocked).length,
      warnN: filtered.filter(r => !r.blocked && r.warned).length,
      paidN: filtered.filter(r => owes(r.line) && r.payment === 'paid').length,
      dueN: filtered.filter(r => owes(r.line)).length,
    };
  }, [filtered]);
  const showPaidSep = rows.some(r => (paiseOf(r.line.paid_separately) ?? 0n) !== 0n);

  // ── The drawer ──
  const [drawer, setDrawer] = useState(null);
  const drawerKey = useRef(0);
  const openDrawer = useCallback(id => setDrawer({ id: String(id), key: ++drawerKey.current }), []);
  const [variance, setVariance] = useState({ key: null, map: new Map() });
  const varianceKey = `${month}:${version}`;
  useEffect(() => {
    if (!drawer || !run || !prevMonth || variance.key === varianceKey) return undefined;
    let live = true;
    hrApi.variance(month).then(v => {
      if (live) setVariance({ key: varianceKey, map: new Map(list(v).map(x => [String(x?.person_id), x])) });
    }, () => { if (live) setVariance({ key: varianceKey, map: new Map() }); });
    return () => { live = false; };
  }, [drawer, run, prevMonth, month, varianceKey, variance.key]);

  // ── Register columns ──
  const columns = useMemo(() => {
    const money = (key, label, pick, { card = 'detail', strong = false } = {}) => ({
      key, label, align: 'right', card,
      sortValue: r => (r._total ? null : sortNum(pick(r))),
      render: r => (
        <span className={`whitespace-nowrap ${strong || r._total ? 'font-bold text-[#1D1D1F]' : ''}`}>
          {inr2(r._total ? r.sums[key] : pick(r))}
        </span>
      ),
      export: r => inr2(r._total ? r.sums[key] : pick(r)),
    });
    const splitTitle = (parts) => parts.filter(([, v]) => (paiseOf(v) ?? 0n) !== 0n).map(([l, v]) => `${l} ${inr2(v)}`).join(' + ');
    return [
      { key: 'name', label: 'Name', card: 'title', sortValue: r => r.name, export: r => (r._total ? 'Total' : r.name),
        render: r => (r._total ? (
          <span className="whitespace-nowrap font-bold text-[#1D1D1F]">Total · {plural(r.count, 'person', 'people')}</span>
        ) : (
          <button type="button" onClick={() => openDrawer(r.id)} className="block max-w-[220px] text-left">
            <span className="block truncate text-sm font-semibold text-[#1D1D1F] hover:text-[#007AFF]">{r.name}</span>
            {r.code && <span className="block truncate font-mono text-[11px] text-[#86868B]">{r.code}</span>}
          </button>
        )) },
      { key: 'department', label: 'Department', card: 'subtitle', render: r => (r._total ? '' : r.department || '—') },
      { key: 'channel', label: 'Channel', card: 'detail', sortValue: r => r.channelLabel, render: r => (r._total ? '' : r.channelLabel || '—') },
      { key: 'present', label: 'Present', align: 'right', card: 'metric', sortValue: r => (r._total ? null : Number(r.line.present_days)),
        render: r => (r._total ? '' : qtyText(r.line.present_days)) },
      { key: 'ot_h', label: 'OT h', align: 'right', card: 'detail', sortValue: r => (r._total ? null : Number(r.input?.ot_hours ?? 0)),
        render: r => (r._total ? <span className="font-bold">{r.otHours}</span> : qtyText(r.input?.ot_hours)) },
      money('basic', 'Basic', r => r.line.basic),
      money('ot', 'OT', r => r.line.ot_amount),
      money('holiday', 'Holiday', r => r.line.holiday_amount),
      { ...money('misc', 'Misc', r => r.misc),
        render: r => {
          const parts = r._total ? '' : splitTitle([['Misc', r.line.misc_earning], ['Bonus', r.line.bonus], ['Adjustments', r.line.adj_earnings]]);
          return (
            <span title={parts || undefined} className={`whitespace-nowrap ${r._total ? 'font-bold text-[#1D1D1F]' : ''}`}>
              {inr2(r._total ? r.sums.misc : r.misc)}
              {!r._total && ((paiseOf(r.line.bonus) ?? 0n) !== 0n || (paiseOf(r.line.adj_earnings) ?? 0n) !== 0n) && <sup className="ml-0.5 text-[#0064D2]">+</sup>}
            </span>
          );
        } },
      money('gross', 'Gross', r => r.line.gross, { card: 'metric', strong: true }),
      money('advance', 'Advance', r => r.line.advance_recovery),
      money('loan', 'Loan', r => r.line.loan_recovery),
      { ...money('other', 'Other', r => r.other),
        render: r => (
          <span className={`whitespace-nowrap ${r._total ? 'font-bold text-[#1D1D1F]' : ''}`}
            title={r._total ? undefined : splitTitle([['Misc deduction', r.line.misc_deduction], ['Adjustments', r.line.adj_deductions]]) || undefined}>
            {inr2(r._total ? r.sums.other : r.other)}
          </span>
        ) },
      money('net', 'Net', r => r.line.net, { card: 'metric' }),
      ...(showPaidSep ? [money('paid_sep', 'Paid sep.', r => r.line.paid_separately)] : []),
      money('payable', 'Payable', r => r.line.payable, { card: 'metric', strong: true }),
      ...(final ? [{ key: 'payment', label: 'Payment', card: 'detail', sortValue: r => r.payment,
        export: r => (r._total ? `${r.paidN} of ${r.dueN} paid` : owes(r.line) ? PAYMENT_STATUS[r.payment].label : 'Nothing to pay'),
        render: r => (r._total
          ? <span className="whitespace-nowrap text-[11px] font-bold text-[#515154]">{r.paidN} of {r.dueN} paid</span>
          : owes(r.line) ? <PaymentPill status={r.payment} /> : <span className="text-[11px] text-[#86868B]">Nothing to pay</span>) }] : []),
      { key: 'flags', label: 'Flags', card: 'status', sortValue: r => (r._total ? null : (r.blocked ? 1000 : 0) + r.flags.length),
        export: r => (r._total ? '' : r.flags.map(f => flagLabel(f.code)).join(', ')),
        render: r => (r._total ? (
          <span className="whitespace-nowrap text-[11px] font-bold">
            {r.blockedN > 0 && <span className="text-red-700">{r.blockedN} blocked</span>}
            {r.blockedN > 0 && r.warnN > 0 && ' · '}
            {r.warnN > 0 && <span className="text-amber-800">{r.warnN} warned</span>}
            {r.blockedN + r.warnN === 0 && <span className="text-emerald-700">clean</span>}
          </span>
        ) : <FlagDots flags={r.flags} />) },
    ];
  }, [openDrawer, showPaidSep, final]);

  // ── Export: every component in its own column; grouped views export one section per group ──
  const exportSpec = useCallback(sorted => {
    const shown = sorted.filter(r => !r._total);
    const m = (key, label) => ({ key: `x_${key}`, label, export: r => inr2(r.line[key]) });
    const exportCols = [
      { key: 'x_name', label: 'Name', export: r => r.name },
      { key: 'x_code', label: 'Code', export: r => r.code },
      { key: 'x_department', label: 'Department', export: r => r.department },
      { key: 'x_channel', label: 'Pay channel', export: r => r.channelLabel },
      { key: 'x_present', label: 'Present days', export: r => qtyText(r.line.present_days) },
      { key: 'x_ot_h', label: 'OT hours', export: r => qtyText(r.input?.ot_hours) },
      m('basic', 'Basic'), m('ot_amount', 'OT'), m('holiday_amount', 'Holiday'), m('misc_earning', 'Misc'),
      m('bonus', 'Bonus'), m('adj_earnings', 'Adjustments (earning)'), m('gross', 'Gross'),
      m('advance_recovery', 'Advance recovered'), m('loan_recovery', 'Loan recovered'), m('misc_deduction', 'Misc deduction'),
      m('adj_deductions', 'Adjustments (deduction)'), m('total_deductions', 'Total deductions'), m('net', 'Net'),
      m('paid_separately', 'Paid separately'), m('rounding', 'Rounding'), m('payable', 'Payable'),
      m('carried_advance', 'Advance carried forward'),
      ...(final ? [{ key: 'x_payment', label: 'Payment', export: r => (owes(r.line) ? PAYMENT_STATUS[r.payment].label : 'Nothing to pay') }] : []),
      { key: 'x_flags', label: 'Flags', export: r => r.flags.map(f => `${LEVEL_META[levelOf(f)].label}: ${flagLabel(f.code)}`).join('; ') },
    ];
    const pdfCols = columns.filter(c => c.key !== 'payment' || final);
    const totals = rs => [
      { label: 'People', value: rs.length },
      { label: 'Gross', value: inr2(sumPaise(rs.map(r => r.line.gross))) },
      { label: 'Deductions', value: inr2(sumPaise(rs.map(r => r.line.total_deductions))) },
      { label: 'Payable', value: inr2(sumPaise(rs.map(r => r.line.payable))) },
    ];
    let sections = [{ columns: exportCols, pdfColumns: pdfCols, rows: shown }];
    if (groupBy !== 'none') {
      const groups = new Map();
      for (const r of shown) {
        const label = groupBy === 'department' ? (r.department || 'No department') : (r.channelLabel || 'No pay channel');
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(r);
      }
      sections = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([heading, rs]) => ({ heading, columns: exportCols, pdfColumns: pdfCols, rows: rs, summary: totals(rs) }));
    }
    return {
      name: `HR Payroll register ${month}`,
      title: `Payroll register — ${monthLabel(month)}`,
      subtitle: `HR & Payroll · ${RUN_STATUS[status]?.label || status}`,
      meta: [
        view !== 'all' && `Showing: ${view.startsWith('flag:') ? flagLabel(view.slice(5)) : view.startsWith('pay:') ? PAYMENT_STATUS[view.slice(4)]?.label : view}`,
        focus && `${focus.size} people named by a refusal`,
        groupBy !== 'none' && `Grouped by ${groupBy}`,
        q.trim() && `Search: "${q.trim()}"`,
        `${shown.length} of ${plural(rows.length, 'person', 'people')}`,
      ],
      summary: totals(shown),
      sections,
    };
  }, [columns, final, groupBy, month, status, view, focus, q, rows.length]);

  const groupFn = groupBy === 'department' ? (r => (r._total ? null : `d:${r.department || ''}`))
    : groupBy === 'channel' ? (r => (r._total ? null : `c:${r.channel ?? ''}`)) : undefined;
  const renderGroup = members => {
    const first = members[0];
    const label = groupBy === 'department' ? (first?.department || 'No department') : (first?.channelLabel || 'No pay channel');
    const blocked = members.filter(r => r.blocked).length;
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[#3A3A3C]">
        <span className="font-bold text-[#1D1D1F]">{label}</span>
        <span>{plural(members.length, 'person', 'people')}</span>
        <span>Gross <b className="tabular-nums">{inr2(sumPaise(members.map(r => r.line.gross)))}</b></span>
        <span>Payable <b className="tabular-nums">{inr2(sumPaise(members.map(r => r.line.payable)))}</b></span>
        {blocked > 0 && <span className="font-bold text-red-700">{blocked} blocked</span>}
      </div>
    );
  };

  // ── Totals: the run's stored ones (exact strings), checked against its lines ──
  const totals = run?.totals && typeof run.totals === 'object' ? run.totals : {};
  const linesTotal = key => sumPaise(lines.map(l => l[key]));
  const kpi = key => (totals[key] != null ? totals[key] : linesTotal(key));
  const mismatch = ['gross', 'payable'].filter(k => totals[k] != null && linesTotal(k) != null
    && paiseOf(totals[k]) !== paiseOf(linesTotal(k)));
  const byChannel = useMemo(() => {
    const stored = list(run?.totals?.by_channel);
    if (stored.length) return stored.map(c => ({ code: c?.pay_channel ?? null, lines: c?.lines, payable: c?.payable, carried: c?.carried_advance }));
    const m = new Map();
    for (const l of lines) {
      const k = l.pay_channel ?? null;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(l);
    }
    return [...m.entries()].map(([code, ls]) => ({ code, lines: ls.length, payable: sumPaise(ls.map(l => l.payable)), carried: sumPaise(ls.map(l => l.carried_advance)) }));
  }, [run, lines]);

  // ── Actions ──
  const [dialog, setDialog] = useState(null); // { kind } | { kind:'pay', group }
  const [wizard, setWizard] = useState(null); // { key, resume }
  const [forget, setForget] = useState(false);
  const openWizard = resume => setWizard({ key: Date.now(), resume: resume ?? null });
  const serverTracks = Boolean(here?.hasServerPending);
  const onPending = useCallback(id => {
    if (!serverTracks) writePending(month, id);
    if (id == null) setPending(null);
  }, [month, serverTracks]);
  const [paying, setPaying] = useState(false);
  // A staff payment moves a balance a draft run recovers: work the run out again, then read it.
  const afterPayment = useCallback(async () => {
    if (run && status === 'draft' && canOperate) {
      try { await hrApi.recalcRun(month); } catch { /* refused — the central toast says why */ }
    }
    await load();
  }, [run, status, canOperate, month, load]);

  const recalc = async () => {
    try {
      await hrApi.recalcRun(month);
    } catch { return; } // refused — the central toast says why
    toast.success('Recalculated');
    await load();
  };

  const samePerson = run?.submitted_by != null && me?.user?.id != null && String(run.submitted_by) === String(me.user.id);
  const strict = settings?.strict_separation === true;

  const refusal = e => {
    const data = e?.data && typeof e.data === 'object' ? e.data : {};
    const ids = list(data.person_ids).map(String);
    const other = MONTH_RE.test(data.month || '') && data.month !== month ? data.month : null;
    return (
      <div className="mt-3 space-y-2">
        <InlineError message={refusalText(e)} className="" />
        {ids.length > 0 && (
          <p className="text-xs text-[#515154]">
            {ids.slice(0, 10).map(nameOf).join(', ')}{ids.length > 10 ? ` and ${ids.length - 10} more` : ''}.{' '}
            <button type="button" className="font-bold text-[#007AFF] hover:underline"
              onClick={() => { setFocus(new Set(ids)); setView('all'); setDialog(null); }}>
              Show {ids.length === 1 ? 'this line' : 'these lines'}
            </button>
          </p>
        )}
        {other && (
          <Button size="sm" variant="secondary" onClick={() => { setDialog(null); setMonth(other); }}>Open {monthLabel(other)}</Button>
        )}
      </div>
    );
  };

  // Why Submit waits (red stops it; the amber upload note stops it until ticked), and where the run is.
  const reasons = [];
  if (status === 'draft' || status === 'none') {
    if (pend) {
      const when = whenText(pend.batch?.uploaded_at);
      reasons.push({
        tone: 'red', key: 'pending',
        text: `${pend.summary.todo > 0
          ? `The sheet uploaded${when ? ` ${when}` : ''} has ${plural(pend.summary.todo, 'row')} still to resolve.`
          : `The sheet uploaded${when ? ` ${when}` : ''} is not applied yet.`} Apply it, or discard it if it is not being used.${pend.earlier
          ? ` ${plural(pend.earlier, 'earlier upload')} of this month ${pend.earlier === 1 ? 'is' : 'are'} not applied either; each shows here in turn.` : ''}`,
        actions: canOperate && (
          <span className="flex flex-wrap gap-1.5">
            {pend.id != null && <Button size="sm" onClick={() => openWizard(pend.id)}>Resume import</Button>}
            {pend.id != null && <Button size="sm" variant="ghost" onClick={() => setForget(true)}>Discard this upload</Button>}
          </span>
        ),
      });
    } else if ((here?.unresolved || 0) > 0 && status === 'draft') {
      reasons.push({
        tone: 'amber', key: 'uploads', ack: true,
        text: `${plural(here.unresolved, 'row')} in an upload for ${monthLabel(month)} ${here.unresolved === 1 ? 'is' : 'are'} still undecided. If that sheet belongs to this run, import the same file again to open it and finish it.`,
        actions: (
          <label className="flex items-center gap-1.5 text-[11px] font-bold">
            <input type="checkbox" className="h-4 w-4 accent-[#007AFF]" checked={ackUploads} onChange={e => setAckUploads(e.target.checked)} />
            Not for this run
          </label>
        ),
      });
    }
  }
  if (status === 'draft') {
    if (!lines.length) reasons.push({ tone: 'red', key: 'empty', text: 'Nothing to submit yet — import the month’s sheet first.' });
    if (blockedCount > 0) {
      const codes = exceptions.block.map(e => `${flagLabel(e.code)} ×${e.ids.length}`).join(', ');
      reasons.push({
        tone: 'red', key: 'blocked',
        text: `${plural(blockedCount, 'line')} ${blockedCount === 1 ? 'has' : 'have'} a blocking flag: ${codes}.`,
        actions: <Button size="sm" variant="secondary" onClick={() => { setView('blocked'); setFocus(null); }}>Show them</Button>,
      });
    }
    if (notInRun.length > 0) {
      reasons.push({
        tone: 'amber', key: 'notinrun',
        text: `${plural(notInRun.length, 'person', 'people')} with a pay setup ${notInRun.length === 1 ? 'is' : 'are'} not in this run (active, or leaving during ${monthLabel(month)}). Submit is refused until each is included or left out (listed under Exceptions).`,
      });
    }
    if (run?.sent_back_reason) {
      reasons.push({ tone: 'amber', key: 'sentback', text: `Sent back ${by('sent_back_by', 'sent_back_at')}: “${run.sent_back_reason}”` });
    }
  }
  if (status === 'submitted') {
    reasons.push({ tone: 'info', key: 's', text: `Submitted ${by('submitted_by', 'submitted_at')}. ${canApprove ? 'Check the exceptions and the register, then approve or send it back.' : 'Waiting for an approver.'}` });
  }
  if (status === 'approved') {
    reasons.push({ tone: 'info', key: 'a', text: `Approved ${by('approved_by', 'approved_at')}. ${canApprove ? 'Finalising locks the month and posts advances and loan recoveries.' : 'Waiting to be finalised.'}` });
  }
  if (final) {
    const due = lines.filter(owes);
    const paidN = due.filter(l => payStatus(l) === 'paid').length;
    reasons.push({ tone: paidN === due.length ? 'green' : 'info', key: 'f', text: `Finalised ${by('finalised_by', 'finalised_at')} — locked. ${paidN} of ${plural(due.length, 'person', 'people')} marked paid.` });
  }
  const submitBlocked = status !== 'draft' || reasons.some(r => r.tone === 'red') || reasons.some(r => r.ack && !ackUploads);

  // ── The steps ──
  const fromSheet = inputs.some(i => i.source === 'import');
  const latestCalc = lines.map(l => l.computed_at).filter(Boolean).sort().pop();
  const dueLines = lines.filter(owes);
  const paidLines = dueLines.filter(l => payStatus(l) === 'paid').length;
  const steps = [
    { key: 'upload', label: 'Upload', state: fromSheet || pend || rank >= 2 ? 'done' : rank >= 1 || canOperate ? 'current' : 'todo',
      sub: pend ? [pend.batch?.uploaded_at ? `uploaded ${whenText(pend.batch.uploaded_at)}` : 'uploaded, not applied', pend.batch?.uploaded_by != null ? `by ${who(pend.batch.uploaded_by, pend.batch.uploaded_by_name)}` : '']
        : [fromSheet ? 'From the sheet' : rank >= 2 ? 'Entered by hand' : 'Not yet'] },
    { key: 'review', label: 'Review', state: pend ? (pend.summary.todo > 0 ? 'blocked' : 'current') : fromSheet || rank >= 2 ? 'done' : 'todo',
      sub: pend ? [pend.summary.todo > 0 ? `${pend.summary.todo} to resolve` : 'Ready to apply'] : [fromSheet ? 'Applied' : ''] },
    { key: 'check', label: 'Check', state: !lines.length ? (rank === 1 ? 'current' : 'todo') : blockedCount > 0 ? 'blocked' : 'done',
      sub: !lines.length ? ['No lines yet'] : [blockedCount > 0 ? `${blockedCount} blocked` : warnCount > 0 ? `${plural(warnCount, 'warning')}` : 'All clear', latestCalc ? `worked out ${whenText(latestCalc)}` : ''] },
    { key: 'submit', label: 'Submit', state: rank >= 2 ? 'done' : rank === 1 ? 'current' : 'todo',
      sub: rank >= 2 ? [by('submitted_by', 'submitted_at')] : [run?.sent_back_reason && rank === 1 ? `sent back ${whenText(run.sent_back_at)}` : ''] },
    { key: 'approve', label: 'Approve', state: rank >= 3 ? 'done' : rank === 2 ? 'current' : 'todo', sub: rank >= 3 ? [by('approved_by', 'approved_at')] : [] },
    { key: 'finalise', label: 'Finalise', state: rank >= 4 ? 'done' : rank === 3 ? 'current' : 'todo', sub: rank >= 4 ? [by('finalised_by', 'finalised_at')] : [] },
    { key: 'pay', label: 'Pay', state: rank >= 4 ? (paidLines === dueLines.length ? 'done' : 'current') : 'todo',
      sub: rank >= 4 ? [`${paidLines} of ${dueLines.length} paid`, whenText(dueLines.map(l => l.paid_at || l.paid_on).filter(Boolean).sort().pop())] : [] },
  ];

  // ── Render ──
  const miniTotals = [
    ['People', String(totals.lines ?? lines.length)],
    ['Gross', inr2(kpi('gross'))],
    ['Deductions', inr2(kpi('total_deductions'))],
    ['Payable', inr2(kpi('payable'))],
  ];
  const activeFlag = view.startsWith('flag:') ? view.slice(5) : null;
  const drawerPerson = drawer ? peopleById.get(drawer.id) : null;

  return (
    <div>
      {/* ── Month bar ── */}
      <section className="glass mb-3 rounded-[22px] border border-white/70 p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <button type="button" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}
              className="flex h-9 w-9 items-center justify-center rounded-full text-[#515154] hover:bg-[#1D1D1F]/[0.05] hover:text-[#1D1D1F]">
              <ChevronLeft size={17} />
            </button>
            <Input type="month" aria-label="Payroll month" value={month} className="!w-[168px]"
              onChange={e => setMonth(e.target.value)} />
            <button type="button" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}
              className="flex h-9 w-9 items-center justify-center rounded-full text-[#515154] hover:bg-[#1D1D1F]/[0.05] hover:text-[#1D1D1F]">
              <ChevronRight size={17} />
            </button>
          </div>
          <h2 className="text-lg font-extrabold tracking-[-0.03em] text-[#1D1D1F]">{monthLabel(month)}</h2>
          <RunChip status={status} />
          {status === 'draft' && run?.sent_back_reason && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700">Sent back</span>}
          {month !== thisMonth && <Button size="sm" variant="ghost" onClick={() => setMonth(thisMonth)}>This month</Button>}
          <button type="button" aria-label="Reload" title="Reload" onClick={() => { load(); checkPending(); }}
            className="flex h-8 w-8 items-center justify-center rounded-full text-[#86868B] hover:bg-[#1D1D1F]/[0.05] hover:text-[#1D1D1F]">
            <RefreshCw size={14} />
          </button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {(status === 'none' || status === 'draft') && canOperate && !monthClosed && (
              <Button variant="secondary" onClick={() => openWizard(null)}><FileUp size={14} /> {pend ? 'Import a new sheet' : 'Import sheet'}</Button>
            )}
            {canOperate && <Button variant="secondary" onClick={() => setPaying(true)}><HandCoins size={14} /> Pay staff</Button>}
            {status === 'draft' && canOperate && <Button variant="secondary" onClick={recalc}><Calculator size={14} /> Recalculate</Button>}
            {status === 'draft' && canOperate && (
              <Button onClick={() => setDialog({ kind: 'submit' })} disabled={submitBlocked}><Send size={14} /> Submit for approval</Button>
            )}
            {(status === 'submitted' || status === 'approved') && canApprove && (
              <Button variant="secondary" onClick={() => setDialog({ kind: 'sendback' })}><CornerUpLeft size={14} /> Send back</Button>
            )}
            {status === 'submitted' && canApprove && (
              <Button onClick={() => setDialog({ kind: 'approve' })}><ShieldCheck size={14} /> Approve</Button>
            )}
            {status === 'approved' && canApprove && (
              <Button onClick={() => setDialog({ kind: 'finalise' })}><Lock size={14} /> Finalise</Button>
            )}
          </div>
        </div>
        <div className="mt-4 border-t border-[#1D1D1F]/[0.06] pt-4">
          <Stepper steps={steps} />
        </div>
        {reasons.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {status === 'draft' && submitBlocked && canOperate && (
              <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-red-700">Submit waits for:</p>
            )}
            {reasons.map(r => <Reason key={r.key} tone={r.tone} actions={r.actions}>{r.text}</Reason>)}
          </div>
        )}
      </section>

      {loadError && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" />
          <span className="min-w-0 flex-1">Couldn’t load {monthLabel(month)} — {loadError}</span>
          <Button size="sm" variant="secondary" onClick={load}>Try again</Button>
        </div>
      )}

      {!here && !loadError && <div className="p-8 text-sm text-slate-400">Loading {monthLabel(month)}…</div>}

      {here && !run && (
        <div className="glass rounded-[22px] border border-white/70 p-8 text-center shadow-card">
          <p className="text-base font-bold tracking-[-0.01em] text-[#1D1D1F]">No payroll for {monthLabel(month)} yet.</p>
          {monthClosed ? (
            <p className="mt-1 text-xs text-[#6E6E73]">
              A later month is already finalised, so this month cannot be started. Corrections go into the next open month as adjustments.
            </p>
          ) : canOperate ? (
            <>
              <p className="mt-1 text-xs text-[#6E6E73]">
                Import the month’s sheet: its rows are matched to people and checked, and nothing is applied until you say so.
              </p>
              <Button className="mt-4" onClick={() => openWizard(null)}><FileUp size={14} /> Import the sheet</Button>
            </>
          ) : (
            <p className="mt-1 text-xs text-[#6E6E73]">Nothing has been prepared for this month yet.</p>
          )}
        </div>
      )}

      {here && run && (
        <>
          <KpiRow cols={5}>
            <KpiCard compact label="People" value={String(totals.lines ?? lines.length)}
              sub={blockedCount ? `${blockedCount} blocked · ${plural(warnCount, 'warning')}` : warnCount ? plural(warnCount, 'warning') : 'no flags to clear'} />
            <KpiCard compact label="Gross" value={inr2(kpi('gross'))} sub="earnings before deductions" />
            <KpiCard compact label="Deductions" value={inr2(kpi('total_deductions'))}
              sub={`advance ${inr2(kpi('advance_recovery'))} · loans ${inr2(kpi('loan_recovery'))}`} />
            <KpiCard compact label="Payable" value={inr2(kpi('payable'))}
              sub={(paiseOf(kpi('paid_separately')) ?? 0n) !== 0n ? `after ${inr2(kpi('paid_separately'))} paid separately` : 'to pay this month'} />
            <KpiCard compact label="Advance carried forward" value={inr2(kpi('carried_advance'))} sub="balance after this month" />
          </KpiRow>
          {mismatch.length > 0 && (
            <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-800">
              The run’s stored {mismatch.join(' and ')} differ{mismatch.length === 1 ? 's' : ''} from its lines added up
              ({mismatch.map(k => `${k}: stored ${inr2(totals[k])}, lines ${inr2(linesTotal(k))}`).join('; ')}).
              {status === 'draft' ? ' Recalculate the run.' : ' Tell whoever looks after the system.'}
            </div>
          )}

          {/* ── Exceptions ── */}
          <section className="glass mb-3 rounded-[22px] border border-white/70 p-4 shadow-card">
            <div className="flex flex-wrap items-center gap-2">
              <AlertTriangle size={15} className="text-[#6E6E73]" />
              <h3 className="text-sm font-bold tracking-[-0.01em] text-[#1D1D1F]">Exceptions</h3>
              {activeFlag && (
                <button type="button" onClick={() => setView('all')} className="ml-auto text-[11px] font-bold text-[#007AFF] hover:underline">Show every line</button>
              )}
            </div>
            {exceptions.block.length + exceptions.warn.length + exceptions.info.length === 0 && !leftOut.length && !notInRun.length ? (
              <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700"><Check size={13} /> No exceptions — every line worked out cleanly.</p>
            ) : (
              ['block', 'warn', 'info'].map(lvl => exceptions[lvl].length > 0 && (
                <div key={lvl} className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className={`mr-1 inline-flex items-center gap-1.5 text-xs font-bold ${LEVEL_META[lvl].ink}`}>
                    <span aria-hidden className={`h-2 w-2 rounded-full ${LEVEL_META[lvl].dot}`} />
                    {plural(peopleWith(lvl), 'person', 'people')} · {LEVEL_META[lvl].plural}
                  </span>
                  {exceptions[lvl].map(e => (
                    <FilterChip key={e.code} label={flagLabel(e.code)} count={e.ids.length} dot={LEVEL_META[lvl].dot}
                      on={activeFlag === e.code}
                      title={e.ids.slice(0, 15).map(nameOf).join(', ') + (e.ids.length > 15 ? ` and ${e.ids.length - 15} more` : '')}
                      onClick={() => { setFocus(null); setView(v => (v === `flag:${e.code}` ? 'all' : `flag:${e.code}`)); }} />
                  ))}
                </div>
              ))
            )}
            {leftOut.length > 0 && <PeopleLine label="Left out this month" people={leftOut} onOpen={openDrawer} />}
            {notInRun.length > 0 && (
              <PeopleLine tone="amber" label="Due this month with a pay setup, not in this run" people={notInRun} onOpen={openDrawer}
                hint={status === 'draft' && canOperate ? 'Open a name to include them (no OT, no absence, or the figures you type) or leave them out — Submit is refused until each is decided.' : undefined} />
            )}
          </section>

          {final && (
            <PaymentsPanel lines={lines} channelLabel={channelLabel} canOperate={canOperate} nameOf={nameOf}
              onPay={g => setDialog({ kind: 'pay', group: g })} onOpen={openDrawer} />
          )}

          {/* ── Register ── */}
          <FilterRail className="mb-2">
            <FilterGroup label="Lines" divider={false}>
              <FilterChip label="All" count={rows.length} on={view === 'all' && !focus} onClick={() => { setView('all'); setFocus(null); }} />
              <FilterChip label="Blocked" count={blockedCount} dot="bg-red-500" on={view === 'blocked'}
                tone="border-red-300 bg-red-100 text-red-800" onClick={() => setView(v => (v === 'blocked' ? 'all' : 'blocked'))} />
              <FilterChip label="Warnings" count={warnCount} dot="bg-amber-500" on={view === 'warn'}
                tone="border-amber-300 bg-amber-100 text-amber-800" onClick={() => setView(v => (v === 'warn' ? 'all' : 'warn'))} />
              <FilterChip label="Clean" count={rows.length - blockedCount - warnCount} on={view === 'clean'}
                tone="border-emerald-300 bg-emerald-100 text-emerald-800" onClick={() => setView(v => (v === 'clean' ? 'all' : 'clean'))} />
            </FilterGroup>
            {final && (
              <FilterGroup label="Payment">
                {['pending', 'paid', 'failed', 'reversed'].map(s => (
                  <FilterChip key={s} label={PAYMENT_STATUS[s].label} count={rows.filter(r => owes(r.line) && r.payment === s).length}
                    on={view === `pay:${s}`} onClick={() => setView(v => (v === `pay:${s}` ? 'all' : `pay:${s}`))} />
                ))}
              </FilterGroup>
            )}
            {activeFlag && (
              <FilterGroup label="Flag">
                <FilterChip label={`${flagLabel(activeFlag)} ×`} on onClick={() => setView('all')} />
              </FilterGroup>
            )}
            {focus && (
              <FilterGroup label="Named by the server">
                <FilterChip label={`${plural(focus.size, 'person', 'people')} ×`} on onClick={() => setFocus(null)} />
              </FilterGroup>
            )}
            <div className="ml-auto flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.07em] text-[#1D1D1F]/35">Group</span>
              <SubTabs active={groupBy} onChange={setGroupBy}
                views={[{ key: 'none', label: 'None' }, { key: 'department', label: 'Department' }, { key: 'channel', label: 'Channel' }]} />
            </div>
          </FilterRail>
          <DataTable
            columns={columns}
            rows={filtered.length ? [totalRow, ...filtered] : []}
            getRowId={r => r.id}
            pinTop={r => r._total === true}
            serialNumber={false}
            dense
            rowClass={r => (r._total ? '!bg-[#0A84FF]/[0.07]' : r.blocked ? '!bg-red-50/70' : '')}
            onRowClick={r => { if (!r._total) openDrawer(r.id); }}
            searchValue={q}
            onSearchChange={setQ}
            searchPlaceholder="Search name, code, department, channel or flag…"
            defaultSort={{ key: 'name', dir: 'asc' }}
            groupBy={groupFn}
            renderGroupHeader={groupFn ? renderGroup : undefined}
            exportName={`HR Payroll register ${month}`}
            exportSpec={exportSpec}
            empty={lines.length ? 'No line matches these filters.' : 'No lines yet — import the sheet, or recalculate the run.'}
          />
        </>
      )}

      {/* ── Dialogs ── */}
      {dialog?.kind === 'submit' && (
        <ActionDialog title={`Submit ${monthLabel(month)} for approval`} confirmLabel="Submit" refusal={refusal}
          onClose={() => setDialog(null)}
          onConfirm={async () => { await hrApi.submitRun(month); toast.success(`${monthLabel(month)} submitted for approval`); await load(); }}>
          <p>The inputs freeze, and the approvers are told (the notice carries no amounts).</p>
          <MiniTotals items={miniTotals} />
          {warnCount > 0 && <p className="text-xs font-semibold text-amber-800">{plural(warnCount, 'line')} carry warnings; they stay on the lines for the approver to see.</p>}
          {notInRun.length > 0 && (
            <p className="text-xs font-semibold text-amber-800">
              {plural(notInRun.length, 'active person', 'active people')} with a pay setup {notInRun.length === 1 ? 'is' : 'are'} not in this run
              ({notInRun.slice(0, 6).map(p => p.name).join(', ')}{notInRun.length > 6 ? '…' : ''}). The server refuses until each is decided.
            </p>
          )}
        </ActionDialog>
      )}
      {dialog?.kind === 'approve' && (
        <ActionDialog title={`Approve ${monthLabel(month)}`} confirmLabel="Approve" refusal={refusal}
          disabled={samePerson && strict} onClose={() => setDialog(null)}
          onConfirm={async () => {
            const res = await hrApi.approveRun(month);
            toast.success(`${monthLabel(month)} approved`);
            if (res?.warning) toast.info(`Note: ${res.warning}`);
            await load();
          }}>
          <p>Submitted {by('submitted_by', 'submitted_at')}. Approving records your decision; finalising is a separate step.</p>
          <MiniTotals items={miniTotals} />
          {warnCount > 0 && <p className="text-xs font-semibold text-amber-800">{plural(warnCount, 'line')} carry warnings — see Exceptions before approving.</p>}
          {samePerson && !strict && (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
              You submitted this run yourself. If you approve it too, nobody else will have checked it.
            </p>
          )}
          {samePerson && strict && (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
              Strict separation of duties is on, and you submitted this run: someone else must approve it.
            </p>
          )}
        </ActionDialog>
      )}
      {dialog?.kind === 'sendback' && <SendBackDialog month={month} refusal={refusal} onClose={() => setDialog(null)}
        onDone={async () => { toast.success(`${monthLabel(month)} sent back to draft`); await load(); }} />}
      {dialog?.kind === 'finalise' && (
        <ActionDialog title={`Finalise ${monthLabel(month)}`} confirmLabel="Finalise and lock" refusal={refusal}
          onClose={() => setDialog(null)}
          onConfirm={async () => { await hrApi.finaliseRun(month); toast.success(`${monthLabel(month)} finalised`); await load(); }}>
          <p>
            This locks the month for good: the lines are recomputed against today’s balances, and if anything moved
            since approval it is refused. Advances and loan recoveries are then posted, once. Corrections after this
            go into next month as adjustments.
          </p>
          <div className="overflow-x-auto rounded-2xl border border-white/75 bg-white/55">
            <table className="w-full text-xs">
              <thead>
                <tr className="ci-table-head">
                  <th className="px-2.5 py-2 text-left">Pay channel</th>
                  <th className="px-2.5 py-2 text-right">People</th>
                  <th className="px-2.5 py-2 text-right">Payable</th>
                  <th className="px-2.5 py-2 text-right">Advance carried</th>
                </tr>
              </thead>
              <tbody>
                {byChannel.map(c => (
                  <tr key={c.code ?? 'none'} className="ci-table-row">
                    <td className="px-2.5 py-2 font-semibold text-[#1D1D1F]">{c.code ? channelLabel(c.code) : <span className="text-amber-700">No pay channel</span>}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{c.lines ?? '—'}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{inr2(c.payable)}</td>
                    <td className="px-2.5 py-2 text-right tabular-nums">{inr2(c.carried)}</td>
                  </tr>
                ))}
                <tr className="border-t border-[#1D1D1F]/[0.08] bg-white/60">
                  <td className="px-2.5 py-2 font-bold text-[#1D1D1F]">Total</td>
                  <td className="px-2.5 py-2 text-right font-bold tabular-nums">{totals.lines ?? lines.length}</td>
                  <td className="px-2.5 py-2 text-right font-bold tabular-nums">{inr2(kpi('payable'))}</td>
                  <td className="px-2.5 py-2 text-right font-bold tabular-nums">{inr2(kpi('carried_advance'))}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-[#515154]">
            Posted at finalise: new advances {inr2(kpi('advance_given'))} · advance recovered {inr2(kpi('advance_recovery'))} ·
            loan instalments recovered {inr2(kpi('loan_recovery'))}.
          </p>
          {byChannel.some(c => !c.code) && (
            <p className="text-xs font-semibold text-amber-800">Some lines have no pay channel — they will have to be marked paid one by one.</p>
          )}
        </ActionDialog>
      )}
      {dialog?.kind === 'pay' && (
        <PayDialog month={month} group={dialog.group} label={channelLabel(dialog.group.code)} kind={channelBy.get(dialog.group.code)?.kind}
          nameOf={nameOf} onClose={() => setDialog(null)}
          onDone={async n => { setDialog(null); toast.success(`${plural(n, 'person', 'people')} marked paid`); await load(); }} />
      )}

      <ConfirmDialog open={forget} onClose={() => setForget(false)}
        onConfirm={async () => {
          if (pend?.id == null) return;
          await hrApi.discardImport(pend.id);          // a refusal keeps the dialog open; the central toast says why
          writePending(month, null);
          setPending(null);
          setAckUploads(false);
          toast.success('Upload discarded');
          await load();
        }}
        title="Discard this upload?" confirmLabel="Discard upload" danger
        message="The upload is set aside: nothing from it reaches the payroll, Submit no longer waits for it, and the same file can be uploaded again later. Inputs already applied from an earlier sheet are not touched." />

      {paying && (
        <PayStaffModal people={people} channels={channels} onClose={() => setPaying(false)} onDone={afterPayment} />
      )}

      {wizard && (
        <ImportWizard key={wizard.key} month={month} run={run} inputs={inputs} people={people} channelLabel={channelLabel}
          canEdit={canOperate} resumeBatchId={wizard.resume}
          onClose={() => { setWizard(null); checkPending(); load(); }}
          onPending={onPending}
          onApplied={() => { load(); }} />
      )}

      {drawer && (
        <RunLineDrawer key={drawer.key} month={month} run={run} personId={drawer.id}
          person={drawerPerson} line={linesById.get(drawer.id) ?? null} input={inputsById.get(drawer.id) ?? null}
          channelLabel={channelLabel} level={level}
          variance={variance.key === varianceKey ? variance.map.get(drawer.id) ?? null : null}
          prevMonth={prevMonth} loadPrevious={loadPrevious} people={people} channels={channels}
          onClose={() => setDrawer(null)} onChanged={load} />
      )}
    </div>
  );
}

function SendBackDialog({ month, refusal, onClose, onDone }) {
  const [reason, setReason] = useState('');
  return (
    <ActionDialog title={`Send ${monthLabel(month)} back to draft`} confirmLabel="Send back" variant="danger" refusal={refusal}
      disabled={!reason.trim()} onClose={onClose}
      onConfirm={async () => { await hrApi.sendBackRun(month, reason.trim()); await onDone(); }}>
      <p>The run goes back to draft so its inputs can be changed; whoever prepared it is told why.</p>
      <Field label="Why it is going back" required>
        <Textarea value={reason} onChange={e => setReason(e.target.value)} />
      </Field>
    </ActionDialog>
  );
}
