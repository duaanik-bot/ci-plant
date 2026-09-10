import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HANDLED_BY } from '../../client/src/api.js';

// The over-issue alarm (over-issue.js) is only as good as its coverage. A route
// that saves a hand-typed parent-sheet figure without judging it is a hole the
// next CI-GANG-0051 walks straight through; a screen that sends one of those
// figures without the guard is worse — api.js keeps OVER_ISSUE quiet because
// the guard draws the dialog, so an unguarded caller's button would simply do
// nothing. Both halves are pinned here, by source, the way
// plate-lifecycle-wiring.test.js pins its hooks.

const SRC = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(SRC, '../../client/src');

// Prose is not wiring. Same stripper as handled-codes.test.js.
const stripComments = s => s
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
const read = p => stripComments(readFileSync(p, 'utf8'));

// One Express handler's body: from `r.<verb>('<path>'` to the next top-level
// route declaration. The closing quote is part of the needle, so
// '/job-cards/:id' can never match '/job-cards/:id/amend'.
function handler(file, verb, path) {
  const src = read(join(SRC, 'routes', file));
  const start = src.indexOf(`r.${verb}('${path}'`);
  assert.ok(start >= 0, `${file} no longer declares ${verb.toUpperCase()} ${path} — update this test`);
  const end = src.indexOf('\nr.', start + 1);
  return src.slice(start, end < 0 ? undefined : end);
}

// The planning engine's two saves judge inline; the three job-card doors share
// production.js's judgeParentSheets, which is itself held to judging below.
const GATED = [
  ['gangs.js', 'post', '/gang-runs/:id/plan', 'overIssueRefusal('],
  ['orders.js', 'post', '/order-lines/:id/plan', 'overIssueRefusal('],
  ['production.js', 'put', '/job-cards/:id', 'judgeParentSheets('],
  ['production.js', 'post', '/job-cards/:id/amend', 'judgeParentSheets('],
  ['production.js', 'put', '/print-planning/:jobCardId', 'judgeParentSheets('],
];

test('every route that saves a hand-typed parent-sheet figure judges it', () => {
  for (const [file, verb, path, needle] of GATED) {
    const body = handler(file, verb, path);
    assert.ok(body.includes(needle),
      `${verb.toUpperCase()} ${path} (${file}) saves a parent-sheet figure without the over-issue alarm`);
    if (needle === 'overIssueRefusal(') {
      assert.ok(body.includes("'over_issue_confirmed'"),
        `${verb.toUpperCase()} ${path} (${file}) never records who confirmed an over-issue`);
    }
  }
});

test("production.js's shared job-card judge really judges, and records the answer", () => {
  const src = read(join(SRC, 'routes', 'production.js'));
  const start = src.indexOf('async function judgeParentSheets(');
  assert.ok(start >= 0, 'judgeParentSheets is gone — the three job-card routes lost their judge');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.ok(body.includes('overIssueRefusal('), 'judgeParentSheets no longer asks the over-issue rule');
  assert.ok(body.includes("'over_issue_confirmed'"), 'judgeParentSheets no longer audits the answer');
});

// Every client call that can come back OVER_ISSUE, by its exact spelling. The
// count is part of the claim: a NEW call to one of these routes must be added
// here, which is the moment someone has to decide whether it is guarded.
const CALLS = [
  ['pages/Planning.jsx', 'api.post(`/order-lines/${planLine.id}/plan`', 1],
  ['pages/Planning.jsx', 'api.post(`/gang-runs/${gangView.id}/plan`', 2],
  ['pages/Production.jsx', 'api.put(`/job-cards/${editing.id}`', 1],
  ['pages/Production.jsx', 'api.post(`/job-cards/${amending.id}/amend`', 1],
  ['pages/PrintPlanning.jsx', 'api.put(`/print-planning/${card.id}`', 1],
];

test('every screen that sends one of those figures can draw the alarm', () => {
  for (const [page, call, expected] of CALLS) {
    const src = read(join(CLIENT, page));
    const hits = [];
    for (let at = src.indexOf(call); at >= 0; at = src.indexOf(call, at + 1)) hits.push(at);
    assert.equal(hits.length, expected,
      `${page}: expected ${expected} call(s) of ${call}, found ${hits.length} — decide whether the new one is guarded, then update this test`);
    for (const at of hits) {
      assert.ok(src.slice(Math.max(0, at - 160), at).includes('guard('),
        `${page}: ${call} is sent outside the over-issue guard — its alarm would be swallowed and the button would do nothing`);
    }
    assert.ok(src.includes('useOverIssueGuard('), `${page} never mounts the over-issue guard`);
    assert.ok(/\.dialog\s*\}/.test(src), `${page} never renders the over-issue alarm`);
  }
});

test('api.js keeps OVER_ISSUE quiet only because the guard draws it', () => {
  assert.deepEqual(HANDLED_BY.OVER_ISSUE?.at, ['components/OverIssueAlarm.jsx']);
  const guard = read(join(CLIENT, 'components/OverIssueAlarm.jsx'));
  assert.ok(guard.includes("'OVER_ISSUE'"), 'the guard no longer branches on the code it claims to handle');
});
