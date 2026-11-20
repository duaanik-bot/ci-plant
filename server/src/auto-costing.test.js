import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoCostValue, autoCostRemarks, unpricedFinishes, costBudget, CALL_DEADLINE_MS } from './auto-costing.js';
import { parseSize, computeCosting } from './costing-engine.js';
import { readFileSync } from 'node:fs';
import { startsFresh, costingValueFromEnquiry } from '../../client/src/lib/enquiryUi.js';
import { recommend, markEdited } from '../../client/src/lib/costingUi.js';
import { chargeGrades } from '../../client/src/lib/costingRules.js';

// The enquiry desk's auto-costing, its pure part: the costing form's own fill on an enquiry, with what it is missing and
// a note for every value the rules, the layout picker or an assumption gave. Invented customer and rate (public repo).
const DEFAULTS = { wastage: 250, colours: 4, print_rate: 500, print_min: 1600, process: 2000, dp_rate: 0.3, emb_rate: 0, pf_pct: 5, misc_pct: 0, margin: 0.05 };
const BOARDS = [{ sheet_l: 23, sheet_w: 36 }];
const CHECK = (size = '120x40x90', o = {}) => ({
  size: parseSize(size), library: { exact: [], near: [] }, dies: { exact: [], reordered: [], near: [] },
  register: { exact: [], reordered: [], near: [] }, history: [], sheets: BOARDS, ...o,
});
const CTX = (o = {}) => ({
  product: null, check: CHECK(), typical: {}, defaults: DEFAULTS,
  boardGrades: [{ grade: 'CFBB', rate_per_kg: 95 }], customerRates: [{ word: 'bluefin', board_rate: 107 }], ...o,
});
const ENQ = (o = {}) => ({
  id: 7, enquiry_no: 'CI-ENQ-0007', customer_id: null, customer_name: 'Bluefin Labs', product_id: null, product_name: 'BL TEST TAB CARTON',
  size_text: '120x40x90', size_key: '120x40x90', style: 'LOCK', opening: null, board: 'FBB', gsm: 300, colours: 4, coating: 'UV',
  specs: null, notes: null, quantities: [10000, 25000], target_price: null, ...o,
});
const NOTED = new Set(['die', 'library', 'proposal', 'rule', 'assumed', 'history']);
// Each says what another line says: the coating button (its factor's line) and the run flag (the "planning:" wastage line).
const SAID_ELSEWHERE = new Set(['coat_choice', 'wastage_by_run']);
// A past costing of the size (invented figures).
const PAST = (id, style = 'LOCK') => {
  const inputs = { qty: 10000, sheet_l: 18, sheet_w: 23, ups: 4, gsm: 300, board_rate: 107, wastage: 200, colours: 4, print_rate: 500, print_min: 1600,
    coat_factor: 3, dp_rate: 0.4, process: 2000, pf_pct: 5, margin: 0.05 };
  return { id, costing_no: `CI-CST-09${id}`, product_name: `BL PAST ${id}`, style, gsm: 300, qty: 10000, costed_on: `2026-0${id}-01`, inputs, result: computeCosting(inputs) };
};

test('a complete enquiry gets a complete value with every assumption noted', () => {
  const a = autoCostValue(ENQ(), CTX());
  assert.equal(a.complete, true);
  assert.equal(a.result.ok, true);
  assert.equal(a.why, null);
  assert.equal(a.value.inputs.board_rate, 107, "Bluefin's own rate, above the ₹95 buying rate");
  assert.equal(a.value.inputs.dp_rate, 0.4);
  assert.equal(a.value.inputs.process, 3000, 'no product and no Die Master die: a new die');
  assert.equal(a.value.inputs.qty, 10000, 'the first quantity asked; the others are its breaks');
  assert.ok(a.notes.some(n => /bluefin/.test(n)), a.notes.join('\n'));
  assert.ok(a.notes.some(n => /planning:/.test(n)), a.notes.join('\n'));
  // a line for each value the rules, the picker or an assumption gave: "{label}: {value} — {note}", the layout "Layout: {note}"
  assert.ok(a.notes.includes('Die & pasting: 0.4 — lock bottom house rate'), a.notes.join('\n'));
  assert.ok(a.notes.includes(`Layout: ${a.value.sources.ups.note}`), a.notes.join('\n'));
  for (const [f, s] of Object.entries(a.value.sources)) {
    if (NOTED.has(s.kind) && !SAID_ELSEWHERE.has(f)) assert.ok(a.notes.some(n => n.endsWith(s.note)), `${f} (${s.kind}) is not noted`);
  }
  assert.ok(!a.notes.some(n => /^Quantity:/.test(n)), 'what the enquiry itself said is not an assumption');
});

