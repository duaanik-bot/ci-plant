// Board issue — shown at the start of a job's FIRST stage (cutting) whose
// Planning mix names more than one board. Confirming is one tap. Changing a
// quantity or a lot is an override and needs a reason, which lands on the
// timeline as a deviation.
//
// `status` tracks the /planning/:lineId/context fetch as THREE states, never
// collapsed into two. Stage start refuses (409) to single-board a job that
// carries a phase='plan' mix but no phase='issued' rows yet — so a client
// that cannot tell "this job has no mix" from "I could not find out whether
// it has one" would let a transient network blip reach Start and hard-block
// the machine on a 409 the operator never saw coming, having never been shown
// a board panel at all. 'idle' means there is nothing to check in the first
// place (not this job's first stage, or a gang card — out of scope for this
// feature by design, see Section.jsx) — Start proceeds exactly as it always
// did. Only 'loaded' with zero rows may take that same plain path; 'loading'
// and 'error' both block Start until resolved. No bypass for 'error' — see
// the plan's Task 11 note on why an escape hatch here defeats the point.
import { useState } from 'react';
import { PackageCheck, AlertTriangle, RefreshCw, Loader2 } from 'lucide-react';
import { Field, Input, Select } from './ui.jsx';
import PacketsOpened from './PacketsOpened.jsx';
import { rowCovers } from '../lib/boardMix.js';
import { fmt } from '../api.js';

export default function BoardIssue({
  status, mix = [], lots = [], rows, onChange, reason, onReason, plannedUps, onRetry,
  packetsOpened = {}, onPacketsOpened,
}) {
  // Hooks run unconditionally, before any of the early returns below.
  const [editing, setEditing] = useState(false);

  if (status === 'idle' || !status) return null;

  if (status === 'loading') {
    return (
      <section className="ci-form-panel border-dashed">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
          <Loader2 size={14} className="animate-spin" /> Loading this job's board plan…
        </div>
      </section>
    );
  }

  if (status === 'error') {
    return (
      <section className="ci-form-panel border-dashed border-red-200 bg-red-50/60">
        <div className="flex items-start gap-2 text-xs font-semibold text-red-700">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            Could not load this job's board plan. Starting is blocked until this loads —
            a board mix has to be confirmed before the run consumes stock.
          </span>
        </div>
        <button type="button" onClick={onRetry}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-red-100 px-2.5 py-1.5 text-[11px] font-bold text-red-700 hover:bg-red-200">
          <RefreshCw size={12} /> Retry
        </button>
      </section>
    );
  }

  // status === 'loaded'. A confirmed successful load with no rows means this
  // job genuinely issues its single planned board — nothing to confirm, and
  // the plain straight-to-start path is correct.
  if (!mix.length) return null;

  const changed = rows.some((r, i) => Number(r.sheets) !== Number(mix[i]?.sheets)
    || (r.stock_batch_id ?? null) !== (mix[i]?.stock_batch_id ?? null));

  const set = (i, patch) => onChange(rows.map((r, j) => {
    if (j !== i) return r;
    const next = { ...r, ...patch };
    // Sheets moved — covers must move with it, or the audit line's "N short of
    // the planned coverage" figure quotes the OLD quantity's coverage forever.
    // Board never changes here (that is Planning's job via BoardMix), so ups
    // is fixed per row and only sheets can invalidate covers.
    if ('sheets' in patch) {
      next.covers = plannedUps > 0 && next.ups > 0
        ? rowCovers({ sheets: next.sheets, ups: next.ups, plannedUps })
        : next.covers;
    }
    return next;
  }));

  return (
    <section className="ci-form-panel border-dashed">
      <div className="ci-form-panel-title">
        <span className="inline-flex items-center gap-1.5"><PackageCheck size={13} /> Board issue</span>
        <button type="button" onClick={() => {
          // Cancelling reverts to the plan, not just to a hidden input — a
          // half-typed edit must not linger as a silent, invisible deviation.
          if (editing) onChange(mix.map(x => ({ ...x })));
          setEditing(v => !v);
        }} className="text-[11px] font-semibold text-slate-500 hover:text-slate-700">
          {editing ? 'Cancel change' : 'Different to the plan?'}
        </button>
      </div>

      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="rounded-lg bg-slate-50 px-2.5 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-semibold text-slate-700">{mix[i]?.board_name}</span>
              {!editing && <span className="shrink-0 font-bold">{fmt.num(r.sheets)} sheets</span>}
            </div>
            {editing && (
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <Field label="Sheets">
                  <Input type="number" min="1" value={r.sheets}
                    onChange={e => set(i, { sheets: +e.target.value })} />
                </Field>
                <Field label="Lot" hint="blank = FIFO">
                  <Select value={r.stock_batch_id ?? ''}
                    onChange={e => set(i, { stock_batch_id: e.target.value ? +e.target.value : null })}>
                    <option value="">FIFO — oldest first</option>
                    {lots.filter(l => l.material_id === r.material_id)
                      .map(l => <option key={l.id} value={l.id}>{l.batch_no} — {fmt.num(l.qty)}</option>)}
                  </Select>
                </Field>
              </div>
            )}
            {/* Counted loose, per board. Shown whether or not the row is being
                edited: how many packets were broken is a fact about the PICK,
                not a deviation from the plan, and a job issuing exactly as
                planned still opened bundles. Blank leaves the server to move
                loose by the implied rule, so this never stands between the
                operator and Start. */}
            {typeof onPacketsOpened === 'function' && (
              <PacketsOpened
                packetSize={mix[i]?.sheets_per_packet} sheets={r.sheets}
                value={packetsOpened[mix[i]?.material_id] ?? null}
                onChange={v => onPacketsOpened({ ...packetsOpened, [mix[i]?.material_id]: v })} />
            )}
          </div>
        ))}
      </div>

      {!editing && !changed && (
        <p className="mt-2 text-[11px] font-semibold text-emerald-600">
          Issuing exactly as planned — tap Start to confirm.
        </p>
      )}

      {changed && (
        <>
          <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700">
            <AlertTriangle size={12} className="mt-px shrink-0" />
            This differs from what Planning allocated. It will be recorded as a deviation.
          </p>
          <Field label="Reason" required className="mt-2">
            <Input value={reason} placeholder="Why is the issue different?"
              onChange={e => onReason(e.target.value)} />
          </Field>
        </>
      )}
    </section>
  );
}
