// Saying a plate set's colour build in one chip instead of five.
//
// The PO register listed every plate as its own chip, so a nineteen-set order
// printed seventy-six of them to say "CMYK" nineteen times — and the one set
// that was actually different could not be picked out of the noise.
//
// This is presentation only. groupedComponents, the statuses and the components
// themselves are untouched; a detail view still names every plate, because where
// you are ticking plates off a delivery the roll-call IS the point.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inkSummary, inkSummaryByStatus, shortComponent, SHORT_COMPONENT, gangMemberNames }
  from '../../client/src/lib/plateInks.js';

const c = (component_type, component_label, extra = {}) =>
  ({ id: Math.random(), component_type, component_label, status: 'po_created', ...extra });

const CMYK = () => [c('cyan', 'Cyan'), c('magenta', 'Magenta'), c('yellow', 'Yellow'), c('black', 'Black')];

test('a full process set is ONE chip that says CMYK', () => {
  const parts = inkSummary(CMYK());
  assert.equal(parts.length, 1);
  assert.equal(parts[0].label, 'CMYK');
  // Nothing is lost — the roll-call moves to the tooltip.
  assert.equal(parts[0].title, 'Cyan · Magenta · Yellow · Black');
});

test('a partial process set names the letters it actually has', () => {
  // "CMYK" on a set with no Yellow would be a plain lie about what was ordered.
  const parts = inkSummary([c('cyan', 'Cyan'), c('magenta', 'Magenta')]);
  assert.equal(parts[0].label, 'CM');
  assert.equal(parts[0].title, 'Cyan · Magenta');
});

test('Black is K, never B', () => {
  // Taking the first letter of the label gives Black a 'B' under a CMYK heading.
  assert.equal(SHORT_COMPONENT.black, 'K');
  assert.equal(shortComponent({ component_type: 'black', component_label: 'Black' }), 'K');
  assert.equal(inkSummary([c('yellow', 'Yellow'), c('black', 'Black')])[0].label, 'YK');
});

test('the letters come out in press order, not row order', () => {
  const parts = inkSummary([c('black', 'Black'), c('cyan', 'Cyan'), c('yellow', 'Yellow'), c('magenta', 'Magenta')]);
  assert.equal(parts[0].label, 'CMYK');
});

test('spot colours are COUNTED, with the codes on hover', () => {
  // The codes are long, they repeat across sets, and they are one hover away.
  const parts = inkSummary([
    ...CMYK(),
    c('pantone', 'Pantone - Pantone 1', { pantone_code: 'Pantone 1' }),
    c('pantone', 'Pantone - Pantone 2', { pantone_code: 'Pantone 2' }),
  ]);
  assert.deepEqual(parts.map(p => p.label), ['CMYK', '2 Pantone']);
  assert.equal(parts[1].title, 'Pantone - Pantone 1 · Pantone - Pantone 2');
});

test('a spot-only set has no process chip at all', () => {
  const parts = inkSummary([
    c('pantone', 'Pantone - Pantone 1', { pantone_code: 'Pantone 1' }),
    c('pantone', 'Pantone - Pantone 2', { pantone_code: 'Pantone 2' }),
    c('pantone', 'Pantone - Pantone 3', { pantone_code: 'Pantone 3' }),
    c('pantone', 'Pantone - Pantone 4', { pantone_code: 'Pantone 4' }),
  ]);
  assert.deepEqual(parts.map(p => p.label), ['4 Pantone']);
});

test('collapsing four chips must not claim four states', () => {
  // The four chips were still saying one thing worth keeping: whether the plates
  // agree. A set half received cannot read as wholly received.
  const same = inkSummary(CMYK());
  assert.equal(same[0].status, 'po_created');
  const mixed = inkSummary([
    c('cyan', 'Cyan', { status: 'available' }), c('magenta', 'Magenta'),
    c('yellow', 'Yellow'), c('black', 'Black'),
  ]);
  assert.equal(mixed[0].status, 'mixed');
});

