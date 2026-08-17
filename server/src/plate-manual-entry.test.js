// Adding plates the plant already owns — by output number OR by product.
//
// The form asks for one identifier and reads the rest — product, customer,
// artwork revision, colour build — out of Product Master and Planning. Everything
// tested here protects that: the key resolving to the wrong thing, or to nothing
// quietly, is how a plate ends up on the rack filed against a carton no
// requirement will ever match.
//
// The output number is a KEY, never a gate. Whatever the plant knows on the way
// through goes back to the master under the Sync Master? fork — filling a blank
// is suggested, overwriting an existing number never is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MANUAL_PLATE_RACKS, manualPlateEntry, manualPlateRack, suggestedPlateQuantities,
  FRESH_PLATES_RACK, USED_PLATES_RACK, expandPlateQuantities,
} from './plates.js';
import { masterOutputSync } from '../../client/src/lib/plateRack.js';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

const CMYK = [
  { component_type: 'cyan', component_label: 'Cyan', qty: 1 },
  { component_type: 'magenta', component_label: 'Magenta', qty: 1 },
  { component_type: 'yellow', component_label: 'Yellow', qty: 1 },
  { component_type: 'black', component_label: 'Black', qty: 1 },
];

test('the two racks say what they mean, and a used plate carries a run', () => {
  assert.deepEqual(MANUAL_PLATE_RACKS.map(row => row.key), ['fresh', 'used']);
  const fresh = manualPlateRack('fresh');
  const used = manualPlateRack('used');
  assert.equal(fresh.rack, FRESH_PLATES_RACK);
  assert.equal(used.rack, USED_PLATES_RACK);
  // The load-bearing pair. A Used plate recorded with zero runs is indistinguishable
  // from a fresh one everywhere wear is asked about — the Average wear KPI, and the
  // "used N times" line a verifier reads before agreeing to print with it again.
  assert.equal(fresh.use_count, 0, 'a fresh plate has never printed');
  assert.equal(used.use_count, 1, 'a used plate has printed at least once');
  // A plate that has never printed cannot already be Fair.
  assert.deepEqual(fresh.conditions, ['Good']);
  assert.deepEqual(used.conditions, ['Good', 'Fair']);
});

test('a fresh plate cannot be entered as anything but Good', () => {
  assert.throws(() => manualPlateEntry({ rack: 'fresh', condition: 'Fair', components: CMYK }),
    /cannot be recorded as Fair/);
  assert.equal(manualPlateEntry({ rack: 'used', condition: 'Fair', components: CMYK }).condition, 'Fair');
});

test('the rack must be chosen, and an unknown one is refused rather than defaulted', () => {
  assert.throws(() => manualPlateEntry({ components: CMYK }), /Fresh or Used/);
  assert.throws(() => manualPlateEntry({ rack: 'scrap', components: CMYK }), /Fresh or Used/);
});

test('artwork version falls back through the party code to the output number', () => {
  // NOT NULL in the table, but the real reason is plateArtworkKey: a Plate PR finds
  // a rack plate by this string. Filed as 'Unversioned', these plates are invisible
  // to every requirement that names a revision — so the plant buys plates it owns.
  assert.equal(manualPlateEntry({ rack: 'fresh', artwork_version: 'R2', components: CMYK }).artwork_version, 'R2');
  assert.equal(manualPlateEntry({ rack: 'fresh', party_artwork_code: 'PCS-W026/R1', components: CMYK }).artwork_version, 'PCS-W026/R1');
  assert.equal(manualPlateEntry({ rack: 'fresh', output_number: '18604', components: CMYK }).artwork_version, '18604');
  assert.equal(manualPlateEntry({ rack: 'fresh', components: CMYK }).artwork_version, 'Unversioned');
});

test('one row per physical plate, and a quantity above one repeats the colour', () => {
  const entry = manualPlateEntry({
    rack: 'used',
    components: [{ component_type: 'cyan', component_label: 'Cyan', qty: 3 }],
  });
  assert.equal(entry.plates.length, 3);
  assert.deepEqual([...new Set(entry.plates.map(row => row.component_label))], ['Cyan']);
  assert.equal(entry.rack_location, USED_PLATES_RACK);
  assert.equal(entry.use_count, 1);
});

