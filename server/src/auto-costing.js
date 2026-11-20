// The enquiry desk costs a filed item by itself (owner, 20 Nov 2026: every item the robots file is costed by CI Plant,
// held for a Management approval, and never sent). The fill is the costing form's own — costingValueFromEnquiry, then
// recommend (client/src/lib) with the context the form gets: the Rates settings, the typical figures, the board grades
// charged ONCE for this customer, the size check with the stocked sheets, the Product Master entry. The costing is saved
// as an Auto draft (costings.auto_costed) waiting for approval, linked to its enquiry, and every value the house rules,
// the layout picker or an assumption gave is noted on it. Nothing here mails anyone.
//
// Guarantees:
//   - at most once by itself: a row is claimed with one UPDATE (enquiries.auto_cost_at), so of two callers only one
//     costs it; "Cost it for me" (force) may cost again only a row whose auto-costing is still incomplete. A claim
//     still "being costed" after five minutes belongs to a call that stopped (a call has 30 s): the row is free again;
//   - a hidden costing counts as none, as on the desk: a new costing is made and linked in its place;
//   - one transaction per enquiry, and the context is read through the pool BEFORE it (on a one-client pool a pool call
//     inside a transaction waits for itself forever);
//   - errors never fail the filing: the row keeps "Could not cost it by itself: …" with an event, and nothing is rethrown;
//   - a costing a person made or revised is never touched, and an auto-costing never adds a size to the Size Library.
//
//   autoCostValue(enquiry, ctx)                 the fill, pure: { value, result, complete, why, notes }
//   autoCostRemarks(enquiryNo, notes)           the costing's remarks, pure: the notes, cut between two at 1,000
//   autoCostEnquiry(id, { force })              one enquiry: claim it, read its context, save and link its costing
//   autoCostPending({ ids, budgetMs, force, deadline })   the filed rows still to cost (or the ticked ids), oldest first, in a budget
//   autoCostPendingSoft(opts)                   the same, never throwing (the filing paths call it before they announce)
import { q, one, tx } from './db.js';
import { lockDocNumber } from './helpers.js';
import { parseSize, normStyle, INPUTS } from './costing-engine.js';
import { STATUS_LABEL, STALE_CLAIM_MINUTES } from './enquiry-desk.js';
import {
  costingFrom, sizeCheck, typicalFigures, boardGrades, productById, insertCosting, reviseCosting,
} from './costing-store.js';
import { linkEnquiry, enquiryEvent } from './routes/enquiries.js';
import { recommend, savePayload } from '../../client/src/lib/costingUi.js';
import { costingValueFromEnquiry } from '../../client/src/lib/enquiryUi.js';
import { chargeGrades, customerBoardRate, masterDieOf } from '../../client/src/lib/costingRules.js';

export const AUTO_RUNNER = 'CI Plant (auto)';
const RUNNER = Object.freeze({ id: null, name: AUTO_RUNNER });
const OPEN = ['new', 'ready', 'costing'];
const intOrNull = v => (Number.isInteger(+v) && +v > 0 ? +v : null);

// ── the fill (pure) ──────────────────────────────────────────────────────────────────────────────
// Finishes no house rule prices (owner's call, 20 Nov 2026): flagged on the costing, never priced by a guess. Each once,
// in the enquiry's own word; one said not to be wanted ("no window", "without lamination") is not asked.
const UNPRICED = [/\bwindow/g, /\blaminat(?:ion|e)/g, /\bvelvet|\bsoft[\s-]*touch/g];
const SAID_NOT = /\b(?:no|without|non)[\s-]*$/;
export function unpricedFinishes(e) {
  const t = [e?.coating, e?.specs, e?.notes].filter(Boolean).join(' · ').toLowerCase();
  const out = [];
  for (const re of UNPRICED) {
    const hit = [...t.matchAll(re)].find(m => !SAID_NOT.test(t.slice(0, m.index)));
    if (hit) out.push(`asked: ${/^soft/.test(hit[0]) ? 'soft-touch' : hit[0]} — not priced`);
  }
  return out;
}

