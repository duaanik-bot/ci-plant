import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isRunCard, isSplitChild, splitGangReverseBlock, stageReverseMoves, reverseNeedsApprover } from './helpers.js';

// A split gang CHILD — one card per member line, made when the gang's parent
// finishes die cutting — carries its own order_line_id AND the run's
// gang_run_id. From the split on it is its own pile. The reverses used to widen
// any card with a gang_run_id to the whole run: a child's Send back was refused
// over a partner's state (or reversed a running partner too), its pull-back
// reopened the split parent, and reversing its line sent every member back to
// planned while one child card was deleted — the CI-JC-0317 orphan.
//
// The rule is lineIdsClosedBy's: only a RUN card (gang_run_id, no order line of
// its own — an unsplit gang parent or a combined run) speaks for the run.
// gang-child-send-back-pg.test.js proves it through the real routes
// (GANG_CHILD_PG=1); this file pins the pure rules and the source.

const parent = { id: 9, jc_number: 'CI-GANG-JC-0090', gang_run_id: 108, order_line_id: null, parent_job_card_id: null, status: 'in_progress' };
const child = { id: 396, jc_number: 'CI-JC-0317', gang_run_id: 108, order_line_id: 661, parent_job_card_id: 9, status: 'in_progress' };
const merge = { id: 50, jc_number: 'CI-JC-0200', gang_run_id: 70, order_line_id: null, parent_job_card_id: null, status: 'in_progress' };
const plain = { id: 7, jc_number: 'CI-JC-0007', gang_run_id: null, order_line_id: 12, parent_job_card_id: null, status: 'open' };

test('only a run card speaks for its run', () => {
  assert.deepEqual([parent, child, merge, plain].map(isRunCard), [true, false, true, false]);
  assert.deepEqual([parent, child, merge, plain].map(isSplitChild), [false, true, false, false]);
});

test('a child cannot be reversed off to Planning on its own — the reason names both cards and the way that works', () => {
  const msg = splitGangReverseBlock(child, 'CI-GANG-JC-0090');
  assert.match(msg, /CI-JC-0317/);
  assert.match(msg, /CI-GANG-JC-0090/);
  assert.match(msg, /Send back at Sort & Paste/);
  assert.doesNotMatch(msg, /on its own/, 'no whole-gang reverse exists after the split to contrast it with');
});

test('a FINISHED child is pointed at the reverse that exists for it, not at Send back', () => {
  const msg = splitGangReverseBlock({ ...child, status: 'closed' }, 'CI-GANG-JC-0090');
  assert.match(msg, /Reverse on its completed run at Sort & Paste/);
  assert.doesNotMatch(msg, /Send back/, 'a closed card cannot be sent back');
});

test('a split parent (a line whose child card is gone) is refused as split', () => {
  assert.match(splitGangReverseBlock({ ...parent, status: 'split' }), /split into one card per job/);
});

test('an unsplit gang, a combined run and a plain card reverse as before', () => {
  for (const jc of [parent, merge, plain]) assert.equal(splitGangReverseBlock(jc), null);
});

test("a child's first stage goes back into its own queue — no Print Planning, no pull-back, no plant-head flag", () => {
  const { moves, blockers } = stageReverseMoves({
    stage: 'sorting', status: 'in_progress', jcStatus: 'in_progress',
    prevStage: null, planningTarget: 'sorting', pullBack: false,
  });
  assert.deepEqual(blockers, []);
  assert.deepEqual(moves.map(m => m.hop), ['send_back']);
  assert.equal(moves[0].target, 'sorting');
  assert.match(moves[0].label, /Back to the sorting queue, uncounted/);
  assert.equal(reverseNeedsApprover({ target: moves[0].target, items: [] }), false);
});