test('no pasting holds the item', () => {
  const a = autoCostValue(ENQ({ style: null }), CTX());
  assert.equal(a.complete, false);
  assert.equal(a.why, 'needs pasting: side or lock?');
});

test('no size holds the item', () => {
  const a = autoCostValue(ENQ({ size_text: null, size_key: null }), CTX({ check: CHECK(null) }));
  assert.equal(a.complete, false);
  assert.equal(a.why, 'needs a size');
  assert.equal(autoCostValue(ENQ({ size_text: null, size_key: null, style: null }), CTX({ check: CHECK(null) })).why, 'needs a size',
    'the size is asked for before the pasting');
});

test('a window or lamination asked is flagged, not priced', () => {
  const plain = autoCostValue(ENQ(), CTX());
  const asked = autoCostValue(ENQ({ specs: 'with window, gloss lamination' }), CTX());
  assert.ok(asked.notes.includes('asked: window — not priced'), asked.notes.join('\n'));
  assert.ok(asked.notes.includes('asked: lamination — not priced'), asked.notes.join('\n'));
  assert.deepEqual(asked.value.inputs, plain.value.inputs);
  assert.deepEqual(unpricedFinishes({ coating: 'Soft touch', notes: 'velvet feel' }), ['asked: soft-touch — not priced']);
  assert.deepEqual(unpricedFinishes({ specs: 'no window, without lamination' }), [], 'a finish said not to be wanted is not asked');
});

test('the notes are one line per distinct note, warnings first, and the remarks are cut between two lines', () => {
  // Side-pasted with no opening, nothing said of GSM, colours or coating, and three finishes no rule prices.
  const rich = ENQ({ style: 'SIDE', board: 'Saffire', gsm: null, colours: null, coating: null, specs: 'window patch, 2 panel foil, soft touch lamination' });
  const a = autoCostValue(rich, CTX());
  assert.equal(a.notes.filter(n => /^Layout: /.test(n)).length, 1, a.notes.join('\n'));
  assert.ok(!a.notes.some(n => /^(Sheet length|Sheet width|Ups):/.test(n)), 'the sheet and ups share the picker\'s note: one line');
  assert.equal(new Set(a.notes).size, a.notes.length, 'no line twice');
  assert.equal(a.notes.filter(n => /coating not given/.test(n)).length, 1, 'the assumed coating is one line, not its factor and its button');
  assert.deepEqual(a.notes.slice(0, 4),
    ['asked: window — not priced', 'asked: lamination — not priced', 'asked: soft-touch — not priced', 'opening assumed: side-open']);
  const remarks = autoCostRemarks(rich.enquiry_no, a.notes);
  assert.ok(remarks.length <= 1000, String(remarks.length));
  assert.equal(remarks, `Auto-costed from CI-ENQ-0007 — ${a.notes.join(' · ')}`, 'it all fits: nothing cut');
  // Too long for the remarks: whole lines only, in order, then a mark that more is on the enquiry's history.
  const long = Array.from({ length: 40 }, (_, i) => `Note ${i}: ${'x'.repeat(40)}`);
  const cut = autoCostRemarks('CI-ENQ-0007', long);
  assert.ok(cut.length <= 1000, String(cut.length));
  const parts = cut.replace(/^Auto-costed from CI-ENQ-0007 — /, '').split(' · ');
  assert.equal(parts.at(-1), '…');
  assert.ok(parts.length > 10);
  assert.deepEqual(parts.slice(0, -1), long.slice(0, parts.length - 1));
});

test('each thing is said once: one coating line and one wastage line', () => {
  const a = autoCostValue(ENQ({ coating: 'UV' }), CTX());
  assert.deepEqual(a.notes.filter(n => /^Coating/.test(n)), ['Coating factor: 3 — UV → factor 3'], a.notes.join('\n'));
  assert.deepEqual(a.notes.filter(n => /^Wastage/.test(n)).length, 1, a.notes.join('\n'));
  assert.match(a.notes.find(n => /^Wastage/.test(n)), /^Wastage sheets: 200 — planning: 2,500 sheets → 200$/);
});

test('what the past costings of the size gave is noted; typical figures and defaults are not', () => {
  const a = autoCostValue(ENQ({ style: null }), CTX({ check: CHECK('120x40x90', { history: [PAST(1), PAST(2), PAST(3)] }) }));
  assert.equal(a.complete, true, 'the pasting from the past costings lets the picker draw it');
  assert.equal(a.value.sources.style.kind, 'history');
  assert.ok(a.notes.includes('Pasting: LOCK — 3 of 3 recent costings of this size'), a.notes.join('\n'));
  assert.equal(a.value.sources.print_rate.kind, 'default');
  assert.ok(!a.notes.some(n => /^Printing rate:|^P&F:|^Quote margin:/.test(n)), 'a Rates default is not an assumption to check');
});

