// The Run Sheet's Lock sheet → is the run engine's ONE door for a sheet change,
// and it asks the planner "Update Product Master / These jobs only". It wrote
// board, child and coating — never the parent — which is how SW-544 moved to
// the 23×38 board on 18 Sep 2026 with its old board's 22×28 parent left behind.
// The parent now travels through the same door, answering the same question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const GANGS = readFileSync(new URL('./routes/gangs.js', import.meta.url), 'utf8');
const route = GANGS.slice(GANGS.indexOf("r.post('/gang-runs/:id/shared'"),
                          GANGS.indexOf("r.get('/gang-runs/:id/smart-match'"));

test('the route takes a parent size, like the child size', () => {
  assert.match(route, /patch\.parent_l = \+req\.body\.parent_l/);
  assert.match(route, /patch\.parent_w = \+req\.body\.parent_w/);
});

test('both sides or neither — a half parent is refused as bad input', () => {
  assert.match(route, /Parent size needs both length and width/);
  assert.match(route, /Parent size must be greater than zero/);
});

test('the master comparison reads the parent too, so "equal to master" drops the override', () => {
  assert.match(route, /SELECT board_material_id, child_l, child_w, coating, parent_l, parent_w FROM products WHERE id=\$1/);
});

test('a co-printed run never has a parent written onto its products (its lock never reads one)', () => {
  assert.match(route, /if \(gang\.kind !== 'merge' && gang\.layout_mode === 'shared'\) \{ delete patch\.parent_l; delete patch\.parent_w; \}/);
});

test('a request left empty by the co-printed guard changes nothing', () => {
  const inTx = route.slice(route.indexOf('await tx('));
  const guard = inTx.indexOf('delete patch.parent_l; delete patch.parent_w; }');
  const early = inTx.indexOf('if (!Object.keys(patch).length) return;');
  assert.ok(guard > 0 && early > guard, 'the empty-patch return must follow the co-printed guard inside the transaction');
});

// ── Task 10 (final whole-branch review, 19 Sep 2026) ────────────────────────
// A. "Use the board's full sheet" + "Update Product Masters" wrote the RUN's
// board sheet into masters that keep their own smaller board — a pair the
// 14-Sep lock refuses on the next order. keepParentOffImpossibleMaster
// (keep-parent-off-impossible-master.test.js) keeps it on the job instead.
const loop = route.slice(route.indexOf('for (const line of lines) {'));

test('the member loop asks keepParentOffImpossibleMaster after the field split and before its products UPDATE', () => {
  const split = loop.indexOf('for (const [f, v] of Object.entries(patch))');
  const ask = loop.indexOf('keepParentOffImpossibleMaster({');
  const write = loop.indexOf('UPDATE products SET');
  assert.ok(split >= 0 && ask > split && write > ask,
    `split → helper → products UPDATE, got ${JSON.stringify({ split, ask, write })}`);
  assert.match(GANGS, /import \{[^}]*\bkeepParentOffImpossibleMaster\b[^}]*\} from '\.\.\/helpers\.js';/);
});