// The values the fill took from a rule, the layout picker, an assumption or the size's past costings: one line for each
// thing, in the fill's own order, "{label}: {value} — {note}". The sheet and ups are one layout with the picker's one note
// ("Layout: {note}"); a coating button is said by its factor's (or rate's) line, and the run flag by the "planning:"
// wastage line. What the enquiry said (Typed here), typical figures and the Rates defaults are not noted.
const NOTED = new Set(['die', 'library', 'proposal', 'rule', 'assumed', 'history']);
const LAYOUT = ['sheet_l', 'sheet_w', 'ups'];
const LABEL = { style: 'Pasting', board_grade: 'Board grade', coat_choice: 'Coating', ...Object.fromEntries(INPUTS.map(i => [i.key, i.label])) };
function sourceNotes(v) {
  const src = v.sources || {};
  const noted = f => NOTED.has(src[f]?.kind);
  const lines = [];
  let layout = false;
  for (const [f, s] of Object.entries(src)) {
    if (!noted(f)) continue;
    if (f === 'wastage_by_run' || (f === 'coat_choice' && (noted('coat_factor') || noted('coat_rate')))) continue;
    if (LAYOUT.includes(f) && s.note && LAYOUT.every(k => !noted(k) || src[k].note === s.note)) {
      if (!layout) lines.push(`Layout: ${s.note}`);
      layout = true;
      continue;
    }
    const x = Object.prototype.hasOwnProperty.call(v.inputs || {}, f) ? v.inputs[f] : v[f];
    lines.push(`${LABEL[f] || f}: ${x}${s.note ? ` — ${s.note}` : ''}`);
  }
  return lines;
}
// The picker's flags (opening assumed, an oversize or unreadable die sheet) speak of the picker's own layout: they are
// noted only when the sheet and ups are that layout — not when the Product Master gave them (final review M8).
function pickerFlags(v) {
  const pick = v.layout_pick;
  if (!pick || pick.none) return [];
  const used = LAYOUT.every(k => v.sources?.[k]?.kind === pick.kind && v.sources[k].note === pick.note);
  return used ? pick.flags || [] : [];
}

// A die of exactly the size on the die list (die_register) changes neither the layout nor the new die — only Die Master
// dies count (17 Nov 2026) — but it is said, so a person checks the rack (design §6.2, final review M4). Named by its job
// number, else by the die list's own number for it.
export function dieListNotes(check) {
  return (check?.register?.exact || []).map(d => {
    const name = d?.job_no ? `Job ${d.job_no}'s die` : d?.die_no != null && String(d.die_no).trim() ? `Die ${String(d.die_no).trim()}` : 'A die';
    return `${name} on the die list is this size — check the rack`;
  });
}
const lowerFirst = s => s.charAt(0).toLowerCase() + s.slice(1);
const NONE = { exact: [], reordered: [], near: [] };
const NO_CHECK = { size: null, library: { exact: [], near: [] }, dies: NONE, register: NONE, history: [], sheets: [] };

// One enquiry, filled as the costing form fills it. ctx: { product, check, typical, defaults, boardGrades (raw, as Board
// Rates has them), customerRates }; check.sheets are the boards the layout picker may use. `why` = what keeps it from
// being complete, the first that applies (null when complete); `notes` = the finishes not priced, the picker's flags (when
// its layout is used), a die-list die of the size, then a line per value the rules, the picker or an assumption gave.
export function autoCostValue(enquiry, ctx = {}) {
  const { product = null, typical = {}, defaults = {}, boardGrades: raw = [], customerRates = [] } = ctx;
  const check = ctx.check || NO_CHECK;
  const customerRate = customerBoardRate(enquiry?.customer_name || product?.customer_name, customerRates);
  const value = recommend(costingValueFromEnquiry(enquiry, defaults || {}), {
    product, check, typical: typical || {}, defaults: defaults || {}, grades: chargeGrades(raw || [], customerRate?.rate ?? null),
    customerRate, boards: check.sheets || [], masterDie: masterDieOf(check),
  });
  const { result } = costingFrom(savePayload(value));
  const complete = !!result.ok;
  const size = parseSize(value.size_text);
  const why = complete ? null
    : !size || size.kind === 'other' ? 'needs a size'
      : !normStyle(value.style) ? 'needs pasting: side or lock?'
        : value.layout_pick?.none ? value.layout_pick.why
          : `needs ${result.missing.map(m => lowerFirst(m.label)).join(', ')}`;
  const notes = [...new Set([...unpricedFinishes(enquiry), ...pickerFlags(value), ...dieListNotes(check), ...sourceNotes(value)])];
  return { value, result, complete, why, notes };
}