test('an empty tick list is refused in the vocabulary of THIS form', () => {
  // Same expansion rule as a Plate PR, different sentence: nobody adding stock to
  // a rack is filling in a requirement, and being told so is a dead end.
  assert.throws(() => manualPlateEntry({ rack: 'fresh', components: [] }),
    /Tick at least one colour/);
  assert.throws(() => manualPlateEntry({ rack: 'fresh', components: CMYK.map(row => ({ ...row, qty: 0 })) }),
    /Tick at least one colour/);
  // The PR keeps its own wording.
  assert.throws(() => expandPlateQuantities([]), /Plate Requirement needs at least one plate/);
});

test('a Pantone plate keeps its identity and cannot be nameless', () => {
  const entry = manualPlateEntry({
    rack: 'fresh',
    components: [{ component_type: 'pantone', component_label: 'Pantone - 871 C', pantone_code: '871 C', qty: 2 }],
  });
  assert.equal(entry.plates.length, 2);
  assert.equal(entry.plates[0].pantone_code, '871 C');
  assert.equal(entry.plates[0].component_label, 'Pantone - 871 C');
  assert.throws(() => manualPlateEntry({
    rack: 'fresh', components: [{ component_type: 'pantone', qty: 1 }],
  }), /needs its Pantone number or name/);
});

test('the suggested colours are the product master\'s own build, folded to quantities', () => {
  // Same answer plateComponentsFromSpec gives the Plate PR. If the rack entry
  // disagreed, the shelf would hold a different set of plates than a requirement
  // for the same carton would have bought.
  const cmyk = suggestedPlateQuantities({ colour_type: 'CMYK', colors: 4 });
  assert.deepEqual(cmyk.map(row => row.component_label), ['Cyan', 'Magenta', 'Yellow', 'Black']);
  assert.deepEqual(cmyk.map(row => row.qty), [1, 1, 1, 1]);

  const mixed = suggestedPlateQuantities({
    colour_type: 'CMYK + Pantone', colors: 6, cmyk_colours: 4, pantone_colours: 2,
    pantone_codes: '871 C, 485 C',
  });
  assert.deepEqual(mixed.map(row => row.component_label),
    ['Cyan', 'Magenta', 'Yellow', 'Black', 'Pantone - 871 C', 'Pantone - 485 C']);
  assert.equal(mixed.reduce((sum, row) => sum + row.qty, 0), 6);

  // A product naming the SAME spot twice is one colour needing two plates, not two
  // rows the operator has to notice are identical.
  const twice = suggestedPlateQuantities({
    colour_type: 'Pantone', colors: 2, pantone_colours: 2, pantone_codes: '871 C, 871 C',
  });
  assert.equal(twice.length, 1);
  assert.equal(twice[0].qty, 2);
});

test('the output number is a KEY, never a gate — a product resolves the same context', () => {
  // Anik, 2026-08-17: "output becomes a hard blocker, sometimes we just want to
  // enter the product name also". Two doors, one context builder — a second
  // shape per door is how the product path would quietly stop suggesting
  // colours, or start filing plates under a size the number path got right.
  const routes = read('server/src/routes/plates.js');
  const start = routes.indexOf("r.get('/plates/entry-context'");
  const body = routes.slice(start, routes.indexOf("r.get('/plates/entry-products'", start));
  assert.ok(body.length > 500, 'the entry-context route was not found — this test is asserting nothing');
  assert.match(body, /req\.query\.output_number/, 'the number opens one door');
  assert.match(body, /req\.query\.product_id/, 'the product opens the other');
  // Both doors return plateEntryMatch(), so neither can drift from the other.
  const byProduct = body.slice(body.indexOf('if (productId)'));
  assert.match(byProduct, /plateEntryMatch\(row\)/, 'the product path must build the same match');
  assert.match(body, /matches: matches\.map\(row => plateEntryMatch\(row, wanted\)\)/,
    'and so must the number path');

  const screen = read('client/src/components/PlatesLifecycle.jsx');
  assert.match(screen, /By output number/, 'the form has to offer both doors');
  assert.match(screen, /By product/);
  assert.match(screen, /api\.get\('\/plates\/entry-products'\)/, 'and a product list to search');
});

