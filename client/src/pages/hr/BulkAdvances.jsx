// HR · Loans & Advances › Bulk advances (owner's request 2026-11-05). Near the 24th–25th most people take an advance:
// one sheet holds them all for a payroll month, like the Excel sheet — every active person in a grid with what they
// owe now (advance and loans), the amount, Advance (default) or Loan with its months and why, and remarks. Submitted,
// it notifies management, who approve, mark not approved, or undo each line with their own remarks. Posted, every
// approved line becomes an advance (or loan) exactly as Pay staff makes it, so payroll recovers it. Excel / PDF for
// management from the table under the grid. Server: routes/hr-ledgers.js /hr/advance-sheets.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, CornerUpLeft, Plus, Send, Trash2, X } from 'lucide-react';
import { Button, DataTable, Field, Input, Modal, Select, useToast } from '../../components/ui.jsx';
import { hrApi, inr2, levelAtLeast, monthLabel } from '../../lib/hr.js';
import { list, paiseOf, plantMonth, plantToday, shiftMonth } from './RunLineDrawer.jsx';
import { InlineError, refusalText } from './PersonDrawer.jsx';

const STATUS = {
  draft: { label: 'Draft', tone: 'bg-[#1D1D1F]/[0.07] text-[#515154]' },
  submitted: { label: 'With management', tone: 'bg-amber-100 text-amber-900' },
  posted: { label: 'Posted', tone: 'bg-emerald-100 text-emerald-800' },
};
const DECISION = {
  pending: { label: 'Pending', tone: 'bg-[#1D1D1F]/[0.07] text-[#515154]' },
  approved: { label: 'Approved', tone: 'bg-emerald-100 text-emerald-800' },
  rejected: { label: 'Not approved', tone: 'bg-red-100 text-red-700' },
};
const Pill = ({ meta }) => <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold ${meta.tone}`}>{meta.label}</span>;
const P = v => paiseOf(v) ?? 0n;
const sumOf = (rows, f) => { const p = rows.reduce((t, r) => t + P(f(r)), 0n); const a = p < 0n ? -p : p; return `${p < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };
const cell = 'h-8 w-full rounded-lg border border-[#1D1D1F]/10 bg-white px-2 text-xs focus:border-[#0A84FF] focus:outline-none disabled:bg-transparent disabled:border-transparent';

