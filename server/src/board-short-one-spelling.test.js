import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boardShortOf } from '../../client/src/lib/boardShort.js';

// TWO READERS, ONE SENTENCE, AND THEY DRIFTED. The row's ReadinessCell had
// three branches; the KPI strip had two — under a comment claiming they were
// "the same arithmetic, so the queue's red '−725' on a row and the strip's
// total are the same number counted the same way".
test('a mixed line is judged on the mix, not the planned board alone', () => {
  // Covered by the mix across two boards: the planned board's own subtraction
  // would read 4,000 − 1,000 = 3,000 short. The truth is nil.
  const covered = { material: false, mix_active: true, mix_short: 0,
                    parent_needed: 4000, available_sheets: 1000 };
  assert.equal(boardShortOf(covered), 0,
    'a covered mix added a phantom 3,000 to the plant-wide total');
  // Genuinely short, but the hole is on an emptied SUBSTITUTE — mix_short is
  // the summed truth, and the planned board\'s own gap is a different number.
  const short = { material: false, mix_active: true, mix_short: 725,
                  parent_needed: 4000, available_sheets: 3900 };
  assert.equal(boardShortOf(short), 725, 'not the planned board\'s 100');
});

test('the unmixed and covered cases are unchanged', () => {
  assert.equal(boardShortOf({ material: true, parent_needed: 4000, available_sheets: 0 }), 0,
    'material is already mix-aware and already blind to other jobs\' stock');
  assert.equal(boardShortOf({ material: false, mix_active: false, parent_needed: 4000, available_sheets: 3275 }), 725);
  assert.equal(boardShortOf({ material: false, mix_active: false, parent_needed: 100, available_sheets: 400 }), 0,
    'never negative');
  assert.equal(boardShortOf(null), 0);
});

test('both readers call the one spelling', () => {
  const src = readFileSync(new URL('../../client/src/pages/Planning.jsx', import.meta.url), 'utf8');
  assert.equal((src.match(/boardShortOf\(/g) || []).length, 2,
    'ReadinessCell and the KPI strip — and nothing hand-rolled beside them');
  assert.doesNotMatch(src, /\(\+l\.readiness\.parent_needed \|\| 0\) - \(\+l\.readiness\.available_sheets \|\| 0\)/,
    'the strip\'s two-branch copy is gone');
});
