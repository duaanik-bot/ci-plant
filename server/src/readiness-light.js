// ─── Readiness traffic light — pure logic, no DB ─────────────────────────────
// The light is DERIVED, never a new source of truth: readiness() already
// computes the gates, tooling-gate.js the per-family tooling states and
// shade-flow.js the shade verdict. This module turns those facts into the one
// dot an operator reads from across the hall, plus the checklist behind it.
//
// RED must mean what the system actually REFUSES, or the colour is a lie.
// Exactly three things refuse a job: artwork not locked and board short with
// NOTHING on order (createJobCardForLine's blocked[]), plus a hard shade-card
// block (the one gate that stops a printing start outright). Everything else —
// a missing or not-ready DIE included — lands in createJobCardForLine's
// pending[], and the plant pushes and runs those jobs every day. Painting a bad
// die red would tell an operator "cannot proceed" about work the floor proceeds
// with, so a bad die is AMBER with the die named. The distinction the operator
// needs is "will the ERP stop me" (red) versus "I can start but someone should
// know" (amber).
import { printingEligibility } from './shade-flow.js';

export const LIGHT_LABEL = { red: 'Blocked', amber: 'Partly ready', green: 'Ready to run' };

// The nine rows, in the order the checklist renders them. `hard` marks the only
// three checks the ERP refuses on — the ONLY items that may ever reach state
// 'blocked'. Die and plate are deliberately soft here even though the tooling
// GATE calls the die hard: the gate decides whether planning nags, the light
// decides whether an operator is told to stop.
const ITEMS = [
  { key: 'artwork',         label: 'Artwork approved', hard: true  },
  { key: 'board_available', label: 'Board available',  hard: true  },
  { key: 'board_cut',       label: 'Board cut',        hard: false },
  { key: 'plate',           label: 'Plate ready',      hard: false },
  { key: 'die',             label: 'Die ready',        hard: false },
  { key: 'shade',           label: 'Shade approved',   hard: true  },
  { key: 'ink',             label: 'Ink available',    hard: false },
  { key: 'machine',         label: 'Machine assigned', hard: false },
  { key: 'released',        label: 'Job released',     hard: false },
];

function boardAvailable(gates) {
  if (gates.material) return ['ok', null];
  // Every qty column is DOUBLE PRECISION, so a raw difference reads as
  // "short by 0 parent sheets" on a float hair. You cannot be short by part of
  // a sheet — round the shortfall up to the sheet the storeman has to find.
  const short = Math.ceil(Math.max(0, (+gates.parent_needed || 0) - (+gates.available_sheets || 0)));
  if (gates.material_pending) return ['pending', `on order — short by ${short} parent sheets`];
  return ['blocked', `Board short by ${short} parent sheets — nothing on order`];
}

const CUT_NOTE = {
  in_progress: 'cutting in progress',
  partially_completed: 'partially cut',
  hold: 'cutting on hold',
};

// The one genuinely new fact in the light. No cutting stage on the route at all
// means the job never needed one (a gang child receives die-cut cartons), so it
// is not applicable rather than outstanding — counting it would hold those jobs
// below 100% for ever.
function boardCut(cuttingStatus) {
  if (cuttingStatus == null) return ['na', 'no cutting stage on this route'];
  if (cuttingStatus === 'completed') return ['ok', null];
  return ['pending', CUT_NOTE[cuttingStatus] ?? 'not cut yet'];
}

function toolingFamily(gates, family, toolingOk) {
  const d = (gates.tooling_detail || []).find(x => x.family === family);
  if (!d) return ['na', null];
  if (d.status === 'ready') return ['ok', null];
  const note = d.status === 'missing' ? 'not registered' : `not ready${d.code ? ` (${d.code})` : ''}`;
  // tooling_ok is the ABSOLUTE manual override of the whole tooling gate
  // (toolingGateOk short-circuits on it), so a job passes planning with this
  // family still bad. The row keeps its real state and only gains the note —
  // a green tick here is how an operator walks to a press with no die.
  return ['pending', toolingOk ? `${note} · accepted by planning` : note];
}

// Shade is one of the three checks the ERP genuinely refuses on, so an
// unapproved or expired card is 'blocked' and the dot goes red. There is no
// soft shade state any more: internal approval is gone, so every shade block
// is a real refusal.
function shadeState(shade) {
  if (!shade) return ['na', 'no shade card registered'];
  if (shade.eligible) return ['ok', null];
  return ['blocked', shade.reason || 'shade card not approved'];
}