// The costing's remarks: "Auto-costed from {no} — " and the notes joined with " · ", at most 1,000 characters. Cut between
// two notes, never inside one, with "…" for those left out (every note is on the enquiry's auto_cost event).
const REMARKS_MAX = 1000;
const MORE = ' · …';
export function autoCostRemarks(no, notes = []) {
  let out = `Auto-costed from ${no}`;
  for (const [i, n] of notes.entries()) {
    const sep = i ? ' · ' : ' — ';
    if (`${out}${sep}${n}`.length + (i < notes.length - 1 ? MORE.length : 0) > REMARKS_MAX) return `${out}${sep}…`;
    out = `${out}${sep}${n}`;
  }
  return out;
}

// ── one enquiry ──────────────────────────────────────────────────────────────────────────────────
const CLAIM_COLS = `e.id, e.enquiry_no, e.customer_id, e.customer_name, e.product_id, e.product_name,
  e.size_text, e.size_key, e.style, e.opening, e.board, e.gsm::float8 AS gsm, e.colours::float8 AS colours, e.coating, e.specs,
  e.quantities::float8[] AS quantities, e.target_price::float8 AS target_price, e.notes`;

// A claim still "being costed" after five minutes: its call stopped (a call has 30 s), so the row is free again. The
// minutes are the desk's one threshold (enquiry-desk.js), which its rows' words read too.
const STALE_CLAIM = `(e.auto_cost_why = 'being costed' AND e.auto_cost_at < now() - make_interval(mins => ${STALE_CLAIM_MINUTES}))`;

// The row as it is now: its claim, and its costing (a hidden costing counts as none — `live` is false).
const ROW_NOW = `SELECT e.enquiry_no, e.status, e.costing_id, e.auto_cost_why, ${STALE_CLAIM} AS stale_claim,
                        c.costing_no, c.auto_costed, c.complete, c.archived
                   FROM enquiries e LEFT JOIN costings c ON c.id = e.costing_id WHERE e.id = $1`;
const liveOf = cur => !!cur?.costing_no && !cur.archived;
// Why a row was not costed, read from the row as it is now.
const skipOf = (id, cur) => ({
  id, enquiry_no: cur?.enquiry_no ?? null, costing_no: cur?.costing_no ?? null, complete: !!cur?.complete, skipped: true,
  why: !cur ? 'was not found'
    : !OPEN.includes(cur.status) ? `is ${(STATUS_LABEL[cur.status] || cur.status).toLowerCase()}`
      : liveOf(cur) && !cur.auto_costed ? 'already has a costing'
        : liveOf(cur) && cur.complete ? 'already costed'
          : cur.auto_cost_why !== 'being costed' ? 'already tried by itself — press Cost it for me'
            : cur.stale_claim ? 'stopped while it was being costed — press Cost it for me'
              : 'already being costed',
});

