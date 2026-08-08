import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultToolingFamilies,
  isToolingRequestOpen,
  statusForSource,
  TOOLING_REQUEST_FAMILIES,
} from './tooling-requirements.js';

test('printing and die cutting default to plates, dies and shade cards', () => {
  assert.deepEqual(
    defaultToolingFamilies({ stages: ['printing', 'die_cutting'], products: [{ special: 'none' }] }),
    ['plate', 'die', 'shade_card'],
  );
});

test('embossing or leafing adds blocks but a plain job does not', () => {
  assert.ok(defaultToolingFamilies({ stages: ['printing', 'embossing'] }).includes('block'));
  assert.ok(defaultToolingFamilies({ stages: ['printing'], products: [{ leafing: 1 }] }).includes('block'));
  assert.ok(!defaultToolingFamilies({ stages: ['printing'], products: [{ special: 'none' }] }).includes('block'));
});

test('source choices map to their first operational status', () => {
  assert.equal(statusForSource('rack'), 'rack_reserved');
  assert.equal(statusForSource('in_house'), 'in_house');
  assert.equal(statusForSource('vendor'), 'vendor_assigned');
  assert.equal(statusForSource('procurement'), 'procurement');
});

test('terminal requests leave the active queue', () => {
  assert.equal(isToolingRequestOpen('pending'), true);
  assert.equal(isToolingRequestOpen('lost_damaged'), true);
  assert.equal(isToolingRequestOpen('ready'), false);
  assert.deepEqual(TOOLING_REQUEST_FAMILIES, ['plate', 'die', 'block', 'shade_card']);
});
