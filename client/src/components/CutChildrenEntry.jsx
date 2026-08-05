// Per-board children entry at cutting completion — the client half of the
// server's `cut_children` contract (production.js's completion handler): a job
// that cut MORE THAN ONE board is judged per board, so the server REQUIRES
// [{material_id, children}] — whole numbers ≥ 0, one entry per issued board,
// summing exactly to output + wastage — and 400/409s anything else. Until this
// component existed no client sent it, so a multi-board cutting completion
// dead-ended on that 400 from every screen.
//
// Shared by Production.jsx, Floor.jsx and Section.jsx — the three screens that
// complete cutting — exactly as PlannedBreakup already is, so the operator
// meets ONE entry form wherever the completion happens. Renders nothing for a
// single pile (no mix, or a one-board mix): the server derives those from the
// stage totals as it always has, and the completion form stays byte-identical.
//
// `mixCuts` is the row's own `mix_cuts` payload ([{material_id, board_name,
// issued, cuts}], planned board first) — carried by the row itself, never
// fetched here, so the entry can't be lost to a failed side-load the way the
// fail-open PlannedBreakup recap can.
import { fmt } from '../api.js';
import { Field, Input } from './ui.jsx';

// Does this row's completion owe the server a per-board entry at all?
export const needsCutChildren = (stage, mixCuts) =>
  stage === 'cutting' && Array.isArray(mixCuts) && mixCuts.length > 1;

// Opening values: each board's own expected children (issued × cuts), so the
// clean on-plan completion stays the one-click close it has always been — the
// same reason the counter itself opens pre-filled.
export const seedCutChildren = mixCuts =>
  Object.fromEntries((mixCuts || []).map(m => [
    m.material_id,
    String(Math.max(0, Math.round(+m.issued || 0)) * Math.max(1, +m.cuts || 1)),
  ]));

const rowsOf = (mixCuts, entries) =>
  (mixCuts || []).map(m => ({ material_id: m.material_id, children: Number(entries?.[m.material_id]) }));

// What the completion POST sends — null while any entry is not a whole number
// of sheets ≥ 0 (the server's own validation, applied before the click).
export const cutChildrenPayload = (mixCuts, entries) => {
  const rows = rowsOf(mixCuts, entries);
  return rows.every(r => Number.isInteger(r.children) && r.children >= 0) ? rows : null;
};

export const cutChildrenTotal = (mixCuts, entries) =>
  rowsOf(mixCuts, entries).reduce((s, r) => s + (Number.isFinite(r.children) ? r.children : 0), 0);

// The gate a Complete button applies: entries valid AND Σ = output + wastage —
// the exact pair the server 400/409s on, checked before the click instead of
// after it.
export const cutChildrenOk = (mixCuts, entries, declared) =>
  cutChildrenPayload(mixCuts, entries) !== null
  && cutChildrenTotal(mixCuts, entries) === Math.round(+declared || 0);

// Client preview of the server's per-board variance (mixCuttingVariance): a
// board whose children don't round back to its issued parents is a variance,
// and the server then demands a shared reason. Section.jsx keys its reason
// gate and panel off this so the demand is visible before the click.
export const cutChildrenVariance = (mixCuts, entries) => {
  const rows = (mixCuts || []).map(m => {
    const cpp = Math.max(1, +m.cuts || 1);
    const children = Number(entries?.[m.material_id]);
    const actualParents = Number.isFinite(children) ? Math.round(children / cpp) : 0;
    const plannedParents = Math.max(0, Math.round(+m.issued || 0));
    return { ...m, cpp, actualParents, plannedParents, parentDelta: actualParents - plannedParents };
  });
  return { rows, isVariance: rows.some(r => r.parentDelta !== 0) };
};

export default function CutChildrenEntry({ mixCuts, entries, onChange, declared }) {
  if (!Array.isArray(mixCuts) || mixCuts.length <= 1) return null;
  const total = cutChildrenTotal(mixCuts, entries);
  const target = Math.round(+declared || 0);
  const valid = cutChildrenPayload(mixCuts, entries) !== null;
  const matches = valid && total === target;
  return (
    <section className="ci-form-panel">
      <div className="ci-form-panel-title">
        <span>Child sheets cut, per board</span>
        <span>{mixCuts.length} piles — each is its own count</span>
      </div>
      <div className="ci-form-grid">
        {mixCuts.map(m => {
          const cuts = Math.max(1, +m.cuts || 1);
          const issued = Math.max(0, Math.round(+m.issued || 0));
          return (
            <Field key={m.material_id} label={m.board_name} required
              hint={`${fmt.num(issued)} parents × ${cuts} cuts = ${fmt.num(issued * cuts)} expected`}>
              <Input type="number" min="0" step="1" value={entries?.[m.material_id] ?? ''}
                onChange={e => onChange({ ...entries, [m.material_id]: e.target.value })} />
            </Field>
          );
        })}
      </div>
      <p className={`mt-2 rounded-lg px-3 py-1.5 text-xs font-semibold ${
        matches ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
        {valid
          ? <>Boards add to <b>{fmt.num(total)}</b> — {matches
              ? 'matches output + wastage ✓'
              : <>output + wastage is <b>{fmt.num(target)}</b>; they must match</>}</>
          : 'Each board needs a whole number of child sheets (0 or more)'}
      </p>
    </section>
  );
}