test('…only on a master update that carries a parent, judged against the RESULTING master board', () => {
  assert.match(loop, /if \(updateMaster && \('parent_l' in masterSets \|\| 'parent_w' in masterSets\)\) \{/);
  assert.match(loop, /const boardId = masterSets\.board_material_id \?\? master\.board_material_id;/);
  assert.match(loop, /await oc\('SELECT sheet_l, sheet_w FROM materials WHERE id=\$1', \[boardId\]\)/);
  assert.match(loop, /const kept = keepParentOffImpossibleMaster\(\{ toMaster: masterSets, toJob: next, master, masterBoard \}\);/);
  // kept job-only: the parent rides the job override, never the products UPDATE
  assert.match(loop, /masterSets = kept\.toMaster; next = kept\.toJob;/);
  assert.match(loop, /if \(kept\.keptJobOnly\) parentKeptJobOnly\.add\(/);
});

test('/shared answers parent_kept_job_only — the product codes, [] when none, the early return included', () => {
  assert.match(route, /const parentKeptJobOnly = new Set\(\);/);
  assert.match(route, /parent_kept_job_only: \[\.\.\.parentKeptJobOnly\]/);
  assert.match(route, /parent_kept_job_only: out\?\.parent_kept_job_only \?\? \[\]/);
});

test('the audit says the parent was kept job-only, and why', () => {
  assert.match(route, /parent kept job-only on \$\{\[\.\.\.parentKeptJobOnly\]\.join\(', '\)\} — the master's own board cannot yield it/);
});

// B. The Run Sheet one-click fixes the product it is clicked on: line_ids
// scopes a PARENT-only change to the orders the red row covers.
import { sharedLineScope } from './routes/gangs.js';

test('line_ids is a list of positive integer order line ids', () => {
  const P = { parent_l: 23, parent_w: 38 };
  assert.deepEqual(sharedLineScope(undefined, P), { scope: null, error: null });
  assert.deepEqual(sharedLineScope(null, P), { scope: null, error: null });
  assert.deepEqual([...sharedLineScope([812, 813, 812], P).scope], [812, 813]);
  for (const bad of [[], 'x', 12, {}, [0], [-3], [1.5], ['812'], [null], [812, 'x']]) {
    assert.deepEqual(sharedLineScope(bad, P), { scope: null, error: 'line_ids must be a list of order line ids' },
      JSON.stringify(bad));
  }
});

test('line_ids scopes a parent change only — a board, child or coating is the whole run\'s one sheet', () => {
  for (const patch of [{ parent_l: 23, parent_w: 38, coating: 'UV' }, { parent_l: 23, parent_w: 38, board_material_id: 399 },
                       { child_l: 12, child_w: 20 }, { coating: 'UV' }]) {
    assert.deepEqual(sharedLineScope([812], patch), { scope: null, error: 'line_ids scopes a parent change only' },
      JSON.stringify(patch));
  }
});

test('the route answers a bad line_ids with a 400, before the transaction', () => {
  assert.match(route, /const \{ scope, error: scopeError \} = sharedLineScope\(req\.body\.line_ids, patch\);\s*if \(scopeError\) return res\.status\(400\)\.json\(\{ error: scopeError \}\);/);
  assert.ok(route.indexOf('sharedLineScope(') < route.indexOf('await tx('));
});

test('every scoped id must be one of this run\'s orders, else a 400', () => {
  assert.match(route, /if \(scope && !\[\.\.\.scope\]\.every\(id => members\.some\(l => l\.id === id\)\)\)\s*throw Object\.assign\(new Error\('line_ids names an order that is not in this run'\), \{ status: 400 \}\);/);
});

test('scoped, the masters read, requestChangesCut, the loop and its re-derive run on the named orders; the card restamp on every member', () => {
  const inTx = route.slice(route.indexOf('await tx('));
  const at = s => inTx.indexOf(s);
  const all = at("const members = await qc('SELECT * FROM order_lines WHERE gang_run_id=$1 ORDER BY id FOR UPDATE OF order_lines', [gang.id]);");
  const scoped = at('const lines = scope ? members.filter(l => scope.has(l.id)) : members;');
  const mastersRead = at('for (const l of lines) {');
  const ask = at('requestChangesCut({ gang, lines, masters, patch })');
  const memberLoop = at('for (const line of lines) {');
  const reDerive = at('reDeriveMemberSheets(line.id');
  const restamp = at("const fresh = await qc('SELECT * FROM order_lines WHERE gang_run_id=$1 ORDER BY id', [gang.id]);");
  assert.ok(all >= 0 && scoped > all && mastersRead > scoped && ask > mastersRead && memberLoop > ask
    && reDerive > memberLoop && restamp > reDerive,
    JSON.stringify({ all, scoped, mastersRead, ask, memberLoop, reDerive, restamp }));
});

test('a scoped lock\'s audit line names the orders it changed', () => {
  assert.match(route, /scope \? `for \$\{lines\.length\} of the \$\{members\.length\} jobs — \$\{lines\.map\(l => `\$\{masters\.get\(l\.product_id\)\?\.code \?\? `product #\$\{l\.product_id\}`\} \(line \$\{l\.id\}\)`\)\.join\(', '\)\}`/);
  assert.match(route, /: `for all \$\{lines\.length\} jobs`/);
});

// ── Task 10, round 2: the transaction body is lockSharedSheet ───────────────
// (lock-shared-sheet.test.js drives it for real). The route keeps its input
// checks and answers with the function's result.
test('the route hands its transaction to lockSharedSheet, with the request\'s own answers', () => {
  assert.match(route, /const out = await tx\(\(qc, oc\) => lockSharedSheet\(\s*\{ gangId: req\.params\.id, patch, updateMaster: !!req\.body\.update_master, scope, user: req\.user\.name \}, qc, oc\)\);/);
  assert.match(GANGS, /export async function lockSharedSheet\(\{ gangId, patch: sent, updateMaster = false, scope = null, user = null \}, qc, oc\) \{\s*const patch = \{ \.\.\.sent \};/);
});

test('/shared answers master_parent_cleared and masters_updated — [] on the early return too', () => {
  assert.match(route, /master_parent_cleared: out\?\.master_parent_cleared \?\? \[\], masters_updated: out\?\.masters_updated \?\? \[\]/);
  assert.match(route, /master_parent_cleared: \[\.\.\.masterParentCleared\.values\(\)\], masters_updated: \[\.\.\.mastersWritten\]\.map\(codeOf\)/);
});

// Round 3: the product's other open plans pinned to the cleared parent.
test('/shared answers parent_pinned_lines — [] on the early return too', () => {
  assert.match(route, /parent_pinned_lines: out\?\.parent_pinned_lines \?\? \[\] \}\);/);
  assert.match(route, /parent_pinned_lines: parentPinnedLines \};/);
  assert.match(route, /parentPinnedLines\.push\(\.\.\.await pinParentOnMasterClear\(\{\s*productId: line\.product_id, oldParent: \{ parent_l: current\.sheet_l, parent_w: current\.sheet_w \},\s*excludeLineIds: lines\.map\(l => l\.id\), user, why: `from gang \$\{gang\.gang_number\}` \}, qc\)\);/);
});
