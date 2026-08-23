import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  plateRequestPlan, plateComponentsFromSpec, expandPlateQuantities,
  DRIP_OFF_PLATE_SIZE, DRIPOFF_LABEL, isDripOff,
} from './plates.js';

// ── ONE JOB, TWO PLATE PRs ────────────────────────────────────────────────
//
// A drip-off carton needs ink plates AND a drip-off mask, and they are bought,
// approved and consumed on different clocks: the inks go to the press and come
// back to the rack, the mask goes to the coating line and is destroyed there.
// Carrying both on one requirement meant one approval, one PO line grouping and
// one status for two different lives.
//
// So the fire splits: the inks raise their own PR and the mask raises its own,
// each carrying the same job card, product and artwork so the legacy is intact
// on both.

const DRIP_SPEC = {
  product_name: 'Amoxy 500', colour_type: 'CMYK', cmyk_colours: 4,
  coating: 'Drip Off', party_artwork_code: 'PCS-W026/R1', plate_size: '600 x 730',
};
const PLAIN_SPEC = { ...DRIP_SPEC, coating: 'Aqueous Varnish' };

test('a plain carton raises ONE plate PR — nothing about the split leaks into it', () => {
  const plan = plateRequestPlan(PLAIN_SPEC);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].kind, 'ink');
  assert.equal(plan[0].components.length, 4);
  assert.ok(!plan[0].components.some(isDripOff));
});

test('a drip-off carton raises TWO PRs — inks first, the mask second', () => {
  const plan = plateRequestPlan(DRIP_SPEC);
  assert.deepEqual(plan.map(entry => entry.kind), ['ink', 'dripoff']);
  const [ink, drip] = plan;
  assert.equal(ink.components.length, 4, 'CMYK only');
  assert.ok(!ink.components.some(isDripOff), 'the ink PR must not carry the mask');
  assert.equal(drip.components.length, 1);
  assert.equal(drip.components[0].component_label, DRIPOFF_LABEL);
});

test('each PR numbers its own plates from 1 — sequence_no is UNIQUE per request', () => {
  const plan = plateRequestPlan(DRIP_SPEC);
  for (const entry of plan) {
    assert.deepEqual(
      entry.components.map(row => row.sequence_no),
      entry.components.map((_, index) => index + 1),
      `${entry.kind} components must renumber from 1`);
  }
});

test('the drip PR is born at 560 x 670 — its own size, not the ink set\'s', () => {
  const [, drip] = plateRequestPlan(DRIP_SPEC);
  assert.equal(drip.plate_size, DRIP_OFF_PLATE_SIZE);
  const [ink] = plateRequestPlan(DRIP_SPEC);
  assert.equal(ink.plate_size, '600 x 730', 'the ink PR keeps the spec size');
});

test('a drip carton with no colours on its master still raises the mask PR alone', () => {
  // Nothing to print but the varnish pattern: no ink PR at all rather than an
  // empty one, which would sit in the queue forever with no plate to buy.
  const plan = plateRequestPlan({ coating: 'Drip Off UV', colour_type: '', colors: 0 });
  assert.deepEqual(plan.map(entry => entry.kind), ['dripoff']);
});

test('the plan splits a HAND-PICKED selection the same way it splits a derived one', () => {
  // The fire dialog now asks which colours to raise. Whatever comes back is one
  // list of plates; the split into two PRs is the server's rule, not the form's,
  // so a client can never put a mask on an ink PR.
  const picked = expandPlateQuantities([
    { component_type: 'cyan', qty: 1 },
    { component_type: 'black', qty: 2 },
    { component_type: 'dripoff', qty: 1 },
  ]);
  const plan = plateRequestPlan(DRIP_SPEC, picked);
  assert.deepEqual(plan.map(entry => entry.kind), ['ink', 'dripoff']);
  assert.equal(plan[0].components.length, 3, 'Cyan + two Black');
  assert.equal(plan[1].components.length, 1);
});

