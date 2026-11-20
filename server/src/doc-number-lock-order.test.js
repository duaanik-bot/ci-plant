import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockDocNumbers, FG_MOVE_PREFIXES } from './helpers.js';

// The document-number lock (helpers.js lockDocNumber) is held to COMMIT, so it
// sits beside the transaction's row locks — and two transactions that take the
// same pair in opposite orders deadlock: Postgres kills one (40P01) and that
// user's save fails. Before the lock existed there was nothing to invert.
//
// The rule: a transaction that will mint takes its prefix locks FIRST, before
// any FOR UPDATE and before any insert whose foreign key share-locks a row; more
// than one prefix goes in FG_MOVE_PREFIXES order. Every route below used to lock
// a row before its minter while another route minted first and then touched
// that row (the pre-ship review of 2026-09-18 traced each pair). Each pin reads
// the route's own source: its lock call must come before its first row lock.

const SRC = path.dirname(fileURLToPath(import.meta.url));
const read = rel => fs.readFileSync(path.join(SRC, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))
  .replace(/^[ \t]*\/\/.*$/gm, '');

// The body from `anchor` up to the first `until` after it.
function before(rel, anchor, until) {
  const src = read(rel);
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `${rel}: cannot find ${anchor}`);
  const end = src.indexOf(until, at);
  assert.ok(end > at, `${rel}: no ${until} after ${anchor}`);
  return src.slice(at, end);
}

const PINS = [
  // POST /grns mints, then its insert share-locks the PO and the line.
  ['routes/procurement.js', "r.post('/grns/bulk'", 'FOR UPDATE', /lockDocNumber\('CI-GRN-', oc\)/],
  ['routes/procurement.js', "r.post('/grns/substitute'", 'FOR UPDATE', /lockDocNumber\('CI-GRN-', oc\)/],
  // POST /dispatches and POST /fg-lots mint, then touch the lines and stock
  // that a move locks first. applyFgMove serves /fg/move and /fg/move-bulk.
  ['routes/dispatch.js', 'export async function applyFgMove(', 'FOR UPDATE', /lockDocNumbers\(FG_MOVE_PREFIXES, oc\)/],
  ['routes/dispatch.js', 'export async function resolveShortage(', 'FOR UPDATE', /if \(action === 'close'\) await lockDocNumbers\(FG_MOVE_PREFIXES, oc\)/],
  ['routes/billing.js', "r.post('/invoices/:id/lines/:lineId/remove'", 'FOR UPDATE', /lockDocNumbers\(\['CI-FG-', 'CI-BOX-'\], oc\)/],
  ['routes/fg.js', "r.post('/fg-lots',", 'FOR UPDATE', /lockDocNumbers\(\['CI-FG-', 'CI-BOX-'\], oc\)/],
  // Every other PR door mints, then share-locks its line through the insert.
  ['routes/board.js', "r.post('/board/move'", 'FOR UPDATE', /lockDocNumber\('CI-PR-', oc\)/],
  // …and Push to Job Card share-locks the gang's row while holding its lines.
  ['routes/gangs.js', "r.post('/gang-runs/:id/raise-pr'", 'FOR UPDATE', /lockDocNumber\('CI-PR-', oc\)/],
  // The enquiry desk's auto-costing mints a costing and links its enquiry, as a person's save for that enquiry does.
  ['auto-costing.js', 'export async function autoCostEnquiry(', 'FOR UPDATE', /lockDocNumber\('CI-CST-', oc\)/],
];

for (const [rel, anchor, until, lock] of PINS) {
  const name = anchor.replace(/^r\.post\('|^export async function /, '').replace(/[(',]+$/, '');
  test(`${name} takes its number lock before its first row lock`, () => {
    assert.match(before(rel, anchor, until), lock,
      `${rel}: ${anchor} locks a row before its document-number lock — two savers can deadlock`);
  });
}

