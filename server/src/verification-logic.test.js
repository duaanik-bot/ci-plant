import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CUTTING_LABEL, cuttingStatusOf,
  VERIFICATION_STATUSES, VERIFICATION_LABEL, COUNTED_STATUSES,
  verificationComputed, verificationStale, poolVerdict,
} from './verification-logic.js';

// ── cuttingStatusOf ─────────────────────────────────────────────────────────

test('cuttingStatusOf: no job card yet reads Not Sent to Cutting', () => {
  assert.equal(cuttingStatusOf({ has_card: false }), 'not_sent');
  assert.equal(cuttingStatusOf({}), 'not_sent');
});

test('cuttingStatusOf: a card without a planning date is Waiting', () => {
  assert.equal(cuttingStatusOf({ has_card: true, stage_status: 'pending' }), 'waiting');
});

test('cuttingStatusOf: a planning date turns Waiting into Planned', () => {
  assert.equal(cuttingStatusOf({ has_card: true, stage_status: 'pending', planned_date: '2026-08-08' }), 'planned');
});

test('cuttingStatusOf: any stage status off pending means Started — a held stage HAS started', () => {
  for (const s of ['in_progress', 'partially_completed', 'hold', 'completed']) {
    assert.equal(cuttingStatusOf({ has_card: true, stage_status: s, planned_date: '2026-08-08' }), 'started',
      `stage_status=${s} must read started even with a planning date`);
  }
});

test('cuttingStatusOf: a stamped started_at is Started even while the status still says pending', () => {
  assert.equal(cuttingStatusOf({ has_card: true, stage_status: 'pending', started_at: '2026-08-05T09:00:00Z' }), 'started');
});

test('cuttingStatusOf: a drawn board is Started no matter what the card says', () => {
  assert.equal(cuttingStatusOf({ board_drawn: true, has_card: false }), 'started');
});

test('cutting labels cover every status and use the floor words', () => {
  for (const s of ['not_sent', 'waiting', 'planned', 'started']) assert.ok(CUTTING_LABEL[s], s);
  assert.equal(CUTTING_LABEL.started, 'Cutting Started');
});

// ── verificationComputed ────────────────────────────────────────────────────

test('verificationComputed: a short count — the full-cover fixture, not a nil-only one', () => {
  // Jobs need 400, the ledger says 150, the rack really holds 150: the
  // verification is short 250 against the requirement while the BOOK is
  // exactly right — the two variances must not be conflated.
  const c = verificationComputed({ physical_qty: 150, required_qty: 400, available_qty: 150 });
  assert.equal(c.shortage_qty, 250);
  assert.equal(c.excess_qty, 0);
  assert.equal(c.variance_vs_book, 0);
});

test('verificationComputed: counting more than the jobs need is excess, and exposes a book error', () => {
  const c = verificationComputed({ physical_qty: 500, required_qty: 400, available_qty: 450 });
  assert.equal(c.shortage_qty, 0);
  assert.equal(c.excess_qty, 100);
  assert.equal(c.variance_vs_book, 50);
});

test('verificationComputed: no count means null variances, never fake zeros', () => {
  const c = verificationComputed({ physical_qty: null, required_qty: 400, available_qty: 150 });
  assert.equal(c.shortage_qty, null);
  assert.equal(c.excess_qty, null);
  assert.equal(c.variance_vs_book, null);
});

test('verificationComputed: material not found (counted zero) is short the whole requirement', () => {
  const c = verificationComputed({ physical_qty: 0, required_qty: 5250, available_qty: 4850 });
  assert.equal(c.shortage_qty, 5250);
  assert.equal(c.excess_qty, 0);
  assert.equal(c.variance_vs_book, -4850);
});

// ── verificationStale ───────────────────────────────────────────────────────

test('verificationStale: no event, a pending event, or no snapshot is never stale', () => {
  assert.equal(verificationStale(null, 5250), false);
  assert.equal(verificationStale({ status: 'pending', required_qty: 100 }, 5250), false);
  assert.equal(verificationStale({ status: 'verified', required_qty: null }, 5250), false);
});

test('verificationStale: flips only when the requirement has moved since the count', () => {
  assert.equal(verificationStale({ status: 'verified', required_qty: 5250 }, 5250), false);
  assert.equal(verificationStale({ status: 'verified', required_qty: 5250 }, 3750), true);
  assert.equal(verificationStale({ status: 'verified', required_qty: 5250.4 }, 5250), false, 'rounding noise is not staleness');
});

// ── poolVerdict ─────────────────────────────────────────────────────────────

