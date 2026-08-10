import test from 'node:test';
import assert from 'node:assert/strict';
import { gangPlateSpecification, issuedPlatesForStage } from './plate-lifecycle.js';

test('a gang produces one shared Plate Set while retaining member traceability', () => {
  const specification = gangPlateSpecification(
    { id: 26, gang_number: 'CI-GANG-0005', output_number: '18700' },
    [
      { id: 101, order_line_id: 11, name: 'Carton A', code: 'A-1', colors: 4, colour_type: 'CMYK', party_artwork_code: 'R1' },
      { id: 102, order_line_id: 12, name: 'Carton B', code: 'B-1', colors: 4, colour_type: 'CMYK', party_artwork_code: 'R2' },
      { id: 103, order_line_id: 13, name: 'Carton C', code: 'C-1', colors: 4, colour_type: 'CMYK', party_artwork_code: 'R3' },
    ],
  );
  assert.equal(specification.is_gang, true);
  assert.equal(specification.product_name, 'CI-GANG-0005');
  assert.equal(specification.output_number, '18700');
  assert.equal(specification.colors, 4);
  assert.equal(specification.gang_members.length, 3);
});

test('issued plates always use the rows query helper', async () => {
  const rows = [{ id: 41 }, { id: 42 }];
  let usedRowsHelper = false;
  let usedOneHelper = false;

  const result = await issuedPlatesForStage(async (sql, params) => {
    usedRowsHelper = true;
    assert.match(sql, /FOR UPDATE OF pa/);
    assert.deepEqual(params, [99]);
    return rows;
  }, async () => {
    usedOneHelper = true;
    return null;
  }, 99, true);

  assert.equal(usedRowsHelper, true);
  assert.equal(usedOneHelper, false);
  assert.equal(result, rows);
});