test('a master with no output number is offered the one being typed', () => {
  // Sync Master? — the plant's existing fork (db.js, PUT /orders/:id). Filling a
  // blank and overwriting a number are different acts and default differently.
  assert.deepEqual(masterOutputSync({ typed: '18604', master: '' }),
    { state: 'missing', offer: true, suggested: true, from: '', to: '18604' });
  assert.deepEqual(masterOutputSync({ typed: '18999', master: '18604' }),
    { state: 'conflict', offer: true, suggested: false, from: '18604', to: '18999' });
  // Nothing to say when they agree, or when no number is known at all.
  assert.equal(masterOutputSync({ typed: '18604', master: '18604' }).offer, false);
  assert.equal(masterOutputSync({ typed: '', master: '18604' }).offer, false);
  assert.equal(masterOutputSync({ typed: '  ', master: '' }).offer, false);
  // Whitespace is not a difference — it would otherwise offer to "change" 18604 to 18604.
  assert.equal(masterOutputSync({ typed: ' 18604 ', master: '18604' }).offer, false);

  // A conflict must NEVER be suggested. A typo in a warehouse form would rename
  // the number every future job for that carton prints under.
  assert.equal(masterOutputSync({ typed: '1', master: '18604' }).suggested, false,
    'overwriting an existing master number is a decision, never a default');
});

test('the route re-decides the sync rather than trusting the form', () => {
  const routes = read('server/src/routes/plates.js');
  const start = routes.indexOf("r.post('/plates/warehouse/assets'");
  const body = routes.slice(start, routes.indexOf("r.get('/plates/warehouse'", start));
  assert.ok(body.length > 500, 'the add-plates route was not found — this test is asserting nothing');
  assert.match(body, /masterOutputSync\(\{ typed: entry\.output_number, master: product\.output_number \}\)/,
    'the state is recomputed server-side; a stale form must not overwrite a master that moved');
  assert.match(body, /req\.body\.update_master && sync\.offer/,
    'the flag alone is not enough — the rule has to agree there is something to sync');
  // The master row is locked with the plates, or two entries race on it.
  assert.match(body, /FOR UPDATE OF p/, 'the product row must be locked before it is written');
  assert.match(body, /'master_update'/, 'a master write is audited, same action as the Artwork form');
  // Only output_number. party_item_code and party_artwork_code are the customer's.
  assert.doesNotMatch(body, /UPDATE products SET (party_item_code|party_artwork_code)/,
    "the customer's own codes are never written from here");
});

test('the lookup reads the master, Planning\'s override AND names a gang run', () => {
  const routes = read('server/src/routes/plates.js');
  const lookup = routes.slice(routes.indexOf("r.get('/plates/entry-context'"));
  const body = lookup.slice(0, lookup.indexOf("r.get('/plates/entry-products'"));
  assert.ok(body.length > 500, 'the lookup route body was not found — this test is asserting nothing');
  assert.match(body, /p\.output_number/, 'Product Master is where the number usually lives');
  assert.match(body, /spec_override->>'output_number'/,
    "some numbers exist ONLY on Planning's override and would otherwise never resolve");
  assert.match(body, /FROM gang_runs/,
    'a gang number has to be reported, not returned as an empty result the operator reads as a typo');
  assert.match(body, /kind='gang'/, 'only a mixed sheet is a gang; a merge run carries the master\'s number');
  // The refusal is the point: a gang sheet has no single product to file plates against.
  assert.doesNotMatch(body, /INSERT INTO plate_assets/,
    'the lookup must not write anything, least of all for a gang');
});

