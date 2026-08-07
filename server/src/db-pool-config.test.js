import test from 'node:test';
import assert from 'node:assert/strict';
import { poolLimits } from './db.js';

test('Vercel defaults to one client per function instance', () => {
  assert.deepEqual(poolLimits({ VERCEL: '1' }), {
    max: 1,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
});

test('local development keeps enough clients for the dashboard fan-out', () => {
  assert.deepEqual(poolLimits({}), {
    max: 20,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false,
  });
});

test('a positive PG_POOL_MAX remains an explicit override', () => {
  assert.equal(poolLimits({ VERCEL: '1', PG_POOL_MAX: '3' }).max, 3);
  assert.equal(poolLimits({ VERCEL: '1', PG_POOL_MAX: '0' }).max, 1);
});