export async function autoCostEnquiry(id, { force = false } = {}) {
  const eid = intOrNull(id);
  if (!eid) return skipOf(id, null);
  let row = null;
  try {
    // 1. The claim: one UPDATE, so of two callers at most one gets the row back. A row a person costed is never claimed;
    // a hidden costing counts as none; a stale claim counts as none.
    row = await one(`
      UPDATE enquiries e SET auto_cost_at = now(), auto_cost_why = 'being costed'
       WHERE e.id = $1 AND e.status = ANY($3::text[]) AND ($2::boolean OR e.auto_cost_at IS NULL OR ${STALE_CLAIM})
         AND NOT EXISTS (SELECT 1 FROM costings c WHERE c.id = e.costing_id AND NOT c.archived
                          AND NOT ($2::boolean AND c.auto_costed AND NOT c.complete))
      RETURNING ${CLAIM_COLS}`, [eid, !!force, OPEN]);
    if (!row) return skipOf(eid, await one(ROW_NOW, [eid]));

    // 2. The context, through the pool — never inside the transaction below.
    const [settings, typical, grades, product] = await Promise.all([
      one('SELECT defaults, customer_rates FROM costing_settings WHERE id = 1'), typicalFigures(), boardGrades(), productById(row.product_id),
    ]);
    const check = await sizeCheck(row.size_key || row.size_text || product?.size || null);
    const a = autoCostValue(row, { product, check, typical, defaults: settings?.defaults, boardGrades: grades, customerRates: settings?.customer_rates });
    const c = costingFrom({ ...savePayload(a.value), remarks: autoCostRemarks(row.enquiry_no, a.notes), save_size: false });

    // 3. One transaction. The number lock first, then the costing, then the enquiry — the order the costing routes take
    // (nextNumber, then reviseCosting, then linkEnquiry) — so a person saving the same enquiry at that moment cannot deadlock it.
    const done = await tx(async (qc, oc) => {
      await lockDocNumber('CI-CST-', oc);
      const was = (await oc('SELECT costing_id FROM enquiries WHERE id = $1', [eid]))?.costing_id ?? null;
      if (was) await oc('SELECT id FROM costings WHERE id = $1 FOR UPDATE', [was]);
      const cur = await oc(`${ROW_NOW} FOR UPDATE OF e`, [eid]);
      const open = OPEN.includes(cur?.status);
      const live = liveOf(cur);
      const revise = open && live && cur.costing_id === was && cur.auto_costed && !cur.complete && !!force;
      if (!open || (live && !revise)) {
        // Changed since the claim. Another call costed it: its why stands. A person costed it, or it moved on: the claim's
        // "being costed" is taken back.
        if (!(open && live && cur.auto_costed)) await qc('UPDATE enquiries SET auto_cost_why = NULL WHERE id = $1', [eid]);
        return skipOf(eid, cur);
      }
      // No live costing (none, or a hidden one): a new costing, which the link puts in the hidden one's place.
      const made = revise
        ? await reviseCosting(cur.costing_id, c, { note: `Auto-costed again from ${row.enquiry_no}`, auto: true }, qc, oc, RUNNER)
        : await insertCosting(c, { note: `Auto-costed from ${row.enquiry_no}`, auto: true }, qc, oc, RUNNER);
      await linkEnquiry(qc, eid, made, null, RUNNER, null, { auto: true });
      await qc('UPDATE enquiries SET auto_cost_why = $2 WHERE id = $1', [eid, a.complete ? null : a.why]);
      await enquiryEvent(qc, { enquiryId: eid, action: 'auto_cost', detail: { costing_no: made.costing_no, complete: a.complete, why: a.why, notes: a.notes } }, RUNNER);
      return { id: eid, enquiry_no: row.enquiry_no, costing_no: made.costing_no, complete: a.complete, why: a.why };
    });
    return done;
  } catch (e) {
    // 4. Never rethrown: the claimed row says why, and an event keeps it. A row whose claim itself failed was never taken:
    // it is left as it was, pending, for the next call. A refusal (e.status) is the row's own; anything else is logged.
    const why = `Could not cost it by itself: ${e?.message || e}`.slice(0, 300);
    if (!e?.status) console.error(`[auto-cost] ${row?.enquiry_no || `enquiry ${eid}`}:`, e?.stack || e);
    if (row) {
      try {
        await q('UPDATE enquiries SET auto_cost_why = $2 WHERE id = $1', [eid, why]);
        await enquiryEvent(q, { enquiryId: eid, action: 'auto_cost', detail: { costing_no: null, complete: false, why, notes: [] } }, RUNNER);
      } catch (e2) { console.error(`[auto-cost] ${row.enquiry_no}: could not keep why:`, e2.message); }
    }
    return { id: eid, enquiry_no: row?.enquiry_no ?? null, costing_no: null, complete: false, why, failed: true };
  }
}