test('the gang run is read by the column that exists', () => {
  // Shipped as `run_number` and 500'd on the first real call: gang_runs has no
  // such column. Every OTHER plate query reaches gang_runs through a join alias,
  // so nothing in the suite named the column directly and only an end-to-end run
  // exposed it. The identifier is a fact about the schema, so pin it there.
  const schema = read('server/src/db.js');
  const ddl = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS gang_runs'));
  const columns = ddl.slice(0, ddl.indexOf(');'));
  assert.ok(columns.length > 100, 'the gang_runs DDL was not found — this test is asserting nothing');
  assert.match(columns, /gang_number/, 'gang_number is what the run is called');
  assert.doesNotMatch(columns, /run_number/, 'there is no run_number to select');

  const routes = read('server/src/routes/plates.js');
  const lookup = routes.slice(routes.indexOf("r.get('/plates/entry-context'"));
  const body = lookup.slice(0, lookup.indexOf("r.get('/plates/entry-products'"));
  assert.match(body, /SELECT gang_number/, 'the lookup must select the column that exists');
  // The screen prints what the route returns; a mismatch here is a blank run name
  // in the one message explaining why a gang number was refused.
  assert.match(read('client/src/components/PlatesLifecycle.jsx'), /row\.gang_number/,
    'and the screen must read the same field back');
});

test('adding plates refuses a product with no customer instead of hiding them', () => {
  const routes = read('server/src/routes/plates.js');
  const start = routes.indexOf("r.post('/plates/warehouse/assets'");
  const body = routes.slice(start, routes.indexOf("r.get('/plates/warehouse'", start));
  assert.ok(body.length > 500, 'the add-plates route body was not found — this test is asserting nothing');
  // GET /plates/warehouse INNER JOINs customers. Without this guard the insert
  // succeeds, the toast says "4 plates added", and the rack is unchanged.
  assert.match(body, /customer_id/, 'the customer must be checked before the plates are written');
  assert.match(body, /has no customer on its master/, 'and the refusal has to say why');
  // No GRN, no vendor, no rate — this stock was not bought through the system, and
  // source_grn_id IS NULL is what tells a hand-entered plate from a received one.
  assert.match(body, /source_grn_id[\s\S]{0,400}NULL/,
    'a hand-entered plate has no source GRN');
  // 'received' is in the live CHECK list. A new action string would need a migration.
  assert.match(body, /'received'/, 'the movement action must be one the database already allows');
});

test('retyping the output number drops the product it had resolved to', () => {
  // Found by driving the real form: type 18604, Find, then edit the box to 18777
  // and the panel still named AZITHRO-500 while the footer offered to add its six
  // plates. The submit sends match.output_number, so the plates would have been
  // filed under the number the operator had just replaced — their own correction
  // is what made the screen lie. Clearing beats disabling: that identity panel is
  // the thing being read to decide this is the right job.
  const screen = read('client/src/components/PlatesLifecycle.jsx');
  const start = screen.indexOf('function AddPlatesModal');
  const modal = screen.slice(start, screen.indexOf('function ReasonActionModal', start));
  assert.ok(modal.length > 1000, 'AddPlatesModal was not found — this test is asserting nothing');
  assert.match(modal, /const retype = value =>/, 'editing the number needs its own handler');
  assert.match(modal, /setMatch\(null\); setForm\(null\); setLookup\(null\);/,
    'a changed number must drop the match, the form AND the lookup panel');
  assert.match(modal, /onChange=\{event => retype\(event\.target\.value\)\}/,
    'and the field has to use it — setNumber alone is the bug');
});

test('the Add Plates button is wired to the modal, not just present', () => {
  const screen = read('client/src/components/PlatesLifecycle.jsx');
  assert.match(screen, /onClick=\{\(\) => setAddingPlates\(true\)\}/,
    'a button that does not open anything is the dead click this module has shipped before');
  assert.match(screen, /\{addingPlates && <AddPlatesModal/, 'and the modal has to be rendered');
  assert.match(screen, /api\.post\('\/plates\/warehouse\/assets'/,
    'the modal must talk to the route that writes the plates');
  assert.match(screen, /api\.get\(`\/plates\/entry-context\?/,
    'and to the lookup that fills the form');
  // Adding stock is a planner action, exactly as Retire and Issue are.
  assert.match(screen, /canManage\(\) && <Button size="sm" variant="secondary" className="ml-auto"/,
    'the button is gated on canManage, like every other rack action');
});
