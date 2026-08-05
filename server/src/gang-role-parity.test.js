import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { requireRole } from './auth.js';

// Every gang mutation on the server is requireRole('planner') — see
// routes/gangs.js. The Planning page must offer the gang controls to exactly
// the roles that guard admits, no more and no less.
//
// More, and a qc/production/dispatch/viewer login holding the `planning` module
// clicks Gang Together and eats a bare 403 toast with nothing to do about it.
// Less, and a planner who is allowed to gang cannot find the button.

const ROLES = ['admin', 'planner', 'production', 'qc', 'dispatch', 'viewer'];

function serverAllows(role) {
  let ok = false;
  requireRole('planner')({ user: { role, id: 1 } },
    { status: () => ({ json: () => { ok = false; } }) },
    () => { ok = true; });
  return ok;
}

const PLANNING = join(dirname(fileURLToPath(import.meta.url)), '../../client/src/pages/Planning.jsx');
const src = readFileSync(PLANNING, 'utf8');

// The single client-side predicate the page gates gang work on.
const decl = src.match(/const canPlanRole = (\[[^\]]*\])\.includes\(auth\.user\?\.role\)/);

test('Planning still gates on one canPlanRole predicate', () => {
  assert.ok(decl, 'canPlanRole declaration not found — the gate was renamed or removed');
});

test('the client gang gate admits exactly the roles the server guard admits', () => {
  const clientRoles = JSON.parse(decl[1].replace(/'/g, '"'));
  for (const role of ROLES) {
    assert.equal(clientRoles.includes(role), serverAllows(role),
      `${role}: client ${clientRoles.includes(role) ? 'shows' : 'hides'} the gang controls but the server ${serverAllows(role) ? 'allows' : 'refuses'} them`);
  }
});

test('every gang control carries the role gate', () => {
  // Each entry: a control that mutates a gang, and the guard that must sit on
  // it. Matched against the line, so a future edit that drops the gate fails
  // here rather than in production.
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

test('the gang-create modal has no ungated way in', () => {
  // pickSuggestion and the bulk buttons are the only openers; both now sit
  // behind canPlanRole. Count the call sites so a new one has to be reviewed.
  const openers = [...src.matchAll(/setGangSel\((?!null|g =>)/g)].length;
  assert.equal(openers, 4,
    `setGangSel now has ${openers} opening call sites — a new one was added; confirm it is behind canPlanRole, then update this count`);
});
