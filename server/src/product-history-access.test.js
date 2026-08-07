import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenProductHistory } from '../../client/src/lib/productHistoryAccess.js';

test('product history opens only in the approved operational modules', () => {
  for (const path of [
    '/planning',
    '/track',
    '/status-sheet',
    '/artwork',
    '/production',
    '/production/jobcard/42',
    '/print-planning',
    '/inventory',
    '/dispatch-invoice',
    '/dispatch/challan/9',
    '/invoices/12',
    '/coas/4',
    '/accounts',
    '/masters',
  ]) assert.equal(canOpenProductHistory(path), true, `${path} should allow product history`);
});

test('live floor and every unlisted module keep product names non-clickable', () => {
  for (const path of [
    '/floor',
    '/floor/printing',
    '/floor/sort-paste',
    '/orders',
    '/procurement',
    '/reports',
    '/tooling',
    '/shade-cards',
  ]) assert.equal(canOpenProductHistory(path), false, `${path} should not allow product history`);
});

test('route matching respects path boundaries', () => {
  assert.equal(canOpenProductHistory('/planning-tools'), false);
  assert.equal(canOpenProductHistory('/inventory-old'), false);
  assert.equal(canOpenProductHistory('/floor?tab=active'), false);
  assert.equal(canOpenProductHistory('/masters/'), true);
});
