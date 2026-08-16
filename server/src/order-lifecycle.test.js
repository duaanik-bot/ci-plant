import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderTransitionError, rollbackBlockers, forceDeleteBlockers, removedLineDetail } from './helpers.js';
import { incompleteOrderLine, payloadLines } from '../../client/src/lib/orderLines.js';

// ── orderTransitionError ──────────────────────────────────────────────
test('order: pending → hold is allowed', () => {
  assert.equal(orderTransitionError('pending', 'hold', false), null);
});
test('order: pending → completed/closed/cancelled allowed', () => {
  for (const to of ['completed', 'closed', 'cancelled'])
    assert.equal(orderTransitionError('pending', to, false), null);
});
test('order: hold → pending allowed (resume)', () => {
  assert.equal(orderTransitionError('hold', 'pending', false), null);
});
test('order: closed → pending blocked for non-admin', () => {
  assert.match(orderTransitionError('closed', 'pending', false), /admin/i);
});
test('order: closed → pending allowed for admin (reopen)', () => {
  assert.equal(orderTransitionError('closed', 'pending', true), null);
});
test('order: cancelled → completed is never allowed', () => {
  assert.match(orderTransitionError('cancelled', 'completed', true), /cannot/i);
});
test('order: same-status is a no-op error', () => {
  assert.match(orderTransitionError('pending', 'pending', false), /already/i);
});

// ── rollbackBlockers ──────────────────────────────────────────────────
test('rollback: clean line has no blockers', () => {
  assert.deepEqual(rollbackBlockers({}), []);
});
test('rollback: a started stage blocks', () => {
  const out = rollbackBlockers({ stages: [{ stage: 'printing', status: 'in_progress' }] });
  assert.equal(out.length, 1);
  assert.match(out[0], /Printing is in progress/);
});
// The whole point of the send-back feature was that "reverse it first" with no
// hint of WHERE is a dead end — the operator reads it, cannot act on it, and
// the job stays stuck. This path kept the old wording after workflow.js was
// fixed, so a roll back to sales order still dead-ended.
test('rollback: a blocked stage says where to go, not just that it is blocked', () => {
  const out = rollbackBlockers({ stages: [{ stage: 'cutting', status: 'in_progress' }] });
  assert.match(out[0], /cutting/i);
  assert.match(out[0], /send it back/i);
  assert.match(out[0], /station/i);
});
test('rollback: a die-cutting stage names its station readably, not with an underscore', () => {
  const out = rollbackBlockers({ stages: [{ stage: 'die_cutting', status: 'hold' }] });
  assert.match(out[0], /die cutting/i);
  assert.doesNotMatch(out[0], /die_cutting/);
});
test('rollback: pending stages do NOT block', () => {
  assert.deepEqual(rollbackBlockers({ stages: [{ stage: 'cutting', status: 'pending' }] }), []);
});
test('rollback: a converted PR blocks', () => {
  assert.match(rollbackBlockers({ prLinkedToPo: true })[0], /requisition/i);
});
test('rollback: produced FG blocks', () => {
  assert.match(rollbackBlockers({ fgProduced: true })[0], /Finished goods/i);
});
test('rollback: dispatched qty blocks with the number', () => {
  assert.match(rollbackBlockers({ dispatchedQty: 12000 })[0], /12000 pcs already dispatched/);
});
test('rollback: multiple blockers are all reported', () => {
  const out = rollbackBlockers({
    stages: [{ stage: 'foiling', status: 'hold' }], fgProduced: true, dispatchedQty: 5,
  });
  assert.equal(out.length, 3);
});

// ── forceDeleteBlockers ───────────────────────────────────────────────
test('force delete: started stages / produced FG / ordered PRs do NOT block', () => {
  assert.deepEqual(forceDeleteBlockers({}), []);
});
test('force delete: dispatched qty still blocks', () => {
  assert.match(forceDeleteBlockers({ dispatchedQty: 300 })[0], /300 pcs already dispatched/);
});
test('force delete: FG reserved by another order blocks', () => {
  assert.match(forceDeleteBlockers({ fgReservedElsewhere: true })[0], /another order/i);
});
test('force delete: gang shared outside the delete scope blocks', () => {
  assert.match(forceDeleteBlockers({ gangOutsideScope: true })[0], /ganged/i);
});

