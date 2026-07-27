// Partial day counts — one engine behind two doors.
//
// A station records output over several days instead of one shot ("12,000 of
// 50,000 today"). Operators reach that from a "Day count" button on the queue
// row, OR from the Partial/Final choice at the top of the completion form. Both
// doors post through postRun() below, so the two paths can never drift apart.
//
// A stage takes as MANY partials as the floor needs — two, three, four, or a
// last entry of 1 to close out a bundle. The operator types today's figure by
// default; the cumulative machine-counter reading stays one click away for the
// stations where that is what the operator is looking at. Both bases resolve
// through partialEntry.js, so the form and the server always agree on the run.
// QC enters today's accepted/rejected; rework, inspector and the Finished Goods
// credit stay final-only.
import { useCallback, useEffect, useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, Field, Input, Modal, Select } from './ui.jsx';
import { resolveEntry, partialBlockers } from '../lib/partialEntry.js';
import { Trash2, AlertTriangle } from 'lucide-react';

// The one save path. Everything that records a partial goes through here.
export async function postRun(stageId, { good, scrap, reason }) {
  return api.post(`/job-stages/${stageId}/runs`, {
    qty_good: Math.max(0, good || 0),
    qty_scrap: Math.max(0, scrap || 0),
    scrap_reason: scrap > 0 ? reason || undefined : undefined,
  });
}

// Day-wise run log for a stage, with the rollup the forms measure against.
export function useStageRuns(stageId) {
  const [runLog, setRunLog] = useState(null);
  const reload = useCallback(() => {
    if (!stageId) return setRunLog(null);
    api.get(`/job-stages/${stageId}/runs`).then(setRunLog).catch(() => setRunLog(null));
  }, [stageId]);
  useEffect(() => { setRunLog(null); reload(); }, [stageId, reload]);
  const removeRun = useCallback(async run => {
    await api.del(`/job-stages/${stageId}/runs/${run.id}`);
    reload();
  }, [stageId, reload]);
  return {
    runLog,
    reload,
    removeRun,
    priorGood: runLog?.rollup?.qty_good || 0,
    priorScrap: runLog?.rollup?.qty_scrap || 0,
  };
}

