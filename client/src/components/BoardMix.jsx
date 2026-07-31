// Board Mix — the boards a job will actually consume, beside the one it was
// planned on. Grade is fixed; GSM (and sometimes size) is what flexes.
//
// Redesigned 2026-07-31 per the plant owner's own words: "the row should say
// this is the number of ups which we are on this board, and this is the
// quantity" — each row states ITS OWN board's ups, never a comparison against
// the plan. And: "the total of totals ... this is our total" — a plain ledger
// (Total vs Required), not a hero balance banner. "A very simple yet
// effective system." No severity chips, no per-row reason field — one shared
// reason for the whole mix.
//
// Moved into its own LEFT-column card (was inside the right-hand Board
// Position card) so the boards a job actually consumes sit beside its own
// spec, not buried under warehouse intelligence — "whatever coverage we are
// going to do should be on the left side". This component owns no border/
// margin of its own any more; Planning.jsx's Card wrapper supplies the frame.
import { Plus, X, AlertTriangle } from 'lucide-react';
import { Button, Input, Select } from './ui.jsx';
import { rowCovers, mixBalance } from '../lib/boardMix.js';
import { parseBoardName } from '../lib/boardCode.js';
import { fmt } from '../api.js';

// The balance the planner sees MUST be the balance the release gate computes,
// so both sides run the same functions — the client twin of board-mix.js, per
// the convention boardMath / boardCode / replenishment already follow. A
// hand-rolled copy here would drift from the gate and show a green zero on a
// job the server still refuses.
//
// Rows are recomputed rather than read from the stored `covers` because the
// planner is editing them; the server recomputes identically on save with the
// same rowCovers, and re-planning clears the mix, so stored and derived can
// never disagree on a saved row.
//
// The ups guard is a RENDER guard, not a semantic one: rowCovers throws by
// design, and a throw inside a map during render blanks the screen on a
// half-typed row. Zero coverage leaves the balance non-zero, which disables the
// save button — fail-closed, and the server still throws if it ever arrives.
export function mixTotals(rows, plannedUps, required) {
  const priced = rows.map(r => ({
    covers: plannedUps > 0 && r.ups > 0 ? rowCovers({ sheets: r.sheets, ups: r.ups, plannedUps }) : 0,
  }));
  return mixBalance({ required, rows: priced });
}