test('poolVerdict: enough on the shelf is covered', () => {
  const v = poolVerdict({ available: 4850, required: 3650, incoming: 0 });
  assert.deepEqual(v, { shortage: 0, uncovered: 0, state: 'covered' });
});

test('poolVerdict: short with nothing on order is the hard red — nobody has acted', () => {
  const v = poolVerdict({ available: 4850, required: 5250, incoming: 0 });
  assert.deepEqual(v, { shortage: 400, uncovered: 400, state: 'short' });
});

test('poolVerdict: a partial PR is still on_order, and the uncovered tail stays visible', () => {
  const v = poolVerdict({ available: 4850, required: 5250, incoming: 150 });
  assert.equal(v.state, 'on_order');
  assert.equal(v.shortage, 400, 'incoming never hides the shortfall');
  assert.equal(v.uncovered, 250);
});

test('poolVerdict: incoming covering the whole gap leaves uncovered at zero, state on_order', () => {
  const v = poolVerdict({ available: 4850, required: 5250, incoming: 1600 });
  assert.deepEqual(v, { shortage: 400, uncovered: 0, state: 'on_order' });
});

test('poolVerdict: uncovered can never exceed shortage', () => {
  for (const incoming of [0, 1, 399, 400, 401, 10000]) {
    const v = poolVerdict({ available: 4850, required: 5250, incoming });
    assert.ok(v.uncovered <= v.shortage, `incoming=${incoming}`);
  }
});

// ── verification statuses ───────────────────────────────────────────────────

test('every verification status carries a written label — colour is never the only signal', () => {
  for (const s of VERIFICATION_STATUSES) assert.ok(VERIFICATION_LABEL[s], s);
  for (const s of COUNTED_STATUSES) assert.ok(VERIFICATION_STATUSES.includes(s), s);
});

// ── Source guards ───────────────────────────────────────────────────────────
// The route file must LOAD the shared demand engine, never re-spell it — the
// committed-demand rule has been hand-rolled and shipped wrong twice before.

const routeSrc = readFileSync(new URL('./routes/verification.js', import.meta.url), 'utf8');

test('verification route reuses the ONE demand engine', () => {
  assert.match(routeSrc, /import \{ claimsByBoard \} from '\.\.\/board-allocation\.js'/,
    'committed demand must come from claimsByBoard');
  assert.match(routeSrc, /boardClaimLines/, 'claims must be loaded via boardClaimLines');
  assert.match(routeSrc, /openPrLineIds/, 'per-job PR coverage must come from openPrLineIds');
});

test('verification route never spells the demand or drawn rules itself', () => {
  assert.doesNotMatch(routeSrc, /'planned'\s*,\s*'ready'/,
    'a local status list would be the seventh spelling of the committed-demand rule');
  assert.doesNotMatch(routeSrc, /in_production/,
    'the demand statuses belong to BOARD_DEMAND_SQL, not this file');
  assert.doesNotMatch(routeSrc, /type\s*=\s*'consumption'/,
    'the drawn test belongs to BOARD_DRAWN_EXISTS, not this file');
});

test('verification writes are role-gated and reads stay open', () => {
  assert.match(routeSrc, /const canVerify = requireRole\('planner', 'production'\)/);
  assert.match(routeSrc, /r\.post\('\/board-verification\/:materialId\/verify', canVerify/);
  assert.doesNotMatch(routeSrc, /r\.get\('\/board-verification\/report', requireRole/,
    'the report is a read — any signed-in user may look');
});

test('a verification event snapshots the requirement and the book', () => {
  assert.match(routeSrc, /INSERT INTO board_verifications/);
  assert.match(routeSrc, /required_qty, available_qty/,
    'without the snapshot a later reader cannot tell a stale count from a wrong one');
  assert.match(routeSrc, /audit\('materials', mid, 'board_verification'/,
    'every verification leaves an audit_log row');
});

test('started jobs leave the report — and the run-parent card is reachable from a member line', () => {
  assert.match(routeSrc, /cutting_status !== 'started'/);
  assert.match(routeSrc, /j\.order_line_id IS NULL AND j\.gang_run_id = ol\.gang_run_id/,
    'a gang member must find the RUN parent card (order_line_id is NULL there)');
});

test('the schema block exists in init() with the five statuses', () => {
  const dbSrc = readFileSync(new URL('./db.js', import.meta.url), 'utf8');
  assert.match(dbSrc, /CREATE TABLE IF NOT EXISTS board_verifications/);
  assert.match(dbSrc, /'pending','verified','mismatch','not_found','partial'/);
});

test('app.js mounts the verification router', () => {
  const appSrc = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(appSrc, /from '\.\/routes\/verification\.js'/);
  assert.match(appSrc, /app\.use\('\/api', verification\)/);
});