// ── The source: every reverse picks its cards and lines by the one rule ──────
const helpers = readFileSync(new URL('./helpers.js', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('./routes/workflow.js', import.meta.url), 'utf8');
const fnBody = (src, head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} not found`);
  const next = src.slice(at + head.length).search(/\n(?:export )?(?:async )?function /);
  return src.slice(at, next < 0 ? undefined : at + head.length + next);
};

test('send back widens to the run only for a run card', () => {
  const plan = fnBody(helpers, 'export async function stageReversePlan(');
  assert.match(plan, /const memberStages = isRunCard\(st\)/);
  assert.match(plan, /WHERE jc\.gang_run_id=\$1 AND jc\.order_line_id IS NULL AND js\.stage=\$2/);
  assert.doesNotMatch(plan, /st\.gang_run_id\s*\?/, 'a card with a gang_run_id is not necessarily the run');
});

test('the reverse preview counts one job for a child and says why it is blocked', () => {
  const pre = fnBody(helpers, 'export async function reverseChainPreview(');
  assert.match(pre, /gang: isRunCard\(jc\)/);
  assert.match(pre, /const jobs = isRunCard\(jc\)/);
  assert.match(pre, /blocked: jc \? splitGangReverseBlock\(/);
});

test('workflow.js reverses never widen a card by gang_run_id alone', () => {
  const post = workflow.slice(workflow.indexOf("r.post('/workflow/order-lines/:id'"));
  assert.doesNotMatch(post, /jc\??\.gang_run_id\s*\?/, 'the lines come from lineIdsClosedBy, not a gang_run_id ternary');
  assert.equal((post.match(/await lineIdsClosedBy\(jc, qc\)/g) || []).length, 2,
    'reverse_to_planning and reverse_job_card each take the lines with the transaction client — the pool default hangs at max=1');
  assert.match(post, /DELETE FROM job_board_mix WHERE phase='issued' AND order_line_id = ANY\(\$1::int\[\]\)/);
});

test('every job-card reverse refuses a split child before it unwinds anything', () => {
  const post = workflow.slice(workflow.indexOf("r.post('/workflow/order-lines/:id'"));
  for (const action of ['reverse_to_planning', 'reverse_plan', 'reverse_job_card']) {
    const at = post.indexOf(`if (action === '${action}')`);
    assert.ok(at >= 0, action);
    const body = post.slice(at, post.indexOf('\n      if (action ===', at + 10));
    const lookup = body.indexOf('await cardFor()');
    const refuse = body.indexOf('refuseSplitGang(jc)');
    assert.ok(lookup >= 0 && refuse > lookup, `${action}: the card is looked up, then a split child refused`);
    const unwind = body.indexOf('clearFloor(');
    assert.ok(unwind > refuse, `${action}: before clearFloor unwinds a single stage`);
    if (action === 'reverse_plan')
      assert.ok(body.indexOf("code: 'LINE_ON_FLOOR'") > refuse, 'reverse_plan: before the floor question it cannot answer');
  }
  assert.match(workflow, /body: \{ code: 'SPLIT_GANG_CHILD', blockers: \[msg\] \}/, 'the code travels in err.body — app.js spreads only that');
});

test('rolling a split child back to the sales order is refused before anything is read or written', () => {
  const rb = fnBody(helpers, 'export async function rollbackLine(');
  const refuse = rb.indexOf('splitGangReverseBlock(card, card.parent_jc_number)');
  assert.ok(refuse > 0, 'rollbackLine asks splitGangReverseBlock');
  assert.ok(refuse < rb.indexOf("SELECT * FROM job_cards WHERE order_line_id=$1"), 'before the card it would delete is even read');
  assert.ok(refuse < rb.indexOf('await releaseFgReservation('), 'before the first write');
  assert.match(rb, /if \(!\(force && mode === 'delete'\)\) \{\s*const card = await cardForLine\(line, oc\);/);
});

test("a line's card is its OWN card first, the run card only after — never an unordered UNION", () => {
  const fn = fnBody(helpers, 'export async function cardForLine(');
  const own = fn.indexOf('WHERE jc.order_line_id=$1');
  const run = fn.indexOf('WHERE jc.gang_run_id=$1 AND jc.order_line_id IS NULL AND jc.parent_job_card_id IS NULL');
  assert.ok(own > 0 && run > own);
  assert.doesNotMatch(workflow, /UNION ALL/);
});