// Final review M8: the picker's flags speak of the picker's layout. When the Product Master gave the sheet and ups, the
// picker's layout was not used and its flags would be about a layout the costing does not carry.
test("the picker's flags are noted only when the picker's layout is used", () => {
  // An invented Product Master entry with its own layout: 6 up on 18 × 24.
  const product = (o = {}) => ({ id: 41, name: 'BL TEST TAB CARTON', code: 'BL-T041', size: '120x40x90', gsm: 300, sheet_l: 18, sheet_w: 24, ups: 6,
    pasting_type: 'Lock Bottom', board_grade: 'CFBB', colours: 4, emboss: 0, customer_id: null, customer_name: 'Bluefin Labs', ...o });
  const layoutOf = a => [a.value.inputs.sheet_l, a.value.inputs.sheet_w, a.value.inputs.ups, a.value.sources.ups.kind];
  // Side-pasted, no opening said: the picker assumes side-open — for its own layout only.
  const opening = 'opening assumed: side-open';
  const sideOwn = autoCostValue(ENQ({ style: 'SIDE', product_id: 41 }), CTX({ product: product({ pasting_type: 'BSO' }) }));
  assert.deepEqual(layoutOf(sideOwn), [18, 24, 6, 'product']);
  assert.deepEqual(sideOwn.value.layout_pick.flags, [opening], 'the picker still ran');
  assert.ok(!sideOwn.notes.includes(opening), sideOwn.notes.join('\n'));
  assert.ok(autoCostValue(ENQ({ style: 'SIDE' }), CTX()).notes.includes(opening), 'no product: the picker\'s layout, and its flag');
  // A Die Master die with junk for its sheet (M3): said when the picker chose the layout by least board, not over the product's.
  const dies = { exact: [{ id: 3, code: 'D-T09', ups: 4, sheet_size: 'N/A', condition: 'Good' }], reordered: [], near: [] };
  const junk = "Die Master D-T09: sheet 'N/A' unreadable — layout chosen by least board";
  const lockOwn = autoCostValue(ENQ({ product_id: 41 }), CTX({ product: product(), check: CHECK('120x40x90', { dies }) }));
  assert.deepEqual(layoutOf(lockOwn), [18, 24, 6, 'product']);
  assert.deepEqual(lockOwn.value.layout_pick.flags, [junk]);
  assert.ok(!lockOwn.notes.includes(junk), lockOwn.notes.join('\n'));
  const lockPicked = autoCostValue(ENQ(), CTX({ check: CHECK('120x40x90', { dies }) }));
  assert.deepEqual(layoutOf(lockPicked).slice(2), [4, 'proposal'], 'the layout with the die\'s ups, by least board');
  assert.ok(lockPicked.notes.includes(junk), lockPicked.notes.join('\n'));
});

// Final review M4 (design §6.2): a die on the die list of exactly the size changes neither the layout nor the new die, but
// is said, so a person checks the rack. Named by its job number, else by the list's own die number. Invented numbers.
test('a die on the die list of exactly the size is noted: check the rack', () => {
  const register = (rows) => ({ exact: rows, reordered: [{ die_no: 'R-T002', job_no: '99002', l: 40, w: 120, h: 90 }], near: [] });
  const a = autoCostValue(ENQ(), CTX({ check: CHECK('120x40x90', { register: register([
    { die_no: 'R-T001', job_no: '99001', l: 120, w: 40, h: 90, ups: 4 }, { die_no: 'R-T003', job_no: null, l: 120, w: 40, h: 90 }]) }) }));
  assert.ok(a.notes.includes("Job 99001's die on the die list is this size — check the rack"), a.notes.join('\n'));
  assert.ok(a.notes.includes('Die R-T003 on the die list is this size — check the rack'), a.notes.join('\n'));
  assert.ok(!a.notes.some(n => /R-T002|99002/.test(n)), 'only a die of exactly the size — not one in another order');
  assert.equal(a.value.inputs.process, 3000, 'a die-list die does not take the new die off');
  assert.notEqual(a.value.sources.ups.kind, 'die');
  assert.ok(!autoCostValue(ENQ(), CTX()).notes.some(n => /die list/.test(n)), 'no die-list die: nothing said');
});

