// Naming a gang member after it has left planning.
//
// The per-member identity panel (artwork code, output / set no., die, block)
// posts to PATCH /gang-runs/:id/lines/:lineId — the same route qty and ups use
// — so every rename went through assertPlanningOnlyGangEdit, a guard written
// for BREAKING a run. CI-MRG-0002 answered a die number with "BRUTAFLAM-CGII
// is already in production. Gangs can be broken only in Planning."
//
// These cases are the split that fixes it: a body carrying only names is
// exempt, and a body carrying anything the plan depends on is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isIdentityOnlyEdit, IDENTITY_SPEC } from './routes/gangs.js';

test('THE FIX: the four fields the identity panel posts are names, and pass', () => {
  // Exactly what saveSpec() sends in Planning.jsx — no qty, no ups, no spec
  // field the cut math or the press reads.
  assert.equal(isIdentityOnlyEdit({
    spec: {
      party_artwork_code: 'NEB5TCJQJQ1770600', output_number: 'OP-1042',
      die_number: 'D-105', block_number: 'B-22',
    },
  }), true);
});

test('one name on its own is still a name', () => {
  for (const f of IDENTITY_SPEC) {
    assert.equal(isIdentityOnlyEdit({ spec: { [f]: 'X-1' } }), true, `${f} should pass alone`);
  }
});

test('a quantity is not a name — the planning-only rule still applies', () => {
  assert.equal(isIdentityOnlyEdit({ qty: 5000 }), false);
  assert.equal(isIdentityOnlyEdit({ qty: 5000, spec: { die_number: 'D-105' } }), false);
});

test('ups is not a name, on either spelling', () => {
  // The route accepts ups both as a legacy top-level field and inside spec.
  assert.equal(isIdentityOnlyEdit({ ups: 6 }), false);
  assert.equal(isIdentityOnlyEdit({ spec: { ups: 6 } }), false);
});

test('geometry and process are physics — every one of them refuses', () => {
  for (const f of ['child_l', 'child_w', 'colors', 'coating', 'emboss', 'leafing',
    'leafing_colour', 'colour_type', 'pasting_type']) {
    assert.equal(isIdentityOnlyEdit({ spec: { [f]: 2 } }), false, `${f} must stay guarded`);
  }
});

test('one physics field alongside four names still refuses — the mix decides, not the majority', () => {
  assert.equal(isIdentityOnlyEdit({
    spec: {
      party_artwork_code: 'A', output_number: 'B', die_number: 'C', block_number: 'D',
      coating: 'matt',
    },
  }), false);
});

test('an empty qty or a blank field writes nothing, so it is not a plan edit', () => {
  // The handler's own `provided` filter drops '' / null / undefined before it
  // writes anything. A body that reaches the route with nothing writable must
  // not be refused by a guard protecting a change that is not being made.
  assert.equal(isIdentityOnlyEdit({ qty: '' }), true);
  assert.equal(isIdentityOnlyEdit({ qty: null }), true);
  assert.equal(isIdentityOnlyEdit({ spec: { coating: '', colors: null } }), true);
  assert.equal(isIdentityOnlyEdit({}), true);
  assert.equal(isIdentityOnlyEdit(), true);
});

test('ups is judged by presence, not by value — an explicit 0 is still a plan edit', () => {
  // ups gets folded into spec by the route before the `provided` filter runs,
  // so `undefined` is the only spelling that means "not touched". 0 is a value
  // the route rejects with a 400; it must not slip past as a rename first.
  assert.equal(isIdentityOnlyEdit({ ups: 0 }), false);
  assert.equal(isIdentityOnlyEdit({ ups: '' }), false);
});