export function readinessLight({
  gates, cuttingStatus = null, machineId = null, finalisedAt = null,
  shade = null, toolingOk = 0, override = null,
} = {}) {
  const g = gates || {};
  const resolved = {
    artwork: g.artwork ? ['ok', null] : ['blocked', 'Artwork not locked'],
    board_available: boardAvailable(g),
    board_cut: boardCut(cuttingStatus),
    plate: toolingFamily(g, 'plate', toolingOk),
    die: toolingFamily(g, 'die', toolingOk),
    shade: shadeState(shade),
    // Ink stock is not modelled anywhere in the ERP. Showing it green would be
    // a fiction and counting it would cap the plant below 100% for ever, so it
    // is stated honestly as untracked.
    ink: ['na', 'not tracked in the ERP yet'],
    machine: machineId ? ['ok', null] : ['pending', 'no press assigned'],
    released: finalisedAt ? ['ok', null] : ['pending', 'not finalised in planning yet'],
  };

  const items = ITEMS.map(it => {
    const [state, note] = resolved[it.key];
    // 'na' rows are dropped from the percentage, so tracked IS "counts towards
    // the score" — ink is untracked because it is permanently na.
    return { key: it.key, label: it.label, state, note, hard: it.hard, tracked: state !== 'na' };
  });

  const tracked = items.filter(i => i.tracked);
  const done = tracked.filter(i => i.state === 'ok').length;
  // The tooltip must say what is WRONG, not what would be right, so a blocked
  // row contributes its note ("Artwork not locked") over its label.
  const blockers = items.filter(i => i.state === 'blocked').map(i => i.note || i.label);
  const computed = blockers.length ? 'red'
    : items.some(i => i.state === 'pending') ? 'amber'
      : 'green';

  // A supervisor's "Ready to Run" paints the dot green and says who did it —
  // it never writes a gate, so the checklist and the percentage keep reporting
  // the truth underneath and a hard blocker stays listed.
  const overridden = !!override?.on;
  return {
    light: overridden ? 'green' : computed,
    pct: tracked.length ? Math.round((done / tracked.length) * 100) : 100,
    overridden,
    override: overridden ? override : null,
    blockers,
    items,
  };
}

// ─── Batch inputs for a page full of job cards ───────────────────────────────
// Job-card rows already carry (or can cheaply carry) the readiness gates; the
// two things they never have are the cutting stage's status and the shade
// verdict. Both are resolved for the WHOLE page in one round trip each —
// print planning renders a hundred cards, and a query per card would put the
// board's latency on a remote DB in the seconds. json_agg is what lets a
// one-row helper (`oc`) carry a whole result set back.
export async function lightForJobCards(cards, oc) {
  const rows = (cards || []).filter(c => c?.id != null);
  const out = new Map();
  if (!rows.length) return out;

  const ids = [...new Set(rows.map(c => +c.id))];
  const productIds = [...new Set(rows.map(c => c.product_id).filter(x => x != null).map(Number))];

  const cut = await oc(`
    SELECT COALESCE(json_agg(json_build_object('job_card_id', js.job_card_id, 'status', js.status)), '[]'::json) AS list
    FROM job_stages js
    WHERE js.job_card_id = ANY($1) AND js.stage='cutting'`, [ids]);

  // The newest live card per product. No requirement columns to join any more —
  // the gate is one rule, so the verdict needs nothing but the card.
  //
  // `s.active` is selected even though the WHERE clause already guarantees it is
  // 1: printingEligibility checks `card.active === 0`, and a row omitting the
  // column would make the verdict depend on a field that isn't there.
  //
  // The old query filtered `status NOT IN ('superseded','archived')` — those
  // statuses no longer exist, and cards that held them were set `active = 0` by
  // the migration, so `active = 1` covers the same ground.
  const shade = productIds.length ? await oc(`
    SELECT COALESCE(json_agg(sc), '[]'::json) AS list FROM (
      SELECT DISTINCT ON (s.product_id) s.product_id, s.sc_number, s.status,
             s.creation_date, s.active
      FROM shade_cards s
      WHERE s.product_id = ANY($1) AND s.active = 1
      ORDER BY s.product_id, s.id DESC
    ) sc`, [productIds]) : null;

  const cutByCard = new Map();
  for (const s of cut?.list ?? []) cutByCard.set(+s.job_card_id, s.status);

  const shadeByProduct = new Map();
  for (const card of shade?.list ?? []) {
    shadeByProduct.set(+card.product_id, printingEligibility(card));
  }

  for (const c of rows) {
    out.set(+c.id, {
      // No cutting row means no cutting stage on this route — 'na', not 'late'.
      cuttingStatus: cutByCard.get(+c.id) ?? null,
      shade: shadeByProduct.get(+c.product_id) ?? null,
    });
  }
  return out;
}
