import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { HANDLED_BY, HANDLED_CODES } from '../../client/src/api.js';

// api.js suppresses the central error toast for any refusal carrying a `code`
// in HANDLED_CODES, on the promise that the caller says the refusal itself.
//
// That promise used to be a trailing comment, and a comment cannot be wrong out
// loud. PLATES_NOT_READY sat in the list with no handler anywhere and made
// Printing Start do literally nothing — the press pressed it twenty times in
// forty seconds (main@987267f). BOARD_NOT_FREE did the same to Lock Plan, which
// the floor read as a 200 ceiling on the wastage field (main@d281ab5). Both
// times the list was the thing that lied, and nothing was checking it.
//
// So the promise is DATA now, and this file is what checks it. HANDLED_BY names,
// per code, the client file(s) that speak the refusal, plus a `says` literal
// each of those files must really contain:
//
//   • says === the code — the caller branches on it (`e.data?.code === 'X'`)
//     and draws its own dialog.
//   • says === an endpoint — the caller has no branch, but wraps that call in a
//     catch that toasts `e.message`. A generic catch is a real handler; the
//     literal simply never appears. The endpoint must then ALSO appear in the
//     server file that throws the code, which is what proves the named screen
//     is talking to the route that can refuse this way.
//
// The second shape is why this is not a plain "grep the code in client/src".
// That grep is wrong in BOTH directions: it fails four codes whose generic
// catch does speak them, and it passes any code merely NAMED in prose — which
// is exactly how PLAN_ALREADY_EXECUTED looked handled while Lock Plan sat there
// doing nothing on an in_production line.
//
// A code with no honest entry cannot be suppressed at all. It falls through to
// the central toast, because a wrong-looking message beats no message.

const SRC = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(SRC, '../../client/src');

// Prose is not a handler. Blanked rather than deleted so reported offsets still
// line up with the real source. Same stripper as structured-errors.test.js.
const stripComments = s => s
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

const readStripped = p => stripComments(readFileSync(p, 'utf8'));

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.isFile() && p.endsWith('.js') && !p.endsWith('.test.js') ? [p] : [];
  });
}

// Server files that really throw the code, by its written form in a throw body.
const throwersOf = code => walk(SRC)
  .filter(f => readStripped(f).includes(`code: '${code}'`));

test('every suppressed refusal names a client file that really says it', () => {
  const offenders = [];
  for (const [code, entry] of Object.entries(HANDLED_BY)) {
    if (!entry || !Array.isArray(entry.at) || entry.at.length === 0) {
      offenders.push(`${code} — no client file named; it cannot be suppressed`);
      continue;
    }
    if (!entry.says) { offenders.push(`${code} — no 'says' anchor`); continue; }
    for (const rel of entry.at) {
      const file = join(CLIENT, rel);
      if (!existsSync(file)) {
        offenders.push(`${code} — names ${rel}, which does not exist`);
        continue;
      }
      if (!readStripped(file).includes(entry.says)) {
        offenders.push(
          `${code} — ${rel} never mentions ${entry.says} outside comments, so nothing there says this refusal`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'these codes suppress the central toast while nothing draws a dialog — the button just dies:\n  '
    + offenders.join('\n  '));
});

test('an endpoint anchor belongs to the route that throws the code', () => {
  const offenders = [];
  for (const [code, entry] of Object.entries(HANDLED_BY)) {
    // A code that anchors on itself is self-evident — the branch IS the proof.
    if (!entry?.says || entry.says === code) continue;
    const thrown = throwersOf(code);
    if (thrown.length === 0) {
      offenders.push(`${code} — anchored on ${entry.says} but no server file throws it`);
      continue;
    }
    if (!thrown.some(f => readStripped(f).includes(entry.says))) {
      offenders.push(`${code} — thrown by ${thrown.map(f => relative(SRC, f)).join(', ')}`
        + `, none of which serves ${entry.says}; the named screen calls some other route`);
    }
  }
  assert.deepEqual(offenders, [],
    'an endpoint anchor must tie the screen to the route that refuses:\n  ' + offenders.join('\n  '));
});

test('HANDLED_CODES is derived from HANDLED_BY and cannot drift from it', () => {
  assert.deepEqual([...HANDLED_CODES].sort(), Object.keys(HANDLED_BY).sort(),
    'the suppression set must be built from the claims, so a code cannot be silenced without one');
});

// The regression this file was written for. savePlan() has no catch of its own,
// every caller fires it from an onClick without one, and there is no
// unhandledrejection handler in the app — so suppressing this code meant Lock
// Plan on an in_production line did nothing at all, no toast, no dialog. The
// server's message even names the way out ("Reverse the job card back to
// Planning first"); the planner was never shown it.
test('Lock Plan on an executed line says so instead of doing nothing', () => {
  assert.ok(!HANDLED_CODES.has('PLAN_ALREADY_EXECUTED'),
    'nothing catches the plan save, so this must fall through to the central toast');
  assert.ok(throwersOf('PLAN_ALREADY_EXECUTED').length > 0,
    'the refusal itself must still exist — otherwise this guard protects nothing');
});
