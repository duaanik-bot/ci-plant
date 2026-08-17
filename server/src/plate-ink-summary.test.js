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
import { inkSummary, shortComponent, SHORT_COMPONENT, gangMemberNames }
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