function Tile({ label, value, sub, tone = '' }) {
  return (
    <div className="min-w-[130px] flex-1 rounded-2xl border border-white/70 bg-white/65 px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-[0.07em] text-[#1D1D1F]/40">{label}</div>
      <div className={`text-lg font-extrabold tabular-nums tracking-[-0.02em] text-[#1D1D1F] ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-[#6E6E73]">{sub}</div>}
    </div>
  );
}

function NewSheet({ channels, onClose, onMade }) {
  // Last month by default (2026-11-14): advances paid in November are deducted from October's payroll.
  const [month, setMonth] = useState(shiftMonth(plantMonth(), -1));
  const [paidOn, setPaidOn] = useState(plantToday());
  const [via, setVia] = useState('cash');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true); setError('');
    try { onMade(await hrApi.createAdvanceSheet({ month, paid_on: paidOn || null, paid_via: via })); } catch (e) { setError(refusalText(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="New bulk advance sheet"
      footer={<div className="flex w-full justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={make} disabled={busy || !month}>{busy ? 'Making…' : 'Make the sheet'}</Button></div>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Deduct from the payroll of" hint="Last month by default: in November, October's salary is paid."><Input type="month" value={month} onChange={e => setMonth(e.target.value)} /></Field>
        <Field label="Paid on" hint="Today by default; not before that payroll month starts."><Input type="date" value={paidOn} onChange={e => setPaidOn(e.target.value)} /></Field>
        <Field label="Paid via">
          <Select value={via} onChange={e => setVia(e.target.value || 'cash')}
            options={[{ value: 'cash', label: 'Cash' }, ...list(channels).map(c => ({ value: c.code, label: c.label || c.code }))]} />
        </Field>
      </div>
      <InlineError message={error} className="mt-3" />
    </Modal>
  );
}

// The entry grid. `draft` rows by person id: { kind, amount, instalments, purpose, remarks }.
function Sheet({ id, level, channels, onBack }) {
  const toast = useToast();
  const canEnter = levelAtLeast(level, 'accounts');
  const canApprove = levelAtLeast(level, 'approver');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(new Map());
  const [q, setQ] = useState('');
  const [onlyEntered, setOnlyEntered] = useState(false);
  const [busy, setBusy] = useState('');
  const [mgmt, setMgmt] = useState(new Map());   // management remarks being typed, by person id
  const [backing, setBacking] = useState(null);  // the send-back reason being typed
  const load = useCallback(async () => {
    try { setData(await hrApi.advanceSheet(id)); setError(''); } catch (e) { setError(refusalText(e)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const sheet = data?.sheet;
  const isDraft = sheet?.status === 'draft';
  const isSubmitted = sheet?.status === 'submitted';
  const lineBy = useMemo(() => new Map(list(data?.lines).map(l => [l.person_id, l])), [data]);
  const valueOf = (pid) => draft.get(pid) ?? (() => { const l = lineBy.get(pid); return l ? { kind: l.kind, amount: String(Number(l.amount)), instalments: l.instalments ? String(l.instalments) : '', purpose: l.purpose || '', remarks: l.remarks || '' } : { kind: 'advance', amount: '', instalments: '', purpose: '', remarks: '' }; })();
  const set = (pid, k, v) => setDraft(d => { const n = new Map(d); n.set(pid, { ...valueOf(pid), [k]: v }); return n; });
  const people = useMemo(() => {
    const all = list(data?.people);
    const needle = q.trim().toLowerCase();
    return all.filter(p => (!needle || `${p.name} ${p.code} ${p.department || ''}`.toLowerCase().includes(needle))
      && (!onlyEntered || lineBy.has(p.id) || draft.has(p.id)));
  }, [data, q, onlyEntered, lineBy, draft]);
  const inputs = useRef(new Map());
  const nextAmount = (pid, dir = 1) => {
    const order = people.map(p => p.id);
    const at = order.indexOf(pid) + dir;
    if (at >= 0 && at < order.length) inputs.current.get(order[at])?.focus();
  };
  const save = async () => {
    setBusy('save');
    try {
      const lines = [...draft].map(([person_id, v]) => ({ person_id, kind: v.kind, amount: v.amount.trim() === '' ? null : v.amount.trim(),
        instalments: v.kind === 'loan' ? v.instalments : null, purpose: v.kind === 'loan' ? v.purpose : null, remarks: v.remarks }));
      const d = await hrApi.setAdvanceSheetLines(id, lines);
      setData(cur => ({ ...cur, ...d })); setDraft(new Map());
      toast.success('Sheet saved');
      return true;
    } catch (e) { toast.error?.(refusalText(e)); setError(refusalText(e)); return false; } finally { setBusy(''); }
  };
  const act = async (key, fn, ok) => {
    setBusy(key); setError('');
    try { const d = await fn(); if (d?.sheet) setData(cur => ({ ...cur, ...d })); if (ok) toast.success(typeof ok === 'function' ? ok(d) : ok); await load(); }
    catch (e) { setError(refusalText(e)); } finally { setBusy(''); }
  };
  const decide = (ids, decision) => act(`d${ids.join(',')}${decision}`, () => hrApi.decideAdvanceSheet(id, {
    person_ids: ids, decision, ...(ids.length === 1 && mgmt.has(ids[0]) ? { mgmt_remarks: mgmt.get(ids[0]) } : {}),
  }));

  if (error && !data) return <InlineError message={error} />;
  if (!data) return <div className="p-8 text-sm text-slate-400">Opening the sheet…</div>;
  const t = data.totals;
  const lines = list(data.lines);
  const pending = lines.filter(l => l.decision === 'pending').map(l => l.person_id);
  const unposted = lines.filter(l => l.decision === 'approved' && !l.posted_at).length;
  const draftTotal = sumOf([...lineBy.keys(), ...draft.keys()].filter((v, i, a) => a.indexOf(v) === i), pid => valueOf(pid).amount || '0');

  const exportCols = [
    { key: 'name', label: 'Employee', export: r => `${r.name} (${r.code})`, render: r => <span className="font-semibold">{r.name} <span className="text-[#86868B]">{r.code}</span></span> },
    { key: 'department', label: 'Department', render: r => r.department || '—' },
    { key: 'kind', label: 'Type', export: r => (r.kind === 'loan' ? `Loan · ${r.instalments} months` : 'Advance'), render: r => (r.kind === 'loan' ? `Loan · ${r.instalments} mo` : 'Advance') },
    { key: 'amount', label: 'Amount', align: 'right', export: r => inr2(r.amount), render: r => <span className="tabular-nums font-semibold">{inr2(r.amount)}</span> },
    { key: 'advance_balance', label: 'Advance owed', align: 'right', export: r => inr2(r.advance_balance), render: r => <span className="tabular-nums">{inr2(r.advance_balance)}</span> },
    { key: 'loans_outstanding', label: 'Loans owed', align: 'right', export: r => inr2(r.loans_outstanding), render: r => <span className="tabular-nums">{inr2(r.loans_outstanding)}</span> },
    { key: 'purpose', label: 'Why (loan)', render: r => r.purpose || '—' },
    { key: 'remarks', label: 'Remarks', render: r => r.remarks || '—' },
    { key: 'mgmt_remarks', label: 'Management remarks', render: r => r.mgmt_remarks || '—' },
    { key: 'decision', label: 'Decision', export: r => DECISION[r.decision]?.label, render: r => <Pill meta={DECISION[r.decision] || DECISION.pending} /> },
  ];
  const personBy = new Map(list(data.people).map(p => [p.id, p]));
  const exportRows = lines.map(l => ({ ...l, id: l.person_id, advance_balance: personBy.get(l.person_id)?.advance_balance, loans_outstanding: personBy.get(l.person_id)?.loans_outstanding }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft size={14} /> All sheets</Button>
        <h3 className="text-base font-bold tracking-[-0.01em] text-[#1D1D1F]">{sheet.sheet_no} · advances for {monthLabel(sheet.month)}</h3>
        <Pill meta={STATUS[sheet.status] || STATUS.draft} />
        <span className="text-xs text-[#6E6E73]">paid on {sheet.paid_on} · {sheet.paid_via === 'cash' ? 'Cash' : (list(channels).find(c => c.code === sheet.paid_via)?.label || sheet.paid_via)}</span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          {isDraft && canEnter && <Button size="sm" variant="secondary" disabled={!draft.size || !!busy} onClick={save}>{busy === 'save' ? 'Saving…' : `Save${draft.size ? ` (${draft.size})` : ''}`}</Button>}
          {isDraft && canEnter && (
            <Button size="sm" disabled={!!busy || (!lines.length && !draft.size)}
              onClick={async () => { if (draft.size && !(await save())) return; act('submit', () => hrApi.submitAdvanceSheet(id), 'Sent to management for approval — they have been notified'); }}>
              <Send size={13} /> Send for approval
            </Button>
          )}
          {isSubmitted && canApprove && pending.length > 0 && <Button size="sm" disabled={!!busy} onClick={() => decide(pending, 'approved')}><Check size={13} /> Approve all pending ({pending.length})</Button>}
          {isSubmitted && canApprove && <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => setBacking('')}><CornerUpLeft size={13} /> Send back</Button>}
          {isSubmitted && canEnter && unposted > 0 && (
            <Button size="sm" disabled={!!busy} onClick={() => act('post', () => hrApi.postAdvanceSheet(id), d => `${d.posted} posted — payroll will recover ${d.posted === 1 ? 'it' : 'them'}${d.closed ? '' : '; the rest wait for a decision'}`)}>
              Post approved ({unposted})
            </Button>
          )}
          {isDraft && canEnter && !lines.some(l => l.posted_at) && (
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act('del', async () => { await hrApi.deleteAdvanceSheet(id); onBack(); return null; }, 'Sheet deleted')}><Trash2 size={13} /></Button>
          )}
        </span>
      </div>
      {sheet.status === 'draft' && sheet.sent_back_reason && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">Sent back by {sheet.sent_back_by_name || 'management'}: {sheet.sent_back_reason}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Tile label="People" value={String(t.lines)} sub={draft.size ? `${draft.size} change${draft.size === 1 ? '' : 's'} not saved` : 'on the sheet'} />
        <Tile label="Total" value={inr2(isDraft ? draftTotal : t.amount)} sub={`advances ${inr2(t.advance)} · loans ${inr2(t.loan)}`} />
        <Tile label="Approved" value={inr2(t.approved)} sub={`${t.approved_lines} approved`} tone="text-emerald-700" />
        <Tile label="Not approved" value={String(t.rejected_lines)} sub="lines" tone={t.rejected_lines ? 'text-red-700' : ''} />
        <Tile label="Pending" value={String(t.pending_lines)} sub="waiting for management" />
      </div>
      <InlineError message={error} />

      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, code, department…" className="max-w-xs" />
        <label className="flex items-center gap-1.5 text-xs text-[#515154]"><input type="checkbox" className="accent-[#007AFF]" checked={onlyEntered} onChange={e => setOnlyEntered(e.target.checked)} /> Only people with an entry</label>
        {isDraft && canEnter && <span className="text-[11px] text-[#86868B]">Type the amount; Enter or ↓ goes to the next person. Blank or 0 takes them off the sheet.</span>}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-white/75 bg-white/60">
        <table className="w-full min-w-[1100px] text-xs">
          <thead>
            <tr className="ci-table-head text-left">
              <th className="px-2 py-2">Employee</th>
              <th className="px-2 py-2 text-right">Advance owed</th>
              <th className="px-2 py-2 text-right">Loans owed</th>
              <th className="px-2 py-2">Type</th>
              <th className="px-2 py-2 text-right">Amount (₹)</th>
              <th className="px-2 py-2">Months</th>
              <th className="px-2 py-2">Why (loan)</th>
              <th className="px-2 py-2">Remarks</th>
              <th className="px-2 py-2">Management remarks</th>
              <th className="px-2 py-2">Decision</th>
            </tr>
          </thead>
          <tbody>
            {people.map(p => {
              const v = valueOf(p.id);
              const line = lineBy.get(p.id);
              const changed = draft.has(p.id);
              const edit = isDraft && canEnter;
              const dec = line?.decision || 'pending';
              return (
                <tr key={p.id} className={`ci-table-row ${changed ? 'bg-[#E1EFFF]/50' : line ? '' : 'opacity-80'}`}>
                  <td className="px-2 py-1.5"><div className="font-semibold text-[#1D1D1F]">{p.name}</div><div className="text-[10px] text-[#86868B]">{p.code}{p.department ? ` · ${p.department}` : ''}</div></td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{inr2(p.advance_balance)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{inr2(p.loans_outstanding)}</td>
                  <td className="px-2 py-1.5 w-[110px]">
                    <select className={cell} disabled={!edit} value={v.kind} onChange={e => set(p.id, 'kind', e.target.value)} aria-label={`Advance or loan for ${p.name}`}>
                      <option value="advance">Advance</option><option value="loan">Loan</option>
                    </select>
                  </td>
                  <td className="px-2 py-1.5 w-[120px]">
                    <input ref={el => { if (el) inputs.current.set(p.id, el); else inputs.current.delete(p.id); }} inputMode="decimal" className={`${cell} text-right tabular-nums`}
                      disabled={!edit} value={v.amount} onChange={e => set(p.id, 'amount', e.target.value)} aria-label={`Amount for ${p.name}`}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); nextAmount(p.id, 1); } if (e.key === 'ArrowUp') { e.preventDefault(); nextAmount(p.id, -1); } }} />
                  </td>
                  <td className="px-2 py-1.5 w-[80px]">{v.kind === 'loan' && <input inputMode="numeric" className={cell} disabled={!edit} value={v.instalments} placeholder="months" onChange={e => set(p.id, 'instalments', e.target.value)} aria-label={`Loan months for ${p.name}`} />}</td>
                  <td className="px-2 py-1.5 w-[160px]">{v.kind === 'loan' && <input className={cell} disabled={!edit} value={v.purpose} placeholder="why it is needed" onChange={e => set(p.id, 'purpose', e.target.value)} aria-label={`Why the loan for ${p.name}`} />}</td>
                  <td className="px-2 py-1.5 w-[170px]"><input className={cell} disabled={!edit} value={v.remarks} onChange={e => set(p.id, 'remarks', e.target.value)} aria-label={`Remarks for ${p.name}`} /></td>
                  <td className="px-2 py-1.5 w-[170px]">
                    {isSubmitted && canApprove && line
                      ? <input className={cell} value={mgmt.get(p.id) ?? line.mgmt_remarks ?? ''} onChange={e => setMgmt(m => new Map(m).set(p.id, e.target.value))} aria-label={`Management remarks for ${p.name}`} />
                      : <span className="text-[#515154]">{line?.mgmt_remarks || ''}</span>}
                  </td>
                  <td className="px-2 py-1.5">
                    {line ? (
                      <span className="flex flex-wrap items-center gap-1">
                        <Pill meta={DECISION[dec]} />
                        {line.posted_at && <span className="text-[10px] font-bold text-emerald-700">Posted{line.loan_no ? ` · ${line.loan_no}` : ''}</span>}
                        {isSubmitted && canApprove && !line.posted_at && (
                          <>
                            {dec !== 'approved' && <button type="button" className="rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-bold text-white" onClick={() => decide([p.id], 'approved')}>Approve</button>}
                            {dec !== 'rejected' && <button type="button" className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white" onClick={() => decide([p.id], 'rejected')}>Not approved</button>}
                            {dec !== 'pending' && <button type="button" className="rounded-full bg-[#1D1D1F]/[0.08] px-2 py-0.5 text-[10px] font-bold text-[#515154]" onClick={() => decide([p.id], 'pending')}>Undo</button>}
                          </>
                        )}
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {!people.length && <tr><td colSpan={10} className="px-3 py-6 text-center text-[#86868B]">Nobody matches.</td></tr>}
          </tbody>
          <tfoot>
            <tr className="border-t border-[#1D1D1F]/10 bg-white/70 font-bold">
              <td className="px-2 py-2">Total · {t.lines} on the sheet</td><td /><td /><td />
              <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{inr2(isDraft ? draftTotal : t.amount)}</td>
              <td colSpan={5} className="px-2 py-2 text-[11px] font-semibold text-[#515154]">approved {inr2(t.approved)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {lines.length > 0 && (
        <div>
          <h4 className="mb-1 mt-4 text-[10px] font-bold uppercase tracking-[0.07em] text-[#1D1D1F]/40">For management — Excel / PDF</h4>
          <DataTable columns={exportCols} rows={exportRows} getRowId={r => r.id} serialNumber dense
            exportName={`${sheet.sheet_no} advances ${sheet.month}`} exportSubtitle={`HR & Payroll · bulk advances for ${monthLabel(sheet.month)} · total ${inr2(t.amount)}`} />
        </div>
      )}

      {backing !== null && (
        <Modal open onClose={() => setBacking(null)} title={`Send ${sheet.sheet_no} back`}
          footer={<div className="flex w-full justify-end gap-2"><Button variant="ghost" onClick={() => setBacking(null)}>Cancel</Button>
            <Button disabled={!backing.trim() || !!busy} onClick={() => act('back', () => hrApi.sendBackAdvanceSheet(id, backing.trim()), 'Sent back for changes').then(() => setBacking(null))}>Send back</Button></div>}>
          <Field label="Why"><Input value={backing} onChange={e => setBacking(e.target.value)} autoFocus /></Field>
        </Modal>
      )}
    </div>
  );
}

export default function BulkAdvances({ level, channels }) {
  const [params, setParams] = useSearchParams();
  const open = params.get('sheet');
  const setOpen = id => setParams(p => { const n = new URLSearchParams(p); if (id) n.set('sheet', String(id)); else n.delete('sheet'); return n; }, { replace: true });
  const [sheets, setSheets] = useState(null);
  const [error, setError] = useState('');
  const [making, setMaking] = useState(false);
  const canEnter = levelAtLeast(level, 'accounts');
  useEffect(() => {
    if (open) return undefined;
    let live = true;
    hrApi.advanceSheets().then(d => { if (live) setSheets(list(d)); }, e => { if (live) setError(refusalText(e)); });
    return () => { live = false; };
  }, [open]);
  if (open) return <Sheet id={open} level={level} channels={channels} onBack={() => setOpen(null)} />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-[#515154]">One sheet for the month&rsquo;s advances: everyone in one grid, sent to management for approval, then posted so payroll recovers them.</p>
        {canEnter && <Button size="sm" className="ml-auto" onClick={() => setMaking(true)}><Plus size={14} /> New sheet</Button>}
      </div>
      <InlineError message={error} />
      {!sheets ? <div className="p-6 text-sm text-slate-400">Loading…</div> : !sheets.length ? (
        <p className="rounded-2xl border border-white/70 bg-white/60 px-4 py-6 text-center text-sm text-[#6E6E73]">No bulk advance sheet yet.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {sheets.map(s => (
            <button key={s.id} type="button" onClick={() => setOpen(s.id)}
              className="rounded-2xl border border-white/75 bg-white/65 p-3 text-left shadow-card transition hover:bg-white">
              <div className="flex items-center gap-2"><span className="font-bold text-[#1D1D1F]">{s.sheet_no}</span><Pill meta={STATUS[s.status] || STATUS.draft} /></div>
              <div className="mt-0.5 text-xs text-[#6E6E73]">For {monthLabel(s.month)} · paid on {s.paid_on}</div>
              <div className="mt-2 flex flex-wrap gap-x-4 text-xs">
                <span><b className="tabular-nums">{s.totals.lines}</b> people</span>
                <span>Total <b className="tabular-nums">{inr2(s.totals.amount)}</b></span>
                <span className="text-emerald-700">Approved <b className="tabular-nums">{inr2(s.totals.approved)}</b></span>
                {s.totals.pending_lines > 0 && <span className="text-amber-700">{s.totals.pending_lines} pending</span>}
              </div>
            </button>
          ))}
        </div>
      )}
      {making && <NewSheet channels={channels} onClose={() => setMaking(false)} onMade={d => { setMaking(false); setOpen(d.sheet.id); }} />}
    </div>
  );
}
