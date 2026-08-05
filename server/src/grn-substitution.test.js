import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSubstitutable, packetsOf, eligibilityOf, planSubstitution } from './grn-substitution.js';

const FBB300 = { id: 10, code: '2336300FBB', name: 'FBB 300 GSM 23x36', category: 'board',
                 grade: 'FBB', gsm: 300, sheet_l: 23, sheet_w: 36, sheets_per_packet: 144, leftover: 0 };
const FBB290 = { ...FBB300, id: 11, code: '2336290FBB', name: 'FBB 290 GSM 23x36', gsm: 290 };

// ── isSubstitutable ─────────────────────────────────────────────────────────

test('a different GSM on the same grade and sheet is a substitution', () => {
  assert.equal(isSubstitutable(FBB300, FBB290).ok, true);
});

test('the same board is not a substitution', () => {
  const r = isSubstitutable(FBB300, FBB300);
  assert.equal(r.ok, false);
  assert.match(r.reason, /same board/i);
});

test('a different grade is refused, not warned about', () => {
  const saffire = { ...FBB290, id: 12, grade: 'Saffire' };
  const r = isSubstitutable(FBB300, saffire);
  assert.equal(r.ok, false);
  assert.match(r.reason, /grade/i);
});

test('a different sheet size is refused — it changes the whole cut plan', () => {
  const other = { ...FBB290, id: 13, sheet_l: 25, sheet_w: 36 };
  const r = isSubstitutable(FBB300, other);
  assert.equal(r.ok, false);
  assert.match(r.reason, /size/i);
});

