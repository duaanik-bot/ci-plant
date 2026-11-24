import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finAutoAllocate, finPickAllocate, finPickOrder, finItemOrder } from '../../client/src/lib/finance/allocation.js';

const it = (line_id, date, open_paise, extra = {}) =>
  ({ line_id, date, due_date: null, bill_ref: null, is_opening_lump: false, open_paise, ...extra });
const LUMP = it(1, '2026-12-31', 2_000_000, { is_opening_lump: true });
const B91 = it(2, '2026-12-02', 3_500_000, { bill_ref: 'Opening bill 0091' });
const B104 = it(3, '2026-12-18', 4_000_000, { bill_ref: 'Opening bill 0104' });

test('Auto settles the opening lump first, then bills oldest first (spec §5.1 sketch: 80,000 + TDS 1,600)', () => {
  assert.deepEqual(finAutoAllocate([B104, B91, LUMP], 8_160_000), {
    allocations: [{ line_id: 1, amount_paise: 2_000_000 }, { line_id: 2, amount_paise: 3_500_000 }, { line_id: 3, amount_paise: 2_660_000 }],
    on_account_paise: 0,
  });
});
test('Auto: more money than is open goes on account', () => {
  assert.equal(finAutoAllocate([it(5, '2026-09-02', 3_000_000), it(6, '2026-09-18', 3_500_000)], 8_000_000).on_account_paise, 1_500_000);
});
test('Auto: nothing open puts it all on account, with no error', () => {
  assert.deepEqual(finAutoAllocate([], 500_000), { allocations: [], on_account_paise: 500_000 });
});
test('Pick: tick order; null fills the bill; the last tick is trimmed to the money left', () => {
  assert.deepEqual(finPickAllocate([B91, B104], [{ line_id: 3, amount_paise: null }, { line_id: 2, amount_paise: null }], 5_000_000).allocations,
    [{ line_id: 3, amount_paise: 4_000_000 }, { line_id: 2, amount_paise: 1_000_000 }]);
});
test('Pick: an edited amount is capped at what is open; an unknown line is dropped', () => {
  assert.deepEqual(finPickAllocate([B91], [{ line_id: 2, amount_paise: 9_999_999 }, { line_id: 99, amount_paise: 100 }], 5_000_000),
    { allocations: [{ line_id: 2, amount_paise: 3_500_000 }], on_account_paise: 1_500_000 });
});
test('order: lump, then date, then due date (null last), then bill ref naturally (INV-9 before INV-10), then line id', () => {
  const list = [it(9, '2027-01-05', 1, { bill_ref: 'INV-10' }), it(8, '2027-01-05', 1, { bill_ref: 'INV-9' }),
    it(7, '2027-01-05', 1, { due_date: '2027-02-01' }), it(6, '2027-01-04', 1), LUMP];
  assert.deepEqual(list.sort(finItemOrder).map(x => x.line_id), [1, 6, 7, 8, 9]);
});
test('Pick order: a typed reference moves its bill to the top', () => {
  assert.equal(finPickOrder([B91, B104], 'bill-0104')[0].line_id, 3);
});
test('amounts must be whole paise ≥ 0', () => {
  for (const bad of [-1, 1.5, NaN, '100']) assert.throws(() => finAutoAllocate([], bad), RangeError);
});
