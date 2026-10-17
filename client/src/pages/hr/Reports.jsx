// HR → Reports (spec §13): the month's payment sheet, the paid register, the on-hold report, the bank transfer
// lists, the payroll register, the variance report, and the loan and advance registers. The payment sheet is split
// into Paid / Unpaid / On hold (per-channel subtotals, grand totals); the payment sheet, paid register and on-hold
// report share multi-select filters (status, channel, department) that drive the screen and the PDF / Excel alike.
// The bank list carries only lines still to pay (unpaid, not on hold) unless on-hold lines are asked for. Each shows on screen and exports through the
// ERP's exporter (lib/exporter.js sections: specs → branded PDF + Excel), except the bank transfer list,
// which is an Excel file of its own (bankFile.js — an account number must stay text).
//
// Access. Every report reads from viewer up. The bank transfer list carries FULL account numbers (read
// per person from GET /hr/people/:id, which gives them to operator and above), so its button is not
// offered to a viewer, and only for a finalised month. The server enforces the same.
//
// Money is only formatted. Where figures are added (subtotals, totals) each amount is read as exact paise
// (sumPaise) and the result kept as a decimal string. Nothing is logged: no amount, no account number.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, ChevronLeft, ChevronRight, Download, Landmark, RefreshCw } from 'lucide-react';
import { Button, DataTable, Input, SubTabs, useToast } from '../../components/ui.jsx';
import { FilterChip, FilterGroup, FilterRail } from '../../components/FilterChip.jsx';
import { hrApi, inr2, levelAtLeast, monthLabel } from '../../lib/hr.js';
import {
  MONTH_RE, PAYMENT_STATUS, PaymentPill, flagLabel, flagsOf, list, paiseOf, plantMonth, plural, qtyText, shiftMonth, signedInr, sumPaise,
} from './RunLineDrawer.jsx';
import { fmt } from '../../api.js';
import { refusalText } from './PersonDrawer.jsx';
import { downloadBankList } from './bankFile.js';

const REPORTS = [
  { key: 'payment', label: 'Payment sheet' },
  { key: 'paid', label: 'Paid register' },
  { key: 'hold', label: 'On hold' },
  { key: 'bank', label: 'Bank transfer lists' },
  { key: 'register', label: 'Payroll register' },
  { key: 'variance', label: 'Variance' },
  { key: 'loans', label: 'Loan register' },
  { key: 'advances', label: 'Advance register' },
];
const MONTHLESS = new Set(['loans', 'advances']);

const owes = l => (paiseOf(l?.payable) ?? 0n) > 0n;
const num = v => { const p = paiseOf(v); return p === null ? null : Number(p); }; // for sorting only
const byText = (a, b) => String(a).localeCompare(String(b));
const money = (key, label, pick) => ({ key, label, align: 'right', sortValue: r => num(pick(r)), export: r => inr2(pick(r)), render: r => <span className="whitespace-nowrap">{inr2(pick(r))}</span> });
const text = (key, label, pick) => ({ key, label, sortValue: r => pick(r), export: r => pick(r) ?? '', render: r => pick(r) || '—' });