export default function BoardMix({ ctx, required, rows, onChange }) {
  const mix = ctx?.mix;
  if (!mix) return null;

  // A gang shares ONE board across every member job and buys it on a single
  // combined PR (gangs.js gangDetail — out of scope for the mix by design).
  // plan-save 409s the instant a gang line's mix is non-empty ("prints in a
  // gang — move the gang's board from Planning"), so say that up front rather
  // than let a planner fill in rows that can only ever be refused.
  if (ctx.gang) {
    return (
      <p className="rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-500">
        This job prints in a gang, which shares one board across every member. Change the
        gang's board from the Gang panel below rather than mixing boards on a single job.
      </p>
    );
  }

  const plannedUps = mix.planned_ups;
  const { balance, balanced } = mixTotals(rows, plannedUps, required);
  const totalSheets = rows.reduce((s, r) => s + Number(r.sheets || 0), 0);
  // Cartons = sheets × that row's OWN ups — the arithmetic the plant does on
  // paper ("2,500 at 6-up is 15,000 cartons"), so the ledger's grand total can
  // be read against the order quantity at sight.
  const cartonsOf = r => Math.round((Number(r.sheets) || 0) * (Number(r.ups) || 0));
  const totalCartons = rows.reduce((s, r) => s + cartonsOf(r), 0);
  const candidateList = mix.candidates || [];
  const byId = new Map(candidateList.map(c => [c.id, c]));
  const hasCandidates = candidateList.length > 0;

  // Exactly one board name in the live master fails to parse ("Unspecified
  // board"). substitutionFlags blocks every candidate against an unparseable
  // planned board, so the list comes back empty with nothing to tell that
  // apart from "no stock anywhere of this grade" — say which one it is.
  const plannedName = ctx?.line?.board_name;
  const plannedUnspecified = !parseBoardName(plannedName);

  // "There should not be any duplicacy of the material which is already
  // being used" — a board already sitting in the mix must not be offered
  // again in another row's dropdown. usedElsewhere is keyed off every OTHER
  // row (never the row being edited itself, or its own current board would
  // vanish from its own Select).
  const usedElsewhere = row => new Set(rows.filter(r => r !== row).map(r => r.material_id));

  // A 'planned'-role row's own board is deliberately excluded from
  // `candidates` — the server only ever offers SUBSTITUTES there — so its
  // Select would otherwise show blank despite holding the right value. Same
  // fallback covers a substitute whose stock ran out since it was added: its
  // board no longer appears in the live candidate list either.
  const optionsFor = row => {
    const used = usedElsewhere(row);
    const list = candidateList.filter(c => !used.has(c.id));
    return list.some(c => c.id === row.material_id)
      ? list
      : [{ id: row.material_id, name: row.board_name || 'Current board', available: null }, ...list];
  };

  // Same no-duplicates rule for "+ Add board": offer (and default-select) the
  // first candidate not already sitting in some row, and disable the button
  // outright once every candidate of this grade is already in the mix.
  const addableCandidates = candidateList.filter(c => !rows.some(r => r.material_id === c.id));
  const add = () => {
    const first = addableCandidates[0];
    if (!first) return;
    onChange([...rows, {
      material_id: first.id, board_name: first.name, ups: first.ups,
      sheets: Math.max(0, Math.round(balance / (first.ups / plannedUps))),
      stock_batch_id: null, reason: '', severity: first.severity, gsm_delta: first.gsm_delta,
      ups_differ: first.ups_differ, size_differs: first.size_differs, available: first.available,
    }]);
  };
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const drop = i => onChange(rows.filter((_, j) => j !== i));

  const pick = (i, id) => {
    const nid = +id;
    // Picking back to the planned board resolves against a synthetic entry
    // (see optionsFor above) rather than `candidates`, which never carries it.
    const c = byId.get(nid) ?? (nid === mix.planned_board_id
      ? { id: nid, name: plannedName, ups: plannedUps, severity: 'none',
          gsm_delta: 0, ups_differ: false, size_differs: false, available: null }
      : null);
    if (!c) return;
    set(i, { material_id: c.id, board_name: c.name, ups: c.ups, stock_batch_id: null,
             severity: c.severity, gsm_delta: c.gsm_delta, ups_differ: c.ups_differ,
             size_differs: c.size_differs, available: c.available });
  };

  // One reason for the whole mix, not one per row — the owner never wanted to
  // type it more than once. `reason` still lives on every substitute row
  // because the server contract is unchanged (it 400s on any substitute row
  // with an empty reason), so the shared field is a plain read/write-through
  // onto every substitute row's `reason` rather than separate state: typing
  // here writes to all of them at once, and reopening a saved mix reads the
  // field straight back out of the first substitute row — nothing extra to
  // seed on load.
  const isSubstitute = r => r.severity && r.severity !== 'none';
  const hasSubstitutes = rows.some(isSubstitute);
  const sharedReason = rows.find(isSubstitute)?.reason || '';
  const setSharedReason = value => onChange(rows.map(r => (isSubstitute(r) ? { ...r, reason: value } : r)));

  return (
    <div>
      {rows.length === 0 && plannedUnspecified && (
        <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] font-medium text-amber-700">
          This job's board ({plannedName || 'no name recorded'}) has no grade recorded, so no
          substitute can be matched to it. Fix the board master's name to enable a mix.
        </p>
      )}
      {rows.length === 0 && !plannedUnspecified && !hasCandidates && (
        <p className="rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-500">
          No other board of this grade currently has stock. This job issues its planned board only.
        </p>
      )}
      {rows.length === 0 && !plannedUnspecified && hasCandidates && (
        <p className="rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-500">
          This job issues its planned board only. Add a board to split the issue across
          several — same grade, any GSM.
        </p>
      )}

      {/* A plain table: Board, Ups, Sheets — each row states its OWN board's
          ups, never a comparison against the plan. */}
      {rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-[#1D1D1F]/[0.08] bg-white/60">
          <div className="grid grid-cols-[1fr_44px_96px_76px_28px] items-center gap-2 border-b border-[#1D1D1F]/[0.06] bg-slate-50/80 px-3 py-1.5 text-[9px] font-bold uppercase tracking-wider text-slate-400">
            <span>Board</span>
            <span className="text-right">Ups</span>
            <span className="text-right">Sheets</span>
            <span className="text-right">Cartons</span>
            <span />
          </div>
          <div className="divide-y divide-[#1D1D1F]/[0.06]">
            {rows.map((r, i) => {
              const lots = (mix.lots || []).filter(l => l.material_id === r.material_id);
              const over = r.available != null && r.sheets > r.available;
              const isPlanned = r.severity === 'none';
              return (
                <div key={i} className="px-3 py-2.5">
                  <div className="grid grid-cols-[1fr_44px_96px_76px_28px] items-start gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <div className="min-w-0 flex-1">
                          <Select value={r.material_id} onChange={e => pick(i, e.target.value)}>
                            {optionsFor(r).map(c => (
                              <option key={c.id} value={c.id}>
                                {c.name}{c.available != null ? ` — ${fmt.num(c.available)} free` : ''}
                              </option>
                            ))}
                          </Select>
                        </div>
                        {isPlanned && (
                          <span className="shrink-0 rounded-full bg-brand-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-brand-600">
                            Planned
                          </span>
                        )}
                      </div>
                      {/* Lot — kept, but a small secondary control that never
                          competes with Board / Ups / Sheets. Same options as
                          before: blank = FIFO. */}
                      <select
                        title="blank = FIFO, oldest first"
                        value={r.stock_batch_id ?? ''}
                        onChange={e => set(i, { stock_batch_id: e.target.value ? +e.target.value : null })}
                        className="mt-1 w-full max-w-[220px] rounded-md border border-[#1D1D1F]/[0.10] bg-transparent px-1.5 py-0.5 text-[10px] font-medium text-slate-500 outline-none focus:border-[#0A84FF]"
                      >
                        <option value="">FIFO — oldest first</option>
                        {lots.map(l => <option key={l.id} value={l.id}>{l.batch_no} — {fmt.num(l.qty)}</option>)}
                      </select>
                    </div>
                    <div className={`pt-2.5 text-right text-sm font-extrabold tabular-nums ${r.ups_differ ? 'text-red-600' : 'text-slate-700'}`}>
                      {r.ups}
                    </div>
                    <Input type="number" min="1" value={r.sheets} className="text-right"
                      onChange={e => set(i, { sheets: +e.target.value })} />
                    {/* Derived, never typed: sheets × this row's own ups. */}
                    <div className="pt-2.5 text-right text-sm font-semibold tabular-nums text-slate-500">
                      {fmt.num(cartonsOf(r))}
                    </div>
                    <button type="button" onClick={() => drop(i)} title="Remove this board"
                      className="mt-1.5 justify-self-end shrink-0 rounded-lg p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600">
                      <X size={14} />
                    </button>
                  </div>
                  {r.ups_differ && (
                    <p className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-700">
                      <AlertTriangle size={12} className="mt-px shrink-0" />
                      Cuts {r.ups} up against the plan's {plannedUps} up — needs its own plate, so it can't be saved.
                    </p>
                  )}
                  {over && (
                    <p className="mt-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700">
                      Only {fmt.num(r.available)} sheets are free on this board.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* LEDGER FOOTER — the plain running total the owner asked for:
              what's been used, against what's required. */}
          <div className="border-t border-[#1D1D1F]/[0.08] bg-slate-50/80 px-3 py-2">
            {/* Totals align under their own columns, so the eye adds straight
                down: Sheets over sheets, Cartons over cartons. */}
            <div className="grid grid-cols-[1fr_44px_96px_76px_28px] items-center gap-2 text-xs">
              <span className="font-bold text-slate-500">Total — {rows.length} board{rows.length === 1 ? '' : 's'}</span>
              <span />
              <span className="text-right font-extrabold tabular-nums text-slate-800">{fmt.num(totalSheets)}</span>
              <span className="text-right font-extrabold tabular-nums text-slate-800">{fmt.num(totalCartons)}</span>
              <span />
            </div>
            <div className="mt-0.5 grid grid-cols-[1fr_44px_96px_76px_28px] items-center gap-2 text-xs">
              <span className={`font-bold ${balanced ? 'text-emerald-600' : 'text-amber-600'}`}>
                {balanced
                  ? 'Fully covered ✓'
                  : balance > 0
                    ? `Short — ${fmt.num(Math.round(balance))} more to allocate`
                    : `Over — ${fmt.num(Math.round(-balance))} too many`}
              </span>
              <span />
              <span className={`text-right font-extrabold tabular-nums ${balanced ? 'text-emerald-600' : 'text-amber-600'}`}>{fmt.num(required)}</span>
              <span className={`text-right font-extrabold tabular-nums ${balanced ? 'text-emerald-600' : 'text-amber-600'}`}>{fmt.num(Math.round(required * plannedUps))}</span>
              <span />
            </div>
          </div>
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
        <Button size="sm" variant="secondary" onClick={add} disabled={addableCandidates.length === 0}
          title={hasCandidates && addableCandidates.length === 0 ? 'Every board of this grade is already in the mix' : undefined}>
          <Plus size={12} /> Add board
        </Button>
        {hasSubstitutes && (
          <div className="flex min-w-[240px] flex-1 items-center gap-2">
            <span className="shrink-0 text-xs font-semibold text-slate-500">Reason for substitution</span>
            <Input value={sharedReason} placeholder="Why the substitute board?"
              onChange={e => setSharedReason(e.target.value)} />
          </div>
        )}
      </div>
    </div>
  );
}