test('a selection with no mask raises no drip PR, even on a drip-off product', () => {
  // The operator decides. A coating master that says Drip Off is a default, not
  // a compulsion — unticking the mask must not have it reappear.
  const picked = expandPlateQuantities([{ component_type: 'cyan', qty: 1 }]);
  const plan = plateRequestPlan(DRIP_SPEC, picked);
  assert.deepEqual(plan.map(entry => entry.kind), ['ink']);
});

// ── The wiring, pinned in the source ──────────────────────────────────────
const sliceOf = (source, anchor, length = 4000) => {
  const at = source.indexOf(anchor);
  assert.ok(at >= 0, `anchor "${anchor}" is missing`);
  const body = source.slice(at, at + length);
  assert.ok(body.length > 200, `slice at "${anchor}" proves nothing`);
  return body;
};
const toolingRoute = readFileSync(new URL('./routes/tooling.js', import.meta.url), 'utf8');
const platesRoute = readFileSync(new URL('./routes/plates.js', import.meta.url), 'utf8');

test('the fire route raises one PR PER PLAN ENTRY and stamps which kind it is', () => {
  const fire = sliceOf(toolingRoute, "r.post('/job-cards/:id/tooling-requirements'", 5000);
  assert.match(fire, /plateRequestPlan/, 'the fire route no longer plans the split');
  assert.match(fire, /plate_kind/, 'a PR must record whether it is the ink set or the mask');
});

test('the dedupe is PER KIND — refiring must not skip the mask because the inks exist', () => {
  // The idempotency check keys on (job card, family, product). With two plate
  // PRs on one job that matched the ink PR and silently dropped the drip one.
  const fire = sliceOf(toolingRoute, "r.post('/job-cards/:id/tooling-requirements'", 5000);
  assert.match(fire, /plate_kind'\s*,\s*'ink'\)\s*=|plate_kind',''\)=|COALESCE\(specification->>'plate_kind'/,
    'the existing-request lookup does not discriminate by plate kind');
});

test('the queue can tell an ink PR from a mask PR', () => {
  assert.match(platesRoute, /plate_kind/,
    'requirementRows ships no plate_kind, so no chip can filter on it');
});

test('the fire PREVIEW offers the colours, so the dialog can ask before it fires', () => {
  const preview = sliceOf(toolingRoute, "r.get('/job-cards/:id/tooling-preview'", 3000);
  assert.match(preview, /plate_plan/, 'the preview ships no colour plan for the dialog to show');
});

test('the schema ALLOWS two plate PRs on one job — the old UNIQUE forbade it', () => {
  // Found only by firing for real: UNIQUE (job_card_id, product_id, family)
  // made the second INSERT die on
  // tooling_requests_job_card_id_product_id_family_key. No unit test could see
  // it — nothing here touches a database — so the rule is pinned in the
  // migration text instead.
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const file = readdirSync(dir).find(name => /tooling_request_plate_kind_unique/.test(name));
  assert.ok(file, 'no migration relaxes the one-tooling-request-per-job-and-family rule');
  const sql = readFileSync(new URL(file, dir), 'utf8');
  assert.match(sql, /DROP CONSTRAINT IF EXISTS tooling_requests_job_card_id_product_id_family_key/,
    'the blocking constraint is not dropped');
  assert.match(sql, /plate_kind/, 'the replacement must discriminate by plate kind');
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS/,
    'the replacement must still be UNIQUE — two ink PRs on one job is still wrong');
  const db = readFileSync(new URL('./db.js', import.meta.url), 'utf8');
  assert.ok(db.includes(file), `db.js init() does not replay ${file} — a fresh database still refuses the split`);
});

test('the replacement keeps every NON-plate family exactly as unique as before', () => {
  // A die or a block stores no plate_kind, so the COALESCE resolves to 'ink'
  // for all of them and (job, product, family) is unchanged. If this default
  // ever became NULL the index would stop constraining them at all, silently.
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const file = readdirSync(dir).find(name => /tooling_request_plate_kind_unique/.test(name));
  const sql = readFileSync(new URL(file, dir), 'utf8');
  assert.match(sql, /COALESCE\(specification->>'plate_kind',\s*'ink'\)/,
    "the kind expression must COALESCE to a non-NULL default, or NULLs stop the index constraining non-plate families");
});