// raise-pr mints and inserts the PR in one transaction (the lock needs it), but
// the allocation mirror onto every gang-mate runs AFTER the commit. Inside, it
// would hold this line while waiting on a mate, and "Push to Job Card" locks
// the line it was clicked on first and the gang after — a deadlock the old
// statement-at-a-time code could never reach.
test('raise-pr mirrors onto the gang after its transaction, not inside it', () => {
  const src = read('routes/orders.js');
  const at = src.indexOf("r.post('/order-lines/:id/raise-pr'");
  const body = src.slice(at, src.indexOf('\nr.', at + 1));
  assert.match(body, /await tx\(async \(qc, oc\) => \{[\s\S]*nextNumber\('CI-PR-'[\s\S]*\}\);\s*[\s\S]*?await syncPrAllocation\(q, pr\);/,
    'the gang mirror must follow the committed transaction');
  assert.doesNotMatch(body, /syncPrAllocation\(qc/, 'the gang mirror runs inside the minting transaction');
});

// The enquiry desk's Approve (20 Nov 2026) locks each row's costing before the row, the order every costing save takes
// (reviseCosting, then linkEnquiry): the other way round, a manager approving a row while a person saves its costing
// would deadlock. The mail's reply mints CI-QTN- numbers in transactions of its own, so it runs only after Approve's
// transaction has committed — inside it, on a one-client pool, the reply's first transaction would wait for itself.
test('approve locks the costings before the enquiries, and replies after its transaction', () => {
  const src = read('routes/enquiries.js');
  const at = src.indexOf("r.post('/costing/enquiries/approve'");
  assert.ok(at >= 0, 'routes/enquiries.js: cannot find the approve route');
  const body = src.slice(at, src.indexOf('\nr.', at + 1));
  // The transaction's own code: from the callback's `{` to the brace that closes it (the braces in its strings pair up).
  const open = body.indexOf('{', body.indexOf('await tx(async (qc, oc) =>'));
  assert.ok(open > 0, 'approve has no transaction of its own');
  let close = -1;
  for (let i = open, depth = 0; i < body.length && close < 0; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) close = i;
  }
  const inside = body.slice(open, close);
  const costings = inside.search(/FROM costings\b[^`]*FOR UPDATE/);
  assert.ok(costings >= 0, 'approve takes no lock on the costings in its transaction');
  assert.ok(costings < inside.indexOf('lockRows(qc'), 'approve locks the enquiries (lockRows) before their costings');
  assert.doesNotMatch(inside, /reply(IfReady|Step)\(/, 'the reply runs inside the approve transaction');
  assert.match(body.slice(close), /await replyStep\(/, 'the reply must follow the committed transaction');
});

// Two presses can reach one mail at once (R22): its reply is claimed in a transaction of its own that locks every row of
// the mail and finalises them, and only then, after that commit, does the send step (its own transactions) run.
test("a mail's reply is claimed under the lock of its rows, and sent only after that transaction", () => {
  const claim = before('routes/enquiries.js', 'async function claimReply(', '\n}\n');
  assert.match(claim, /return tx\(async \(qc\) => \{/, 'the claim is one transaction');
  assert.match(claim, /mailItems\(qc, [^;]*\{ lock: true \}\)/, "the claim reads the mail's rows locked, inside it");
  assert.doesNotMatch(claim, /sendQuotations\(|makeQuotations\(|queueDraft\(|\bq\(|\bone\(/, 'a pool call or the send step inside the claim');
  assert.match(before('routes/enquiries.js', 'async function mailItems(', '\n}\n'), /ORDER BY e\.id\$\{lock \? ' FOR UPDATE OF e' : ''\}/,
    'the rows are locked in id order');
  assert.match(before('routes/enquiries.js', 'async function replyIfReady(', '\n}\n'), /await claimReply\([\s\S]*await sendQuotations\(/,
    'the send step follows the claim');
});

test('several prefixes are locked in one fixed order, one at a time on the caller\'s transaction', async () => {
  assert.deepEqual([...FG_MOVE_PREFIXES], ['CI-CH-', 'CI-FG-', 'CI-BOX-']);
  const seen = [];
  await lockDocNumbers(FG_MOVE_PREFIXES, async (sql, params) => { seen.push([sql, params[0]]); });
  assert.deepEqual(seen.map(s => s[1]), ['CI-CH-', 'CI-FG-', 'CI-BOX-']);
  for (const [sql] of seen) assert.match(sql, /pg_advisory_xact_lock\(764002, hashtext\(\$1\)\)/);
});

// Any literal list handed to lockDocNumbers must follow FG_MOVE_PREFIXES — two
// routes locking FG and BOX in opposite orders would deadlock each other.
test('every literal prefix list keeps FG_MOVE_PREFIXES order', () => {
  const lists = [];
  for (const rel of ['routes/billing.js', 'routes/fg.js', 'routes/dispatch.js', 'helpers.js']) {
    for (const m of read(rel).matchAll(/lockDocNumbers\(\[([^\]]*)\]/g))
      lists.push({ rel, prefixes: [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) });
  }
  assert.ok(lists.length >= 2, 'the scan found the literal lists it is guarding');
  for (const { rel, prefixes } of lists) {
    const idx = prefixes.map(p => FG_MOVE_PREFIXES.indexOf(p));
    assert.ok(idx.every(i => i >= 0), `${rel}: ${prefixes} names a prefix outside FG_MOVE_PREFIXES`);
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b), `${rel}: ${prefixes} is out of order`);
  }
});

// The four job-card creators mint CI-JC- / CI-GANG-JC- through their `oc`. A
// pool default would let a future caller mint outside its transaction, where
// the lock is released the moment its own statement ends.
test('the job-card creators have no pool default for their clients', () => {
  const src = read('helpers.js');
  for (const name of ['createJobCardForLine', 'createJobCardForGang', 'createJobCardForMergeRun', 'splitGangParentJob']) {
    const sig = src.match(new RegExp(`export async function ${name}\\(([^)]*)\\)`));
    assert.ok(sig, `${name} not found`);
    assert.doesNotMatch(sig[1], /\b(qc|oc)\s*=/, `${name}(${sig[1]}) still defaults a client to the pool`);
  }
});
