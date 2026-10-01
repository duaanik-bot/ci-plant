// Client side of a carton made in parts (server rules: server/src/carton-parts.js).
import { worstBoardStateOf } from './boardState.js';

// The chip under a part's product name in Planning.
export const partChipText = row => (row?.part_of_line_id
  ? `${row.part_label || 'Part'} · for ${row.outer_code || 'its carton'}` : null);

// One board verdict per carton, from its part rows on screen: how many parts
// are covered, and the worst state among them (the carton is only as ready
// as its scarcest board). Keyed by the carton line id.
//
// `fallback(row)` decides what a part served WITHOUT board_state reads as — the
// page's own board-column rule (boardState.js worstBoardStateOf) — and the
// count and the colour read that same one answer, so they cannot disagree.
export function cartonBoardSummary(rows = [], fallback) {
  const stateOf = r => r.board_state || (fallback ? fallback(r) : 'covered');
  const byCarton = new Map();
  for (const r of rows) {
    if (!r?.part_of_line_id) continue;
    if (!byCarton.has(r.part_of_line_id)) byCarton.set(r.part_of_line_id, []);
    byCarton.get(r.part_of_line_id).push(r);
  }
  const out = new Map();
  for (const [id, parts] of byCarton) {
    out.set(id, {
      covered: parts.filter(p => stateOf(p) === 'covered').length,
      total: parts.length,
      state: worstBoardStateOf(parts, fallback),
    });
  }
  return out;
}

// How many CARTONS a set of Planning rows makes. A carton made in parts is on
// the board as its parts, and each part row carries PIECES — its qty is the
// carton's qty × its pieces per carton — so adding every row's qty counts the
// carton once per part, in pieces (5,000 SW-715 in two parts + a 3,000 inner
// read 13,000). Each carton counts ONCE here, in cartons: the first of its part
// rows among `rows`, its qty ÷ its pieces per carton (1 when the line remembers
// none, as the server's own pasting card reads it — carton-parts-db.js). Every
// other row adds its own qty, exactly as before.
export function cartonQtyOf(rows = []) {
  const counted = new Set();
  let total = 0;
  for (const r of rows) {
    if (r?.part_of_line_id == null) { total += +r?.qty || 0; continue; }
    const carton = Number(r.part_of_line_id);
    if (counted.has(carton)) continue;
    counted.add(carton);
    total += (+r.qty || 0) / (Number(r.part_per_carton) || 1);
  }
  return total;
}

// A carton's PASTING CARD made for 0 cartons (its scarcest part was die-cut at
// 0 — the card is still made, so the shortage re-raise can bring the carton
// back) cannot close through the Sort & Paste form: its pool is 0, and that
// completion rightly refuses an empty grid. It closes through the same
// per-stage calls the Job Cards page makes (Production.jsx startStage → doStart,
// then complete): each stage still open, in route order — sorting, then
// pasting — started where it is still pending, then completed at 0 good, 0
// scrap. The start carries the line clearance the operator confirmed, as the
// Job Cards page's start does; the server refuses a start without it.
export function closeAtZeroCalls(stages = [], lineClearance) {
  const calls = [];
  for (const st of [...stages].sort((a, b) => a.seq - b.seq)) {
    if (st.status === 'completed') continue;
    if (st.status === 'pending') calls.push({ url: `/job-stages/${st.id}/start`, body: { line_clearance: lineClearance } });
    calls.push({ url: `/job-stages/${st.id}/complete`, body: { qty_out: 0, qty_scrap: 0 } });
  }
  return calls;
}

// What the floor is told about a pasting card with nothing to paste: before it
// closes, and once it has — never "FG added to stock" over a close that made
// nothing. The carton goes to Dispatch → Shortage, where Planning re-raises it.
export const nothingToPasteText = (jcNumber, code) =>
  `${jcNumber} has 0 cartons to paste. Close it? ${code || 'The carton'} goes to the Shortage tab for Planning to re-raise.`;
export const closedNothingMadeText = (jcNumber, code) =>
  `${jcNumber} closed with nothing made — ${code || 'the carton'} is in the Shortage tab`;

// A carton's PASTING CARD (job_cards.is_assembly) only sorts and pastes: its
// pieces were cut, printed and die-cut on its parts' cards, so it uses no board,
// no sheets and no press. ONE sentence says so, wherever a card would name its
// board: the board box of the printed card (JobCardSheet) and the head of its
// editor (Production.jsx).
export const PASTING_NO_BOARD_TEXT = "No board — this card pastes the pieces from its parts' job cards";

// What a pasting card's printed card therefore leaves out, by the sheet's own
// titles and labels: the two groups that belong to the part cards, and three
// rows of Planning — Sheets Required and Press, and Planned Qty, which is the
// same number as the "Cartons to Paste" it keeps.
export const PASTING_CARD_OMITS = Object.freeze({
  groups: Object.freeze(['Sheet & Finish', 'Printing Specifications']),
  planning: Object.freeze(['Planned Qty', 'Sheets Required', 'Press']),
});

// The spec groups a job card prints: [{ title, rows: [[label, value], …] }] in,
// the same shape out. Every card but a pasting card gets back the very list it
// gave — an ordinary card, a part card, a gang parent and a split gang child
// print every group and every row, exactly as before.
export function printedSpecGroups(jc, groups) {
  if (!jc?.is_assembly) return groups;
  return groups
    .filter(g => !PASTING_CARD_OMITS.groups.includes(g.title))
    .map(g => (g.title === 'Planning'
      ? { ...g, rows: g.rows.filter(([label]) => !PASTING_CARD_OMITS.planning.includes(label)) }
      : g));
}

// A pasting card's sheets_issued holds its CARTONS — the card is made with
// qty_planned = sheets_issued = the sets its parts join (carton-parts-db.js) —
// so a total of sheets issued leaves it out. Every other card adds its own
// figure, exactly as before.
export const sheetsIssuedTotal = (rows = []) =>
  rows.reduce((s, j) => s + (j?.is_assembly ? 0 : (+j?.sheets_issued || 0)), 0);

// How a pasting card's cartons ARE corrected, said under the figure its editor
// shows and never takes: Planning amends it, with a reason, and the amendment
// is audited (POST /job-cards/:id/amend). The Job Cards page offers Amend only
// once a card is finalised, so a card still to be finalised is told that first;
// and it has to happen before Sort & Paste starts the card, because Start
// stamps this figure onto the sorting stage. Takes whether the card is
// finalised as a plain yes or no.
export const pastingQtyCorrectionText = finalised => (finalised
  ? 'Planning corrects it through Amend, with a reason, before the card is started at Sort & Paste.'
  : 'Planning corrects it through Amend, with a reason, once this card is finalised and before it is started at Sort & Paste.');

// Why a pasting card's Amend offers no order quantity — the server's own words
// for an amendment that sends one (routes/production.js).
export const PASTING_ORDER_QTY_TEXT = 'its quantity follows the carton: change the carton in Orders → Edit';

// The row a deep link naming this line (a bell, ?line=) should land on: the
// line itself when it is on the page; else — a carton made in parts, which
// Planning does not list while its parts are being made — its first part on
// the page (the list is in the server's order, so that is Part 1). Unchanged
// when neither is here yet, so the page can still wait for its other half.
export function focusLineOf(lines = [], lineId) {
  if (lineId == null) return lineId;
  if (lines.some(l => Number(l.id) === Number(lineId))) return lineId;
  const part = lines.find(l => l.part_of_line_id != null && Number(l.part_of_line_id) === Number(lineId));
  return part ? part.id : lineId;
}
