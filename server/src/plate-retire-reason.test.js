// A reason the plant never gave must not be recorded as the word "undefined".
//
// Live evidence this is not hypothetical (Supabase ylbfeptgefzimcqnwphy):
//   plate_asset_movements 539  note    = 'Retired after 1 run(s) — undefined'
//   plate_assets         1513  remarks = 'undefined'
// That plate is CI-PL-A-1491, scrapped off product 1683 (SW-801 BECELAC FORTZ).
// The remark is the ONLY surviving record of why a physical plate was destroyed,
// and it was overwritten with a JavaScript artefact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { optionalText, withReason } from './helpers.js';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

// The body of one express route handler, from its r.post(...) to the next one.
function route(source, path) {
  const at = source.indexOf(`r.post('${path}'`);
  if (at < 0) return null;
  const next = source.indexOf('\nr.', at + 1);
  return source.slice(at, next < 0 ? source.length : next);
}

test('a missing reason is nothing at all, not the string "undefined"', () => {
  // The exact wire shape: JSON.stringify DROPS a key whose value is undefined,
  // so the ordinary client idiom `reason: text.trim() || undefined` sends no
  // key — and String(undefined) is 9 characters of noise.
  const body = JSON.parse(JSON.stringify({ asset_ids: [1], reason: ''.trim() || undefined }));
  assert.equal(body.reason, undefined, 'the key never reaches the server at all');
  assert.equal(String(body.reason).trim(), 'undefined', 'which is precisely why the bare String() is a trap');
  assert.equal(optionalText(body.reason), null, 'the guard must turn that back into nothing');
});

test('optionalText refuses every spelling of "no reason given"', () => {
  for (const empty of [undefined, null, '', '   ', '\n\t ']) {
    assert.equal(optionalText(empty), null, `${JSON.stringify(empty)} is not a reason`);
  }
  // These arrive from `${maybeUndefined}` interpolation on the client — the same
  // bug through a different door, where the noise IS on the wire as text.
  assert.equal(optionalText('undefined'), null, 'a literal "undefined" is never something a human typed');
  assert.equal(optionalText('null'), null, 'nor is a literal "null"');
  assert.equal(optionalText('  undefined  '), null, 'padding does not make it a reason');
});

test('optionalText keeps a real reason exactly as the plant wrote it', () => {
  assert.equal(optionalText('Worn out — dot loss'), 'Worn out — dot loss');
  assert.equal(optionalText('  Scratched on press  '), 'Scratched on press', 'trimmed, not altered');
  // A reason that merely CONTAINS the word survives: only the bare token is noise.
  assert.equal(optionalText('undefined edge on the cyan'), 'undefined edge on the cyan');
});

test('withReason leaves a clean sentence when there is no reason', () => {
  // The live note read 'Retired after 1 run(s) — undefined'. With nothing given
  // it must read as a complete sentence, with no dangling em-dash either.
  assert.equal(withReason('Retired after 1 run(s)', undefined), 'Retired after 1 run(s)');
  assert.equal(withReason('Retired after 1 run(s)', ''), 'Retired after 1 run(s)');
  assert.equal(withReason('Retired after 1 run(s)', 'undefined'), 'Retired after 1 run(s)');
  assert.doesNotMatch(withReason('Retired after 1 run(s)', undefined), /—/,
    'no reason means no separator, not a trailing dash');
});

test('withReason appends the reason the plant did give', () => {
  assert.equal(withReason('Retired after 3 run(s)', 'Worn out'), 'Retired after 3 run(s) — Worn out');
});

test('the retire route reads its reason through the guard, not String()', () => {
  // The defect itself, pinned at the source. Reinstating `String(req.body.reason)`
  // here is what put 'undefined' in the database, and it must fail the suite.
  const body = route(read('server/src/routes/plates.js'), '/plates/assets/retire');
  assert.ok(body, 'the retire route is missing');
  assert.doesNotMatch(body, /String\(req\.body\.reason\)/,
    'String(undefined) is the literal string "undefined" — read the reason through optionalText');
  assert.match(body, /optionalText\(req\.body\.reason\)/,
    'retire must take its reason through the shared guard');
});

test('retire writes NULL to remarks rather than a placeholder', () => {
  const body = route(read('server/src/routes/plates.js'), '/plates/assets/retire');
  // COALESCE($1,remarks) keeps the old remark only when $1 is genuinely NULL.
  // '' or 'undefined' are both non-null and would overwrite it.
  assert.match(body, /remarks=COALESCE\(\$1,remarks\)/,
    'a missing reason must leave the existing remark standing');
});
