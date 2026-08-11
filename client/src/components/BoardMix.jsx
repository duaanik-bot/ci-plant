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
import { rowCovers, mixBalance, mixUnstockedRows, DEFAULT_MIX_REASON } from '../lib/boardMix.js';
import { parseBoardName } from '../lib/boardCode.js';
// Client twins of the server's chosen-cuts geometry (this wave's Task 1) —
// the per-row leftover chip below must offer exactly the strip orders.js's
// plan-save will bank, or the chip and the banked strip disagree.
import { chosenCutsValid, chosenStrips } from '../lib/cutFit.js';
import PacketAdvice from './PacketAdvice.jsx';
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

export default function BoardMix({
  ctx, required, rows, onChange,
  // New props (board-mix wave, Task 6). All optional — the two existing call
  // sites (Planning.jsx's single-line engine and its gang/run panel) don't
  // pass any of these yet (Task 7 / Task 9 wire them), so every default
  // below has to make the panel render sensibly on what it can vouch for,
  // rather than guessing.
  //
  // printUps: images per print sheet (cartons per child). Defaults to null —
  // NOT 1 — because 1 is a real, wrong answer for most products: it would
  // draw a "Cartons" column that quietly just repeats Child Sheets. null
  // hides the column outright, the honest state for a caller that hasn't
  // told us the real number yet.
  printUps = null,
  // orderQty: order cartons, for the ledger's "vs order" line. No figure to
  // compare against, no line — same reasoning as printUps.
  orderQty = null,
  // leftovers: {[material_id]: bool} — per-row opt-in/out of banking a
  // reduced-cut row's offcut. onLeftovers is its setter, deliberately left
  // WITHOUT a default here (see leftoverWired below) — a no-op default would
  // make every call site look "wired" and the toggle chip would render with
  // no way to actually persist a click.
  leftovers = {},
  onLeftovers,
  // derivedCuts: the caller's cuts are COMPUTED, not chosen — a GANG-kind
  // run, whose members each cut the shared sheet by their own child fit, so
  // there is no one number for a planner to edit. Renders the Cuts column
  // read-only, offers no strip chips (a gang banks nothing at plan — its
  // offcut has no product identity until the die-cut split), and says so in
  // one line under the table. Defaults false: the single-line engine and the
  // merge run keep the editable input exactly as it is.
  derivedCuts = false,
  // boardFor: material_id → that board's MATERIALS row, for the per-row packet
  // advice. A resolver rather than a field on the rows, because neither ctx
  // carries the packet size where it is needed: the single line's `ctx.board`
  // is hand-built in the planning route ({id, name, sheet_l, sheet_w}), NOT a
  // SELECT *, and the run's gangMixCtx has no board row at all. Only the
  // caller's own materials master can answer it.
  //
  // Deliberately WITHOUT a default, the same reasoning as onLeftovers above: a
  // no-op default would make every call site look wired, and each row would
  // then claim its board master carries no packet size — a statement about live
  // master data this component would not have checked. Unwired renders no
  // advice at all.
  boardFor,
  // packetChoice: {[material_id]: option key} — the planner's per-board pick,
  // with onPacketChoice its setter. Picking is a NOTE and still moves nothing
  // on its own; the advice panel's Accept button is what writes the chosen
  // option's total into this row's `sheets`, and only when the planner clicks
  // it. No setter renders the advice read-only, selecting nothing.
  packetChoice = {},
  onPacketChoice,
}) {
  const mix = ctx?.mix;
  if (!mix) return null;

  // A gang or Combined Run shares ONE board across every member and buys it on
  // a single combined PR, so its mix belongs to the RUN, not to one member of
  // it: orders.js's plan-save still 409s a mix sent on a ganged LINE ("prints
  // in a gang"). It is no longer a dead end though — the run's own engine
  // renders this very panel against the run's total and splits what it saves
  // across the members (gang-mix.js), so point there rather than just refusing.
  if (ctx.gang) {
    return (
      <p className="rounded-lg bg-slate-50 px-2.5 py-2 text-[11px] text-slate-500">
        This job prints in a gang, which draws one pile of board for every member. Cover the
        run from <b className="font-semibold text-slate-600">Board Mix — the whole run</b> in
        the Gang panel below; a mix saved here would only apply to this one job.
      </p>
    );
  }

  const plannedUps = mix.planned_ups;
  const { balance, sufficient } = mixTotals(rows, plannedUps, required);
  // Sufficient is only half of covered. The release gate has always asked the
  // other half too — every row's board must actually be holding its sheets —
  // and until this the panel did not, so a mix could read 'Fully covered ✓'
  // over an empty shelf. Same function the gate's rule is written in.
  const unstocked = mixUnstockedRows(rows);
  const covered = sufficient && unstocked.length === 0;
  const totalSheets = rows.reduce((s, r) => s + Number(r.sheets || 0), 0);
  // COVERS — this row's sheets expressed in the PLANNED board's parent sheets,
  // which is the only unit the requirement is written in. Without it the
  // ledger totalled each board's OWN sheets and set that against a
  // planned-unit requirement: 1,976 sheets of a 2-cut board under a 1,317
  // requirement read as 659 too many when it is in fact exactly covered. Two
  // different sheets stacked in one column is precisely the parent/child
  // confusion this column exists to end.
  const coversOf = r => (Number(plannedUps) > 0 && Number(r.ups) > 0
    ? (Number(r.sheets) || 0) * Number(r.ups) / Number(plannedUps) : 0);
  const totalCovers = rows.reduce((s, r) => s + coversOf(r), 0);
  // Child sheets = sheets × that row's OWN cuts — the honest name for what
  // this column used to call "Cartons". A product's real cartons figure
  // needs printUps too (below); without it this is as far as the arithmetic
  // can honestly go.
  const childSheetsOf = r => Math.round((Number(r.sheets) || 0) * (Number(r.ups) || 0));
  const totalChildSheets = rows.reduce((s, r) => s + childSheetsOf(r), 0);
  // hasPrintUps gates the Cartons column's very EXISTENCE, not just its
  // values — a caller that passed printUps=0 by mistake gets the same
  // "can't vouch for this" treatment as one that passed nothing at all.
  const hasPrintUps = Number(printUps) > 0;
  const cartonsOf = r => (hasPrintUps ? Math.round(childSheetsOf(r) * Number(printUps)) : null);
  const totalCartons = hasPrintUps ? Math.round(totalChildSheets * Number(printUps)) : null;
  const hasOrderQty = Number(orderQty) > 0;
  const candidateList = mix.candidates || [];
  const byId = new Map(candidateList.map(c => [c.id, c]));
  const hasCandidates = candidateList.length > 0;

  // ── Task 6 additions: editable cuts, its cap, and the per-row leftover ──
  //
  // The cap a row's Cuts input clamps against: a substitute's own natural
  // ceiling (ctx's max_cuts, added alongside this feature in Task 4), or the
  // planned row's own plannedUps. A row whose candidate has since gone stale
  // (stock ran dry, or an older ctx that predates max_cuts) has no ceiling
  // to read — falling back to the row's OWN current ups freezes the input
  // at whatever it already holds rather than guessing a number that could be
  // wrong in either direction.
  const maxCutsFor = r => {
    if (r.severity === 'none') {
      const p = Number(mix.planned_ups);
      return p > 0 ? p : Math.max(1, Number(r.ups) || 1);
    }
    const m = Number(byId.get(r.material_id)?.max_cuts);
    return m > 0 ? m : Math.max(1, Number(r.ups) || 1);
  };
  // The server would 409 an out-of-range value at save; the input clamps on
  // every keystroke AND on blur so the planner never sees a number the save
  // was always going to refuse.
  const clampUps = (raw, max) => {
    const n = Math.round(+raw) || 1;
    return Math.min(Math.max(1, n), Math.max(1, Math.round(+max) || 1));
  };

  // onLeftovers is left without a default in the destructure above ON
  // PURPOSE: leftoverWired distinguishes "no setter was ever passed" from
  // "a setter was passed", BEFORE any default could paper over the
  // difference — the chip's very existence has to depend on it. A call
  // site that hasn't been wired for banking yet must render no chip at all,
  // never a chip that clicks and silently does nothing. setLeftover is the
  // safe-to-call form the chip's own onClick uses.
  const leftoverWired = typeof onLeftovers === 'function';
  const setLeftover = (materialId, bank) => {
    if (leftoverWired) onLeftovers({ ...leftovers, [materialId]: bank });
  };

  // What a row's leftover chip should say, or why it can't say anything yet.
  // Returns null when there is nothing to show (cuts not reduced, no child
  // size to measure against, or a valid cut that simply leaves nothing
  // usable to bank); { valid } when the chosen k is geometrically invalid
  // (ragged); { valid, pick } when there is a real strip to offer — `pick`
  // being the LARGEST-BY-AREA usable one, because orders.js's own bank step
  // sorts the same way and takes the same index, so the chip can never
  // promise a strip the server would bank differently.
  const stripInfoFor = r => {
    // Derived cuts are never reduced cuts — a gang row sits at its computed
    // fit by definition, so there is neither a ragged state to warn about
    // nor a strip to offer.
    if (derivedCuts) return null;
    if (!(Number(r.ups) > 0)) return null;
    const max = maxCutsFor(r);
    // Only a REDUCED cut leaves anything new to bank here. A row at its own
    // max is the pre-existing single-board Leftover card's territory
    // (Planning's lo.push/lo.strip, untouched by this feature) — this chip
    // exists for exactly the case that card can't reach: cuts the planner
    // has turned down below the board's own ceiling.
    if (!(Number(r.ups) < max)) return null;
    const childL = Number(ctx?.line?.child_l), childW = Number(ctx?.line?.child_w);
    if (!(childL > 0 && childW > 0)) return null;
    const isPlannedRow = r.severity === 'none';
    const cand = byId.get(r.material_id);
    // Same asymmetry orders.js's rowParentFor uses at save: the planned row
    // cuts from the trimmed effective parent, a substitute from its own
    // native mother sheet.
    const pl = isPlannedRow ? Number(mix.planned_parent_l) : Number(cand?.sheet_l);
    const pw = isPlannedRow ? Number(mix.planned_parent_w) : Number(cand?.sheet_w);
    if (!(pl > 0 && pw > 0)) return null;
    const valid = chosenCutsValid(pl, pw, childL, childW, r.ups);
    if (!valid.ok) return { valid };
    const strips = chosenStrips(pl, pw, childL, childW, r.ups);
    const usable = strips.filter(s => s.usable);
    if (!usable.length) return null;
    const pick = [...usable].sort((a, b) => (b.l * b.w) - (a.l * a.w))[0];
    return { valid, pick };
  };

  // ── The per-row packet advice ────────────────────────────────────────
  //
  // Which materials row a given mix row's packet size comes from — the SAME
  // planned/substitute asymmetry stripInfoFor uses above, for the same reason.
  // A substitute's candidate row is already a full materials row (the server
  // selects `m.*` in both the line's mixCandidates and the run's), so it
  // carries sheets_per_packet on its own. The PLANNED board is deliberately
  // never in `candidates`, so only the caller's resolver can answer for it.
  //
  // Falls back to the resolver for a substitute too: a row whose candidate has
  // gone stale (its stock ran dry since it was added) drops out of the list,
  // and its board's packet size has not changed just because its shelf emptied.
  const packetWired = typeof boardFor === 'function';
  const packetBoardFor = r => {
    if (!packetWired) return null;
    const cand = r.severity === 'none' ? null : byId.get(r.material_id);
    return cand ?? boardFor(r.material_id);
  };

  // Line 2's numeric columns — one literal string per branch, never an
  // interpolated grid-cols-${n}: Tailwind only keeps classes it can see
  // whole in the source (see ui.jsx's KPI_COLS for the same rule). Shared by
  // the header, every row and the footer, so all three stay pixel-aligned —
  // the same job the old single flat grid did before Board moved to its own
  // full-width line.
  const LINE2_COLS = hasPrintUps
    ? 'grid-cols-[64px_88px_92px_84px_92px_1fr]'
    : 'grid-cols-[64px_88px_92px_84px_1fr]';

  const EPS = 1e-6;
  // How the ledger's true cartons total reads against what the order still
  // needs — null when either half of that comparison has nothing to say.
  const orderDelta = hasPrintUps && hasOrderQty ? totalCartons - Number(orderQty) : null;
  const orderShort = orderDelta != null && orderDelta < -EPS;

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
      // The synthetic entry carries the PLANNED board's own trim so it can be
      // read against the substitutes below it — the list is ordered by waste
      // now, and an option with no waste figure looks like missing data rather
      // than like the plan.
      : [{ id: row.material_id, name: row.board_name || 'Current board', available: null,
           waste_pct: row.material_id === mix.planned_board_id ? mix.planned_waste_pct ?? null : null },
         ...list];
  };

  // Same no-duplicates rule for "+ Add board": offer (and default-select) the
  // first candidate not already sitting in some row, and disable the button
  // outright once every candidate of this grade is already in the mix. The
  // server orders candidates least-trim-first, so `[0]` IS the suggestion.
  const addableCandidates = candidateList.filter(c => !rows.some(r => r.material_id === c.id));
  const add = () => {
    const first = addableCandidates[0];
    if (!first) return;
    onChange([...rows, {
      material_id: first.id, board_name: first.name, ups: first.ups,
      sheets: Math.max(0, Math.round(balance / (first.ups / plannedUps))),
      // Pre-filled, not blank: the shared field below shows the sentence that
      // will be recorded the moment the row appears, and the planner types over
      // it if there is a better one. Candidates are always substitutes, so this
      // row always earns a reason.
      stock_batch_id: null, reason: DEFAULT_MIX_REASON,
      severity: first.severity, gsm_delta: first.gsm_delta,
      ups_differ: first.ups_differ, size_differs: first.size_differs,
      // `free`, not the gross shelf: what this job may take (see the costing in
      // orders.js's planning context). mixUnstockedRows warns off this figure.
      available: first.free ?? first.available,
      // …and the RAW shelf beside it, so the over-allocation warning can tell a
      // board that is EMPTY from one that is full but wholly committed. Written
      // on every constructor, not just the reopen seeds: a row added in-session
      // carried no shelf at all, so the "every sheet is committed" arm was dead
      // on exactly the rows a planner is looking at while they type.
      shelf: first.available ?? null,
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
    // Switching a row's board can change what it IS. Landing on the planned
    // board makes the reason meaningless (the server stores NULL for a
    // 'planned' role regardless); landing on a substitute earns one — this
    // row's own if it already had it, else whatever the shared field currently
    // holds for the other substitutes, else the default. Without this, a row
    // flipped planned → substitute would arrive blank and silently take the
    // server's fallback instead of showing the planner what will be recorded.
    const others = rows.filter((r, j) => j !== i && r.severity && r.severity !== 'none');
    const reason = c.severity === 'none'
      ? ''
      : (rows[i]?.reason?.trim() || others.find(r => r.reason?.trim())?.reason || DEFAULT_MIX_REASON);
    // `shelf` is written EXPLICITLY, never merely omitted: set() spreads
    // { ...r, ...patch }, so a missing key would leave the PREVIOUS board's
    // shelf sitting on the row after a pick.
    set(i, { material_id: c.id, board_name: c.name, ups: c.ups, stock_batch_id: null, reason,
             severity: c.severity, gsm_delta: c.gsm_delta, ups_differ: c.ups_differ,
             size_differs: c.size_differs, available: c.free ?? c.available,
             shelf: c.available ?? null });
  };

  // One reason for the whole mix, not one per row — the owner never wanted to
  // type it more than once. `reason` still lives on every substitute row
  // because that is the shape the server stores, so the shared field is a plain
  // read/write-through onto every substitute row's `reason` rather than
  // separate state: typing here writes to all of them at once, and reopening a
  // saved mix reads the field straight back out of the first substitute row —
  // nothing extra to seed on load.
  //
  // OPTIONAL, deliberately, and PRE-FILLED. The plan-save route used to 400 on
  // any substitute row with an empty reason; it no longer does, and a row that
  // arrives blank takes DEFAULT_MIX_REASON rather than a NULL. Every substitute
  // row is seeded with that same constant the moment it appears, so the field
  // shows what will be recorded instead of an empty box demanding to be filled.
  // See the soft-alarm comment in orders.js's mix loop.
  const isSubstitute = r => r.severity && r.severity !== 'none';
  const hasSubstitutes = rows.some(isSubstitute);
  const sharedReason = rows.find(isSubstitute)?.reason || '';
  const setSharedReason = value => onChange(rows.map(r => (isSubstitute(r) ? { ...r, reason: value } : r)));
  // Cleared by hand — the one case the field no longer speaks for itself. Say
  // which sentence the save will write, so the fallback is never a surprise
  // discovered later on the job card. Named, not counted.
  const cleared = hasSubstitutes && !sharedReason.trim()
    ? rows.filter(isSubstitute).map(r => r.board_name).filter(Boolean)
    : [];

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

      {/* Two-line rows. Line 1 is the board picker at full width — the fix
          for the ~60px squeeze the old 5-column grid left it (a picker
          sharing a row with four numeric cells could never get more than a
          sliver). Line 2 is the numbers, in a grid shared with the header
          and footer below so all three stay pixel-aligned. "Cuts" (never
          "ups" — that means something else entirely: products.ups, the
          printed images per print sheet) is the plant's own word for
          childFit's count, and is now EDITABLE per row rather than a fixed
          read-out of the board's own maximum. */}
      {rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-[#1D1D1F]/[0.08] bg-white/60">
          <div className="border-b border-[#1D1D1F]/[0.06] bg-slate-50/80 px-3 py-1.5">
            <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Board</div>
            <div className={`mt-1 grid ${LINE2_COLS} items-center gap-2 text-[9px] font-bold uppercase tracking-wider text-slate-400`}>
              <span className="text-right">Cuts</span>
              <span className="text-right">Sheets</span>
              {/* The only column in the planned board's units — the one the
                  requirement below is written in, and the only one that can
                  honestly be read against it. */}
              <span className="text-right" title="This board's sheets, in the planned board's parent sheets">Covers</span>
              <span className="text-right">Child Sheets</span>
              {hasPrintUps && <span className="text-right">Cartons</span>}
              <span />
            </div>
          </div>
          <div className="divide-y divide-[#1D1D1F]/[0.06]">
            {rows.map((r, i) => {
              const lots = (mix.lots || []).filter(l => l.material_id === r.material_id);
              const over = r.available != null && r.sheets > r.available;
              const isPlanned = r.severity === 'none';
              const max = maxCutsFor(r);
              const info = stripInfoFor(r);
              const bankOn = info?.pick ? ((r.material_id in leftovers) ? !!leftovers[r.material_id] : true) : false;
              return (
                <div key={i} className="px-3 py-2.5">
                  {/* Line 1 — board, planned chip, remove. Full width now:
                      the Select owns the row instead of sharing a grid
                      column with four numeric cells. */}
                  <div className="flex items-center gap-1.5">
                    <div className="min-w-0 flex-1">
                      {/* Ordered LEAST TRIM FIRST by the server, so the top
                          of this list is the board that throws away least —
                          and the waste rides along in the label, because a
                          suggestion the planner cannot check is just a
                          different kind of guess. Still a plain select:
                          the suggestion is a default, never a decision. */}
                      <Select value={r.material_id} onChange={e => pick(i, e.target.value)}>
                        {optionsFor(r).map(c => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                            {c.waste_pct != null ? ` — ${c.waste_pct}% waste` : ''}
                            {/* FREE, and it says so honestly. This printed the
                                GROSS shelf and called it free: a board holding
                                2,000 sheets with 1,100 already committed to a
                                job in production offered "2,000 free", and the
                                seeds sized themselves off it. When any of it is
                                spoken for, both figures show — the planner can
                                still choose to take it off the other job, but
                                not without being told the other job exists. */}
                            {c.free != null
                              ? (c.committed > 0
                                  ? ` · ${fmt.num(c.free)} free of ${fmt.num(c.available)}`
                                  : ` · ${fmt.num(c.free)} free`)
                              : c.available != null ? ` · ${fmt.num(c.available)} free` : ''}
                          </option>
                        ))}
                      </Select>
                    </div>
                    {isPlanned && (
                      <span className="shrink-0 rounded-full bg-brand-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-brand-600">
                        Planned
                      </span>
                    )}
                    <button type="button" onClick={() => drop(i)} title="Remove this board"
                      className="shrink-0 rounded-lg p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600">
                      <X size={14} />
                    </button>
                  </div>
                  {/* Lot — only when there is genuinely a lot to choose
                      BETWEEN, or one is already named. It used to sit under
                      every row announcing "FIFO — oldest first", which is
                      not a choice the planner is making: with a single lot
                      on the board (the ordinary case) naming it and leaving
                      it blank issue exactly the same sheets, so the control
                      was pure noise under a board picker that does matter.
                      The named-lot feature itself is untouched — it is how
                      a planner deliberately clears an ageing lot — and the
                      row still renders whenever a lot IS named, so a
                      choice already made can always be seen and undone. */}
                  {(lots.length > 1 || r.stock_batch_id) && (
                    <select
                      title="Any available lot. Name one only to clear a specific ageing lot; left alone, the warehouse issues oldest first."
                      value={r.stock_batch_id ?? ''}
                      onChange={e => set(i, { stock_batch_id: e.target.value ? +e.target.value : null })}
                      className="mt-1 w-full max-w-[220px] rounded-md border border-[#1D1D1F]/[0.10] bg-transparent px-1.5 py-0.5 text-[10px] font-medium text-slate-500 outline-none focus:border-[#0A84FF]"
                    >
                      <option value="">Any lot</option>
                      {lots.map(l => <option key={l.id} value={l.id}>{l.batch_no} — {fmt.num(l.qty)}</option>)}
                    </select>
                  )}

                  {/* Line 2 — the numbers. Cuts render read-only when the
                      caller's figure is derived (a gang's per-member fit),
                      an editable choice everywhere else. */}
                  <div className={`mt-2 grid ${LINE2_COLS} items-start gap-2`}>
                    {derivedCuts ? (
                      <div className="pt-2.5 text-right text-sm font-semibold tabular-nums text-slate-500">
                        {r.ups}
                      </div>
                    ) : (
                    <div>
                      <Input type="number" min={1} max={max} value={r.ups} className="text-right"
                        onChange={e => set(i, { ups: clampUps(e.target.value, max) })}
                        onBlur={e => set(i, { ups: clampUps(e.target.value, max) })} />
                      <div className="mt-0.5 text-right text-[9px] font-semibold text-slate-400">of {max}</div>
                    </div>
                    )}
                    <Input type="number" min="1" value={r.sheets} className="text-right"
                      onChange={e => set(i, { sheets: +e.target.value })} />
                    {/* Derived, never typed: this row converted into the
                        PLANNED board's parent sheets, so it can be read
                        straight down against the requirement. */}
                    <div className="pt-2.5 text-right text-sm font-bold tabular-nums text-slate-700"
                      title={`${fmt.num(r.sheets)} sheets × ${r.ups} cuts ÷ ${plannedUps} cuts on the planned board`}>
                      {fmt.num(Math.round(coversOf(r)))}
                    </div>
                    {/* Derived, never typed: sheets × this row's own cuts. */}
                    <div className="pt-2.5 text-right text-sm font-semibold tabular-nums text-slate-500">
                      {fmt.num(childSheetsOf(r))}
                    </div>
                    {hasPrintUps && (
                      <div className="pt-2.5 text-right text-sm font-semibold tabular-nums text-slate-500"
                        title={`${fmt.num(r.sheets)} sheets × ${r.ups} cuts × ${printUps} up per sheet`}>
                        {fmt.num(cartonsOf(r))}
                      </div>
                    )}
                    <div className="flex flex-col items-end justify-start gap-1 pt-2.5">
                      {/* A ragged chosen k — the leftover check reuses the
                          same twin the server's save gate runs, so this is
                          the same "why" a 409 would give, seen before the
                          planner ever tries to save. */}
                      {info && !info.valid.ok && (
                        <span className="text-right text-[9px] font-semibold leading-snug text-amber-600">
                          {info.valid.why}
                        </span>
                      )}
                      {/* The chip only exists once a caller has actually
                          wired somewhere for it to write — see leftoverWired
                          above. */}
                      {info?.pick && leftoverWired && (
                        <button type="button" onClick={() => setLeftover(r.material_id, !bankOn)}
                          title={`Strip ${info.pick.l}×${info.pick.w}" off ${fmt.num(Math.round(Number(r.sheets) || 0))} sheets of ${r.board_name}`}
                          className={`rounded-full px-2 py-1 text-right text-[9px] font-bold uppercase tracking-wide transition-colors ${
                            bankOn ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                          }`}>
                          {bankOn
                            ? `Banks ${fmt.num(Math.round(Number(r.sheets) || 0))} × ${info.pick.l}×${info.pick.w}"`
                            : 'Strip to waste'}
                        </button>
                      )}
                    </div>
                  </div>
                  {/* A SUBSTITUTE whose natural cuts differ from the plan's —
                      a calm statement of fact, not a refusal. The save is no
                      longer blocked here: Planning.jsx's own gate is what
                      decides that (mixOk / gangMixOk), and it is untouched
                      by this component. The child/print sheet never changes
                      across a mix, only how many of it each board yields —
                      arithmetic to convert by, not a problem to fix. */}
                  {!isPlanned && r.ups_differ && (
                    <p className="mt-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-medium text-slate-600">
                      Cuts {max} up natively against the plan's {plannedUps} — covers convert accordingly.
                    </p>
                  )}
                  {over && (
                    <p className="mt-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700">
                      {/* r.available is the FREE figure (both seeds put free
                          first); r.shelf is the raw pile. A full-but-frozen
                          board is not "empty" — saying so sent planners
                          hunting for stock that was sitting in the racks. */}
                      {Number(r.available) > 0
                        ? `Only ${fmt.num(r.available)} sheets are free on this board — ${fmt.num(Math.round(Number(r.sheets) - Number(r.available)))} of this row is not there.`
                        : Number(r.shelf) > 0
                          ? `Every sheet on this board is committed to other jobs (${fmt.num(r.shelf)} on the shelf, none free) — the hold will cap at nothing. Take from another job, or raise a PR.`
                          : 'This board is empty — there is no stock behind these sheets. Move them onto a board that has some, or raise a PR.'}
                    </p>
                  )}
                  {/* "Separate recommendations for each board allocation" —
                      each row against ITS OWN sheets, its own board's packet
                      size and its own lots (the same `lots` the lot picker
                      above is filtered from). Compact: a mix row is a dense
                      place, so the figure line-up collapses to one line and
                      the two leading options to chips. */}
                  {packetWired && (
                    <PacketAdvice compact required={r.sheets}
                      board={packetBoardFor(r)} lots={lots}
                      chosen={packetChoice?.[r.material_id] ?? null}
                      onChoose={typeof onPacketChoice === 'function'
                        ? key => onPacketChoice({ ...packetChoice, [r.material_id]: key })
                        : undefined}
                      // The row owns its sheets figure, so the row is where an
                      // accepted suggestion lands — the same `set` the number
                      // box writes through, which is what keeps it editable
                      // afterwards. Gated on onChange for the same reason every
                      // other control here is: a panel with nowhere to write
                      // must not offer a button that silently does nothing.
                      onAccept={typeof onChange === 'function'
                        ? total => set(i, { sheets: total })
                        : undefined} />
                  )}
                </div>
              );
            })}
          </div>

          {/* LEDGER FOOTER — the plain running total the owner asked for:
              what's been used, against what's required, in both units. */}
          <div className="border-t border-[#1D1D1F]/[0.08] bg-slate-50/80 px-3 py-2">
            <div className="text-xs font-bold text-slate-500">Total — {rows.length} board{rows.length === 1 ? '' : 's'}</div>
            {/* Totals align under their own columns, so the eye adds straight
                down: Sheets over sheets, Child Sheets over child sheets. */}
            <div className={`mt-0.5 grid ${LINE2_COLS} items-center gap-2 text-xs`}>
              <span />
              <span className="text-right font-extrabold tabular-nums text-slate-800">{fmt.num(totalSheets)}</span>
              <span className="text-right font-extrabold tabular-nums text-slate-800">{fmt.num(Math.round(totalCovers))}</span>
              <span className="text-right font-extrabold tabular-nums text-slate-800">{fmt.num(totalChildSheets)}</span>
              {hasPrintUps && <span className="text-right font-extrabold tabular-nums text-slate-800">{fmt.num(totalCartons)}</span>}
              <span />
            </div>
            {/* Over-coverage is NOT an error. Once boards cut at different
                counts an exact landing is usually impossible — you cannot cut
                a third of a sheet — so the surplus is stated as the fact it
                is and the plan still locks. Only a SHORTFALL blocks, because
                that one is physics: the board is not there. */}
            <div className={`mt-1.5 text-xs font-bold ${covered ? 'text-emerald-600' : 'text-amber-600'}`}>
              {covered
                ? (balance < -EPS
                    ? `Covered ✓ — ${fmt.num(Math.ceil(-balance))} parent sheets more than the minimum`
                    : 'Fully covered ✓')
                : sufficient
                  ? `Adds up — but ${unstocked.length === 1 ? 'one board has' : `${unstocked.length} boards have`} no stock for it`
                  : `Short — ${fmt.num(Math.ceil(balance))} more to allocate`}
            </div>
            <div className={`mt-0.5 grid ${LINE2_COLS} items-center gap-2 text-xs`}>
              <span />
              <span />
              {/* The requirement sits under COVERS, the only column in the
                  same unit. It used to sit under Sheets, inviting a
                  comparison between two different boards' sheets. */}
              <span className={`text-right font-extrabold tabular-nums ${covered ? 'text-emerald-600' : 'text-amber-600'}`}>{fmt.num(required)}</span>
              <span className={`text-right font-extrabold tabular-nums ${covered ? 'text-emerald-600' : 'text-amber-600'}`}>{fmt.num(Math.round(required * plannedUps))}</span>
              {hasPrintUps && <span />}
              <span />
            </div>
            {/* Against the actual order — the number Anik's complaint was
                really about: whether the boards on this mix, in real
                cartons, meet what was sold. Only appears once a caller has
                told us both halves of that arithmetic (printUps, orderQty). */}
            {orderDelta != null && (
              <p className={`mt-1.5 text-[11px] font-bold ${orderShort ? 'text-amber-600' : 'text-emerald-600'}`}>
                ≈ {fmt.num(totalCartons)} cartons vs order {fmt.num(orderQty)}
              </p>
            )}
          </div>
        </div>
      )}

      {derivedCuts && rows.length > 0 && (
        <p className="mt-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-500">
          A gang's cuts are per member — set by each child's own fit.
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
        <Button size="sm" variant="secondary" onClick={add} disabled={addableCandidates.length === 0}
          title={hasCandidates && addableCandidates.length === 0 ? 'Every board of this grade is already in the mix' : undefined}>
          <Plus size={12} /> Add board
        </Button>
        {hasSubstitutes && (
          <div className="flex min-w-[240px] flex-1 items-center gap-2">
            <span className="shrink-0 text-xs font-semibold text-slate-500">
              Reason for substitution <span className="font-medium text-slate-400">(optional)</span>
            </span>
            <Input value={sharedReason} placeholder="Why the substitute board?"
              onChange={e => setSharedReason(e.target.value)} />
          </div>
        )}
      </div>

      {/* Soft alarm, not a gate — the plan locks with this on screen. */}
      {cleared.length > 0 && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700">
          <AlertTriangle size={12} className="mt-px shrink-0" />
          <span>
            Reason left blank for {cleared.join(', ')} — “{DEFAULT_MIX_REASON}” will be recorded.
            You can lock the plan as it stands.
          </span>
        </p>
      )}
    </div>
  );
}
