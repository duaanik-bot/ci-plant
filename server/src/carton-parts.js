// A carton MADE IN PARTS — one saleable outer carton printed as separate pieces,
// each on its own sheet and board, die-cut apart and pasted together into one
// carton at Sort & Paste (VOGEAB GM1/GM2 outers). The PO names only the carton;
// every rule about its parts lives here, pure, so each one is a unit test.
//
//   carton line (the PO line)   — carries no board, hidden from Planning
//     ├─ part line  Part 1      — planned, covered and printed like any job on
//     └─ part line  Part 2        ITS OWN board, ending at die cutting
//   pasting card (is_assembly)  — sorting + pasting, made once EVERY part is
//                                 die-cut; closing it credits FG with the carton
//
// The DB side is carton-parts-db.js; the guards are called from the routes.
// The only import is stage-runs.js, itself import-free — so helpers.js can
// import this module without a cycle.
import { toStageUnit } from './stage-runs.js';

const n = v => Math.max(0, Math.round(+v || 0));
const per = p => Math.max(1, n(p?.per_carton) || 1);
const said = s => String(s || '').replace(/_/g, ' ');
const id = v => Number(v);
// A quantity in a message someone reads: Indian grouping, as the parts save
// already writes its own ("PO 02545 (11,500 · B-7)"). Audit rows stay raw.
const qtyText = v => n(v).toLocaleString('en-IN');

// Where a line stands, in the plant's words — never a raw status ("already
// ready"). 'ready' has every gate green but NO card yet: a line only reaches
// in_production when its job card is made (helpers.js createJobCardForLine).
const LINE_SAYS = {
  ready: 'already cleared for its job card',
  in_production: 'already in production',
  produced: 'already produced',
  dispatched: 'already dispatched',
  cancelled: 'cancelled',
};
export const lineSays = status => LINE_SAYS[status] || `already ${said(status)}`;

// A PART reads its card too: a die-cut part is still in_production on its line
// (contract C4) — its card is 'split' — and a part walked to produced and
// dispatched has handed its pieces to the carton's pasting card (C5).
// partLines rows carry jc_status (helpers.js PART_LINES_SQL).
const pasted = p => p.status === 'produced' || p.status === 'dispatched';
const dieCut = p => pasted(p) || p.jc_status === 'split';
export function partSays(p) {
  if (pasted(p)) return 'already pasted';
  if (p.jc_status === 'split') return 'already die-cut';
  return lineSays(p.status);
}

// Rolling a carton back in Planning takes EVERY part back with it
// (rollbackLine), and a die-cut or pasted part can never go back — so once any
// part is die-cut, no message may offer that road.
const canRollBack = partLines => !partLines.some(dieCut);

// The stages that belong to the finished carton, not to a piece of it.
export const JOIN_STAGES = ['sorting', 'pasting'];

// A part's own route: everything up to AND ENDING AT die cutting — never "the
// route minus sorting and pasting", or a stage added after pasting (a QC hop,
// say) would become the part card's last stage, the die-cut join would never
// fire, and the ordinary closer would credit FG with the part itself.
export function partStages(routing) {
  const end = routing.findIndex(s => s.stage === 'die_cutting');
  if (end < 0) throw Object.assign(new Error('A part must be die-cut — its route has no die cutting stage'), { status: 409 });
  return routing.slice(0, end + 1);
}

// The pasting card's route — the same two stages a split gang child runs.
export const assemblyStages = routing => routing.filter(s => JOIN_STAGES.includes(s.stage));

// Completing this stage finishes a PART: its route's last stage, die cutting,
// on a line that belongs to a carton.
export function shouldJoinAtDieCut({ isLastStage, stage, partOfLineId }) {
  return !!(isLastStage && stage === 'die_cutting' && partOfLineId);
}

// Pieces a part card made: die-cut sheets × ups — the same sheets→cartons
// conversion every Sorting receipt uses (stage-runs.js toStageUnit).
export const partPieces = ({ dieCutSheets, ups }) =>
  toStageUnit({ prevQtyOut: dieCutSheets, prevUnit: 'sheets', unit: 'cartons', ups }) ?? 0;

