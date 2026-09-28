// The Fluence module's tabs, ticked per login in Masters → Users
// (users.fluence_tabs, NULL = every tab). A tab left unticked is not shown AND
// what only that tab reads or changes is refused by the API — the same rule on
// the screen and on the server, like the module ticks themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FLUENCE_TABS, FLUENCE_TAB_KEYS, KIT_EDIT_TABS, fluenceTabsOf, canOpenFluenceTab, canEditFluenceKits,
} from '../../client/src/modules.js';
import { accessOf, gateDecision, tabsForRequest, mayUseTab, tabRefusal, refusalCode } from './access.js';

const root = new URL('../../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');

test('the tabs are the Fluence page\'s chips, in its order, and every Kit Studio view is one of them', () => {
  assert.deepEqual(FLUENCE_TAB_KEYS, ['overview', 'kits', 'build', 'drafts', 'inner', 'products', 'customer', 'changes', 'settings']);
  assert.deepEqual([...new Set(FLUENCE_TABS.map(t => t.group))], ['Kits', 'Masters', 'Records']);
  for (const t of FLUENCE_TABS) assert.ok(t.label && t.hint, t.key);
  const html = read('client/public/kit-studio-app/index.html');
  const views = JSON.parse(html.match(/const VIEWS=(\[[^\]]*\]);/)[1].replace(/'/g, '"'));
  const tabViews = FLUENCE_TABS.filter(t => t.view).map(t => t.view);
  assert.deepEqual([...tabViews].sort(), [...views].sort(), 'one tab per studio view');
  assert.deepEqual(KIT_EDIT_TABS, ['kits', 'products', 'customer']);
});

test('which tabs a login opens: all unless ticked otherwise; an admin always all', () => {
  assert.deepEqual(fluenceTabsOf({ role: 'planner', fluence_tabs: null }), FLUENCE_TAB_KEYS);
  assert.deepEqual(fluenceTabsOf({ role: 'planner' }), FLUENCE_TAB_KEYS, 'no column yet = every tab');
  assert.deepEqual(fluenceTabsOf({ role: 'admin', fluence_tabs: ['changes'] }), FLUENCE_TAB_KEYS);
  assert.deepEqual(fluenceTabsOf({ role: 'planner', fluence_tabs: ['changes', 'kits', 'no-such-tab'] }), ['kits', 'changes'], 'page order, unknown keys dropped');
  assert.deepEqual(fluenceTabsOf({ role: 'planner', fluence_tabs: [] }), []);
  assert.deepEqual(fluenceTabsOf(null), []);
  assert.ok(canOpenFluenceTab({ role: 'viewer', fluence_tabs: ['overview'] }, 'overview'));
  assert.ok(!canOpenFluenceTab({ role: 'viewer', fluence_tabs: ['overview'] }, 'kits'));
});

test('who may edit a kit\'s contents and prescription: a Planning role with a tab a kit is edited from', () => {
  assert.ok(canEditFluenceKits({ role: 'planner', modules: ['fluence'], fluence_tabs: null }));
  for (const t of KIT_EDIT_TABS) assert.ok(canEditFluenceKits({ role: 'planner', fluence_tabs: [t] }), t);
  assert.ok(!canEditFluenceKits({ role: 'planner', fluence_tabs: ['overview', 'changes', 'inner', 'settings'] }));
  assert.ok(!canEditFluenceKits({ role: 'viewer', fluence_tabs: null }), 'the role still decides view or edit');
  assert.ok(canEditFluenceKits({ role: 'admin', fluence_tabs: [] }));
});

test('the server refuses what only an unticked tab does — a customer\'s login', () => {
  const a = accessOf({ role: 'planner', modules: ['fluence'], fluence_tabs: ['overview', 'kits'], email: 'fluence01' });
  assert.deepEqual(a.tabs, ['overview', 'kits']);
  const ok = [
    ['GET', '/kit-studio/state'], ['PUT', '/kit-studio/kits/k12'], ['DELETE', '/kit-studio/kits/k12'],
    ['PUT', '/fluence/kits/3/kit'], ['PUT', '/fluence/products/9/kit'], ['PUT', '/fluence/products/9/prescription'],
    // A kit's dossier and history, and the inner products a kit is built from, are no single tab's.
    ['GET', '/fluence/kits/3/dossier'], ['GET', '/fluence/dossiers'], ['GET', '/fluence/kits/3/revisions'], ['GET', '/fluence/inner-products'],
  ];
  for (const [m, p] of ok) assert.equal(gateDecision(p, a, m), 'ok', `${m} ${p}`);
  const refused = [
    ['GET', '/fluence/changes', 'Change log'], ['GET', '/fluence/kits', 'Customer list'], ['GET', '/fluence/products', 'Fluence products'],
    ['POST', '/fluence/inner-products', 'Inner products'], ['PUT', '/fluence/inner-products/4', 'Inner products'],
    ['PUT', '/kit-studio/products/p7', 'Inner products'], ['PUT', '/kit-studio/settings/main', 'Export & settings'],
    ['PUT', '/kit-studio/drafts/d1', 'New kit'], ['DELETE', '/kit-studio/drafts/d1', 'Drafts'],
  ];
  for (const [m, p, tab] of refused) {
    const v = gateDecision(p, a, m);
    assert.ok(v !== 'ok' && v.includes(`“${tab}”`), `${m} ${p}: ${v}`);
  }
  // Nothing of the plant, whatever its tabs.
  assert.match(gateDecision('/orders', a, 'GET'), /Fluence module only/);
  // A login with no Studio tab ticked has no studio at all.
  const logOnly = accessOf({ role: 'planner', modules: ['fluence'], fluence_tabs: ['changes'], email: 'fluence02' });
  assert.match(gateDecision('/kit-studio/state', logOnly, 'GET'), /“Overview”.*none of them is ticked/);
  assert.match(gateDecision('/fluence/kits/3/kit', logOnly, 'PUT'), /Kits.*Fluence products.*Customer list/);
  assert.equal(gateDecision('/fluence/changes', logOnly, 'GET'), 'ok');
});

test('staff: the tabs narrow the Fluence module, never the Fluence doors in the plant\'s own modules', () => {
  const s = accessOf({ role: 'planner', modules: ['planning', 'production', 'fluence'], fluence_tabs: ['overview'], email: 'designer' });
  for (const [m, p] of [['GET', '/orders'], ['GET', '/fluence/dossiers'], ['GET', '/fluence/resolve'], ['GET', '/fluence/job-cards/products'], ['GET', '/fluence/scope']]) {
    assert.equal(gateDecision(p, s, m), 'ok', `${m} ${p}`);
  }
  assert.notEqual(gateDecision('/fluence/changes', s, 'GET'), 'ok');
  // Untouched logins keep every tab: nothing changes for anyone until a tab is unticked.
  const all = accessOf({ role: 'planner', modules: null, fluence_tabs: null, email: 'x' });
  for (const [m, p] of [['GET', '/fluence/changes'], ['PUT', '/kit-studio/settings/main'], ['DELETE', '/kit-studio/drafts/d1'], ['POST', '/fluence/kits/1/link']]) {
    assert.equal(gateDecision(p, all, m), 'ok', `${m} ${p}`);
  }
  assert.ok(mayUseTab(undefined, 'changes'), 'no access record = the gate did not run; the route answers as before');
});

test('every write of the Fluence module and Kit Studio belongs to a tab', () => {
  const sample = p => p.replace(/:[a-zA-Z]+/g, 'x1');
  // A download's record belongs to whichever tab offered the file — the list it
  // exports was already served to that tab. It writes the record, not the master.
  const NO_TAB = new Set(['POST /fluence/downloads']);
  for (const file of ['server/src/routes/kitstudio.js', 'server/src/routes/fluence.js']) {
    const src = read(file);
    for (const [, m, p] of src.matchAll(/r\.(put|post|delete)\('([^']+)'/g)) {
      if (NO_TAB.has(`${m.toUpperCase()} ${p}`)) continue;
      assert.ok(tabsForRequest(m.toUpperCase(), sample(p)), `${m.toUpperCase()} ${p} (${file}) is no tab's`);
    }
  }
  assert.equal(tabsForRequest('POST', '/fluence/downloads'), null);
  // The listings a tab alone shows are that tab's.
  assert.deepEqual(tabsForRequest('GET', '/fluence/changes'), ['changes']);
  assert.deepEqual(tabsForRequest('GET', '/fluence/kits'), ['customer']);
  assert.equal(tabsForRequest('GET', '/fluence/kits/3'), null);
});

test('a refusal names the tab, and Kit Studio shows its own', () => {
  assert.equal(tabRefusal(['changes']), 'The Fluence tab “Change log” is not ticked for this login.');
  assert.equal(tabRefusal(['build', 'drafts']), 'This needs the Fluence tab “New kit” or “Drafts” — neither is ticked for this login.');
  assert.match(tabRefusal(KIT_EDIT_TABS), /“Kits”, “Fluence products” or “Customer list” — none of them is ticked/);
  assert.equal(refusalCode('/kit-studio/drafts/d1', tabRefusal(['drafts'])), 'KIT_STUDIO_REFUSED');
  assert.equal(refusalCode('/fluence/changes', tabRefusal(['changes'])), 'FLUENCE_TAB');
  assert.equal(refusalCode('/orders', 'This login is for the Fluence module only.'), 'FLUENCE_ONLY');
  const access = read('server/src/access.js');
  assert.match(access, /gateDecision\(req\.path, access, req\.method\)/);
  assert.match(access, /code: refusalCode\(req\.path, verdict\)/);
  assert.match(access, /'SELECT id, name, email, role, active, modules, fluence_tabs FROM users WHERE id = \$1'/);
});

test('Kit Studio: drafts only with New kit or Drafts, a new kit is New kit\'s, a change Kits\'', () => {
  const studio = read('server/src/routes/kitstudio.js');
  assert.match(studio, /drafts: seesDrafts\(req\) \? state\.drafts : \[\]/);
  assert.match(studio, /const seesDrafts = req => mayUseTab\(req\.access, 'build'\) \|\| mayUseTab\(req\.access, 'drafts'\);/);
  assert.match(studio, /const tab = fk \? 'kits' : 'build';\s*if \(!mayUseTab\(req\.access, tab\)\) throw fail\(403, tabRefusal\(\[tab\]\)\);/);
  assert.match(studio, /views: FLUENCE_TABS\.filter\(t => t\.view && tab\(t\.key\)\)\.map\(t => t\.view\)/);
  // The studio page keeps to those views and edits only where it may.
  const html = read('client/public/kit-studio-app/index.html');
  assert.match(html, /busy=true; try\{ holdView\(\); renderInner\(\); \}/);
  assert.match(html, /show\(v\)\{ if\(!VIEWS\.includes\(v\)\|\|!viewOk\(v\)/);
  assert.match(html, /const ro=!can\(D\.t==='prod'\?'inner':'kits'\);/);
  assert.match(html, /const ro=!can\('build'\), dr=/);
  assert.match(html, /const st=S\.settings, ro=!can\('settings'\);/);
  assert.match(html, /const f=S\.df, ro=!can\('drafts'\);/);
  assert.match(html, /\.no-drafts \[data-goto="drafts"\]/);
  const bridge = read('client/public/kit-studio-app/erp-bridge.js');
  assert.match(bridge, /views: function \(\) \{ return Array\.isArray\(me\.views\)/);
  assert.match(bridge, /canArea: function \(area\) \{ return !me\.can \|\| !!me\.can\[area\]; \}/);
  // A tab's refusal refuses that one thing — the studio does not turn view-only over it.
  assert.match(bridge, /if \(err && err\.status === 403 && !err\.refused\) e\.code = 'invalid_argument';/);
  assert.match(read('client/src/components/fluence/KitStudioFrame.jsx'), /status: e\.status, refused: true/);
});

test('the ticks are kept per login: the column, its migration, and Masters → Users', () => {
  assert.match(read('server/src/db.js'), /ALTER TABLE users ADD COLUMN IF NOT EXISTS fluence_tabs JSONB;/);
  assert.match(read('supabase/migrations/20260928120000_users_fluence_tabs.sql'), /ALTER TABLE users ADD COLUMN IF NOT EXISTS fluence_tabs JSONB;/);
  const auth = read('server/src/auth.js');
  assert.match(auth, /fluence_tabs: u\.fluence_tabs \?\? null,/, 'the app shell gets them');
  assert.ok((auth.match(/modules, sections, fluence_tabs, machine_ids/g) || []).length >= 4, '/auth/me, the list, create and update');
  assert.match(auth, /if \('fluence_tabs' in req\.body\)/);
  assert.match(auth, /FLUENCE_TAB_KEYS\.filter\(k => m\.map\(String\)\.includes\(k\)\)/, 'only known tab keys are stored');
  const masters = read('client/src/pages/Masters.jsx');
  assert.match(masters, /body\.fluence_tabs = Array\.isArray\(editing\.fluence_tabs\) \? editing\.fluence_tabs : null;/);
  assert.match(masters, /data-fluence-tabs="1"/);
  assert.match(masters, /fluence_tabs: t\.fluence_tabs \?\? null/, 'a preset resets the tabs too');
});

test('the Fluence page shows only the ticked tabs, and edits only where it may', () => {
  const page = read('client/src/pages/Fluence.jsx');
  assert.match(page, /const allowed = useMemo\(\(\) => fluenceTabsOf\(user\), \[user\]\);/);
  assert.match(page, /const tab = allowed\.includes\(params\.get\('tab'\)\) \? params\.get\('tab'\) : \(allowed\[0\] \?\? null\);/);
  assert.match(page, /FLUENCE_TABS\.filter\(t => t\.group === g && has\(t\.key\)\)/);
  assert.match(page, /\{fresh && studioTabs\.length > 0 && \(/);
  assert.match(page, /needsProducts \? api\.get\('\/fluence\/products'\)/);
  // Ticks changed since sign-in: the page asks with the login as the server has
  // it now, never with the saved copy (which would be refused).
  assert.match(page, /currentUser\(\)\.then\(u => live && setUser\(u\)\)/);
  assert.match(page, /useEffect\(\(\) => \{ if \(fresh\) load\(\); \}, \[fresh, load\]\);/);
  const api = read('client/src/api.js');
  assert.match(api, /export function currentUser\(\) \{/);
  assert.match(read('client/src/components/AppLayout.jsx'), /currentUser\(\)\.then\(setUser\)/, 'the shell and the page share one ask');
  const drawer = read('client/src/components/fluence/FluenceDrawer.jsx');
  assert.match(drawer, /const canEdit = canEditServer && canEditFluenceKits\(user\);/);
  assert.match(read('client/src/components/fluence/KitRxEditor.jsx'), /const keepsInner = canOpenFluenceTab\(auth\.user, 'inner'\);/);
  assert.match(read('client/src/components/fluence/InnerProductForm.jsx'), /const editable = canPlan\(auth\.user\) && canOpenFluenceTab\(auth\.user, 'inner'\);/);
  const route = read('server/src/routes/fluence.js');
  assert.match(route, /const editsKits = req => canEdit\(req\.user\) && KIT_EDIT_TABS\.some\(t => mayUseTab\(req\.access, t\)\);/);
  assert.equal((route.match(/can_edit: editsKits\(req\)/g) || []).length, 3);
});
