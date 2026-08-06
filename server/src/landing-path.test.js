import test from 'node:test';
import assert from 'node:assert/strict';
import { canAccess, moduleForPath, firstAllowedPath } from '../../client/src/modules.js';

// A landing_path is a convenience — each login opens straight to its own board.
// It is NOT a grant. If the account was never given the module that path belongs
// to, honouring it sends the user to a route the App.jsx module gate bounces,
// and the bounce target is that same landing_path: an infinite redirect that
// locks the account out of the whole ERP.
//
// The Design login on prod was exactly this: landing_path '/' (dashboard) with a
// module list that never included `dashboard`. It read as "the designer has no
// ganging rights" — they simply could never reach Planning.

// Walk the real App.jsx guard: block a module the user lacks, redirect to
// firstAllowedPath, repeat. Returns the path it settles on, or null if it loops.
function settle(user, from = '/', hops = 8) {
  let path = from;
  for (let i = 0; i < hops; i++) {
    const mod = moduleForPath(path);
    if (!mod || canAccess(user, mod)) return path;
    const next = firstAllowedPath(user);
    if (next === path) return null;      // bounced to itself — hard loop
    path = next;
  }
  return null;                            // never settled
}

const designer = {
  role: 'planner',
  landing_path: '/',
  modules: ['track', 'status_sheet', 'orders', 'planning', 'artwork', 'production', 'shade_cards', 'tooling'],
};

test('a landing_path the account cannot open never traps it in a redirect loop', () => {
  assert.notEqual(settle(designer), null, 'the designer login must reach some page');
});

test('the designer lands on a module it was actually granted', () => {
  const landed = firstAllowedPath(designer);
  const mod = moduleForPath(landed);
  assert.ok(canAccess(designer, mod), `landed on ${landed} (module ${mod}) without the grant`);
});

test('an unreachable landing_path falls back to a module the designer holds', () => {
  // The fallback is the first granted module in MODULES order — Tracking here.
  // It is not Planning, but it opens, which is the whole contract: never bounce.
  const landed = firstAllowedPath(designer);
  assert.equal(landed, '/track');
  assert.equal(settle(designer), '/track');
});

test('pointing the designer at Planning is honoured, because it holds Planning', () => {
  // This is how the account is meant to be configured: ganging and merging live
  // in Planning, so that is where the login should open.
  const onPlanning = { ...designer, landing_path: '/planning' };
  assert.equal(firstAllowedPath(onPlanning), '/planning');
  assert.equal(settle(onPlanning), '/planning');
});

test('a valid landing_path is still honoured exactly', () => {
  const plant = { role: 'admin', landing_path: '/orders', modules: null };
  assert.equal(firstAllowedPath(plant), '/orders');

  // A restricted account whose landing_path IS granted keeps it, even when it
  // is not the first module in MODULES order.
  const press = { role: 'production', landing_path: '/floor', modules: ['orders', 'floor'] };
  assert.equal(firstAllowedPath(press), '/floor');
});

test('an unrestricted login is unaffected', () => {
  const md = { role: 'admin', landing_path: '/', modules: null };
  assert.equal(firstAllowedPath(md), '/');
  assert.equal(settle(md), '/');
});

test('a login with no landing_path falls through to its first granted module', () => {
  const qc = { role: 'qc', landing_path: null, modules: ['inventory', 'shade_cards'] };
  assert.equal(firstAllowedPath(qc), '/inventory');
});

test('ganging, merging and planning all sit in modules the designer holds', () => {
  // Ganging and merging (combined runs) are driven from Planning; the gang is
  // then carried through Artwork and onto the Job Card. Print Planning is
  // deliberately NOT required — the designer never touches the press board.
  for (const key of ['planning', 'artwork', 'production']) {
    assert.ok(canAccess(designer, key), `designer must hold ${key}`);
  }
  assert.ok(!canAccess(designer, 'print_planning'), 'designer must NOT hold print_planning');
  assert.ok(!canAccess(designer, 'dashboard'), 'designer must NOT hold dashboard');
});