// "Recorded so far" — what the stage already holds, newest work at the bottom.
// onDelete is omitted once the stage is closed, so a completed run is read-only.
export function RunLogPanel({ runLog, onDelete, children }) {
  if (!runLog?.runs?.length) return null;
  const { qty_good = 0, qty_scrap = 0 } = runLog.rollup || {};
  return (
    <div className="mb-3 rounded-xl border border-cyan-200 bg-cyan-50/50 p-3">
      <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wide text-cyan-800">
        <span>Recorded so far</span>
        <span className="tabular-nums">{fmt.num(qty_good)} good · {fmt.num(qty_scrap)} waste</span>
      </div>
      <table className="mt-2 w-full text-xs">
        <tbody>
          {runLog.runs.map(run => (
            <tr key={run.id} className="border-t border-cyan-100">
              <td className="py-1.5 pr-2 tabular-nums text-slate-500">{fmt.date(run.run_date)}</td>
              <td className="py-1.5 pr-2 text-right font-semibold tabular-nums text-emerald-700">{fmt.num(run.qty_good)}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums text-red-600">
                {run.qty_scrap > 0
                  ? <>{fmt.num(run.qty_scrap)}{run.scrap_reason && <span className="ml-1 text-[10px] text-red-400">({run.scrap_reason})</span>}</>
                  : <span className="text-slate-300">—</span>}
              </td>
              <td className="py-1.5 pr-2 text-[11px] text-slate-500">{run.operator || '—'}{run.note ? ` · ${run.note}` : ''}</td>
              <td className="py-1.5 text-right">
                {onDelete && (
                  <button type="button" title="Remove this day count" onClick={() => onDelete(run)}
                    className="rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-500">
                    <Trash2 size={12} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {children}
    </div>
  );
}

// The three numbers an operator needs at any count: what the stage already
// holds, what THIS entry adds, and the resulting total. The server writes a
// balancing "closing balance" run for (total − prior), so `adding` here mirrors
// exactly what will be recorded. Shown on every completion surface so previous
// totals and the new entry read the same whether the field is cumulative
// (counter stations, type the total) or today's-figure (QC / Sort & Paste).
export function CumulativeSummary({ prior = 0, total = 0, unit = 'units', enteredIsDelta = false, className = '' }) {
  if (prior <= 0) return null;              // nothing recorded yet — one figure says it all
  const adding = enteredIsDelta ? total : Math.max(0, total - prior);
  const grand = enteredIsDelta ? prior + total : total;
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-cyan-50 px-3 py-2 text-xs font-semibold ${className}`}>
      <span className="text-slate-500">Already recorded <b className="tabular-nums text-slate-800">{fmt.num(prior)}</b></span>
      <span className="text-cyan-700">+ Adding now <b className="tabular-nums">{fmt.num(adding)}</b></span>
      <span className="ml-auto text-emerald-700">Total <b className="tabular-nums">{fmt.num(grand)}</b> {unit}</span>
    </div>
  );
}

// How the number in the box should be read. Only ever shown once a stage HAS a
// log — on a first count the two bases are the same figure, so the choice would
// be noise. Default is "Adding now": an operator asked for a partial almost
// always means the quantity he just ran, not a running total.
export function BasisToggle({ basis, onChange, unit = 'units', prior = 0, className = '' }) {
  if (prior <= 0) return null;
  const opt = (key, label, hint) => (
    <button type="button" onClick={() => onChange(key)} title={hint}
      className={`flex-1 rounded-lg px-2.5 py-1.5 text-left transition-all ${basis === key
        ? 'bg-white shadow-sm ring-2 ring-cyan-400'
        : 'bg-transparent hover:bg-white/60'}`}>
      <div className={`text-xs font-bold ${basis === key ? 'text-cyan-800' : 'text-slate-500'}`}>{label}</div>
      <div className="text-[10px] leading-tight text-slate-400">{hint}</div>
    </button>
  );
  return (
    <div className={`flex gap-1 rounded-xl bg-slate-100 p-1 ${className}`}>
      {opt('delta', 'Adding now', `${unit} run since the last count`)}
      {opt('total', 'Counter total', `cumulative reading — ${fmt.num(prior)} logged`)}
    </div>
  );
}

// The fork every completion form now opens with: is this today's count, or the
// figure that closes the stage? `shortfall` switches it from a neutral prompt to
// the amber challenge shown when a Final entry reads below what was expected.
export function ModeChoice({ mode, onChoose, isQC, shortfall = null, className = '' }) {
  const amber = !!shortfall;
  return (
    <div className={`mb-3 rounded-xl border-2 p-3 ${amber ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-slate-50/70'} ${className}`}>
      {amber ? (
        <>
          <div className="flex items-center gap-2 text-sm font-bold text-amber-800">
            <AlertTriangle size={15} />
            Counter is short — {fmt.num(shortfall.entered)} of {fmt.num(shortfall.expected)} {isQC ? 'accounted for' : 'expected'}
          </div>
          <p className="mt-1 text-xs text-amber-700">Is this a partial day count, or the final figure for this stage?</p>
        </>
      ) : (
        <p className="text-xs font-semibold text-slate-500">
          Recording today's output, or closing the stage?
        </p>
      )}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => onChoose('partial')}
          className={`rounded-xl border-2 p-2.5 text-left transition-all ${mode === 'partial' ? 'border-cyan-500 bg-cyan-50 ring-2 ring-cyan-200' : 'border-slate-200 bg-white hover:border-cyan-300'}`}>
          <div className="text-sm font-bold text-cyan-800">Day count — more to come</div>
          <div className="mt-0.5 text-[11px] leading-snug text-slate-500">
            Save today's count and keep the job open here. Nothing goes to wastage.
          </div>
        </button>
        <button type="button" onClick={() => onChoose('final')}
          className={`rounded-xl border-2 p-2.5 text-left transition-all ${mode === 'final' ? 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200' : 'border-slate-200 bg-white hover:border-emerald-300'}`}>
          <div className="text-sm font-bold text-emerald-800">Final — complete the stage</div>
          <div className="mt-0.5 text-[11px] leading-snug text-slate-500">
            {isQC ? 'Close QC with these totals.' : 'Close the stage — the shortfall counts as wastage unless you edit it.'}
          </div>
        </button>
      </div>
    </div>
  );
}

// Standalone day-count modal — the row-button door. Self-contained: it owns the
// run log, the arithmetic and the save, so a board only has to say which stage.
//
// `variant` picks the arithmetic: 'counter' reads cumulatively off the machine,
// 'qc' takes today's accepted/rejected. `onStageNeedsStart` lets a board start a
// still-pending stage first (QC batches sit pending until someone inspects).
export function DayCountDialog({
  open, onClose, onSaved, stageId, title, subtitle,
  variant = 'counter', unit = 'units', expected = 0, reasons = [],
  onStageNeedsStart = null,
}) {
  const { runLog, reload, removeRun, priorGood, priorScrap } = useStageRuns(open ? stageId : null);
  const [form, setForm] = useState({ good: '', scrap: '0', reason: '' });
  // QC has only ever typed today's figure, so it is delta by definition and
  // never offered the choice. Counter stations default to the same thing.
  const [basis, setBasis] = useState('delta');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (open) { setForm({ good: '', scrap: '0', reason: '' }); setBasis('delta'); setErr(''); }
  }, [open, stageId]);

  const isQC = variant === 'qc';
  const scrap = +form.scrap || 0;
  const entryBasis = isQC ? 'delta' : basis;
  const { adding: todayGood, total: newTotal, belowLog } =
    resolveEntry({ basis: entryBasis, entered: form.good, priorGood });
  const blockers = partialBlockers({
    basis: entryBasis, entered: form.good, priorGood, scrap, scrapReason: form.reason,
  });
  const stillToGo = Math.max(0, expected - newTotal);

  const save = async () => {
    setSaving(true); setErr('');
    try {
      if (onStageNeedsStart) await onStageNeedsStart();
      await postRun(stageId, { good: todayGood, scrap, reason: form.reason });
      onSaved?.({ good: todayGood, scrap });
      onClose();
    } catch (e) {
      setErr(e.message || 'Could not save the day count');
      reload();
    } finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={title}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={saving || blockers.length > 0}>
          Save Day Count — Job Continues
        </Button>
      </>}>
      <div className="space-y-3">
        {subtitle && <div className="ci-summary-panel text-xs">{subtitle}</div>}
        <RunLogPanel runLog={runLog} onDelete={removeRun}>
          {/* A cumulative reading under the log is a typo, not a dead end — the
              same keystrokes are almost always today's figure, so offer that. */}
          {belowLog && (
            <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] font-semibold text-amber-800">
              {fmt.num(+form.good || 0)} is below the {fmt.num(priorGood)} already logged.
              <button type="button" onClick={() => setBasis('delta')}
                className="ml-1 underline decoration-dotted underline-offset-2 hover:text-amber-900">
                Is {fmt.num(+form.good || 0)} what you ran just now? Switch to “Adding now”.
              </button>
            </p>
          )}
          {!belowLog && todayGood > 0 && (
            <p className="mt-2 text-[11px] font-semibold text-cyan-700">
              Adds {fmt.num(todayGood)} to the log · stage reaches {fmt.num(newTotal)} {unit}.
            </p>
          )}
        </RunLogPanel>
        <section className="ci-form-panel">
          <div className="ci-form-panel-title">
            <span>{isQC ? 'Inspected today' : 'Counter entry'}</span>
            <span>Day count</span>
          </div>
          {!isQC && (
            <BasisToggle basis={basis} onChange={setBasis} unit={unit} prior={priorGood} className="mb-2.5" />
          )}
          <div className="ci-form-grid">
            <Field
              label={isQC
                ? `Accepted today (${unit})`
                : entryBasis === 'total' && priorGood > 0
                  ? `Counter reading now — total good ${unit}`
                  : `Good ${unit} run now`}
              required
              hint={isQC
                ? 'Only what you cleared today — Finished Goods is credited at the final pass'
                : entryBasis === 'total' && priorGood > 0
                  ? `Cumulative, as the machine reads — ${fmt.num(priorGood)} already recorded`
                  : priorGood > 0
                    ? `Just this lot — it is added to the ${fmt.num(priorGood)} already recorded`
                    : 'The balance stays pending, not wasted'}>
              <Input type="number" min="0" value={form.good} autoFocus
                onChange={e => setForm(f => ({ ...f, good: e.target.value }))} />
            </Field>
            <Field label={isQC ? `Rejected today (${unit}) — optional` : `Wastage today (${unit}) — optional`}>
              <Input type="number" min="0" value={form.scrap}
                onChange={e => setForm(f => ({ ...f, scrap: e.target.value }))} />
            </Field>
          </div>
        </section>
        {scrap > 0 && (
          <section className="ci-form-panel">
            <Field label={isQC ? 'Rejection reason (NCR)' : 'Wastage reason'} required>
              {reasons.length ? (
                <Select value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}>
                  <option value="">Select reason…</option>
                  {reasons.map(r => <option key={r} value={r}>{r}</option>)}
                </Select>
              ) : (
                <Input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                  placeholder="Why were pieces lost?" />
              )}
            </Field>
          </section>
        )}
        {expected > 0 && (
          <p className="rounded-lg bg-cyan-50 px-3 py-2 text-xs font-semibold text-cyan-700">
            {fmt.num(newTotal)} of {fmt.num(expected)} {unit} after this count
            {stillToGo > 0 && <> · {fmt.num(stillToGo)} still to go</>}
            {priorScrap > 0 && <span className="text-red-600"> · {fmt.num(priorScrap + scrap)} waste so far</span>}
          </p>
        )}
        {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{err}</p>}
      </div>
    </Modal>
  );
}
