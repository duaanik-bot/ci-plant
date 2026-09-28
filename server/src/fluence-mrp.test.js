// Two rules for a customer's own login in the Fluence module:
//   1. a kit on the list keeps the size Colour Impressions gave it — no size
//      recommendation, size comparison or dies in hand on screen, and its panel
//      size and carton arrangement are read-only (and refused by the server);
//   2. its MRPs stay its to change — and every MRP change, by anyone, is on
//      record old → new; a customer's is flagged until Colour Impressions
//      management acknowledges it, and management is told at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sizeChanges } from './kit-studio.js';
import { kitItemMrpChanges, mrpLine, mrpValue, sameMrp, } from '../../client/src/lib/fluence.js';
import { FLUENCE_TAB_KEYS } from '../../client/src/modules.js';
import { accessOf, gateDecision, tabsForRequest } from './access.js';

const root = new URL('../../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');

// ── 1. The kit's size ─────────────────────────────────────────────────────────

const KIT = { L: 142, W: 122, H: 108, sizeStatus: 'CONFIRMED', sizeSource: 'Die in hand',
  layout: { contents: { L: 138, W: 118, H: 102 }, rows: [[{ pid: 'p1', o: 'edge', rot: false }]] }, remarks: 'x', status: 'Active' };

test('a save changes the size when the panel size, its status, its source or the arrangement moves', () => {
  assert.deepEqual(sizeChanges(KIT, { ...KIT, remarks: 'new', status: 'Inactive', family: 'Hair Fact' }), [], 'the rest of the kit is the customer\'s');
  assert.deepEqual(sizeChanges(KIT, { ...KIT, L: '142', layout: { rows: [[{ rot: false, o: 'edge', pid: 'p1' }]], contents: { H: 102, W: 118, L: 138 } } }), [],
    'the same size spelt differently, the same arrangement in another key order');
  assert.deepEqual(sizeChanges(KIT, { ...KIT, W: 120 }), ['the panel size']);
  assert.deepEqual(sizeChanges(KIT, { ...KIT, sizeStatus: 'PROPOSED' }), ['the size status']);
  assert.deepEqual(sizeChanges(KIT, { ...KIT, sizeSource: 'mine' }), ['where the size came from']);
  assert.deepEqual(sizeChanges(KIT, { ...KIT, layout: { ...KIT.layout, rows: [[{ pid: 'p1', o: 'flat', rot: false }]] } }), ['the carton arrangement']);
  assert.deepEqual(sizeChanges({ sizeStatus: 'MISSING' }, { L: '', W: null, sizeStatus: 'nonsense' }), [], 'nothing on file, nothing sent');
});

