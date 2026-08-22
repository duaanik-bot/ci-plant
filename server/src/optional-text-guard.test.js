// `String(req.body.anything)` is a loaded gun pointed at the database.
//
// JSON.stringify DROPS a key whose value is undefined, so the ordinary client
// idiom `field: typed.trim() || undefined` sends NO key — and String() then
// turns that absence into the nine-character string 'undefined', which is a
// perfectly good non-null value as far as COALESCE, a NOT NULL column, or a
// template literal is concerned. It reached production once: plate CI-PL-A-1491
// carries remarks 'undefined' and a movement note reading
// 'Retired after 1 run(s) — undefined'. See plate-retire-reason.test.js.
//
// The cure is helpers.js optionalText()/withReason(). This test stops the shape
// from coming back: every bare String(req.body.x) in a route must be listed
// below WITH the reason it cannot fire. Anything new fails the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const routes = new URL('../src/routes/', import.meta.url);
const BARE = /String\(req\.body\.[A-Za-z_][A-Za-z0-9_.]*\)/g;

// file → expression → why this one cannot write 'undefined'.
// Keyed on the expression, never a line number, so refactors do not churn it.
const GATED = {
  'gangs.js': {
    'String(req.body.coating)':
      'same line: guarded by req.body.coating != null && !== ""',
    'String(req.body.reraise_reason)':
      'the route throws 400 above unless reraise_of comes with a non-empty reason',
  },
  'masters.js': {
    'String(req.body.category)':
      'compared to "board", never written — "undefined" simply is not a match',
    'String(req.body.code)':
      'this IS the emptiness gate, and the write below runs only once it passes',
  },
  'plates.js': {
    'String(req.body.reason)':
      'plate REPLACEMENT: validatePlateReplacementRequest throws 400 unless the '
      + 'reason is one of PLATE_REPLACEMENT_REASONS, so it is a closed vocabulary '
      + 'by the time it is read. (Retire, which had no such gate, is the bug.)',
  },
};

test('no route reads req.body through a bare String() without a gate', () => {
  const unlisted = [];
  for (const file of readdirSync(routes).filter(name => name.endsWith('.js'))) {
    const source = readFileSync(new URL(file, routes), 'utf8');
    for (const found of new Set(source.match(BARE) || [])) {
      if (!GATED[file]?.[found]) unlisted.push(`${file}: ${found}`);
    }
  }
  assert.deepEqual(unlisted, [],
    'These read a possibly-absent body field through String(), which yields the '
    + 'literal text "undefined". Use optionalText()/withReason() from helpers.js — '
    + 'or, if a gate above genuinely makes it unreachable, say so in GATED.');
});

test('the allowlist stays honest — every entry still exists', () => {
  // An entry left behind after its code is gone is a claim nobody is checking.
  const stale = [];
  for (const [file, entries] of Object.entries(GATED)) {
    const source = readFileSync(new URL(file, routes), 'utf8');
    for (const expr of Object.keys(entries)) {
      if (!source.includes(expr)) stale.push(`${file}: ${expr}`);
    }
  }
  assert.deepEqual(stale, [], 'remove allowlist entries whose code no longer exists');
});

test('retire is NOT on the allowlist — it is the defect this exists for', () => {
  const source = readFileSync(new URL('plates.js', routes), 'utf8');
  const at = source.indexOf("r.post('/plates/assets/retire'");
  const body = source.slice(at, source.indexOf('\nr.', at + 1));
  assert.doesNotMatch(body, BARE,
    'the retire route must read its optional reason through optionalText()');
});
