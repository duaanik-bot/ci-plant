// A customer's own login — Masters → Users, only the Fluence module ticked.
// It opens the Fluence module and nothing of Colour Impressions, on the screen
// AND on the server; it may change its kits, each change signed with its login
// ID and told to CI management; product masters stay behind the Masters tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODULES, FLUENCE_KEYS, isFluenceOnly, canAccess, canAccessSection, firstAllowedPath } from '../../client/src/modules.js';
import { accessOf, gateDecision, dossierFor, signedName } from './access.js';

const root = new URL('../../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');

const customer = { role: 'planner', modules: ['fluence'] };
const oldTick = { role: 'planner', modules: ['kit_studio'] };
const floorOnly = { role: 'production', modules: ['floor'] };
const plantPlanner = { role: 'planner', modules: ['planning', 'artwork', 'masters'] };
const everyone = { role: 'planner', modules: null };

test('a login with only Fluence ticked is a customer\'s: the Fluence module and nothing else', () => {
  assert.ok(isFluenceOnly(customer));
  assert.ok(isFluenceOnly(oldTick), 'Kit Studio\'s tick from before the merge is Fluence too');
  assert.ok(isFluenceOnly({ role: 'viewer', modules: [] }), 'no ticks at all opens nothing of the plant');
  for (const u of [floorOnly, plantPlanner, everyone, { role: 'admin', modules: ['fluence'] }]) assert.ok(!isFluenceOnly(u), JSON.stringify(u));
  assert.ok(canAccess(customer, 'fluence'));
  for (const m of MODULES.filter(x => !FLUENCE_KEYS.includes(x.key))) {
    assert.ok(!canAccess(customer, m.key), `a customer's login opens ${m.key}`);
  }
  // Not even the Cutting board a Planning role otherwise reaches without a tick.
  assert.ok(canAccess({ role: 'planner', modules: ['orders'] }, 'floor'), 'staff keep the shared Cutting board');
  assert.ok(!canAccess(customer, 'floor'));
  assert.ok(!canAccessSection(customer, 'cutting'));
  assert.ok(!canAccess({ role: 'viewer', modules: [] }, 'fluence'), 'an empty list opens nothing');
  assert.equal(firstAllowedPath(customer), '/fluence', 'it lands on the Fluence module');
  assert.equal(firstAllowedPath({ ...customer, landing_path: '/orders' }), '/fluence', 'a landing path is never a grant');
});

test('the server gate: a customer reaches the Fluence module\'s routes and none of the plant\'s', () => {
  const c = accessOf({ ...customer, email: 'fluence01' });
  assert.deepEqual([c.outside, c.fluence, c.masters, c.login], [true, true, false, 'fluence01']);
  for (const path of ['/fluence/products', '/fluence/kits/12/dossier', '/fluence/products/9/kit', '/fluence/kits/3/kit',
    '/fluence/inner-products', '/fluence/changes', '/fluence/scope', '/kit-studio/state', '/kit-studio/kits/k024']) {
    assert.equal(gateDecision(path, c), 'ok', path);
  }
  for (const path of ['/orders', '/customers', '/products', '/products/picker', '/dashboard', '/notifications',
    '/approvals/pending', '/chat/conversations', '/push/key', '/floor/counts', '/users', '/materials', '/invoices',
    '/tooling/requirements/summary', '/avs', '/fluence/resolve', '/fluencex']) {
    assert.match(gateDecision(path, c), /Fluence module only/, path);
  }
  // Staff are answered as before — a Fluence door in every plant module reads the master.
  const floor = accessOf({ ...floorOnly, email: 'op1' });
  assert.equal(floor.outside, false);
  for (const path of ['/orders', '/floor/counts', '/fluence/dossiers', '/fluence/resolve']) assert.equal(gateDecision(path, floor), 'ok', path);
  // Kit Studio answers a login that can open the Fluence module.
  assert.match(gateDecision('/kit-studio/state', floor), /not ticked/);
  for (const u of [plantPlanner, everyone]) assert.equal(gateDecision('/orders', accessOf({ ...u, email: 'x' })), 'ok');
  assert.equal(gateDecision('/kit-studio/state', accessOf({ ...everyone, email: 'x' })), 'ok');
  assert.equal(accessOf({ ...plantPlanner, email: 'x' }).masters, true);
});

