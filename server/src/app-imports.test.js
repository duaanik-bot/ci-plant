// The guard that was missing when a merge took production down.
//
// `npm test` runs `node --test src/*.test.js`, and no test imported a route
// file. So when the shade-card wave removed an export that routes/production.js
// still imported, the whole suite stayed green — 473/473 — while the deployed
// Vercel function crashed on cold start with FUNCTION_INVOCATION_FAILED and
// every endpoint returned 500. A passing suite said nothing about whether the
// app could actually boot.
//
// Importing app.js pulls in every route, and importing api/index.js pulls in
// what Vercel actually runs. An ESM import error is a load-time SyntaxError, so
// simply getting here is the assertion. This is the cheapest possible check for
// the most expensive possible failure.
import test from 'node:test';
import assert from 'node:assert/strict';

test('app.js imports — every route file resolves its imports', async () => {
  const mod = await import('./app.js');
  assert.equal(typeof mod.default, 'function', 'app.js must default-export the express app');
});

test('api/index.js imports — the Vercel entry can cold-start', async () => {
  const mod = await import('../../api/index.js');
  assert.equal(typeof mod.default, 'function', 'the Vercel entry must default-export a handler');
});
