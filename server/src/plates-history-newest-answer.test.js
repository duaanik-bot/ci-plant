// The Plates History tab's rows are fetched by the tab opening AND by load() —
// a realtime ping or a write on the screen — and the two can overlap. Only an
// answer that is older than what is already ON SCREEN may be thrown away.
//
// The first cut dropped an answer as soon as a newer REQUEST had merely started.
// On a tablet on flaky Wi-Fi: History opens (fetch 1), a realtime ping 650 ms
// later starts fetch 2, fetch 1 returns 1,266 rows and is dropped, fetch 2 times
// out — and load()'s failure is swallowed by the realtime hook, so no toast. The
// tab sat on "Loading history…" with a good answer thrown away, until some
// unrelated DB change happened to fire load() again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newestAnswerGate } from '../../client/src/lib/newestAnswer.js';

// Plays the History tab: each fetch begins, then either lands rows or fails.
const tab = () => {
  const gate = newestAnswerGate();
  let shown = null;
  return {
    begin: () => gate.begin(),
    succeed: (seq, rows) => { if (gate.accept(seq)) shown = rows; },
    // A failed fetch throws before accept() is ever asked — it paints nothing.
    fail: () => {},
    get shown() { return shown; },
  };
};

test('a newer fetch that FAILS does not veto an older one that succeeded', () => {
  const t = tab();
  const opened = t.begin();       // the tab opens
  const realtime = t.begin();     // a realtime load() starts while it is in flight
  t.succeed(opened, ['1,266 ledger rows']);
  t.fail(realtime);               // flaky Wi-Fi: the newer one times out
  assert.deepEqual(t.shown, ['1,266 ledger rows'],
    'the good answer must land — otherwise History reads "Loading history…" with the rows thrown away');
});

test('a newer fetch that fails FIRST still lets the older success land', () => {
  const t = tab();
  const opened = t.begin();
  const local = t.begin();        // load() after an issue/retire, fails fast
  t.fail(local);
  t.succeed(opened, ['rows']);
  assert.deepEqual(t.shown, ['rows']);
});

test('an older answer arriving after a newer one has landed is still ignored', () => {
  const t = tab();
  const older = t.begin();
  const newer = t.begin();
  t.succeed(newer, ['after the retire']);
  t.succeed(older, ['before the retire']);
  assert.deepEqual(t.shown, ['after the retire'],
    'the plate just retired must not reappear as on the rack because a slow answer came in last');
});

test('answers in order both land, the last one staying on screen', () => {
  const t = tab();
  const a = t.begin(); t.succeed(a, ['first']);
  const b = t.begin(); t.succeed(b, ['second']);
  assert.deepEqual(t.shown, ['second']);
});

test('an older success landing late, still newer than what is shown, replaces it', () => {
  const t = tab();
  const one = t.begin(); const two = t.begin(); const three = t.begin();
  t.succeed(one, ['one']);
  t.succeed(two, ['two']);        // newer than what is on screen: lands
  t.fail(three);
  assert.deepEqual(t.shown, ['two']);
});

test('PlatesLifecycle gates History rows through the gate, not a started-counter compare', () => {
  const src = readFileSync(new URL('../../client/src/components/PlatesLifecycle.jsx', import.meta.url), 'utf8');
  assert.match(src, /import \{ newestAnswerGate \} from '\.\.\/lib\/newestAnswer\.js'/);
  const at = src.indexOf('const loadHistory = async () => {');
  assert.ok(at >= 0);
  const body = src.slice(at, src.indexOf('\n  };', at));
  assert.match(body, /historyGate\.current\.begin\(\)/);
  assert.match(body, /if \(historyGate\.current\.accept\(seq\)\) setHistory\(rows\)/);
  assert.doesNotMatch(src, /historySeq/, 'the started-counter guard is gone');
});
