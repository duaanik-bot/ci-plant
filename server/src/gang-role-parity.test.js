import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { requireRole, PLANNING_ROLES } from './auth.js';

// Planning, Artwork and Job Cards — including every gang / combined-run action
// — are open to the designer, the planner and the plant, exactly as to the MD.
// The server spreads PLANNING_ROLES into each guard; the client mirrors it in
// modules.js. The two lists must stay identical.
//
// Drift in one direction hands a user a button the server refuses — the bare
// "Your role (production) cannot perform this action" toast. Drift the other
// way hides work from someone allowed to do it.

const ALL_ROLES = ['admin', 'planner', 'production', 'qc', 'dispatch', 'viewer'];
const SRC = dirname(fileURLToPath(import.meta.url));
const read = p => readFileSync(join(SRC, p), 'utf8');

function serverAllows(role) {
  let ok = false;
  requireRole(...PLANNING_ROLES)({ user: { role, id: 1 } },
    { status: () => ({ json: () => { ok = false; } }) },
    () => { ok = true; });
  return ok;
}

test('the plant floor role can do planning-side work', () => {
  // The whole point of the change: a production login gangs, plans, does
  // artwork and edits a job card. If this ever goes red, the floor is locked
  // out of ganging again.
  assert.ok(serverAllows('production'), 'production must pass the planning guards');
  assert.ok(serverAllows('planner'), 'planner (the designer) must pass');
  assert.ok(serverAllows('admin'), 'admin (MD / Planning / Plant) must pass');
});

test('planning-side work is not open to everyone', () => {
  // Read-only and downstream roles stay out — this is a widened door, not a
  // removed one.
  for (const role of ['qc', 'dispatch', 'viewer']) {
    assert.ok(!serverAllows(role), `${role} must NOT pass the planning guards`);
  }
});

test('the client mirror matches the server list exactly', () => {
  const client = read('../../client/src/modules.js');
  const m = client.match(/export const PLANNING_ROLES = (\[[^\]]*\])/);
  assert.ok(m, 'PLANNING_ROLES not found in client/src/modules.js');
  const clientRoles = JSON.parse(m[1].replace(/'/g, '"'));

  for (const role of ALL_ROLES) {
    assert.equal(clientRoles.includes(role), serverAllows(role),
      `${role}: client ${clientRoles.includes(role) ? 'shows' : 'hides'} planning work but the server ${serverAllows(role) ? 'allows' : 'refuses'} it`);
  }
});

test('every planning-side guard spreads the one constant', () => {
  for (const [file, expected] of [
    ['routes/gangs.js', 1],          // canPlan — every gang action
    ['routes/orders.js', 2],         // canPlanWork + canArtwork
    ['routes/production.js', 1],     // canPlan — job cards + press board
  ]) {
    const src = read(file);
    assert.equal((src.match(/requireRole\(\.\.\.PLANNING_ROLES/g) || []).length, expected,
      `${file}: expected ${expected} guard(s) spreading PLANNING_ROLES`);
  }
  for (const file of ['routes/gangs.js', 'routes/production.js']) {
    assert.ok(!/requireRole\('planner'\)/.test(read(file)),
      `${file}: hand-rolled requireRole('planner') — use PLANNING_ROLES`);
  }
  const wf = read('routes/workflow.js');
  assert.ok(!/requireAny\(req, \['planner'\]\)/.test(wf),
    "workflow.js: still has a hand-rolled requireAny(req, ['planner'])");
  assert.equal((wf.match(/requireAny\(req, PLANNING_ROLES\)/g) || []).length, 5,
    'workflow.js: expected 5 planning-side actions guarded by PLANNING_ROLES');
});

test('the SALES-ORDER lifecycle stays off the widened guard', () => {
  // orders.js keeps exactly one planner-only guard. Deleting, cancelling or
  // restatusing a customer's order is not planning work, and the floor logins
  // are role=production — widening this would hand every operator
  // DELETE /orders/:id. The split is the whole reason canPlanWork exists.
  const src = read('routes/orders.js');
  assert.equal((src.match(/const canPlan = requireRole\('planner'\);/g) || []).length, 1,
    'orders.js must keep exactly one planner-only canPlan for order lifecycle');

  for (const route of [
    "r.post('/orders', canPlan,",
    "r.put('/orders/:id', canPlan,",
    "r.delete('/orders/:id', canPlan,",
    "r.post('/orders/:id/cancel', canPlan,",
    "r.post('/order-lines/:id/cancel', canPlan,",
    "r.post('/orders/:id/status', canPlan,",
  ]) {
    assert.ok(src.includes(route), `order lifecycle route drifted onto a wider guard: ${route}`);
  }

  // And the planning work that SHOULD be open to the plant.
  for (const route of [
    "r.post('/order-lines/:id/plan', canPlanWork,",
    "r.patch('/planning/:id/set-type', canPlanWork,",
    "r.put('/order-lines/:id/spec', canPlanWork,",
  ]) {
    assert.ok(src.includes(route), `planning-work route not on canPlanWork: ${route}`);
  }
});

test('the client pages gate on the shared predicate, not a local array', () => {
  for (const [page, gates] of [
    ['Planning.jsx', ['const canPlanRole = canPlan(auth.user);']],
    ['Artwork.jsx', ['const canEditPlanning = canPlan(auth.user);', 'const canPush = canPlan(auth.user);']],
    ['Production.jsx', ['const canEditJobCard = canPlan(auth.user);']],
  ]) {
    const src = read(`../../client/src/pages/${page}`);
    for (const g of gates) assert.ok(src.includes(g), `${page}: expected ${JSON.stringify(g)}`);
    assert.ok(!/\['admin', 'planner'\]\.includes\(auth\.user\?\.role\)/.test(src),
      `${page}: still has a hand-rolled ['admin','planner'] check`);
  }
});

test('every gang control still carries the role gate', () => {
  const src = read('../../client/src/pages/Planning.jsx');
  for (const [what, needle] of [
    ['bulk build / tag buttons', 'if (!canPlanRole) return null;'],
    ['dissolve the run', '{canPlanRole && <Button variant="ghost" className="!text-red-500" onClick={gangDissolve}>'],
    ['remove a member', '{canPlanRole && <button type="button" title="Remove from gang"'],
    ['consolidation suggestion chips', '{canPlanRole && !hideSuggest &&'],
    ['reverse a planned run', '{canPlanRole && gangView?.members?.some('],
  ]) {
    assert.ok(src.includes(needle), `${what}: role gate missing (looked for ${JSON.stringify(needle)})`);
  }
});