// ── the rows still to cost ───────────────────────────────────────────────────────────────────────
// Pending = filed by a robot, still in the Inbox, with no costing, never tried by itself (or its claim went stale).
// Exported: the alert's wait (enquiry-intake.js) asks exactly this, never a copy of it.
export const PENDING = `e.source = 'robot' AND e.costing_id IS NULL AND e.status = 'new' AND (e.auto_cost_at IS NULL OR ${STALE_CLAIM})`;
const empty = () => ({ costed: [], held: [], failed: [], skipped: [], left: 0 });

// The costing's time in one call (final review M2). A call has 30 s (vercel.json maxDuration), and a route that costs after
// other work (the filing) has spent part of it: the route passes `deadline` = its request's start + CALL_DEADLINE_MS. The
// run may take its own budget, never past that deadline; the first row is costed even on a spent budget (R7), unless the
// deadline itself has passed. Pure: { ms, first }.
export const CALL_DEADLINE_MS = 25_000;
export function costBudget({ budgetMs = 15000, deadline = null, now = Date.now() } = {}) {
  const left = Number.isFinite(deadline) ? deadline - now : Infinity;
  return { ms: Math.max(0, Math.min(budgetMs, left)), first: left > 0 };
}

// Without `ids`: the pending rows, never-tried first (a stale claim never jumps the queue), then oldest, only while the desk's "cost new enquiries by themselves" is on. With
// `ids` (Cost it for me): those rows. Each row is one call of autoCostEnquiry, at least one a call, then while the budget
// lasts (costBudget: never past `deadline`); `left` = the rows not reached. `skipped` names the rows left as they are, with the reason.
export async function autoCostPending({ ids = null, budgetMs = 15000, force = false, deadline = null } = {}) {
  const out = empty();
  const ticked = Array.isArray(ids) ? [...new Set(ids.map(intOrNull).filter(Boolean))].slice(0, 200) : null;
  if (!ticked && !(await one('SELECT auto_cost FROM enquiry_settings WHERE id = 1'))?.auto_cost) return out;
  const list = ticked || (await q(`SELECT e.id FROM enquiries e WHERE ${PENDING} ORDER BY e.auto_cost_at NULLS FIRST, e.created_at, e.id LIMIT 500`)).map(r => r.id);
  const started = Date.now();
  const budget = costBudget({ budgetMs, deadline, now: started });
  let n = 0;
  for (const id of list) {
    if (n === 0 ? !budget.first : Date.now() - started >= budget.ms) break;
    n++;
    const r = await autoCostEnquiry(id, { force });
    if (r.skipped) out.skipped.push({ enquiry_no: r.enquiry_no ?? `#${id}`, why: r.why });
    else if (r.failed) out.failed.push({ enquiry_no: r.enquiry_no ?? `#${id}`, why: r.why });
    else if (r.complete) out.costed.push(r.enquiry_no);
    else out.held.push({ enquiry_no: r.enquiry_no, why: r.why });
  }
  out.left = ticked ? list.length - n : (await one(`SELECT count(*)::int AS n FROM enquiries e WHERE ${PENDING}`)).n;
  return out;
}

export async function autoCostPendingSoft(opts) {
  try {
    return await autoCostPending(opts);
  } catch (e) {
    console.error('[auto-cost] the run stopped:', e?.message || e);
    return empty();
  }
}
