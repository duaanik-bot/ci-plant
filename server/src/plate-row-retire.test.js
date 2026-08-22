// Retiring the plate a requirement is HOLDING, from the requirement row.
//
// The order of the two calls is not a style choice, it is the whole feature:
// /plates/assets/retire runs pickAvailableRackPlates, which throws 409 on any
// plate whose status is not 'available' — and a plate a requirement holds is
// 'reserved'. Retiring straight from the row would refuse every single time and
// read as a button that does nothing, which is the failure this codebase has
// already shipped once (see the structured-409 silent button).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickAvailableRackPlates } from './plates.js';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const page = () => read('client/src/components/PlatesLifecycle.jsx');

// The body of one client handler.
function handler(source, name) {
  const at = source.indexOf(`const ${name} = async (`);
  if (at < 0) return null;
  const next = source.indexOf('\n  const ', at + 1);
  return source.slice(at, next < 0 ? source.length : next);
}

test('a plate a requirement is holding cannot be retired directly', () => {
  // The refusal this feature is built around. If this ever stops throwing, the
  // release-first step below is dead weight and should be reconsidered — but
  // until then, skipping it is a button that 409s on every click.
  assert.throws(
    () => pickAvailableRackPlates({
      rackAssets: [{ id: 5, asset_number: 'CI-PL-A-0412', component_label: 'Cyan', status: 'reserved' }],
      assetIds: [5],
    }),
    /not available — it is reserved/,
  );
  // The same plate, once released, is retirable.
  assert.deepEqual(
    pickAvailableRackPlates({
      rackAssets: [{ id: 5, asset_number: 'CI-PL-A-0412', status: 'available' }],
      assetIds: [5],
    }).map(row => row.id),
    [5],
  );
});

test('Retire releases the plate BEFORE it scraps it', () => {
  const body = handler(page(), 'retireHeldPlate');
  assert.ok(body, 'retireHeldPlate() is missing — the requirement row has no way to scrap a dead plate');
  const release = body.indexOf('release-rack');
  const retire = body.indexOf('/plates/assets/retire');
  assert.ok(release > 0, 'the plate must be returned to the rack first or the retire call 409s');
  assert.ok(retire > 0, 'the plate must then actually be retired');
  assert.ok(release < retire,
    'retiring before releasing refuses every time: a held plate is reserved, and '
    + 'pickAvailableRackPlates only takes available ones');
});

test('a one-click retire still writes a real reason', () => {
  // The endpoint no longer writes junk when nothing is sent — it reads the reason
  // through optionalText() and leaves remarks NULL (see plate-retire-reason.test.js;
  // it used to stamp the literal text "undefined"). This call site still has to say
  // something true regardless: it is ONE CLICK with no input field anywhere, so a
  // reason it does not send is a reason nobody will ever be able to supply — and
  // that remark is the only surviving record of why a physical plate was scrapped.
  const body = handler(page(), 'retireHeldPlate');
  assert.match(body, /reason:/, 'retire must send a reason');
  assert.doesNotMatch(body, /reason:\s*(undefined|''|""|null)/,
    'an empty reason is written to the plate as the string "undefined"');
});

test('a failed retire says the plate is back on the rack, not that nothing happened', () => {
  // The two calls are not atomic. If the second fails the plate IS released —
  // a valid, visible state — and the message has to say so, or the planner
  // reads "could not retire" and assumes the rack is untouched.
  const body = handler(page(), 'retireHeldPlate');
  assert.match(body, /released/, 'the handler must track whether the release half succeeded');
  assert.match(body, /Warehouse tab/,
    'a half-completed retire must name where the plate now is and how to finish the job');
});

test('the row names the plant’s decision, not the mechanism', () => {
  const source = page();
  // "Undo" sat where Raise PR is now. The call behind it sets the colour to
  // pr_required — it IS the decision to buy a new plate, and naming it Undo hid
  // that behind a word that means "I mis-clicked".
  assert.match(source, /onClick=\{\(\)=>releaseRack\(detail,lifecycle\.component_ids\)\}>Raise PR<\/Button>/,
    'the release-rack control must read Raise PR');
  assert.match(source, /Retire plate<\/Button>/, 'the row must offer Retire plate');
  assert.match(source, /retireHeldPlate\(detail,lifecycle\.component_ids,lifecycle\.asset_ids\)/,
    'Retire acts on the ASSET the colour holds, so the row must pass asset_ids');
});

test('a grouped colour carries the rack plates it is holding', () => {
  // Retire needs asset ids; groupedComponents only collected component ids, so
  // the row had nothing to retire. The grouping itself lives in lib/ — `.jsx`
  // cannot be run under node --test, and this is exactly the kind of rule that
  // should be pinned rather than eyeballed.
  const inks = read('client/src/lib/plateInks.js');
  assert.match(inks, /asset_ids: \[\]/, 'groupedComponents must collect asset_ids');
  assert.match(inks, /if \(component\.matched_asset_id\) group\.asset_ids\.push/,
    'the held plate is prc.matched_asset_id — the PROPOSED one is a candidate, not a plate the job has');
});