test('a cancelled plate is not part of the build', () => {
  // groupedComponents already drops them; the summary must inherit that rather
  // than counting a plate nobody is making.
  const parts = inkSummary([...CMYK(), c('pantone', 'Pantone - Old', { status: 'cancelled' })]);
  assert.deepEqual(parts.map(p => p.label), ['CMYK']);
});

test('an empty set summarises to nothing, not to an empty chip', () => {
  assert.deepEqual(inkSummary([]), []);
  assert.deepEqual(inkSummary(), []);
});

test('a gang row names the cartons on its sheet', () => {
  // The run number is exactly what does NOT answer "what is on it".
  assert.equal(
    gangMemberNames({ gang_members: [{ product_name: 'NIMOCED-5' }, { product_name: 'DAYO OD 1G' }] }),
    'NIMOCED-5 · DAYO OD 1G',
  );
  assert.equal(gangMemberNames({ gang_members: [] }), '');
  assert.equal(gangMemberNames({}), '', 'a non-gang line has no members and must not throw');
});

// ── The requirement register: the build once per STATE ──────────────────────
//
// A purchase order's plates are all in the same state, so one "CMYK" says it.
// A REQUIREMENT's are not — two colours may sit on the rack while the other two
// have to be bought — and which ones is the entire question that column exists
// to answer. Collapsing to a single chip there would hide it.

test('a set that is wholly one state is still ONE chip', () => {
  const parts = inkSummaryByStatus(CMYK());
  assert.equal(parts.length, 1);
  assert.equal(parts[0].label, 'CMYK');
  assert.equal(parts[0].status, 'po_created');
});

test('a SPLIT set says which colours are in which state', () => {
  // This is the case a plain collapse destroys: "CMYK · mixed" tells the buyer
  // nothing about what to buy.
  const parts = inkSummaryByStatus([
    c('cyan', 'Cyan', { status: 'verified_existing' }),
    c('magenta', 'Magenta', { status: 'verified_existing' }),
    c('yellow', 'Yellow', { status: 'pr_required' }),
    c('black', 'Black', { status: 'pr_required' }),
  ]);
  assert.deepEqual(parts.map(p => [p.status, p.label]), [
    ['verified_existing', 'CM'],
    ['pr_required', 'YK'],
  ]);
});

test('spots keep their own state alongside the process build', () => {
  const parts = inkSummaryByStatus([
    ...CMYK(),
    c('pantone', 'Pantone - 485C', { pantone_code: '485C', status: 'pr_required' }),
  ]);
  assert.deepEqual(parts.map(p => [p.status, p.label]), [
    ['po_created', 'CMYK'],
    ['pr_required', '1 Pantone'],
  ]);
});

test('one state holding both process and spots reads as one chip', () => {
  const parts = inkSummaryByStatus([
    ...CMYK(),
    c('pantone', 'Pantone - 485C', { pantone_code: '485C' }),
  ]);
  assert.deepEqual(parts.map(p => p.label), ['CMYK + 1 Pantone']);
});

test('the states come out in PRESS order, not map order', () => {
  // Two rows holding the same plates must not shuffle their chips between them.
  const parts = inkSummaryByStatus([
    c('black', 'Black', { status: 'pr_required' }),
    c('cyan', 'Cyan', { status: 'verified_existing' }),
    c('yellow', 'Yellow', { status: 'pr_required' }),
    c('magenta', 'Magenta', { status: 'verified_existing' }),
  ]);
  assert.deepEqual(parts.map(p => [p.status, p.label]), [
    ['verified_existing', 'CM'],
    ['pr_required', 'YK'],
  ]);
});

test('a cancelled plate is not in any state group', () => {
  const parts = inkSummaryByStatus([...CMYK(), c('pantone', 'Pantone - Old', { status: 'cancelled' })]);
  assert.deepEqual(parts.map(p => p.label), ['CMYK']);
});

test('an empty requirement summarises to nothing', () => {
  assert.deepEqual(inkSummaryByStatus([]), []);
  assert.deepEqual(inkSummaryByStatus(), []);
});
