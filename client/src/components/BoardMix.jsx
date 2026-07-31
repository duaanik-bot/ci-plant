// Board Mix — the boards a job will actually consume, beside the one it was
// planned on. Grade is fixed; GSM (and sometimes size) is what flexes. The
// balance is the hero: green at zero, amber otherwise, and it never has to be
// scrolled to — it sits directly under the header, above the row list.
import { Plus, X, AlertTriangle } from 'lucide-react';
import { Button, Field, Input, Select } from './ui.jsx';
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

// Tone reads as what the difference costs: 'warn' (GSM, or a size change that
// still cuts the same ups) is an ordinary amber pill. 'heavy' (ups differs)
// gets a ring and an icon because it is not a substitution this build can
// actually run — it is offered so the planner knows the board exists, and
// refused at save (see the red explanation below and the scope decision at
// the top of the plan).
function Chip({ tone, children }) {
  const cls = {
    warn: 'bg-amber-50 text-amber-700',
    heavy: 'bg-red-100 text-red-700 ring-1 ring-inset ring-red-300',
    none: 'bg-slate-100 text-slate-500',
  }[tone] || 'bg-slate-100 text-slate-500';
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[9px] font-bold uppercase tracking-wide ${cls}`}>
      {tone === 'heavy' && <AlertTriangle size={9} />}
      {children}
    </span>
  );
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
      <div className="mt-3 border-t border-[#1D1D1F]/[0.07] pt-3">
        <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">Board Mix</div>
        <p className="rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-500">
          This job prints in a gang, which shares one board across every member. Change the
          gang's board from the Gang panel below rather than mixing boards on a single job.
        </p>
      </div>
    );
  }

  const plannedUps = mix.planned_ups;
  const { covered, balance, balanced } = mixTotals(rows, plannedUps, required);
  const candidateList = mix.candidates || [];
  const byId = new Map(candidateList.map(c => [c.id, c]));
  const hasCandidates = candidateList.length > 0;

  // Exactly one board name in the live master fails to parse ("Unspecified
  // board"). substitutionFlags blocks every candidate against an unparseable
  // planned board, so the list comes back empty with nothing to tell that
  // apart from "no stock anywhere of this grade" — say which one it is.
  const plannedName = ctx?.line?.board_name;
  const plannedUnspecified = !parseBoardName(plannedName);

  // A 'planned'-role row's own board is deliberately excluded from
  // `candidates` — the server only ever offers SUBSTITUTES there — so its
  // Select would otherwise show blank despite holding the right value. Same
  // fallback covers a substitute whose stock ran out since it was added: its
  // board no longer appears in the live candidate list either.
  const optionsFor = r => (candidateList.some(c => c.id === r.material_id)
    ? candidateList
    : [{ id: r.material_id, name: r.board_name || 'Current board', available: null }, ...candidateList]);

  const add = () => {
    const first = candidateList[0];
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

  return (
    <div className="mt-3 border-t border-[#1D1D1F]/[0.07] pt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
          Board Mix — {fmt.num(required)} required
        </span>
        <Button size="sm" variant="secondary" onClick={add} disabled={!hasCandidates}>
          <Plus size={12} /> Add board
        </Button>
      </div>

      {/* HERO — the one number this panel exists to answer. Sits above the
          rows so it is never scrolled past on a mix with several boards. */}
      {rows.length > 0 && (
        <div className={`mb-2.5 rounded-xl px-3.5 py-3 ${balanced ? 'bg-emerald-50' : 'bg-amber-50'}`}>
          <div className="flex items-center justify-between gap-2">
            <span className={`text-[10px] font-bold uppercase tracking-wider ${balanced ? 'text-emerald-700' : 'text-amber-700'}`}>
              Balance to allocate
            </span>
            <span className={`text-base font-extrabold tabular-nums ${balanced ? 'text-emerald-700' : 'text-amber-700'}`}>
              {balanced ? '0 ✓' : fmt.num(Math.round(balance))}
            </span>
          </div>
          {!balanced && (
            <p className="mt-0.5 text-[10px] font-medium text-amber-600/80">
              Covered {fmt.num(Math.round(covered))} of {fmt.num(required)} parent sheets.
            </p>
          )}
        </div>
      )}

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

      <div className="space-y-2">
        {rows.map((r, i) => {
          const lots = (mix.lots || []).filter(l => l.material_id === r.material_id);
          const over = r.available != null && r.sheets > r.available;
          return (
            <div key={i} className="rounded-xl bg-slate-50/80 p-2.5">
              <div className="mb-1.5 flex items-center gap-1.5">
                {r.severity && r.severity !== 'none' && (
                  <Chip tone={r.severity}>
                    {r.ups_differ ? `${r.ups} up vs ${plannedUps} up`
                      : r.gsm_delta ? `${r.gsm_delta > 0 ? '+' : ''}${r.gsm_delta} gsm`
                      : r.size_differs ? 'different size' : 'substitute'}
                  </Chip>
                )}
                <button type="button" onClick={() => drop(i)} title="Remove this board"
                  className="ml-auto shrink-0 rounded-lg p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600">
                  <X size={12} />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Board" className="col-span-2">
                  <Select value={r.material_id} onChange={e => pick(i, e.target.value)}>
                    {optionsFor(r).map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}{c.available != null ? ` — ${fmt.num(c.available)} free` : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Lot" hint="blank = FIFO">
                  <Select value={r.stock_batch_id ?? ''}
                    onChange={e => set(i, { stock_batch_id: e.target.value ? +e.target.value : null })}>
                    <option value="">FIFO — oldest first</option>
                    {lots.map(l => <option key={l.id} value={l.id}>{l.batch_no} — {fmt.num(l.qty)}</option>)}
                  </Select>
                </Field>
                <Field label="Sheets">
                  <Input type="number" min="1" value={r.sheets}
                    onChange={e => set(i, { sheets: +e.target.value })} />
                </Field>
                {r.severity && r.severity !== 'none' && (
                  <Field label="Reason" className="col-span-2" required>
                    <Input value={r.reason || ''} placeholder="Why this board?"
                      onChange={e => set(i, { reason: e.target.value })} />
                  </Field>
                )}
              </div>
              {r.ups_differ && (
                <p className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-700">
                  <AlertTriangle size={12} className="mt-px shrink-0" />
                  This sheet cuts {r.ups} up against the plan's {plannedUps} up — a different imposition
                  needs its own plate, so it cannot be mixed into this job.
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
    </div>
  );
}