test("the picker's flags are noted, and what is still missing is the why", () => {
  const side = autoCostValue(ENQ({ style: 'SIDE' }), CTX());
  assert.equal(side.complete, true);
  assert.ok(side.notes.includes('opening assumed: side-open'), side.notes.join('\n'));
  // A duplex board takes no house rate and has no grade here: the rate is missing.
  const duplex = autoCostValue(ENQ({ board: 'Duplex' }), CTX());
  assert.equal(duplex.complete, false);
  assert.equal(duplex.why, 'needs board rate');
});

// Final review M2: a call has 30 s, and the filing before the costing takes part of it. The costing's budget counts from
// the request's start: its own budget, never past the deadline the route passes (the start + CALL_DEADLINE_MS); the first
// row is costed even on a spent budget (R7), unless the deadline itself has passed.
test("the costing budget counts from the request's start", () => {
  const now = 1_000_000;
  assert.equal(CALL_DEADLINE_MS, 25_000);
  assert.deepEqual(costBudget({ budgetMs: 15000, now }), { ms: 15000, first: true }, 'no deadline: its own budget');
  assert.deepEqual(costBudget({ budgetMs: 15000, deadline: now + 25000, now }), { ms: 15000, first: true });
  assert.deepEqual(costBudget({ budgetMs: 15000, deadline: now + 4000, now }), { ms: 4000, first: true }, 'the filing took 21 s: 4 s are left');
  assert.deepEqual(costBudget({ budgetMs: 15000, deadline: now, now }), { ms: 0, first: false }, 'at the deadline nothing runs');
  assert.deepEqual(costBudget({ budgetMs: 15000, deadline: now - 1, now }), { ms: 0, first: false });
  assert.deepEqual(costBudget({ budgetMs: 1, now }), { ms: 1, first: true }, 'a spent budget still costs one row');
  assert.deepEqual(costBudget({ budgetMs: 0, deadline: now + 5000, now }), { ms: 0, first: true });
});

test('the mails and notify routes pass their request start down as the deadline', () => {
  const src = readFileSync(new URL('./routes/enquiry-robot.js', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/autoCostPendingSoft\(([^)]*)\)/g)].map(m => m[1]);
  assert.equal(calls.length, 2, 'the mails route and the notify route');
  for (const args of calls) assert.match(args, /deadline: started \+ CALL_DEADLINE_MS/, args);
});

// Final review C1 (the reviewer's simulation): an item held for "needs pasting" is saved with the Rates defaults (die &
// pasting 0.3, the flat wastage 250) — no rule could apply without the pasting. Opened as the saved draft, setting LOCK keeps
// them (a saved value with no source is kept). So the desk opens CI Plant's incomplete draft as a fresh fill from its
// enquiry: setting the pasting there gives what Cost it for me gives.
test("CI Plant's incomplete draft opens as a fresh fill: setting the pasting gives the rules' figures", () => {
  const enq = ENQ({ style: null, quantities: [20000] });
  const ctx = CTX({ customerRates: [] });
  const held = autoCostValue(enq, ctx);
  assert.equal(held.why, 'needs pasting: side or lock?');
  assert.deepEqual([held.value.inputs.dp_rate, held.value.inputs.wastage], [0.3, 250], 'saved with the Rates defaults');
  // The desk row of that draft opens fresh; any other costing opens as it was saved.
  const row = { costing_live: true, costing_id: 5, costing_auto: true, costing_complete: false };
  assert.equal(startsFresh(row), true);
  for (const o of [{ costing_complete: true }, { costing_auto: false }, { costing_live: false }, { costing_id: null }]) {
    assert.equal(startsFresh({ ...row, ...o }), false, JSON.stringify(o));
  }
  assert.equal(startsFresh(null), false);
  // The form: what the customer asked, the module's own fill, then the person sets LOCK.
  const form = { check: CHECK('120x40x90'), typical: {}, defaults: DEFAULTS, grades: chargeGrades([{ grade: 'CFBB', rate_per_kg: 95 }]), boards: BOARDS };
  let v = recommend(costingValueFromEnquiry(enq, DEFAULTS), form);
  v = recommend(markEdited({ ...v, style: 'LOCK', autofill: true }, ['style']), form);
  assert.deepEqual([v.inputs.dp_rate, v.inputs.wastage, v.inputs.wastage_by_run, v.inputs.ups], [0.4, 300, 1, 4]);
  const auto = autoCostValue({ ...enq, style: 'LOCK' }, ctx).value.inputs;
  assert.deepEqual([v.inputs.dp_rate, v.inputs.wastage, v.inputs.wastage_by_run], [auto.dp_rate, auto.wastage, auto.wastage_by_run], 'as Cost it for me');
});