test('the gate stands on every route after sign-in, and a switched-off login is refused on a live token', () => {
  const app = read('server/src/app.js');
  const auth = app.indexOf("app.use('/api', requireAuth)");
  const gate = app.indexOf("app.use('/api', moduleGate)");
  const firstRouter = app.indexOf("app.use('/api', usersRouter)");
  assert.ok(auth > 0 && gate > auth && gate < firstRouter, 'the gate runs after sign-in and before every router');
  const access = read('server/src/access.js');
  assert.match(access, /if \(!u \|\| !\+u\.active\) return res\.status\(401\)/);
  assert.match(access, /withoutLedger\(\(\) => one\(/, 'who may ask is not part of any cached answer');
  // A changed tick applies at once.
  const users = read('server/src/auth.js');
  assert.match(users, /forgetAccess\(\+req\.params\.id\)/);
  assert.match(users, /forgetAccess\(id\)/);
});

test('a customer\'s login signs every change with its ID', () => {
  assert.equal(signedName('Fluence Pharma', 'fluence01'), 'Fluence Pharma (ID fluence01)');
  const access = read('server/src/access.js');
  assert.match(access, /if \(access\.outside\) \{\s*req\.user\.name = signedName\(u\.name, u\.email\);/);
});

test('the manufacturing spec is Colour Impressions\' own: a login without the Masters tick does not get it', () => {
  const dossier = { product: { id: 1, code: 'FP-240', name: 'SKIN FACT TIMELESS', party_item_code: '20251240', mrp: 4105, size: '155X90X122',
    board_name: 'Met Saffire', gsm: 350, ups: 1, die_number: 'D-12', child_l: 19, child_w: 20, coating: 'Drip Off', output_number: 'O-7',
    shade_card_number: 'CI0307', internal_carton_code: 'IC1', pasting_type: 'Lock bottom' }, kit: { id: 5 }, components: [] };
  const seen = dossierFor(dossier, { masters: false });
  assert.deepEqual(Object.keys(seen.product).sort(), ['code', 'id', 'mrp', 'name', 'party_item_code', 'size']);
  assert.equal(dossier.product.board_name, 'Met Saffire', 'the original is not touched');
  assert.equal(dossierFor(dossier, { masters: true }), dossier);
  assert.equal(dossierFor({ product: null, kit: { id: 9 } }, { masters: false }).product, null);
  const route = read('server/src/routes/fluence.js');
  assert.match(route, /dossiers: dossiers\.map\(d => dossierFor\(d, req\.access\)\)/);
  assert.match(route, /dossier: dossierFor\(dossier, req\.access\) \}\);/);
  // Which carton a customer kit is printed as is a product-master decision.
  assert.match(route, /r\.post\('\/fluence\/kits\/:id\/link', canEditMaster, needsMasters,/);
  assert.match(route, /r\.post\('\/fluence\/kits\/:id\/unlink', canEditMaster, needsMasters,/);
});

test('CI management hears of every change a customer\'s login makes, in the same transaction', () => {
  const route = read('server/src/routes/fluence.js');
  const tell = route.slice(route.indexOf('export async function tellManagement'), route.indexOf('// ── Scope'));
  assert.match(tell, /if \(!user\?\.outside\) return;/, 'staff changes stay quiet');
  assert.match(tell, /notificationRecipients\(users, 'is_management', user\.id\)/);
  assert.match(tell, /kind: 'fluence_change'/);
  assert.match(tell, /Signed: \$\{user\.name\}/);
  // Every write in the module tells — the Fluence master's and Kit Studio's.
  const writes = (src, re) => [...src.matchAll(re)].length;
  assert.ok(writes(route, /await tellManagement\(/g) >= 5, 'kit save, prescription, kit list, inner product add and change');
  const studio = read('server/src/routes/kitstudio.js');
  assert.ok(writes(studio, /await tellManagement\(req\.user,/g) >= 7, 'kit add, change, delete; inner product; draft save, delete; clearances');
  const cats = read('server/src/notify-categories.js');
  assert.match(cats, /fluence_change: 'alerts'/);
});

test('the plant is never told to a customer\'s login, and it joins no plant chat', () => {
  const helpers = read('server/src/helpers.js');
  const notify = helpers.slice(helpers.indexOf('export async function notify('), helpers.indexOf('deferPushToUsers(ids'));
  assert.match(notify, /\.filter\(u => !isFluenceOnly\(u\)\)/);
  const auth = read('server/src/auth.js');
  assert.match(auth, /if \(!isFluenceOnly\(u\)\) \{\s*await q\(`\s*INSERT INTO conversation_members/);
});

test('the shell of a customer\'s login asks the plant for nothing', () => {
  const layout = read('client/src/components/AppLayout.jsx');
  assert.match(layout, /const outside = isFluenceOnly\(user\);/);
  assert.match(layout, /const shellActions = outside \? null : <><ChatDock \/><NotificationBell \/><\/>;/);
  assert.equal((layout.match(/actions=\{shellActions\}/g) || []).length, 3, 'phone, tablet and desktop shells');
  assert.match(layout, /useFloorTotal\(tier !== 'desktop' && !outside\)/);
  // One Fluence module in the rail — no second Kit Studio entry.
  assert.equal((layout.match(/module: 'fluence'/g) || []).length, 1);
  assert.doesNotMatch(layout, /module: 'kit_studio'/);
});
