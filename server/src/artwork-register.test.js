import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseItemCode, sourcePrint, placeVersion, versionLabel, jobKey } from './artwork-register.js';

// The artwork register's identity rules (Artwork Manager P1). Invented names and codes.

test('item code, revision and pack are read from a file name', () => {
  assert.deepEqual(parseItemCode('pcs-x001-r3 - ALPHA SUSPENSION - 200ML -SALE - CARTON.cdr'), { code: 'PCS-X001', rev: 'R3', pack: 'carton' });
  assert.deepEqual(parseItemCode('PML-X012 ALPHA label'), { code: 'PML-X012', rev: null, pack: 'label' });
  assert.deepEqual(parseItemCode('PMLF-X007 - R1 insert'), { code: 'PMLF-X007', rev: 'R1', pack: 'insert' });
  assert.deepEqual(parseItemCode('Skin Hydra boost.pdf'), { code: null, rev: null, pack: null });
});

test('a revision is read only after the code, and words that merely contain R and a digit are not one', () => {
  assert.deepEqual(parseItemCode('PMC-X028 - BETA 10 -R1 - Carton.cdr'), { code: 'PMC-X028', rev: 'R1', pack: 'carton' });
  assert.deepEqual(parseItemCode('R2 notes for PCS-X001 CARTON FOR3 pack'), { code: 'PCS-X001', rev: null, pack: 'carton' });
  assert.deepEqual(parseItemCode(null), { code: null, rev: null, pack: null });
});

test('the same bytes are the same version; new bytes under one revision get the next receipt number', () => {
  const have = [{ id: 5, client_rev: 'R0', receipt_no: 1, source_print: 'aa|bb' }];
  assert.deepEqual(placeVersion(have, { client_rev: 'R0', source_print: 'aa|bb' }), { sameAs: 5, receipt_no: 1 });
  assert.deepEqual(placeVersion(have, { client_rev: 'R0', source_print: 'cc' }), { sameAs: null, receipt_no: 2 });
  assert.deepEqual(placeVersion(have, { client_rev: 'R1', source_print: 'cc' }), { sameAs: null, receipt_no: 1 });
  assert.deepEqual(placeVersion(have, { client_rev: 'R0', source_print: '' }), { sameAs: null, receipt_no: 2 });
});

test('no revision and an empty revision are the same revision; the first version of a job is receipt 1', () => {
  assert.deepEqual(placeVersion([], { client_rev: null, source_print: 'aa' }), { sameAs: null, receipt_no: 1 });
  const have = [{ id: 9, client_rev: null, receipt_no: 1, source_print: 'aa' }, { id: 10, client_rev: '', receipt_no: 2, source_print: '' }];
  assert.deepEqual(placeVersion(have, { client_rev: '', source_print: 'zz' }), { sameAs: null, receipt_no: 3 });
  assert.deepEqual(placeVersion(have, { client_rev: null, source_print: '' }), { sameAs: null, receipt_no: 3 });
});

test('labels and keys', () => {
  assert.equal(versionLabel('R0', 2), 'R0.2');
  assert.equal(versionLabel(null, 3), 'v3');
  assert.equal(sourcePrint([{ sha256: 'bb' }, { sha256: 'aa' }, { sha256: 'bb' }]), 'aa|bb');
  // one file that could not be hashed: the set cannot be told from another, so it has no print (and is a new version)
  assert.equal(sourcePrint([{ sha256: 'bb' }, { sha256: 'aa' }, {}]), '');
  assert.equal(sourcePrint([]), '');
  assert.equal(jobKey(' Example  Pharma Ltd', 'PCS-X001', 'x'), 'example pharma ltd|pcs-x001');
  assert.equal(jobKey('Example Pharma Ltd', null, 'Skin  Kit'), 'example pharma ltd|name:skin kit');
});
