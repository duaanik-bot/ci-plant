import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockLineGangFirst, PUSH_LOCKS } from './helpers.js';
import { LOCKS_BY_ACTION, REVERSE_LOCKS } from './routes/workflow.js';

// Push to Job Card used to lock the clicked line, then every member of its gang
// in id order, then the gang row last (through the job card's foreign key) —
// the reverse of every gangs.js route, so two pushes on one gang, a push and a
// gang edit, or a push and a PR on a member could deadlock (40P01, one save
// fails). helpers.js lockLineGangFirst puts the gang first for every caller;
// gang-lock-order-pg.test.js proves it against a real Postgres. These pin the
// order and the wiring in the ordinary suite.

const SRC = path.dirname(fileURLToPath(import.meta.url));
const read = rel => fs.readFileSync(path.join(SRC, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))
  .replace(/^[ \t]*\/\/.*$/gm, '');
const fnBody = (src, head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `cannot find ${head}`);
  const next = src.slice(at + head.length).search(/\n(?:export )?(?:async )?function |\nr\.(?:get|post|put|patch|delete)\(/);
  return src.slice(at, next < 0 ? undefined : at + head.length + next);
};

// A stub transaction that answers like the tables would and records each lock.
function stubTx({ gangId = 7, cardIds = [], lineAfter } = {}) {
  const seen = [];
  const answer = sql => {
    if (/^SELECT gang_run_id FROM order_lines/.test(sql)) return { gang_run_id: gangId };
    if (/FROM gang_runs/.test(sql)) return { id: gangId };
    if (/FROM job_cards/.test(sql)) return cardIds.map(id => ({ id }));
    if (/FROM order_lines WHERE gang_run_id/.test(sql)) return [{ id: 1 }, { id: 5 }];
    if (/^SELECT \* FROM order_lines/.test(sql)) return lineAfter ?? { id: 5, gang_run_id: gangId };
    return null;
  };
  const oc = async (sql, params) => { seen.push(sql.replace(/\s+/g, ' ').trim()); const r = answer(sql); return Array.isArray(r) ? r[0] ?? null : r; };
  const qc = async (sql, params) => { seen.push(sql.replace(/\s+/g, ' ').trim()); const r = answer(sql); return Array.isArray(r) ? r : (r ? [r] : []); };
  return { seen, oc, qc };
}

test('push locks the gang, then its members ascending, then the clicked line', async () => {
  const t = stubTx();
  const line = await lockLineGangFirst(5, t.qc, t.oc, PUSH_LOCKS);
  assert.equal(line.id, 5);
  assert.deepEqual(t.seen, [
    'SELECT gang_run_id FROM order_lines WHERE id=$1',
    'SELECT id FROM gang_runs WHERE id=$1 FOR NO KEY UPDATE',
    'SELECT id FROM job_cards WHERE gang_run_id=$1 AND parent_job_card_id IS NULL ORDER BY id FOR NO KEY UPDATE',
    'SELECT id FROM order_lines WHERE gang_run_id=$1 ORDER BY id FOR NO KEY UPDATE',
    'SELECT * FROM order_lines WHERE id=$1 FOR NO KEY UPDATE',
  ]);
});

test('once the run has its card, push locks the card and leaves the members alone', async () => {
  const t = stubTx({ cardIds: [42] });
  await lockLineGangFirst(5, t.qc, t.oc, PUSH_LOCKS);
  assert.ok(!t.seen.some(s => /FROM order_lines WHERE gang_run_id/.test(s)), 'the early return never touches the members');
  assert.match(t.seen[2], /FROM job_cards .* FOR NO KEY UPDATE/);
});

test('a plain line is just its own lock, as before', async () => {
  const t = stubTx({ gangId: null, lineAfter: { id: 3, gang_run_id: null } });
  await lockLineGangFirst(3, t.qc, t.oc, { gang: 'UPDATE', line: 'UPDATE' });
  assert.deepEqual(t.seen, ['SELECT gang_run_id FROM order_lines WHERE id=$1', 'SELECT * FROM order_lines WHERE id=$1 FOR UPDATE']);
});

