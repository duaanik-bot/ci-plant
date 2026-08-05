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

// The rows, in the order the checklist renders them. `hard` marks the only
// three checks the ERP refuses on — the ONLY items that may ever reach state
// 'blocked'. Die and plate are deliberately soft here even though the tooling
// GATE calls the die hard: the gate decides whether planning nags, the light
// decides whether an operator is told to stop.
const ITEMS = [
  // Most upstream fact of all: is the product itself finished? A line can now be
  // raised before its board and ups are known (the order desk knows the carton
  // and the price, not the sheet), which parks the product on a placeholder
  // board with ups 1 and flags spec_incomplete. Soft by construction — nothing
  // refuses such a line, and the planner clears it simply by finalising a plan.
  { key: 'spec',            label: 'Product spec complete', hard: false },
  { key: 'artwork',         label: 'Artwork approved', hard: true  },
  { key: 'board_available', label: 'Board available',  hard: true  },
  { key: 'board_cut',       label: 'Board cut',        hard: false },
  { key: 'plate',           label: 'Plate ready',      hard: false },
  { key: 'die',             label: 'Die ready',        hard: false },
  // Soft since printing start became an acknowledge-and-run alarm: the ERP
  // warns about a lapsed or unapproved card, it no longer refuses one.
  { key: 'shade',           label: 'Shade approved',   hard: false },
  { key: 'ink',             label: 'Ink available',    hard: false },
  { key: 'machine',         label: 'Machine assigned', hard: false },
  { key: 'released',        label: 'Job released',     hard: false },
  // Station view only. Hard, because a station with nothing in front of it
  // genuinely cannot finish — see inputReady() for why that is a refusal.
  { key: 'input_ready',     label: 'Work received',    hard: true  },
];

// Which rows each station is actually asked about. A station judged on a row it
// has no say in is a station whose dot never goes green: printing cannot
// produce a die, cutting cannot produce a plate, and nobody downstream of
// cutting goes looking for board — it was issued and consumed upstream.
// An unknown stage falls back to being asked everything, which is the safe way
// to be wrong: it over-reports rather than hiding a real blocker.
//
// 'spec' appears in NO station list, deliberately. A half-known product master
// is a planning question; by the time sheets are in front of a press the board
// has already been bought, cut and issued, and no operator can finish the
// master anyway. Leaving it out keeps every station dot and percentage exactly
// as they were — the row still renders, as 'not applicable at <stage>', so the
// operator can see it was asked and ruled out. Do not "fix" this by adding it.
const STAGE_ITEMS = {
  cutting:     ['artwork', 'board_available', 'machine', 'released', 'input_ready'],
  // No 'board_cut' here, or anywhere below: it asks the same question
  // 'input_ready' does, but demands cutting be COMPLETED, so it would pin a
  // press to amber while the sheets it is printing sit in front of it.
  // board_cut stays a PLANNING row, where nothing has been handed over yet.
  printing:    ['artwork', 'plate', 'shade', 'ink', 'machine', 'released', 'input_ready'],
  coating:     ['artwork', 'machine', 'released', 'input_ready'],
  lamination:  ['artwork', 'machine', 'released', 'input_ready'],
  foiling:     ['artwork', 'die', 'machine', 'released', 'input_ready'],
  embossing:   ['artwork', 'die', 'machine', 'released', 'input_ready'],
  die_cutting: ['artwork', 'die', 'machine', 'released', 'input_ready'],
  sorting:     ['artwork', 'machine', 'released', 'input_ready'],
  pasting:     ['artwork', 'machine', 'released', 'input_ready'],
  qc:          ['artwork', 'input_ready'],
};