// ── seed / constraint parity ──────────────────────────────────────────
// db.js creates `orders` with the LEGACY check (…'open'…) and then immediately
// ALTERs it to the real lifecycle set. A seeder writing 'open' therefore passes
// the CREATE TABLE definition and fails the live constraint — which aborted
// seedIfEmpty() on every FRESH database while leaving existing plants working,
// so nothing caught it. Read both files and assert they still agree.
test('seed: every order status it writes is allowed by the live constraint', async () => {
  const { readFile } = await import('node:fs/promises');
  const dir = new URL('.', import.meta.url);
  const db = await readFile(new URL('db.js', dir), 'utf8');
  const seed = await readFile(new URL('seed.js', dir), 'utf8');

  const allowed = db.match(/ADD CONSTRAINT orders_status_check\s*\n?\s*CHECK \(status IN \(([^)]*)\)\)/);
  assert.ok(allowed, 'orders_status_check must still be defined in db.js');
  const valid = new Set([...allowed[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
  assert.ok(valid.has('pending'), 'lifecycle set must contain pending');

  // The seeder's order rows: ord(po, customer, po_date, delivery_date, STATUS, off).
  // Anchored on the call's TAIL — the earlier arguments carry their own
  // parentheses (d(-2), d(12)), so a [^)] scan stops at the first one.
  const written = [...seed.matchAll(/await ord\(.*?,\s*'([a-z_]+)',\s*\d+\);/g)].map(m => m[1]);
  assert.ok(written.length >= 5, `expected several seeded orders, found ${written.length}`);
  for (const s of written)
    assert.ok(valid.has(s), `seed.js writes orders.status='${s}', not in ${[...valid].join('/')}`);
});

// The same drift bit shade_cards on 2026-07-30: db.js swaps
// shade_cards_status_check from the twelve-value legacy set to the four-value
// draft/sent/approved/rejected set, and seed.js's shadeCard('SHD-0001', ...)
// still wrote status: 'customer_approved' — passing the CREATE TABLE
// definition but failing the live constraint, aborting seedIfEmpty() on every
// FRESH database. Same read-both-files check, adapted for shadeCard()'s
// options-object call shape rather than ord()'s positional one.
test('seed: every shade card status it writes is allowed by the live constraint', async () => {
  const { readFile } = await import('node:fs/promises');
  const dir = new URL('.', import.meta.url);
  const db = await readFile(new URL('db.js', dir), 'utf8');
  const seed = await readFile(new URL('seed.js', dir), 'utf8');

  const allowed = db.match(/ADD CONSTRAINT shade_cards_status_check\s*\n?\s*CHECK \(status IN \(([^)]*)\)\)/);
  assert.ok(allowed, 'shade_cards_status_check must still be defined in db.js');
  const valid = new Set([...allowed[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
  assert.ok(valid.has('draft') && valid.has('approved'), 'lifecycle set must contain draft and approved');

  // Each shadeCard(...) call: an explicit status: 'x' overrides the helper's
  // own fallback of 'draft' (shadeCard's `x.status ?? 'draft'`), so a call
  // with no status: at all is implicitly writing 'draft' — always valid.
  const calls = [...seed.matchAll(/await shadeCard\([^;]*?\);/gs)].map(m => m[0]);
  assert.ok(calls.length >= 1, `expected at least one seeded shade card, found ${calls.length}`);
  for (const call of calls) {
    const hasStatusKey = /\bstatus\s*:/.test(call);
    const explicit = call.match(/status:\s*'([a-z_]+)'/);
    // A call with no status: key at all legitimately relies on shadeCard's own
    // `x.status ?? 'draft'` default — that IS 'draft', nothing further to check.
    // But a status: key present whose value isn't a plain quoted literal (a
    // variable, a ternary, a template string…) is unreadable to this static
    // check, and silently assuming 'draft' for it would let an invalid runtime
    // value pass vacuously — so THAT case must fail loudly instead.
    if (hasStatusKey)
      assert.ok(explicit, 'seed.js must write shade_cards.status as a readable literal — this guard cannot check a variable');
    const status = explicit ? explicit[1] : 'draft';
    assert.ok(valid.has(status), `seed.js writes shade_cards.status='${status}', not in ${[...valid].join('/')}`);
  }
});

// ── removedLineDetail ─────────────────────────────────────────────────
// PUT /orders/:id treats the submitted lines array as the complete set and
// hard-deletes every existing line whose id is absent. On 2026-08-13 that
// silently dropped 16 lines (9,500 nos) from order 153 and 4 (4,000) from 154,
// and the only trace was a single order/update row — the removed lines left no
// record of what they were, so the loss had to be reconstructed from gaps in
// the id sequence. The detail below is what makes that path readable: the row
// is gone after the DELETE, so entity_id points at nothing and the detail must
// carry the identity and quantity itself.
test('removedLineDetail: names the product, the quantity and the status it was in', () => {
  const s = removedLineDetail({ product_id: 7, qty: 500, status: 'pending' }, { code: 'FP-016', name: 'F3D3' });
  assert.match(s, /FP-016/);
  assert.match(s, /F3D3/);
  assert.match(s, /\b500\b/);
  assert.match(s, /pending/);
});

test('removedLineDetail: says it was an order edit, so the cause is not guesswork', () => {
  const s = removedLineDetail({ product_id: 7, qty: 1, status: 'pending' }, { code: 'FP-001', name: 'X' });
  assert.match(s, /order edit/i);
});

test('removedLineDetail: survives a product row the lookup could not resolve', () => {
  // Never throw while auditing a delete — losing the audit row would restore
  // exactly the blindness this exists to remove.
  for (const prod of [null, undefined, {}]) {
    const s = removedLineDetail({ product_id: 42, qty: 250, status: 'pending' }, prod);
    assert.match(s, /42/, 'must still identify the product by id');
    assert.match(s, /\b250\b/);
  }
});

test('removedLineDetail: a missing status still produces a usable line', () => {
  const s = removedLineDetail({ product_id: 1, qty: 10 }, { code: 'FP-001', name: 'X' });
  assert.match(s, /FP-001/);
  assert.match(s, /\b10\b/);
});

test('orders.js audits a removed line BEFORE it deletes the row', async () => {
  // A DELETE that runs before the audit would leave the same blind spot: the
  // ordering is the guarantee, not merely the presence of an audit() call.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('routes/orders.js', new URL('.', import.meta.url)), 'utf8');

  const loop = src.match(/for \(const line of existing\) \{[\s\S]*?\n {6}\}/);
  assert.ok(loop, 'the line-removal loop must still exist in PUT /orders/:id');
  const body = loop[0];

  const auditAt = body.indexOf("audit('order_line'");
  const deleteAt = body.indexOf('DELETE FROM order_lines');
  assert.ok(auditAt !== -1, 'a removed line must be audited as order_line');
  assert.ok(deleteAt !== -1, 'the loop must still delete the row');
  assert.ok(auditAt < deleteAt, 'the audit must be written BEFORE the DELETE');
  assert.match(body, /removedLineDetail\(/, 'the audit detail must come from the shared builder');
});

// ── order edit payload (client/src/lib/orderLines.js) ─────────────────
// The client half of the same hazard: omitting a line from the PUT payload
// deletes it, so the edit form must refuse an incomplete row rather than
// filter it out. Tested here because a .jsx page cannot be imported by
// node --test — the rule lives in client/src/lib/ for exactly that reason.
test('edit payload: a persisted line with the qty cleared blocks the save', () => {
  for (const qty of ['', null, undefined, 0, '0'])
    assert.equal(incompleteOrderLine({ id: 9, product_id: '3', qty }), true, `qty ${JSON.stringify(qty)} must block`);
});

test('edit payload: a persisted line that is complete does not block', () => {
  assert.equal(incompleteOrderLine({ id: 9, product_id: '3', qty: 500 }), false);
  assert.equal(incompleteOrderLine({ id: 9, product_id: '3', qty: '500' }), false);
});

test('edit payload: a blank row the user just added is skipped, not an error', () => {
  assert.equal(incompleteOrderLine({ product_id: '', qty: '' }), false);
  assert.equal(incompleteOrderLine({}), false);
});

test('edit payload: a new row naming a product but no qty is lost input, so it blocks', () => {
  assert.equal(incompleteOrderLine({ product_id: '3', qty: '' }), true);
});

test('edit payload: garbage qty blocks rather than posting NaN', () => {
  assert.equal(incompleteOrderLine({ id: 9, product_id: '3', qty: 'abc' }), true);
});

test('edit payload: payloadLines keeps every real line and drops only blank rows', () => {
  const rows = [
    { id: 1, product_id: '3', qty: 500 },
    { product_id: '', qty: '' },
    { id: 2, product_id: '4', qty: '250' },
  ];
  assert.deepEqual(payloadLines(rows).map(l => l.product_id), ['3', '4']);
  assert.deepEqual(payloadLines([]), []);
  assert.deepEqual(payloadLines(), []);
});

test('edit payload: the two halves agree — nothing incompleteOrderLine clears is then dropped', () => {
  // The invariant that makes the guard sufficient: once every row passes
  // incompleteOrderLine, payloadLines may only remove rows that carry no id.
  const rows = [
    { id: 1, product_id: '3', qty: 500 },
    { product_id: '', qty: '' },
    { id: 2, product_id: '4', qty: '250' },
    { product_id: '', qty: '' },
  ];
  assert.ok(!rows.some(incompleteOrderLine));
  const kept = new Set(payloadLines(rows));
  for (const r of rows)
    if (r.id) assert.ok(kept.has(r), `persisted line ${r.id} must survive the filter`);
});