test('same GSM at a different size is still refused — GSM is not the only axis', () => {
  const r = isSubstitutable(FBB300, { ...FBB300, id: 14, sheet_w: 38 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /size/i);
});

test('a leftover offcut is never a substitute', () => {
  const r = isSubstitutable(FBB300, { ...FBB290, leftover: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /leftover/i);
});

test('a non-board material is never a substitute', () => {
  const r = isSubstitutable(FBB300, { ...FBB290, category: 'ink' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /board/i);
});

// A board with no grade or no size cannot be PROVEN to be the same family, and
// an unprovable substitution is the one that silently re-boards a wrong job.
test('a board missing its grade or size is refused rather than assumed', () => {
  assert.equal(isSubstitutable(FBB300, { ...FBB290, grade: null }).ok, false);
  assert.equal(isSubstitutable({ ...FBB300, sheet_l: null }, FBB290).ok, false);
});

// ── packetsOf ───────────────────────────────────────────────────────────────

test('packets are a display unit derived from sheets', () => {
  assert.equal(packetsOf(FBB300, 14400), 100);
  assert.equal(packetsOf(FBB290, 15840), 110);
});

test('a board with no packet size reports no packet count rather than guessing', () => {
  assert.equal(packetsOf({ ...FBB300, sheets_per_packet: null }, 14400), null);
  assert.equal(packetsOf({ ...FBB300, sheets_per_packet: 0 }, 14400), null);
});

// ── eligibilityOf ───────────────────────────────────────────────────────────

test('a job whose board has already gone to the floor cannot be re-boarded', () => {
  const r = eligibilityOf({ id: 1, status: 'in_production', board_drawn: true });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /issued|floor/i);
});

test('a job carded but not yet issued board is still eligible', () => {
  assert.equal(eligibilityOf({ id: 1, status: 'in_production', board_drawn: false }).eligible, true);
  assert.equal(eligibilityOf({ id: 2, status: 'planned', board_drawn: false }).eligible, true);
  assert.equal(eligibilityOf({ id: 3, status: 'ready', board_drawn: false }).eligible, true);
});

test('a job past the board-demand statuses is not re-boardable', () => {
  const r = eligibilityOf({ id: 1, status: 'completed', board_drawn: false });
  assert.equal(r.eligible, false);
});

// ── planSubstitution ────────────────────────────────────────────────────────

const NIKOS = { id: 101, product_name: 'Nikos 5', customer_name: 'Nikos', status: 'planned',
                parent_sheets_required: 14400, board_drawn: false, bought: true, requisition_id: 55 };
const SWISS = { id: 102, product_name: 'Swiss C-12', customer_name: 'Swiss', status: 'planned',
                parent_sheets_required: 4000, board_drawn: false, bought: false, requisition_id: null };
const GARNIER = { id: 103, product_name: 'Garnier 40', customer_name: 'Garnier', status: 'in_production',
                  parent_sheets_required: 3000, board_drawn: true, bought: false, requisition_id: null };

const PO_LINE = { id: 900, qty: 14400, received_qty: 0 };

const base = (over = {}) => ({
  ordered: FBB300, received: FBB290, receivedSheets: 15840,
  poLine: PO_LINE, claims: [NIKOS, SWISS, GARNIER], picks: [NIKOS.id], ...over,
});

const kinds = effects => effects.map(e => e.kind);

test('the happy path receives the actual board and re-boards the job it was bought for', () => {
  const r = planSubstitution(base());
  assert.equal(r.ok, true);
  assert.deepEqual(r.blockers, []);
  assert.ok(kinds(r.effects).includes('receive'));
  const reboard = r.effects.find(e => e.kind === 'reboard');
  assert.equal(reboard.order_line_id, NIKOS.id);
  assert.equal(reboard.to, FBB290.id);
  assert.equal(reboard.from, FBB300.id);
  assert.ok(kinds(r.effects).includes('alloc_repoint'));
});

test('receiving more than ordered closes the PO line and never reports a negative balance', () => {
  const r = planSubstitution(base());
  assert.equal(r.balance.closes, true);
  assert.equal(r.balance.remaining, 0);
  assert.ok(kinds(r.effects).includes('po_close'));
});

// The honesty rule. An un-ticked job that this PO was buying for is now waiting
// on board that will never arrive, so its incoming allocation must go.
test('an un-ticked job on a closing PO line has its allocation RELEASED, not left standing', () => {
  const alsoBought = { ...SWISS, bought: true, requisition_id: 56 };
  const r = planSubstitution(base({ claims: [NIKOS, alsoBought, GARNIER], picks: [NIKOS.id] }));
  const rel = r.effects.find(e => e.kind === 'alloc_release');
  assert.ok(rel, 'expected the un-ticked bought job to be released');
  assert.equal(rel.order_line_id, alsoBought.id);
  assert.match(rel.text, /no longer|never|not coming/i);
});

test('a SHORT substituted receipt leaves the PO line open and the allocation standing', () => {
  const alsoBought = { ...SWISS, bought: true, requisition_id: 56 };
  const r = planSubstitution(base({
    receivedSheets: 5000, claims: [NIKOS, alsoBought, GARNIER], picks: [NIKOS.id],
  }));
  assert.equal(r.balance.closes, false);
  assert.equal(r.balance.remaining, 9400);
  assert.equal(kinds(r.effects).includes('alloc_release'), false);
  assert.ok(kinds(r.effects).includes('po_partial'));
});

test('a job whose board is already issued cannot be ticked', () => {
  const r = planSubstitution(base({ picks: [NIKOS.id, GARNIER.id] }));
  assert.equal(r.ok, false);
  assert.equal(r.effects.length, 0);
  assert.match(r.blockers.join(' '), /Garnier 40/);
});

test('a pick that is not on the list is refused rather than silently dropped', () => {
  const r = planSubstitution(base({ picks: [NIKOS.id, 999] }));
  assert.equal(r.ok, false);
  assert.match(r.blockers.join(' '), /no longer|not on/i);
});

test('a non-substitutable pair produces a blocker and no effects at all', () => {
  const r = planSubstitution(base({ received: { ...FBB290, grade: 'Saffire' } }));
  assert.equal(r.ok, false);
  assert.equal(r.effects.length, 0);
  assert.match(r.blockers.join(' '), /grade/i);
});

test('a non-positive received quantity is a blocker', () => {
  assert.equal(planSubstitution(base({ receivedSheets: 0 })).ok, false);
  assert.equal(planSubstitution(base({ receivedSheets: -5 })).ok, false);
});

// Substituting nothing onto any job is legitimate: the board arrived and goes to
// the shelf. It must still receive, and must still release the jobs it was bought
// for once the line closes.
test('receiving with no job ticked still books the stock and still tells the truth', () => {
  const r = planSubstitution(base({ picks: [] }));
  assert.equal(r.ok, true);
  assert.ok(kinds(r.effects).includes('receive'));
  assert.equal(kinds(r.effects).includes('reboard'), false);
  assert.ok(r.effects.some(e => e.kind === 'alloc_release' && e.order_line_id === NIKOS.id));
});

test('a partial prior receipt is counted before deciding whether the line closes', () => {
  const r = planSubstitution(base({
    receivedSheets: 4400, poLine: { id: 900, qty: 14400, received_qty: 10000 },
  }));
  assert.equal(r.balance.closes, true);
  assert.equal(r.balance.already, 10000);
});

test('effects are the same list the dialog renders — every one carries text', () => {
  const r = planSubstitution(base());
  assert.ok(r.effects.length > 0);
  for (const e of r.effects) assert.equal(typeof e.text, 'string', `${e.kind} has no text`);
});