function boardAvailable(gates) {
  if (gates.material) return ['ok', null];
  // Every qty column is DOUBLE PRECISION, so a raw difference reads as
  // "short by 0 parent sheets" on a float hair. You cannot be short by part of
  // a sheet — round the shortfall up to the sheet the storeman has to find.
  if (gates.mix_active) {
    // mix_balance is a SUM across rows (board-mix.js's mixBalance), not a
    // single subtraction of two integers — the float hair above is MORE
    // likely here, not less, and a few EPS of residue can land on either
    // side of zero. Snap it the same way mixBalance's own `balanced` flag
    // does, before it is ever allowed to become a message.
    const MIX_EPS = 1e-6;
    const balance = Math.abs(gates.mix_balance) < MIX_EPS ? 0 : (+gates.mix_balance || 0);
    if (balance > 0) {
      // Unbalanced: the rows do not sum to the requirement. That is a
      // PLANNING gap, not a stock one — no PR orders a finished plan into
      // existence — so this is always 'blocked', matching
      // createJobCardForLine's gate, and never 'pending'.
      const short = Math.ceil(balance);
      const needed = +gates.parent_needed || 0;
      return ['blocked',
        `Board mix covers ${needed - short} of ${needed} parent sheets — allocate the remaining ${short}`];
    }
    // Balanced (or over-allocated, which reads the same to an operator: the
    // paperwork adds up but the gate is still shut either way) — the failure
    // is that a row's own board no longer holds what it claims. mix_balance
    // is ~0 by construction here, so "short by 0" would be actively wrong,
    // not merely imprecise. Say what happened instead of inventing a number.
    if (gates.material_pending)
      return ['pending', 'on order — a board in the mix is short, supply already requested'];
    return ['blocked', 'A board in the mix no longer has the stock allocated to it — re-check the mix'];
  }
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

// A half-known product: raised from the order desk with no board chosen, so it
// sits on a placeholder board with ups 1 until Planning finalises the real one.
// This is a PLANNING row, not an operator's — see STAGE_ITEMS, which gives it to
// no station. A press cannot repair the product master, and a dot that nags an
// operator about paperwork they cannot touch is a dot that teaches them to
// ignore dots. Amber, never red: nothing in the ERP refuses a spec_incomplete
// line, so claiming a stop here would make the colour lie.
function specState(specIncomplete) {
  if (!specIncomplete) return ['ok', null];
  return ['pending', 'board and ups not confirmed — placeholder spec until planning finalises'];
}

// Shade is a WARNING, not a refusal. Printing start no longer turns an
// unapproved or lapsed card away — it names the problem and records who chose
// to run anyway — so this dot must not claim the ERP will stop the press.
// RED means "you will be refused"; this is amber: real, loud, and the
// supervisor's call. Leaving it red after the gate softened would make the dot
// lie, and a dot that cries stop when nothing stops is a dot nobody reads.
function shadeState(shade) {
  if (!shade) return ['na', 'no shade card registered'];
  if (shade.eligible) return ['ok', null];
  return ['pending', shade.reason || 'shade card not approved'];
}

// Has the work physically reached this station? The one fact a station has
// that planning does not, and the reason a station needs its own dot at all.
//
// RED here is deliberate and it is NOT a contradiction of the rule above.
// Stations run inline — any station may be STARTED at any time — so an
// un-started upstream does not refuse the start. It refuses the COMPLETE: a
// stage cannot be completed with no input, and a station with nothing in front
// of it cannot produce. So "will the ERP stop me" is still exactly what red
// means; the stop just lands one step later.
function inputReady(prevStatus, prevStage, qtyReceived) {
  const name = (prevStage || 'the previous stage').replace(/_/g, ' ');
  // No upstream at all — this is where production begins on this route.
  if (prevStatus == null) return ['na', 'first stage on this route — nothing to wait for'];
  // Sheets in hand beat any upstream status: a partial handoff has happened,
  // and the operator can work. This is the case that must not read amber.
  if (qtyReceived > 0) return ['ok', null];
  if (prevStatus === 'completed') return ['ok', null];
  if (['in_progress', 'partially_completed', 'hold'].includes(prevStatus))
    return ['pending', `${name} in progress — nothing received here yet`];
  return ['blocked', `Nothing received — ${name} has not started`];
}

export function readinessLight({
  gates, cuttingStatus = null, machineId = null, finalisedAt = null,
  shade = null, toolingOk = 0, override = null, specIncomplete = 0,
  // Station view. `stage` null keeps the planning view exactly as it was —
  // Planning and Print Planning render the original nine rows and never see
  // an input row, because at planning time nothing has been handed over yet.
  stage = null, prevStatus = null, prevStage = null, qtyReceived = 0,
} = {}) {
  const g = gates || {};
  const resolved = {
    spec: specState(specIncomplete),
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
    input_ready: inputReady(prevStatus, prevStage, qtyReceived),
  };

  const station = !!stage;
  const allowed = station ? new Set(STAGE_ITEMS[stage] || ITEMS.map(i => i.key)) : null;
  // The input row exists only in a station view; planning never shows it.
  const shown = ITEMS.filter(it => it.key !== 'input_ready' || station);

  const items = shown.map(it => {
    let [state, note] = resolved[it.key];
    // A row this station has no say in is set aside rather than dropped: the
    // checklist reads the same everywhere, and an operator can see the row was
    // considered and ruled out instead of wondering where it went.
    if (allowed && !allowed.has(it.key)) {
      state = 'na';
      note = `not applicable at ${stage.replace(/_/g, ' ')}`;
    }
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

  // Whether each product is still half-known. One row per product, same shape
  // as the shade fetch above — never per card, or Print Planning's hundred
  // cards become a hundred round trips.
  const spec = productIds.length ? await oc(`
    SELECT COALESCE(json_agg(json_build_object(
      'product_id', p.id, 'spec_incomplete', COALESCE(p.spec_incomplete, 0))), '[]'::json) AS list
    FROM products p WHERE p.id = ANY($1)`, [productIds]) : null;

  const cutByCard = new Map();
  for (const s of cut?.list ?? []) cutByCard.set(+s.job_card_id, s.status);

  const specByProduct = new Map();
  for (const p of spec?.list ?? []) specByProduct.set(+p.product_id, +p.spec_incomplete || 0);

  const shadeByProduct = new Map();
  for (const card of shade?.list ?? []) {
    shadeByProduct.set(+card.product_id, printingEligibility(card));
  }

  for (const c of rows) {
    out.set(+c.id, {
      // No cutting row means no cutting stage on this route — 'na', not 'late'.
      cuttingStatus: cutByCard.get(+c.id) ?? null,
      shade: shadeByProduct.get(+c.product_id) ?? null,
      specIncomplete: specByProduct.get(+c.product_id) ?? 0,
    });
  }
  return out;
}