// Cartons the parts make together — the scarcest part decides — and what each
// part has left over. Zero is an answer, not an error: a pasting card for 0
// closes short at Sort & Paste, and the shortage re-raise brings the carton
// (and its parts) back — the same road any short job takes.
export function joinableSets(parts = []) {
  if (!parts.length) return { sets: 0, spare: [] };
  const sets = Math.min(...parts.map(p => Math.floor(n(p.pieces) / per(p))));
  return {
    sets,
    spare: parts.map(p => ({ label: p.label, qty: n(p.pieces) - sets * per(p) })).filter(s => s.qty > 0),
  };
}

// The statuses a carton line steps through to in_production, one allowed
// transition at a time (LINE_TRANSITIONS in helpers.js). A carton never gets
// a card from Planning, so it may still be pending when its last part is cut.
const WALK = ['pending', 'planned', 'ready', 'in_production'];
export function walkToInProduction(status) {
  const i = WALK.indexOf(status);
  if (i < 0) throw Object.assign(new Error(`The carton line is ${said(status)} — it cannot start pasting`), { status: 409 });
  return WALK.slice(i + 1);
}

// The same refusal as the die-cut operator reads it — they never see the
// carton line, so it is named, in one sentence (carton-parts-db.js).
export const pastingCantStart = ({ code, po, status }) =>
  `${code} on PO ${po} is ${lineSays(status)}, so its pasting card can't start — ask Planning`;

// A part line the planner can still change: nothing of it is on the floor.
export const EDITABLE_PART = ['pending', 'planned'];

// Once ANY part is past planning, the carton is physically being made as the
// parts on this order — the parts LIST is frozen for it. (The carton line
// itself stays pending until its pasting card exists, so its own status can
// never say this.)
export const partsFrozen = partLines => partLines.some(p => !EDITABLE_PART.includes(p.status));

// What keeping a carton line's part lines in step should do. Pure diff:
//   outer    { qty, status, line_remark }
//   parts    [{ part_product_id, label, per_carton }] from product_parts
//   existing [{ id, product_id, qty, status, line_remark, part_label,
//             part_per_carton, label, jc_status }] the carton's part lines
//             (partLinesOf) — each REMEMBERS its own label and pieces per
//             carton; jc_status says a die-cut part apart ('split')
// Every part line ON THE ORDER still in planning follows the carton's qty and
// batch — including one the master has dropped, sized by its own remembered
// pieces per carton. What a part IS (label, pieces per carton) follows the
// master only while the part is listed and nothing is under way; once the list
// is frozen, or once the master drops the part, the line's own figures stand.
// The LIST follows the master (adds, removes) only while no part is under way;
// after that a changed list is one warning.
export const SYNCABLE_OUTER = ['pending', 'planned'];
export function partLineSyncPlan({ outer, parts = [], existing = [] }) {
  const plan = { insert: [], update: [], remove: [], warnings: [] };
  if (!SYNCABLE_OUTER.includes(outer.status)) return plan;
  const remark = outer.line_remark ?? null;
  const frozen = partsFrozen(existing);
  const listed = new Set(parts.map(p => id(p.part_product_id)));
  // The one road to a new figure on a part past planning — while none is die-cut.
  const redo = canRollBack(existing) ? ' — to change it, roll the carton back in Planning and save this order again' : '';
  for (const line of existing) {
    const p = parts.find(x => id(x.part_product_id) === id(line.product_id));
    const master = !frozen && p;                 // the master speaks for this part
    const label = master ? p.label : (line.part_label ?? line.label);
    const perCarton = master ? per(p) : (n(line.part_per_carton) || per(p));
    const qty = n(outer.qty) * perCarton;
    const qtyMoved = n(line.qty) !== qty;
    const batchMoved = (line.line_remark ?? null) !== remark;
    const whatMoved = (line.part_label ?? null) !== label || n(line.part_per_carton) !== perCarton;
    if (!qtyMoved && !batchMoved && !whatMoved) continue;
    if (EDITABLE_PART.includes(line.status)) {
      plan.update.push({ id: line.id, qty, line_remark: remark, label, per_carton: perCarton });
      continue;
    }
    if (qtyMoved) plan.warnings.push(`${label} is ${partSays(line)}, so its quantity stays at ${qtyText(line.qty)}${redo}`);
    if (batchMoved) plan.warnings.push(`${label} is ${partSays(line)}, so it keeps batch ${line.line_remark ?? 'none'}, not ${remark ?? 'none'}${redo}`);
  }
  if (!frozen) {
    for (const p of parts) {
      if (!existing.some(e => id(e.product_id) === id(p.part_product_id)))
        plan.insert.push({ product_id: id(p.part_product_id), qty: n(outer.qty) * per(p), label: p.label, per_carton: per(p) });
    }
    for (const line of existing) if (!listed.has(id(line.product_id))) plan.remove.push({ id: line.id });
  }
  const onOrder = new Set(existing.map(e => id(e.product_id)));
  const differs = listed.size !== onOrder.size || [...listed].some(x => !onOrder.has(x));
  if (frozen && differs) {
    plan.warnings.push(`This carton is already under way as ${existing.map(e => e.part_label ?? e.label).join(' + ')} — a changed parts list applies from the next order`
      + (canRollBack(existing) ? ', or to this one once the carton is rolled back in Planning and this order saved again' : ''));
  }
  return plan;
}