function MiniTotals({ items }) {
  return (
    <dl className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-xl bg-[#1D1D1F]/[0.04] px-3 py-2">
          <dt className="text-[10px] font-bold uppercase tracking-wide text-[#86868B]">{label}</dt>
          <dd className="text-sm font-extrabold tabular-nums text-[#1D1D1F]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// Runs `fn` over `items`, `n` at a time, keeping order.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// ── Payment status: paid / unpaid / on hold ─────────────────────────────────
// Every line is in exactly one bucket, as the server's payment_totals: paid, on hold, or unpaid (pending, failed,
// reversed). A paid line counts what was paid (paid_amount); the others what is payable.

const payStatus = l => (PAYMENT_STATUS[l?.payment_status] ? l.payment_status : 'pending');
const bucketOf = l => { const st = payStatus(l); return st === 'paid' ? 'paid' : st === 'on_hold' ? 'on_hold' : 'unpaid'; };
const BUCKETS = [['paid', 'Paid'], ['unpaid', 'Unpaid'], ['on_hold', 'On hold']];
const amountOf = l => (bucketOf(l) === 'paid' ? (l.paid_amount ?? l.payable) : l.payable);
const statusLabel = l => (owes(l) || payStatus(l) !== 'pending' ? PAYMENT_STATUS[payStatus(l)].label : 'Nothing to pay');
const byChannel = (rows, channelLabel) => {
  const m = new Map();
  for (const r of rows) {
    const k = r.channel ?? '';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()].sort((a, b) => (a[0] === '') - (b[0] === '') || byText(channelLabel(a[0]), channelLabel(b[0])));
};

// The multi-select filters (status, channel, department) the payment reports share: the same rows drive the screen
// and the PDF / Excel. An empty set is "every".
function filterMeta(f, channelLabel) {
  return [
    f.status.size > 0 && `Status: ${BUCKETS.filter(([k]) => f.status.has(k)).map(([, l]) => l).join(', ')}`,
    f.channel.size > 0 && `Channel: ${[...f.channel].map(c => (c ? channelLabel(c) : 'No pay channel')).join(', ')}`,
    f.dept.size > 0 && `Department: ${[...f.dept].map(d => d || 'No department').join(', ')}`,
  ];
}

function PayFilters({ rows, filters, setFilters, channelLabel, showStatus = true }) {
  const toggle = (axis, v) => setFilters(f => { const n = new Set(f[axis]); if (n.has(v)) n.delete(v); else n.add(v); return { ...f, [axis]: n }; });
  const channels = [...new Set(rows.map(r => r.channel ?? ''))].sort((a, b) => (a === '') - (b === '') || byText(channelLabel(a), channelLabel(b)));
  const depts = [...new Set(rows.map(r => r.department || ''))].sort((a, b) => (a === '') - (b === '') || byText(a, b));
  const any = filters.status.size + filters.channel.size + filters.dept.size > 0;
  return (
    <FilterRail className="mb-2">
      {showStatus && (
        <FilterGroup label="Status" divider={false}>
          {BUCKETS.map(([k, label]) => (
            <FilterChip key={k} label={label} count={rows.filter(r => bucketOf(r.line) === k).length} on={filters.status.has(k)}
              dot={k === 'paid' ? 'bg-emerald-500' : k === 'on_hold' ? 'bg-amber-500' : 'bg-gray-400'} onClick={() => toggle('status', k)} />
          ))}
        </FilterGroup>
      )}
      {channels.length > 1 && (
        <FilterGroup label="Channel" divider={showStatus}>
          {channels.map(c => (
            <FilterChip key={c || '_'} label={c ? channelLabel(c) : 'No pay channel'} count={rows.filter(r => (r.channel ?? '') === c).length}
              on={filters.channel.has(c)} onClick={() => toggle('channel', c)} />
          ))}
        </FilterGroup>
      )}
      {depts.length > 1 && (
        <FilterGroup label="Department">
          {depts.map(d => (
            <FilterChip key={d || '_'} label={d || 'No department'} count={rows.filter(r => (r.department || '') === d).length}
              on={filters.dept.has(d)} onClick={() => toggle('dept', d)} />
          ))}
        </FilterGroup>
      )}
      {any && <FilterChip label="Clear filters" on={false} onClick={() => setFilters({ status: new Set(), channel: new Set(), dept: new Set() })} />}
    </FilterRail>
  );
}

const applyFilters = (rows, f) => rows.filter(r => (!f.status.size || f.status.has(bucketOf(r.line)))
  && (!f.channel.size || f.channel.has(r.channel ?? '')) && (!f.dept.size || f.dept.has(r.department || '')));

// ── Payment sheet ───────────────────────────────────────────────────────────

function paymentSpec({ month, run, rows, channelLabel, meta = [] }) {
  const name = k => (k ? channelLabel(k) : 'No pay channel');
  const inBucket = (rs, b) => rs.filter(r => bucketOf(r.line) === b);
  const sumOf = rs => inr2(sumPaise(rs.map(r => amountOf(r.line))));
  const countAndSum = rs => (rs.length ? `${rs.length} · ${sumOf(rs)}` : '—');

  // Summary: per channel, each bucket's people and amount, then the grand total.
  const summaryRows = byChannel(rows, channelLabel).map(([k, rs]) => ({
    channel: name(k), people: String(rs.length), paid: countAndSum(inBucket(rs, 'paid')), unpaid: countAndSum(inBucket(rs, 'unpaid')),
    on_hold: countAndSum(inBucket(rs, 'on_hold')), payable: inr2(sumPaise(rs.map(r => r.line.payable))),
    carried: inr2(sumPaise(rs.map(r => r.line.carried_advance))),
  }));
  summaryRows.push({
    channel: 'Total', people: String(rows.length), paid: countAndSum(inBucket(rows, 'paid')), unpaid: countAndSum(inBucket(rows, 'unpaid')),
    on_hold: countAndSum(inBucket(rows, 'on_hold')), payable: inr2(sumPaise(rows.map(r => r.line.payable))),
    carried: inr2(sumPaise(rows.map(r => r.line.carried_advance))), total: true,
  });
  const summaryCols = [
    { key: 'channel', label: 'Channel' }, { key: 'people', label: 'People', align: 'right' },
    { key: 'paid', label: 'Paid', align: 'right' }, { key: 'unpaid', label: 'Unpaid', align: 'right' },
    { key: 'on_hold', label: 'On hold', align: 'right' }, { key: 'payable', label: 'Payable', align: 'right' },
    { key: 'carried', label: 'Carried as advance', align: 'right' },
  ];
  const sections = [
    { heading: 'Summary by channel', columns: summaryCols, rows: summaryRows, pdfRowTone: r => (r.total ? 'info' : null) },
  ];

  // One section per bucket: its lines by channel, a subtotal per channel and the bucket's total.
  const detail = {
    paid: [
      { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'department', label: 'Department' },
      { key: 'amount', label: 'Amount paid', align: 'right' }, { key: 'paid_on', label: 'Paid on' }, { key: 'ref', label: 'Reference' },
    ],
    unpaid: [
      { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'department', label: 'Department' },
      { key: 'amount', label: 'Payable', align: 'right' }, { key: 'status', label: 'Status' },
    ],
    on_hold: [
      { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'department', label: 'Department' },
      { key: 'amount', label: 'Payable', align: 'right' }, { key: 'reason', label: 'Why on hold' },
    ],
  };
  for (const [b, title] of BUCKETS) {
    const rs = inBucket(rows, b);
    if (!rs.length) continue;
    const body = [];
    for (const [k, list2] of byChannel(rs, channelLabel)) {
      for (const r of list2) {
        body.push({
          code: r.code, name: r.name, department: r.department, amount: inr2(amountOf(r.line)),
          paid_on: r.line.paid_on || '', ref: r.line.paid_ref || '', status: statusLabel(r.line), reason: r.line.hold_reason || '',
        });
      }
      body.push({ code: '', name: `Subtotal — ${name(k)} · ${plural(list2.length, 'person', 'people')}`, department: '', amount: sumOf(list2), subtotal: true });
    }
    body.push({ code: '', name: `Total ${title.toLowerCase()} — ${plural(rs.length, 'person', 'people')}`, department: '', amount: sumOf(rs), total: true });
    sections.push({ heading: title, columns: detail[b], rows: body, pdfRowTone: r => (r.total ? 'info' : r.subtotal ? 'info' : null) });
  }

  const carried = rows.filter(r => !owes(r.line) && (paiseOf(r.line.carried_advance) ?? 0n) > 0n);
  if (carried.length) {
    sections.push({
      heading: 'Nothing payable this month — carried as advance',
      columns: [
        { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'channel', label: 'Channel' },
        { key: 'carried', label: 'Advance carried', align: 'right' }, { key: 'why', label: 'Why' },
      ],
      rows: carried.map(r => ({
        code: r.code, name: r.name, channel: name(r.channel), carried: inr2(r.line.carried_advance),
        why: flagsOf(r.line).some(f => f.code === 'INSUFFICIENT_PAY') ? flagLabel('INSUFFICIENT_PAY') : 'Nothing payable',
      })),
    });
  }
  return {
    name: `HR Payment sheet ${month}`,
    title: `Payment sheet — ${monthLabel(month)}`,
    subtitle: `HR & Payroll · ${run?.status === 'finalised' ? 'Finalised' : `Run is ${run?.status || 'not started'} — not final`}`,
    orientation: 'portrait',
    meta: [...meta, `${plural(rows.length, 'person', 'people')}`],
    summary: [
      { label: 'People', value: String(rows.length) },
      ...BUCKETS.map(([b, label]) => ({ label, value: `${inBucket(rows, b).length} · ${sumOf(inBucket(rows, b))}` })),
      { label: 'Payable', value: inr2(sumPaise(rows.map(r => r.line.payable))) },
    ],
    sections,
  };
}

// ── Bank transfer lists ─────────────────────────────────────────────────────

function BankLists({ month, run, rows, channels, channelLabel, canExport }) {
  const toast = useToast();
  const finalised = run?.status === 'finalised';
  const banks = channels.filter(c => c.kind === 'bank' && c.active !== false);
  const [busy, setBusy] = useState('');
  // Only lines still to pay: unpaid (not paid, not on hold) by default; on-hold lines only when asked for.
  const [withHeld, setWithHeld] = useState(false);
  const toPay = r => owes(r.line) && (bucketOf(r.line) === 'unpaid' || (withHeld && bucketOf(r.line) === 'on_hold'));

  const make = async channel => {
    const lines = rows.filter(r => r.channel === channel.code && toPay(r));
    if (!lines.length) { toast.info('Nobody is left to pay through this channel.'); return; }
    setBusy(channel.code);
    try {
      const people = await pool(lines, 5, r => hrApi.person(r.id));
      const out = [];
      let missing = 0;
      lines.forEach((r, i) => {
        const p = people[i] || {};
        const account = String(p.bank_account ?? '').replace(/\s+/g, '');
        // A viewer's copy is masked ('••••1234'); a masked or empty number is no account.
        if (!account || /[^0-9A-Za-z]/.test(account)) { missing += 1; return; }
        out.push({
          holder: p.bank_holder || p.name || r.name, account, ifsc: String(p.bank_ifsc ?? '').toUpperCase(),
          amount: String(r.line.payable), reference: `${month} ${r.code}`,
        });
      });
      if (!out.length) { toast.error('None of these people has a bank account on file.'); return; }
      await downloadBankList({
        fileName: `HR Bank list ${month} ${channel.label || channel.code}`,
        title: `Bank transfer list — ${channel.label || channel.code} — ${monthLabel(month)}`,
        meta: [channel.bank_name && `Bank: ${channel.bank_name}`, plural(out.length, 'transfer'),
          withHeld ? 'Unpaid lines, including lines on hold' : 'Unpaid lines only (paid and on-hold lines left out)'],
        rows: out,
        total: sumPaise(out.map(o => o.amount)),
      });
      toast.success(`Bank list downloaded${missing ? ` — ${plural(missing, 'person', 'people')} left out: no account on file` : ''}`);
    } catch (e) {
      toast.error(`The bank list could not be made: ${refusalText(e)}`);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-[#515154]">
        One Excel file per bank channel: beneficiary, account number, IFSC, amount and a reference (month and payroll code).
        {!canExport && ' Account numbers are shown only to operators and above, so this download is not available at your access level.'}
        {canExport && !finalised && ' Available once the month is finalised.'}
        {' '}Only lines still to pay are listed: paid lines are never in it, and lines on hold only when ticked below.
      </p>
      <label className="flex items-center gap-2 text-xs font-semibold text-[#515154]">
        <input type="checkbox" className="h-4 w-4 accent-[#007AFF]" checked={withHeld} onChange={e => setWithHeld(e.target.checked)} />
        Include lines on hold
      </label>
      {banks.length === 0 && <p className="text-xs text-[#86868B]">No bank pay channel is set up (Settings → Pay channels).</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {banks.map(c => {
          const mine = rows.filter(r => r.channel === c.code && toPay(r));
          const held = rows.filter(r => r.channel === c.code && owes(r.line) && bucketOf(r.line) === 'on_hold').length;
          return (
            <div key={c.code} className="glass flex items-center gap-3 rounded-2xl border border-white/70 p-3 shadow-card">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#E1EFFF] text-[#0064D2]"><Landmark size={16} /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-[#1D1D1F]">{channelLabel(c.code)}</p>
                <p className="text-[11px] text-[#6E6E73]">
                  {plural(mine.length, 'transfer')} · {inr2(sumPaise(mine.map(r => r.line.payable)))}
                  {held > 0 && !withHeld && <span className="text-amber-800"> · {held} on hold left out</span>}
                </p>
              </div>
              {canExport && (
                <Button size="sm" variant="secondary" disabled={!finalised || !mine.length || (busy !== '' && busy !== c.code)} onClick={() => make(c)}>
                  <Download size={13} /> {busy === c.code ? 'Preparing…' : 'Excel'}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── The screen ──────────────────────────────────────────────────────────────

export default function Reports({ level }) {
  const canExportBank = levelAtLeast(level, 'operator');
  const [params, setParams] = useSearchParams();
  const asked = params.get('month');
  const month = MONTH_RE.test(asked || '') ? asked : plantMonth();
  const setMonth = useCallback(m => {
    if (!MONTH_RE.test(m || '')) return;
    setParams(p => { const n = new URLSearchParams(p); n.set('month', m); return n; }, { replace: true });
  }, [setParams]);
  const [report, setReport] = useState('payment');
  // Status / channel / department, shared by the payment sheet, the paid register and the on-hold report.
  const [filters, setFilters] = useState(() => ({ status: new Set(), channel: new Set(), dept: new Set() }));
  useEffect(() => { setFilters({ status: new Set(), channel: new Set(), dept: new Set() }); }, [month]);

  const [people, setPeople] = useState([]);
  const [channels, setChannels] = useState([]);
  useEffect(() => {
    let live = true;
    Promise.allSettled([hrApi.people(), hrApi.payChannels()]).then(([p, c]) => {
      if (!live) return;
      if (p.status === 'fulfilled' && Array.isArray(p.value)) setPeople(p.value);
      if (c.status === 'fulfilled' && Array.isArray(c.value)) setChannels(c.value);
    });
    return () => { live = false; };
  }, []);
  const peopleById = useMemo(() => new Map(people.map(p => [String(p.id), p])), [people]);
  const channelLabel = useCallback(code => (code ? channels.find(c => c.code === code)?.label || code : ''), [channels]);

  // The month's run (read only when the month has one: a GET for a missing run would toast on every new month).
  const [month$, setMonth$] = useState(null); // { month, run, lines, inputs } | { month, error }
  const seq = useRef(0);
  const loadRun = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const runs = await hrApi.runs();
      const found = list(Array.isArray(runs) ? runs : runs?.runs).some(r => String(r?.month ?? '').slice(0, 7) === month);
      const d = found ? await hrApi.run(month) : null;
      if (mine === seq.current) setMonth$({ month, run: d?.run || null, lines: list(d?.lines), inputs: list(d?.inputs) });
    } catch (e) {
      if (mine === seq.current) setMonth$({ month, error: refusalText(e) });
    }
  }, [month]);
  useEffect(() => { if (!MONTHLESS.has(report)) loadRun(); }, [loadRun, report]);

  const here = month$?.month === month ? month$ : null;
  const run = here?.run || null;
  const inputsById = useMemo(() => new Map(list(here?.inputs).map(i => [String(i.person_id), i])), [here]);
  const rows = useMemo(() => list(here?.lines).map(l => {
    const id = String(l.person_id);
    const p = peopleById.get(id);
    return {
      id, line: l, input: inputsById.get(id),
      name: l.name ?? l.person_name ?? p?.name ?? `Person #${id}`,
      code: l.code ?? l.person_code ?? p?.code ?? '',
      department: l.department ?? p?.department ?? '',
      channel: l.pay_channel ?? null,
      channelLabel: channelLabel(l.pay_channel),
    };
  }), [here, peopleById, inputsById, channelLabel]);

  const needsRun = !MONTHLESS.has(report);
  const waiting = needsRun && !here;

  return (
    <div>
      <section className="glass mb-3 rounded-[22px] border border-white/70 p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          {needsRun && (
            <>
              <button type="button" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}
                className="flex h-9 w-9 items-center justify-center rounded-full text-[#515154] hover:bg-[#1D1D1F]/[0.05]"><ChevronLeft size={17} /></button>
              <Input type="month" aria-label="Report month" value={month} className="!w-[168px]" onChange={e => setMonth(e.target.value)} />
              <button type="button" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}
                className="flex h-9 w-9 items-center justify-center rounded-full text-[#515154] hover:bg-[#1D1D1F]/[0.05]"><ChevronRight size={17} /></button>
              <h2 className="text-lg font-extrabold tracking-[-0.03em] text-[#1D1D1F]">{monthLabel(month)}</h2>
              <button type="button" aria-label="Reload" title="Reload" onClick={loadRun}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[#86868B] hover:bg-[#1D1D1F]/[0.05]"><RefreshCw size={14} /></button>
            </>
          )}
          {!needsRun && <h2 className="text-lg font-extrabold tracking-[-0.03em] text-[#1D1D1F]">As of today</h2>}
        </div>
        <div className="mt-3"><SubTabs views={REPORTS} active={report} onChange={setReport} /></div>
      </section>

      {needsRun && here?.error && (
        <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" /><span className="min-w-0 flex-1">Couldn’t load {monthLabel(month)} — {here.error}</span>
          <Button size="sm" variant="secondary" onClick={loadRun}>Try again</Button>
        </div>
      )}
      {waiting && <div className="p-8 text-sm text-slate-400">Loading {monthLabel(month)}…</div>}
      {needsRun && here && !here.error && !run && (
        <div className="glass rounded-[22px] border border-white/70 p-8 text-center shadow-card">
          <p className="text-base font-bold text-[#1D1D1F]">No payroll for {monthLabel(month)} yet.</p>
          <p className="mt-1 text-xs text-[#6E6E73]">Reports for a month appear once its sheet has been imported.</p>
        </div>
      )}

      {needsRun && run && report === 'payment' && (
        <PaymentReport month={month} run={run} rows={rows} channelLabel={channelLabel} filters={filters} setFilters={setFilters} />
      )}
      {needsRun && run && report === 'paid' && (
        <PaidRegister month={month} run={run} rows={rows} channelLabel={channelLabel} filters={filters} setFilters={setFilters} />
      )}
      {needsRun && run && report === 'hold' && (
        <OnHoldReport month={month} run={run} rows={rows} channelLabel={channelLabel} filters={filters} setFilters={setFilters} />
      )}
      {needsRun && run && report === 'bank' && (
        <BankLists month={month} run={run} rows={rows} channels={channels} channelLabel={channelLabel} canExport={canExportBank} />
      )}
      {needsRun && run && report === 'register' && <RegisterReport month={month} run={run} rows={rows} />}
      {needsRun && run && report === 'variance' && <VarianceReport month={month} rows={rows} />}
      {report === 'loans' && <LoanRegister />}
      {report === 'advances' && <AdvanceRegister />}
    </div>
  );
}

// ── Payment sheet (on screen) ───────────────────────────────────────────────

function PaymentPillCell({ line }) {
  if (!owes(line) && payStatus(line) === 'pending') return <span className="text-[#86868B]">Nothing to pay</span>;
  const st = payStatus(line);
  return <PaymentPill status={st} reason={st === 'on_hold' ? line.hold_reason || 'No reason recorded' : null} />;
}

function BucketTotals({ rows }) {
  return (
    <MiniTotals items={[['People', String(rows.length)],
      ...BUCKETS.map(([b, label]) => {
        const rs = rows.filter(r => bucketOf(r.line) === b);
        return [`${label} · ${rs.length}`, inr2(sumPaise(rs.map(r => amountOf(r.line))))];
      })]} />
  );
}

function PaymentReport({ month, run, rows, channelLabel, filters, setFilters }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => applyFilters(rows, filters), [rows, filters]);
  const columns = useMemo(() => [
    text('name', 'Name', r => r.name), text('code', 'Code', r => r.code), text('department', 'Department', r => r.department),
    text('channel', 'Channel', r => r.channelLabel || 'No pay channel'),
    money('payable', 'Payable', r => r.line.payable), money('carried', 'Carried as advance', r => r.line.carried_advance),
    { key: 'payment', label: 'Payment', sortValue: r => payStatus(r.line), export: r => statusLabel(r.line), render: r => <PaymentPillCell line={r.line} /> },
    text('paid_on', 'Paid on', r => r.line.paid_on || ''), text('ref', 'Reference', r => r.line.paid_ref || ''),
  ], []);
  return (
    <>
      <PayFilters rows={rows} filters={filters} setFilters={setFilters} channelLabel={channelLabel} />
      <BucketTotals rows={shown} />
      <DataTable columns={columns} rows={shown} getRowId={r => r.id} dense serialNumber={false}
        searchValue={q} onSearchChange={setQ} searchPlaceholder="Search name, code or channel…"
        defaultSort={{ key: 'name', dir: 'asc' }} exportName={`HR Payment sheet ${month}`}
        exportSpec={sorted => paymentSpec({ month, run, rows: sorted, channelLabel, meta: [...filterMeta(filters, channelLabel), q.trim() && `Search: "${q.trim()}"`] })}
        empty={rows.length ? 'No line matches these filters.' : 'No lines in this run.'} />
    </>
  );
}

// ── Paid register: who was paid, through what, how much, when and against which reference ──

function PaidRegister({ month, run, rows, channelLabel, filters, setFilters }) {
  const [q, setQ] = useState('');
  const paid = useMemo(() => rows.filter(r => bucketOf(r.line) === 'paid'), [rows]);
  const shown = useMemo(() => applyFilters(paid, { ...filters, status: new Set() }), [paid, filters]);
  const columns = useMemo(() => [
    text('name', 'Person', r => r.name), text('code', 'Code', r => r.code), text('department', 'Department', r => r.department),
    text('channel', 'Channel', r => r.channelLabel || 'No pay channel'),
    money('amount', 'Amount paid', r => amountOf(r.line)), text('paid_on', 'Paid on', r => r.line.paid_on || ''),
    text('ref', 'Reference', r => r.line.paid_ref || ''),
  ], []);
  const spec = sorted => {
    const cols = [
      { key: 'name', label: 'Person' }, { key: 'code', label: 'Code' }, { key: 'channel', label: 'Channel' },
      { key: 'amount', label: 'Amount paid', align: 'right' }, { key: 'paid_on', label: 'Paid on' }, { key: 'ref', label: 'Reference' },
    ];
    const sections = byChannel(sorted, channelLabel).map(([k, rs]) => ({
      heading: k ? channelLabel(k) : 'No pay channel', columns: cols,
      rows: [...rs.map(r => ({ name: r.name, code: r.code, channel: r.channelLabel || 'No pay channel', amount: inr2(amountOf(r.line)), paid_on: r.line.paid_on || '', ref: r.line.paid_ref || '' })),
        { name: `Subtotal — ${plural(rs.length, 'person', 'people')}`, code: '', channel: '', amount: inr2(sumPaise(rs.map(r => amountOf(r.line)))), paid_on: '', ref: '', subtotal: true }],
      pdfRowTone: r => (r.subtotal ? 'info' : null),
    }));
    return {
      name: `HR Paid register ${month}`, title: `Paid register — ${monthLabel(month)}`,
      subtitle: `HR & Payroll · ${run.status}`, orientation: 'portrait',
      meta: [...filterMeta({ ...filters, status: new Set() }, channelLabel), q.trim() && `Search: "${q.trim()}"`, plural(sorted.length, 'person', 'people')],
      summary: [{ label: 'People paid', value: String(sorted.length) }, { label: 'Amount paid', value: inr2(sumPaise(sorted.map(r => amountOf(r.line)))) }],
      sections: sections.length ? sections : [{ columns: cols, rows: [] }],
    };
  };
  return (
    <>
      <PayFilters rows={paid} filters={filters} setFilters={setFilters} channelLabel={channelLabel} showStatus={false} />
      <MiniTotals items={[['People paid', String(shown.length)], ['Amount paid', inr2(sumPaise(shown.map(r => amountOf(r.line))))],
        ['Not paid yet', String(rows.length - paid.length)], ['Run', run.status]]} />
      <DataTable columns={columns} rows={shown} getRowId={r => r.id} dense serialNumber={false}
        searchValue={q} onSearchChange={setQ} searchPlaceholder="Search person, code, channel or reference…"
        defaultSort={{ key: 'name', dir: 'asc' }} exportName={`HR Paid register ${month}`} exportSpec={spec}
        empty={paid.length ? 'No paid line matches these filters.' : 'Nobody has been marked paid for this month yet.'} />
    </>
  );
}

// ── On hold: who is not to be paid, how much, why, and who put it on hold when ──

function OnHoldReport({ month, run, rows, channelLabel, filters, setFilters }) {
  const [q, setQ] = useState('');
  const held = useMemo(() => rows.filter(r => bucketOf(r.line) === 'on_hold'), [rows]);
  const shown = useMemo(() => applyFilters(held, { ...filters, status: new Set() }), [held, filters]);
  const heldBy = r => r.line.held_by_name || (r.line.held_by != null ? `user #${r.line.held_by}` : '');
  const heldAt = r => (r.line.held_at ? fmt.dt(r.line.held_at) : '');
  const columns = useMemo(() => [
    text('name', 'Person', r => r.name), text('code', 'Code', r => r.code), text('department', 'Department', r => r.department),
    text('channel', 'Channel', r => r.channelLabel || 'No pay channel'),
    money('amount', 'Amount', r => r.line.payable), text('reason', 'Why on hold', r => r.line.hold_reason || ''),
    text('held_by', 'Held by', heldBy), { ...text('held_at', 'Held at', heldAt), sortValue: r => r.line.held_at || '' },
  ], []);
  return (
    <>
      <PayFilters rows={held} filters={filters} setFilters={setFilters} channelLabel={channelLabel} showStatus={false} />
      <MiniTotals items={[['On hold', String(shown.length)], ['Amount on hold', inr2(sumPaise(shown.map(r => r.line.payable)))], ['Run', run.status]]} />
      <DataTable columns={columns} rows={shown} getRowId={r => r.id} dense serialNumber={false}
        searchValue={q} onSearchChange={setQ} searchPlaceholder="Search person, code, channel or reason…"
        defaultSort={{ key: 'name', dir: 'asc' }} exportName={`HR On hold ${month}`}
        exportSubtitle={`HR & Payroll · Payments on hold · ${monthLabel(month)}`}
        exportMeta={() => [...filterMeta({ ...filters, status: new Set() }, channelLabel), q.trim() && `Search: "${q.trim()}"`]}
        exportSummary={rs => [{ label: 'On hold', value: String(rs.length) }, { label: 'Amount', value: inr2(sumPaise(rs.map(r => r.line.payable))) }]}
        empty={held.length ? 'No line on hold matches these filters.' : 'No payment is on hold for this month.'} />
    </>
  );
}

// ── Payroll register ────────────────────────────────────────────────────────

function RegisterReport({ month, run, rows }) {
  const [q, setQ] = useState('');
  const [groupBy, setGroupBy] = useState('none');
  const columns = useMemo(() => [
    text('name', 'Name', r => r.name), text('code', 'Code', r => r.code), text('department', 'Department', r => r.department),
    text('channel', 'Channel', r => r.channelLabel),
    { key: 'present', label: 'Present', align: 'right', sortValue: r => Number(r.line.present_days), export: r => qtyText(r.line.present_days), render: r => qtyText(r.line.present_days) },
    money('basic', 'Basic', r => r.line.basic), money('ot', 'OT', r => r.line.ot_amount), money('holiday', 'Holiday', r => r.line.holiday_amount),
    money('gross', 'Gross', r => r.line.gross), money('advance', 'Advance', r => r.line.advance_recovery), money('loan', 'Loan', r => r.line.loan_recovery),
    money('ded', 'Deductions', r => r.line.total_deductions), money('net', 'Net', r => r.line.net), money('payable', 'Payable', r => r.line.payable),
  ], []);
  const exportSpec = sorted => {
    const m = (key, label) => ({ key: `x_${key}`, label, align: 'right', export: r => inr2(r.line[key]) });
    const cols = [
      { key: 'x_name', label: 'Name', export: r => r.name }, { key: 'x_code', label: 'Code', export: r => r.code },
      { key: 'x_dept', label: 'Department', export: r => r.department }, { key: 'x_channel', label: 'Pay channel', export: r => r.channelLabel },
      { key: 'x_present', label: 'Present days', align: 'right', export: r => qtyText(r.line.present_days) },
      { key: 'x_ot_h', label: 'OT hours', align: 'right', export: r => qtyText(r.input?.ot_hours) },
      m('basic', 'Basic'), m('ot_amount', 'OT'), m('holiday_amount', 'Holiday'), m('misc_earning', 'Misc'), m('bonus', 'Bonus'),
      m('adj_earnings', 'Adjustments (earning)'), m('gross', 'Gross'), m('advance_recovery', 'Advance recovered'), m('loan_recovery', 'Loan recovered'),
      m('misc_deduction', 'Misc deduction'), m('adj_deductions', 'Adjustments (deduction)'), m('total_deductions', 'Total deductions'),
      m('net', 'Net'), m('paid_separately', 'Paid separately'), m('rounding', 'Rounding'), m('payable', 'Payable'), m('carried_advance', 'Advance carried'),
    ];
    const pdfCols = [
      { key: 'p_name', label: 'Name', export: r => `${r.name}\n${r.code}` }, { key: 'p_dept', label: 'Department', export: r => r.department },
      m('basic', 'Basic'), m('ot_amount', 'OT'), m('holiday_amount', 'Holiday'), m('gross', 'Gross'),
      m('advance_recovery', 'Advance'), m('loan_recovery', 'Loan'), m('total_deductions', 'Deductions'), m('payable', 'Payable'),
    ];
    const totals = rs => [
      { label: 'People', value: String(rs.length) }, { label: 'Gross', value: inr2(sumPaise(rs.map(r => r.line.gross))) },
      { label: 'Deductions', value: inr2(sumPaise(rs.map(r => r.line.total_deductions))) }, { label: 'Payable', value: inr2(sumPaise(rs.map(r => r.line.payable))) },
    ];
    let sections = [{ columns: cols, pdfColumns: pdfCols, rows: sorted }];
    if (groupBy !== 'none') {
      const groups = new Map();
      for (const r of sorted) {
        const k = groupBy === 'department' ? r.department || 'No department' : r.channelLabel || 'No pay channel';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      sections = [...groups.entries()].sort((a, b) => byText(a[0], b[0]))
        .map(([heading, rs]) => ({ heading, columns: cols, pdfColumns: pdfCols, rows: rs, summary: totals(rs) }));
    }
    return {
      name: `HR Payroll register ${month}`, title: `Payroll register — ${monthLabel(month)}`,
      subtitle: `HR & Payroll · ${run.status}`, orientation: 'landscape',
      meta: [groupBy !== 'none' && `Grouped by ${groupBy}`, q.trim() && `Search: "${q.trim()}"`, `${sorted.length} of ${plural(rows.length, 'person', 'people')}`],
      summary: totals(sorted), sections,
    };
  };
  return (
    <>
      <FilterRail className="mb-2">
        <FilterGroup label="Group the export by" divider={false}>
          {['none', 'department', 'channel'].map(g => (
            <FilterChip key={g} label={g === 'none' ? 'Nothing' : g === 'department' ? 'Department' : 'Pay channel'} on={groupBy === g} onClick={() => setGroupBy(g)} />
          ))}
        </FilterGroup>
      </FilterRail>
      <DataTable columns={columns} rows={rows} getRowId={r => r.id} dense serialNumber={false}
        searchValue={q} onSearchChange={setQ} searchPlaceholder="Search name, code, department or channel…"
        defaultSort={{ key: 'name', dir: 'asc' }} exportName={`HR Payroll register ${month}`} exportSpec={exportSpec}
        empty="No lines in this run." />
    </>
  );
}

// ── Variance ────────────────────────────────────────────────────────────────

const PARTS = [['revision', 'Pay revision'], ['attendance', 'Attendance'], ['ot', 'Overtime'], ['holiday', 'Holiday'],
  ['misc', 'Misc'], ['advance', 'Advance'], ['loan', 'Loan'], ['other', 'Other']];

function VarianceReport({ month, rows }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [onlyOff, setOnlyOff] = useState(false);
  useEffect(() => {
    let live = true;
    setData(null);
    setError('');
    hrApi.variance(month).then(v => { if (live) setData(list(v)); }, e => { if (live) setError(refusalText(e)); });
    return () => { live = false; };
  }, [month]);
  const deptOf = useMemo(() => new Map(rows.map(r => [r.id, r.department])), [rows]);
  const all = useMemo(() => list(data).map(v => ({ ...v, id: String(v.person_id), department: deptOf.get(String(v.person_id)) || '' })), [data, deptOf]);
  const isOff = v => v.unexplained != null && (paiseOf(v.unexplained) ?? 0n) !== 0n;
  const shown = useMemo(() => all.filter(v => !onlyOff || isOff(v)), [all, onlyOff]);
  const off = all.filter(isOff).length;
  const columns = useMemo(() => [
    text('name', 'Name', v => v.name), text('code', 'Code', v => v.code),
    money('previous', 'Last month', v => v.previous_payable), money('payable', 'This month', v => v.payable),
    { key: 'change', label: 'Change', align: 'right', sortValue: v => num(v.change), export: v => (v.change == null ? '' : signedInr(v.change)), render: v => (v.change == null ? '—' : signedInr(v.change)) },
    ...PARTS.map(([k, label]) => ({ key: `p_${k}`, label, align: 'right', sortValue: v => num(v.parts?.[k]),
      export: v => (v.parts?.[k] == null ? '' : signedInr(v.parts[k])), render: v => (v.parts?.[k] == null ? '—' : signedInr(v.parts[k])) })),
    { key: 'unexplained', label: 'Unexplained', align: 'right', sortValue: v => num(v.unexplained),
      export: v => (v.unexplained == null ? '' : signedInr(v.unexplained)),
      render: v => (v.unexplained == null ? '—' : <span className={isOff(v) ? 'font-bold text-red-700' : ''}>{signedInr(v.unexplained)}</span>) },
  ], []);
  if (error) return <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</p>;
  if (!data) return <div className="p-8 text-sm text-slate-400">Reading the variance…</div>;
  return (
    <>
      <FilterRail className="mb-2">
        <FilterGroup label="Show" divider={false}>
          <FilterChip label="Everyone" count={all.length} on={!onlyOff} onClick={() => setOnlyOff(false)} />
          <FilterChip label="Unexplained only" count={off} on={onlyOff} tone="border-red-300 bg-red-100 text-red-800" onClick={() => setOnlyOff(v => !v)} />
        </FilterGroup>
      </FilterRail>
      <DataTable columns={columns} rows={shown} getRowId={v => v.id} dense serialNumber={false}
        searchValue={q} onSearchChange={setQ} searchPlaceholder="Search name or code…" defaultSort={{ key: 'name', dir: 'asc' }}
        exportName={`HR Variance ${month}`} exportSubtitle="HR & Payroll · Variance against the last finalised month"
        exportMeta={() => [monthLabel(month), onlyOff && 'Unexplained only']}
        empty="No variance to show — there is no earlier finalised month to compare with." />
    </>
  );
}

// ── Loan and advance registers ──────────────────────────────────────────────

function useLoaded(fetcher) {
  const [state, setState] = useState({ rows: null, error: '' });
  const load = useCallback(() => {
    setState({ rows: null, error: '' });
    fetcher().then(r => setState({ rows: list(r), error: '' }), e => setState({ rows: null, error: refusalText(e) }));
  }, [fetcher]);
  useEffect(() => { load(); }, [load]);
  return [state, load];
}

const loansFetch = () => hrApi.loans();
function LoanRegister() {
  const [{ rows, error }, reload] = useLoaded(loansFetch);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const all = rows || [];
  const shown = useMemo(() => all.filter(l => !status || l.status === status), [all, status]);
  const columns = useMemo(() => [
    text('loan_no', 'Loan', l => l.loan_no), text('person_name', 'Person', l => l.person_name), text('person_code', 'Code', l => l.person_code),
    text('issued_on', 'Issued', l => l.issued_on),
    money('principal', 'Principal', l => l.principal), money('instalment', 'Instalment', l => l.instalment),
    money('outstanding', 'Outstanding', l => l.outstanding),
    text('next_due_month', 'Next due', l => (l.next_due_month ? monthLabel(l.next_due_month) : '')),
    text('status', 'Status', l => l.status),
  ], []);
  if (error) return <div role="alert" className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}<Button size="sm" variant="secondary" onClick={reload}>Try again</Button></div>;
  if (!rows) return <div className="p-8 text-sm text-slate-400">Reading loans…</div>;
  return (
    <>
      <FilterRail className="mb-2">
        <FilterGroup label="Status" divider={false}>
          <FilterChip label="All" count={all.length} on={!status} onClick={() => setStatus('')} />
          {['active', 'closed', 'cancelled'].map(s => (
            <FilterChip key={s} label={s[0].toUpperCase() + s.slice(1)} count={all.filter(l => l.status === s).length} on={status === s} onClick={() => setStatus(c => (c === s ? '' : s))} />
          ))}
        </FilterGroup>
      </FilterRail>
      <MiniTotals items={[['Loans', String(shown.length)], ['Principal', inr2(sumPaise(shown.map(l => l.principal)))],
        ['Outstanding', inr2(sumPaise(shown.map(l => l.outstanding)))], ['Due this month', inr2(sumPaise(shown.map(l => l.due_this_month)))]]} />
      <DataTable columns={columns} rows={shown} getRowId={l => l.id} dense serialNumber={false}
        searchValue={q} onSearchChange={setQ} searchPlaceholder="Search loan, person or code…" defaultSort={{ key: 'loan_no', dir: 'desc' }}
        exportName="HR Loan register" exportSubtitle="HR & Payroll · Loan register" exportMeta={() => [status && `Status: ${status}`]}
        exportSummary={rs => [{ label: 'Loans', value: String(rs.length) }, { label: 'Principal', value: inr2(sumPaise(rs.map(l => l.principal))) },
          { label: 'Outstanding', value: inr2(sumPaise(rs.map(l => l.outstanding))) }]}
        empty="No loans match." />
    </>
  );
}

const advancesFetch = () => hrApi.advances();
function AdvanceRegister() {
  const [{ rows, error }, reload] = useLoaded(advancesFetch);
  const [q, setQ] = useState('');
  const [owing, setOwing] = useState(true);
  const all = rows || [];
  const shown = useMemo(() => all.filter(a => !owing || (paiseOf(a.balance) ?? 0n) !== 0n), [all, owing]);
  const columns = useMemo(() => [
    text('person_name', 'Person', a => a.person_name), text('person_code', 'Code', a => a.person_code), text('department', 'Department', a => a.department),
    money('balance', 'Balance', a => a.balance), text('last', 'Last entry', a => a.last_txn_date),
    { key: 'txn_count', label: 'Entries', align: 'right', sortValue: a => a.txn_count, export: a => String(a.txn_count ?? ''), render: a => a.txn_count ?? '—' },
  ], []);
  if (error) return <div role="alert" className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}<Button size="sm" variant="secondary" onClick={reload}>Try again</Button></div>;
  if (!rows) return <div className="p-8 text-sm text-slate-400">Reading advances…</div>;
  return (
    <>
      <FilterRail className="mb-2">
        <FilterGroup label="Show" divider={false}>
          <FilterChip label="Owing" count={all.filter(a => (paiseOf(a.balance) ?? 0n) !== 0n).length} on={owing} onClick={() => setOwing(true)} />
          <FilterChip label="Everyone with a history" count={all.length} on={!owing} onClick={() => setOwing(false)} />
        </FilterGroup>
      </FilterRail>
      <MiniTotals items={[['People', String(shown.length)], ['Total outstanding', inr2(sumPaise(shown.map(a => a.balance)))]]} />
      <DataTable columns={columns} rows={shown} getRowId={a => a.person_id} dense serialNumber={false}
        searchValue={q} onSearchChange={setQ} searchPlaceholder="Search person, code or department…" defaultSort={{ key: 'person_name', dir: 'asc' }}
        exportName="HR Advance register" exportSubtitle="HR & Payroll · Advance register" exportMeta={() => [owing && 'Only people who owe']}
        exportSummary={rs => [{ label: 'People', value: String(rs.length) }, { label: 'Outstanding', value: inr2(sumPaise(rs.map(a => a.balance))) }]}
        empty="No advances." />
    </>
  );
}