test('the server refuses a customer\'s save that moves a kit\'s size — before anything is written', () => {
  const route = read('server/src/routes/kitstudio.js');
  const put = route.slice(route.indexOf("r.put('/kit-studio/kits/:id'"), route.indexOf("r.post('/kit-studio/kits/:id/erp-size'"));
  assert.match(put, /const shown = req\.user\?\.outside \? await composeOne\('kits', id\) : null;\s*const outcome = await tx\(/, 'what it was shown, read outside the transaction');
  const check = put.indexOf('const moved = sizeChanges(shown?.data, req.body?.doc);');
  assert.ok(check > 0 && check < put.indexOf('let created = null;'), 'refused before any write');
  assert.match(put, /if \(fk && req\.user\?\.outside\) \{/, 'a kit on the list, from a customer\'s login; a new kit is New kit\'s');
  // What the studio is told.
  assert.match(route, /size_tools: !outside,/);
  assert.match(route, /kit_size: edit && tab\('kits'\) && !outside,/);
});

test('the studio shows a customer\'s login the kit\'s size, not the size engine, and keeps it read-only', () => {
  const html = read('client/public/kit-studio-app/index.html');
  assert.match(html, /const canCtx = c => c==='d' \? can\('kits'\)&&can\('kit_size'\) : can\('build'\);/, 'size picks and dragging in a kit need kit_size');
  assert.match(html, /const sized=can\('kit_size'\), tools=sizeTools\(\), sro=ro\|\|!sized;/);
  for (const f of ['dL', 'dW', 'dH']) assert.match(html, new RegExp(`id="${f}" data-d="\\w" value="\\$\\{esc\\(d\\.\\w\\?\\?''\\)\\}" \\$\\{sro\\?'disabled':''\\}`), `${f} read-only`);
  assert.match(html, /id="dSS" data-d="sizeStatus" \$\{sro\?'disabled':''\}/);
  assert.match(html, /\$\{tools\?recCard\(r,\{useBtn:true,disabled:sro,ctx:'d'/, 'no recommended panel size, top sizes or dies in hand');
  assert.match(html, /\$\{tools\?sizeTable\(r,'d',hasSize\(d\)\?d:null\):''\}/, 'no size comparison');
  assert.match(html, /spaceBlock\(\(d\.items\|\|\[\]\)\.filter\(i=>i\.pid\),d,r,tools\)/, 'no tightest-box advice');
  assert.match(html, /'Carton orientation · top view', 'd', sro\):''\}/, 'the arrangement shows, read-only');
  assert.match(html, /if\(D\.layEdit&&can\('kit_size'\)\)\{/, 'a save from such a login sends the arrangement back as it was');
  assert.match(html, /const noRec=ctx==='d'&&!sizeArg&&!sizeTools\(\);/, 'its kit report never stands a recommended size in');
  assert.match(html, /data-size-locked>The panel size and the carton arrangement are set by Colour Impressions\. MRPs, contents and the prescription are yours to change\./);
  const bridge = read('client/public/kit-studio-app/erp-bridge.js');
  assert.match(bridge, /sizeTools: function \(\) \{ return me\.size_tools !== false; \}/);
});

// ── 2. The MRP trail ───────────────────────────────────────────────────────────

test('one spelling of "the same MRP": to the paisa, blank and absent alike', () => {
  assert.equal(mrpValue('221.00'), 221);
  assert.equal(mrpValue('126.255'), 126.26);
  assert.equal(mrpValue(''), null);
  assert.ok(sameMrp(null, ''));
  assert.ok(sameMrp('200.00', 200));
  assert.ok(!sameMrp(200, 200.01));
});

test('the kit items whose MRP moved — not an item that joined or left the kit', () => {
  const before = [{ inner_product_id: 1, name: 'F-CAL D3', mrp_in_kit: '200.00' }, { inner_product_id: 2, name: 'F-NOURISH', mrp_in_kit: null },
    { inner_product_id: 3, name: 'F-IMMUSURGE', mrp_in_kit: 150 }, { inner_product_id: 5, name: 'LEFT', mrp_in_kit: 9 }];
  const after = [{ inner_product_id: 1, name: 'F-CAL D3', mrp_in_kit: 221 }, { inner_product_id: 2, name: 'F-NOURISH', mrp_in_kit: '99.50' },
    { inner_product_id: 3, name: 'F-IMMUSURGE', mrp_in_kit: '150.00' }, { inner_product_id: 4, name: 'JOINED', mrp_in_kit: 7 }];
  const changes = kitItemMrpChanges(before, after, { kitId: 12, kitName: 'NEW - M4' });
  assert.deepEqual(changes.map(c => [c.innerProductId, c.oldMrp, c.newMrp]), [[1, 200, 221], [2, null, 99.5]]);
  assert.ok(changes.every(c => c.subject === 'kit_item' && c.kitId === 12 && c.kitName === 'NEW - M4'));
  assert.equal(mrpLine(changes[0]), 'F-CAL D3 in NEW - M4: ₹200 → ₹221');
  assert.equal(mrpLine(changes[1]), 'F-NOURISH in NEW - M4: no MRP → ₹99.5');
  assert.equal(mrpLine({ subject: 'inner_product', itemName: 'F-ACT-SURGE', oldMrp: 126.26, newMrp: 130 }), 'F-ACT-SURGE: ₹126.26 → ₹130');
});

test('every place an MRP is written records it, in the same transaction', () => {
  const route = read('server/src/routes/fluence.js');
  const rec = route.slice(route.indexOf('export async function recordMrpChanges'), route.indexOf('// The same notice for a file'));
  assert.match(rec, /const real = \(changes \|\| \[\]\)\.filter\(c => !sameMrp\(c\.oldMrp, c\.newMrp\)\);/);
  assert.match(rec, /INSERT INTO fluence_mrp_changes/);
  assert.match(rec, /user\.outside \? 1 : 0/);
  assert.match(rec, /if \(user\.outside\) \{[\s\S]*kind: 'fluence_mrp',[\s\S]*link: '\/fluence\?tab=mrp',/, 'a customer\'s change: management told');
  assert.match(route, /await recordMrpChanges\(kitItemMrpChanges\(beforeComps, after, \{ kitId: kit\.id, kitName: label \}\), user, from, qc\);/, 'the one-table editor');
  assert.match(route, /await recordMrpChanges\(kitItemMrpChanges\(before, after, \{ kitId: kit\.id, kitName: `\$\{product\.code\} \$\{product\.name\}` \}\), req\.user, from, qc\);/, 'the old kit-list editor');
  assert.match(route, /oldMrp: null, newMrp: created\.standard_mrp \}\]/, 'a new inner product');
  assert.match(route, /if \(changed\.includes\('standard_mrp'\)\) \{\s*await recordMrpChanges\(\[\{ subject: 'inner_product', innerProductId: before\.id/, 'an inner product\'s MRP');
  const studio = read('server/src/routes/kitstudio.js');
  assert.equal((studio.match(/await recordMrpChanges\(/g) || []).length, 2, 'Kit Studio: a new inner product, and a changed MRP');
  assert.match(read('server/src/notify-categories.js'), /fluence_mrp: 'alerts'/);
});

test('only Colour Impressions management acknowledges, and the flag clears for everyone', () => {
  const route = read('server/src/routes/fluence.js');
  const who = route.slice(route.indexOf('async function acknowledgesMrp'), route.indexOf('const OPEN_MRP'));
  assert.match(who, /if \(!req\.user \|\| req\.user\.outside\) return false;/, 'never a customer\'s own login');
  assert.match(who, /if \(req\.user\.role === 'admin'\) return true;/);
  assert.match(who, /SELECT is_management FROM users WHERE id = \$1/, 'the Management tick, read now — not from the token');
  const ack = route.slice(route.indexOf("r.post('/fluence/mrp-changes/ack'"), route.indexOf('// ── The change log'));
  assert.match(ack, /if \(!\(await acknowledgesMrp\(req\)\)\) \{\s*throw fail\(403,/);
  assert.match(ack, /UPDATE fluence_mrp_changes SET ack_at = now\(\), ack_by = \$1, ack_by_id = \$2\s*WHERE \$\{OPEN_MRP\}/);
  assert.match(route, /const OPEN_MRP = 'outside = 1 AND ack_at IS NULL';/);
  // The chip, and the gate.
  assert.ok(FLUENCE_TAB_KEYS.includes('mrp'));
  assert.deepEqual(tabsForRequest('GET', '/fluence/mrp-changes'), ['mrp']);
  assert.deepEqual(tabsForRequest('POST', '/fluence/mrp-changes/ack'), ['mrp']);
  const a = accessOf({ role: 'planner', modules: ['fluence'], fluence_tabs: ['kits'], email: 'f' });
  assert.match(gateDecision('/fluence/mrp-changes', a, 'GET'), /“MRP updates”/);
});

test('the MRP updates chip counts what waits, and the notification centre carries the button', () => {
  const page = read('client/src/pages/Fluence.jsx');
  assert.match(page, /t\.key === 'mrp' && mrp\?\.open \? `MRP updates · \$\{mrp\.open\}`/);
  assert.match(page, /api\.post\('\/fluence\/mrp-changes\/ack', ids === 'all' \? \{ all: true \} : \{ ids \}\)/);
  assert.match(page, /if \(mrp\?\.can_ack\) \{/, 'the button only for who may');
  const shell = read('client/src/components/AppLayout.jsx');
  assert.match(shell, /const acksMrp = !isFluenceOnly\(bellUser\) && canAccess\(bellUser, 'fluence'\)\s*&& \(bellUser\?\.role === 'admin' \|\| Number\(bellUser\?\.is_management\) === 1\);/);
  assert.match(shell, /acksMrp \? api\.get\('\/fluence\/mrp-changes\?pending=1&limit=10'\)/);
  assert.match(shell, /data-bell-mrp-ack=\{m\.id\}/);
  assert.match(shell, /useRealtimeRefresh\(loadPersonal, \['approval_requests', 'fluence_mrp_changes'\]/);
  // The table: replayed locally, applied to production as a named migration.
  const sql = read('supabase/migrations/20260928160000_fluence_mrp_changes.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fluence_mrp_changes/);
  assert.match(sql, /create or replace trigger ci_erp_realtime_ping after insert or update or delete on public\.fluence_mrp_changes/);
  assert.match(read('server/src/db.js'), /await pool\.query\(migration\('20260928160000_fluence_mrp_changes\.sql'\)\);/);
});