// Why a part line could not leave its carton: a record still points at it (a
// foreign key, not one of rollbackLine's blockers). Named when it is a shade
// card raised against the part — the form offers part lines — and said plainly
// for anything else. `table` is the referencing table Postgres names on the
// error (node-pg e.table).
export const partStillReferenced = (label, table) => (table === 'shade_cards'
  ? `${label} has a shade card raised against it`
  : `other records still point at ${label}`);

// Why this line cannot be cancelled (or, for a part, cancelled or removed on its
// own), or null. partLines: the carton's part lines, each with a label and its
// card's status (partLinesOf()). A part still pending or planned cancels with
// its carton — setLineStatus releases a planned part's holds on the way.
//
// The way out it names is the real one: rolling back any part in Planning rolls
// back the whole carton (rollbackLine), and the carton then cancels. That
// rollback is refused, naming the station, while a part's card has a stage
// started, and is never possible once a part is die-cut. So the part FURTHEST
// along speaks: one die-cut part and there is no way back, whatever the others are.
export const CANCELLABLE_PART = ['pending', 'planned'];
const farAlong = p => (pasted(p) ? 3 : p.jc_status === 'split' ? 2 : p.status === 'in_production' ? 1 : 0);
export function partsChangeBlock(line, partLines = []) {
  if (line?.part_of_line_id)
    return 'This is one part of a carton made in parts — cancel or remove the carton, not its part';
  const busy = partLines.filter(p => !CANCELLABLE_PART.includes(p.status))
    .sort((a, b) => farAlong(b) - farAlong(a))[0];
  if (!busy) return null;
  return dieCut(busy)
    ? `${busy.label} of this carton is ${partSays(busy)} — the carton can no longer be cancelled`
    : `${busy.label} of this carton is ${partSays(busy)} — roll the carton back in Planning first, then cancel it`;
}

// Why these lines cannot run as a gang or a combined run, or null. A part ends
// at die cutting on its own card, and a carton made in parts has no sheet of
// its own — a gang child or a combined run would credit FG with the wrong thing.
export function partLineGangBlock(members = []) {
  const part = members.find(m => m.part_of_line_id);
  if (part) return `${part.product_name} is one part of a carton made in parts — it runs on its own job card, never in a gang or combined run`;
  const carton = members.find(m => m.has_parts);
  if (carton) return `${carton.product_name} is made in parts — its parts run on their own job cards, never in a gang or combined run`;
  return null;
}