test('a line that joined or moved gang after the peek is refused; one that left carries on', async () => {
  for (const [peekGang, nowGang] of [[7, 8], [null, 8]]) {
    const t = stubTx({ gangId: peekGang, lineAfter: { id: 5, gang_run_id: nowGang } });
    await assert.rejects(lockLineGangFirst(5, t.qc, t.oc, PUSH_LOCKS), e => e.status === 409, `${peekGang} → ${nowGang}`);
  }
  const left = stubTx({ gangId: 7, lineAfter: { id: 5, gang_run_id: null } });
  assert.equal((await lockLineGangFirst(5, left.qc, left.oc, PUSH_LOCKS)).id, 5);
});

test('no line → null for the caller\'s own 404; a mode outside the list is refused', async () => {
  const t = stubTx();
  const none = { ...t, oc: async () => null };
  assert.equal(await lockLineGangFirst(1, none.qc, none.oc, PUSH_LOCKS), null);
  await assert.rejects(lockLineGangFirst(1, t.qc, t.oc, { gang: 'UPDATE; DROP TABLE x' }), /not a lock mode/);
});

// ── wiring ──────────────────────────────────────────────────────────────────
test('both Push to Job Card doors take the gang first', () => {
  const ANY_LOCK = /\bFOR (?:NO KEY )?UPDATE|\bFOR (?:KEY )?SHARE|lockLineGangFirst\(|\bawait oc\(|\bawait qc\(/;
  const create = fnBody(read('helpers.js'), 'export async function createJobCardForLine(');
  const firstC = create.slice(create.search(ANY_LOCK));
  assert.ok(firstC.startsWith('lockLineGangFirst(lineId, qc, oc, PUSH_LOCKS)'),
    'createJobCardForLine (POST /order-lines/:id/job-card) must reach lockLineGangFirst before any other statement');
  assert.doesNotMatch(create, /FROM order_lines WHERE id=\$1 FOR UPDATE/, 'no stronger re-lock of the line afterwards');

  const wf = read('routes/workflow.js');
  assert.match(wf, /\['push_to_job_card', PUSH_LOCKS\]/);
  // The reverses reach the run's card after its stages (stage start / complete
  // lock stage then card), so they never pre-lock it.
  assert.match(wf, /const REVERSE_LOCKS = Object\.freeze\(\{ gang: 'NO KEY UPDATE', line: 'UPDATE' \}\);/);
  for (const a of ['reverse_to_planning', 'reverse_job_card', 'reverse_plan'])
    assert.match(wf, new RegExp(`\\['${a}', REVERSE_LOCKS\\]`), a);
  // The live map, not its text: push takes PUSH_LOCKS, the reverses the plain
  // gang-then-line set, and nothing else is looked up there.
  assert.deepEqual([...LOCKS_BY_ACTION.keys()].sort(), ['push_to_job_card', 'reverse_job_card', 'reverse_plan', 'reverse_to_planning']);
  assert.equal(LOCKS_BY_ACTION.get('push_to_job_card'), PUSH_LOCKS);
  for (const a of ['reverse_to_planning', 'reverse_job_card', 'reverse_plan']) assert.equal(LOCKS_BY_ACTION.get(a), REVERSE_LOCKS, a);
  assert.deepEqual({ ...REVERSE_LOCKS }, { gang: 'NO KEY UPDATE', line: 'UPDATE' });
  const route = fnBody(wf, "r.post('/workflow/order-lines/:id'");
  assert.match(route, /const locks = LOCKS_BY_ACTION\.get\(action\);/, 'the lock set comes from the request\'s own action');
  const firstLock = route.search(ANY_LOCK);
  assert.ok(firstLock > 0 && route.slice(firstLock).startsWith('lockLineGangFirst('),
    'the workflow transaction must reach lockLineGangFirst before any plain line lock');
});

test('the member sweeps are NO KEY UPDATE, and split takes the gang before them', () => {
  const src = read('helpers.js');
  for (const head of ['export async function createJobCardForGang(', 'export async function createJobCardForMergeRun(', 'export async function splitGangParentJob(']) {
    const body = fnBody(src, head);
    assert.match(body, /ORDER BY ol\.id\s+FOR NO KEY UPDATE OF ol/, `${head} member sweep`);
    assert.doesNotMatch(body, /FOR UPDATE OF ol/, `${head} still takes FOR UPDATE on members`);
  }
  const split = fnBody(src, 'export async function splitGangParentJob(');
  const gangAt = split.indexOf("SELECT id FROM gang_runs WHERE id=$1 FOR KEY SHARE");
  assert.ok(gangAt > 0 && gangAt < split.indexOf('FOR NO KEY UPDATE OF ol'), 'split share-locks the gang before its members');
});

// NO KEY UPDATE on the run, never FOR UPDATE up front: a save that updates a
// ganged line twice share-locks the run through the foreign key, and FOR UPDATE
// would deadlock it (gang-lock-order-pg.test.js runs that race).
test('a line leaving (and maybe dissolving) its gang takes the gang first, NO KEY UPDATE', () => {
  const rollback = fnBody(read('helpers.js'), 'export async function rollbackLine(');
  assert.match(rollback, /lockLineGangFirst\(lineId, qc, oc, \{ gang: 'NO KEY UPDATE', line: 'UPDATE' \}\)/);
  const plan = fnBody(read('routes/orders.js'), "r.post('/order-lines/:id/plan'");
  const gangAt = plan.indexOf("SELECT id FROM gang_runs WHERE id=$1 FOR NO KEY UPDATE");
  const firstWrite = plan.search(/UPDATE order_lines/);
  assert.ok(gangAt > 0 && gangAt < firstWrite, 'plan-save locks a ganged line\'s run before it writes a line');
  assert.match(plan, /line = await oc\('SELECT \* FROM order_lines WHERE id=\$1', \[req\.params\.id\]\);\s*if \(!line\)[^\n]*\n\s*if \(line\.gang_run_id && line\.gang_run_id !== gangId\)/,
    'plan-save re-reads the line under the gang lock and refuses a line that moved');
  assert.doesNotMatch(read('helpers.js') + read('routes/workflow.js') + read('routes/orders.js'),
    /gang: 'UPDATE'/, 'no caller takes the run FOR UPDATE up front');
});

test('deleting an order locks all its gangs, before the order row and any line', () => {
  const del = read('routes/orders.js');
  const tx = del.slice(del.indexOf("const before = await qc('SELECT DISTINCT gang_run_id FROM order_lines WHERE order_id=$1"));
  assert.match(tx, /SELECT id, gang_run_id FROM order_lines WHERE order_id=\$1 ORDER BY id FOR UPDATE/, 'the lines are locked as they are checked');
  const lockAt = tx.indexOf('await lockGangsFirst(before.map(r => r.gang_run_id), qc);');
  const orderAt = tx.indexOf("SELECT * FROM orders WHERE id=$1 FOR UPDATE");
  assert.ok(lockAt >= 0 && orderAt > lockAt, 'the gangs before the order row');
  assert.ok(orderAt < tx.indexOf('await rollbackLine('), 'and the order row before any line');
  assert.match(tx, /if \(lines\.some\(l => l\.gang_run_id && !locked\.has\(l\.gang_run_id\)\)\)/, 'a line that joined a gang meanwhile is refused');
  assert.match(read('helpers.js'), /SELECT id FROM gang_runs WHERE id = ANY\(\$1::int\[\]\) ORDER BY id FOR NO KEY UPDATE/);
});

test('pull-back writes every card (in id order) before any line', () => {
  const pull = fnBody(read('helpers.js'), 'export async function pullBackToJobCard(');
  // Only a RUN card's cards — a split gang child is refused before any write.
  assert.match(pull, /SELECT id, order_line_id FROM job_cards WHERE gang_run_id=\$1 AND order_line_id IS NULL ORDER BY id/);
  const refuseAt = pull.indexOf('if (isSplitChild(child))');
  assert.ok(refuseAt > 0 && refuseAt < pull.indexOf('await sendStageBack('), 'a child is refused before sendStageBack writes anything');
  const cardWrite = pull.indexOf('UPDATE job_cards SET finalised_at=NULL');
  const lineWrite = pull.indexOf('UPDATE order_lines SET machine_id=NULL');
  assert.ok(cardWrite > 0 && lineWrite > cardWrite, 'cards first');
  assert.match(pull, /const lineIds = cards\.map\(c => c\.order_line_id\)\.filter\(Boolean\)\.sort\(\(a, b\) => a - b\);\s*for \(const id of lineIds\)/,
    'the lines after, ascending, outside the card loop');
});