// Why this line cannot be planned, covered, raised for or filled from stock
// through a single-line Planning/FG door, or null.
//   hasParts — a CARTON made in parts: no board and no card of its own; its
//              parts are planned, covered and filled instead.
//   isPart   — pass at the two FG doors only (consume-fg, fulfil-from-stock): a
//              part's pieces come from its own job card; FG booked against a
//              part would leave the pasting join waiting for a card forever.
export function cartonLineBlock({ hasParts = false, isPart = false }) {
  if (hasParts) return 'This carton is made in parts — plan, cover and fill its parts, not the carton itself';
  if (isPart) return 'This is one part of a carton made in parts — its pieces come from its own job card, never from FG stock';
  return null;
}

// Pieces of one part in one carton: far above any real carton (almost always
// 1). A quantity typed into this box would multiply every open line by it.
const MAX_PER_CARTON = 1000;

// Why this parts list cannot be saved on this carton, or null. Each refusal
// names the row, since the Product Master editor shows a list.
//   outer          { id, customer_id }
//   parts          [{ part_product_id, label, per_carton }]
//   products       Map id(number) → { id, customer_id } for every part_product_id
//   outerIsPart    the outer already sits under another carton
//   partsWithParts part ids that are cartons-in-parts themselves
export function partsSetError({ outer, parts = [], products, outerIsPart, partsWithParts = [] }) {
  if (!parts.length) return null; // clearing the list is always allowed
  if (parts.length < 2) return 'A carton made in parts needs at least two parts — or none';
  if (outerIsPart) return 'This product is itself a part of another carton — a part cannot have parts';
  const nested = new Set(partsWithParts.map(id));
  const labels = new Set();
  const ids = new Set();
  for (const [i, p] of parts.entries()) {
    const row = String(p.label || '').trim() || `Row ${i + 1}`;
    const pid = id(p.part_product_id);
    if (!Number.isInteger(pid) || pid <= 0) return `${row}: pick the part's product`;
    if (pid === id(outer.id)) return `${row}: a carton cannot be a part of itself`;
    const prod = products.get(pid);
    if (!prod) return `${row}: that product is not in the Product Master`;
    if (id(prod.customer_id) !== id(outer.customer_id)) return `${row}: every part must belong to the same customer as the carton`;
    if (nested.has(pid)) return `${row}: that product has parts of its own — only one level is allowed`;
    if (ids.has(pid)) return `${row}: the same product is listed twice`;
    ids.add(pid);
    const label = String(p.label || '').trim().toLowerCase();
    if (!label) return `${row}: give the part a label (Part 1, Part 2 …)`;
    if (labels.has(label)) return `${row}: two parts have the same label`;
    labels.add(label);
    if (!Number.isInteger(Number(p.per_carton)) || Number(p.per_carton) < 1) return `${row}: pieces per carton must be a whole number, 1 or more`;
    if (Number(p.per_carton) > MAX_PER_CARTON) return `${row}: pieces per carton must be ${MAX_PER_CARTON} or fewer`;
  }
  return null;
}

// The Status Sheet's Print Status for a carton made in parts. Its own card is
// its pasting card (sorting + pasting), so it never has a printing stage of its
// own — it is printed as its parts are. Given each part's printing-stage
// status (null for a part with no card yet), the one status the sheet's
// printState reads, in the same vocabulary as an ordinary line's stage:
//   completed           every part printed                   → Done
//   in_progress         a part printing now                  → Running
//   partially_completed some parts printed (or partly)       → Partial
//   hold                a part's printing held, nothing done → On hold
//   pending             a part carded, none printing yet     → Queued
//   null                no part has a card                   → Not started
export function cartonPrintState(printing = []) {
  const has = s => printing.includes(s);
  if (!printing.length || printing.every(s => s == null)) return null;
  if (printing.every(s => s === 'completed')) return 'completed';
  if (has('in_progress')) return 'in_progress';
  if (has('completed') || has('partially_completed')) return 'partially_completed';
  if (has('hold')) return 'hold';
  return 'pending';
}
