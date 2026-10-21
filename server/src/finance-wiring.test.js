import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { categoryOf } from './notify-categories.js';
import { MINTING_POSTS } from '../../client/src/lib/writeOnce.js';
import { MODULES, canAccess, firstAllowedPath, moduleForPath } from '../../client/src/modules.js';
import { FIN_ROLES as clientRoles, finCan as clientCan } from '../../client/src/lib/finance/caps.js';
import { FIN_ROLES as serverRoles, finCan as serverCan } from './finance-rules.js';
import { FINANCE_TABLES } from '../../client/src/lib/finance/tables.js';
import { finBookAfterReload, finBookOf, finPickBook } from '../../client/src/lib/finance/book.js';
const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');

test('the finance router is mounted behind requireAuth and moduleGate', () => {
  const app = src('./app.js');
  assert.match(app, /import finance from '\.\/routes\/finance\.js';/);
  const mount = app.indexOf("app.use('/api', finance);");
  assert.ok(mount > app.indexOf("app.use('/api', moduleGate);"), 'mounted after moduleGate');
  assert.ok(mount < app.indexOf('// Central error handler'), 'mounted before the error handler');
});

// indexOf answers -1 for a line that has gone, and "mount > -1" then passes for the wrong reason. A line
// commented out is still found by the text pin above, so this reads app.js without its comments.
test('the mount pin above is not vacuous: every line it searches for is live code, in this order', () => {
  const live = src('./app.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const lines = ["app.use('/api', requireAuth);", "app.use('/api', moduleGate);", "app.use('/api', finance);", 'app.use((err, _req, res, _next) => {'];
  const at = lines.map(line => { assert.ok(live.includes(line), `${line} is not live code in app.js: re-read the pin above`); return live.indexOf(line); });
  assert.deepEqual(at, [...at].sort((a, b) => a - b));
  assert.match(live, /import finance from '\.\/routes\/finance\.js';/);
});

// The text pins say what app.js is written like; this says what Express was actually handed.
test('in the app\'s middleware stack the finance router sits after moduleGate and before the central error handler', async () => {
  const { default: app } = await import('./app.js');
  const stack = app._router.stack;
  const gate = stack.findIndex(layer => layer.handle.name === 'moduleGate');
  const finance = stack.findIndex(layer => layer.name === 'router' && layer.handle.stack.some(l => l.route?.path === '/finance/me'));
  const handler = stack.findIndex(layer => layer.handle.length === 4);
  assert.ok(gate >= 0, 'moduleGate is in the stack');
  assert.ok(finance > gate, 'the finance router comes after moduleGate');
  assert.ok(handler > finance, 'the error handler comes after the finance router');
});

// The route rule (spec §9.3). A refusal the database makes has to come out as a Finance refusal with its code,
// whichever handler it happens in; next(e) would turn it into a bare 500 and lose the code.
test('every finance route ends  catch (e) { next(finMapDbError(e)); }', () => {
  const routes = src('./routes/finance.js');
  const blocks = routes.split(/^(?=r\.(?:get|post|put|patch|delete)\()/m).filter(block => block.startsWith('r.'));
  assert.ok(blocks.length >= 5, `non-vacuous: only ${blocks.length} routes found`);
  for (const block of blocks) {
    const route = block.split('\n')[0];
    assert.match(block, /\} catch \(e\) \{ next\(finMapDbError\(e\)\); \}/, `${route}: its catch must be  catch (e) { next(finMapDbError(e)); }`);
    assert.doesNotMatch(block, /next\(e\)/, `${route}: hands a raw error on`);
  }
});

// Ruling R39: the ledgers read says is_bank_cash and is_party from the ONE group-kinds helper that the voucher drafts and the Tally
// import already use (finGroupKinds and finIsPartyLedger, finance-vouchers.js), and has no SQL of its own for either. A third
// definition is how the entry form and the posting come to disagree about where the bill fields go.
test('the ledgers read takes is_bank_cash and is_party from the one group-kinds helper, with no recursion of its own', () => {
  const routes = src('./routes/finance.js');
  const block = routes.slice(routes.indexOf("r.get('/finance/books/:bookId/ledgers'"), routes.indexOf("r.get('/finance/books/:bookId/years'"));
  assert.ok(block.length > 400, 'non-vacuous: the route was found');
  assert.match(block, /finGroupKinds\(q, bookId\)/);
  assert.match(block, /is_bank_cash: kinds\.get\(l\.group_id\)\?\.is_bank_cash === true/);
  assert.match(block, /is_party: finIsPartyLedger\(l, kinds\)/);
  assert.doesNotMatch(block, /WITH RECURSIVE/i, 'a recursive walk of the groups is finGroupKinds\' job');
  assert.doesNotMatch(block, /FIN_BANK_CASH_GROUPS|FIN_PARTY_GROUPS/, 'the group names are finGroupKinds\' business');
});

// Fix round, M5 (ruling R23): the groups read says the same two things of a GROUP, from the same helper, so a screen never has to work out
// what a party group is from names of its own. The Opening Match step used to (a client walk over "Sundry Debtors"/"Sundry Creditors").
test('the groups read takes is_bank_cash and is_party from the same group-kinds helper, with no recursion of its own', () => {
  const routes = src('./routes/finance.js');
  const block = routes.slice(routes.indexOf("r.get('/finance/books/:bookId/groups'"), routes.indexOf("// The book's ledgers, switched-off ones only"));
  assert.ok(block.length > 400, 'non-vacuous: the route was found');
  assert.match(block, /finGroupKinds\(q, bookId\)/);
  assert.match(block, /is_bank_cash: kinds\.get\(g\.id\)\?\.is_bank_cash === true/);
  assert.match(block, /is_party: kinds\.get\(g\.id\)\?\.is_party === true/);
  assert.doesNotMatch(block, /WITH RECURSIVE/i, 'a recursive walk of the groups is finGroupKinds\' job');
  assert.doesNotMatch(block, /FIN_BANK_CASH_GROUPS|FIN_PARTY_GROUPS/, 'the group names are finGroupKinds\' business');
});

// The two bells Finance rings (spec §12, item 7): an entry waiting for an Approver, and the Approver's answer
// going back to its maker. A kind no category claims files under 'other', a tab nobody reads.
test('the Finance bells file under Approvals and Decisions', () => {
  assert.equal(categoryOf('fin_approval'), 'approvals');
  assert.equal(categoryOf('fin_decision'), 'decisions');
});

// Submit and approve mint a voucher number (spec §7.4, §12 item 6), so a double-click on either is joined to the
// request already on the wire. Reject mints nothing and is never joined.
test('submit and approve are minting POSTs the client joins on a double-click; reject is not', () => {
  assert.ok(MINTING_POSTS.includes('/finance/vouchers/:id/submit'), 'submit');
  assert.ok(MINTING_POSTS.includes('/finance/vouchers/:id/approve'), 'approve');
  assert.ok(!MINTING_POSTS.includes('/finance/vouchers/:id/reject'), 'reject mints nothing');
});

// Reverse mints too: the reversal takes its number when it posts (spec §7.5, §9.1), so a double-click on Reverse is joined
// to the request already on the wire, as submit and approve are.
test('reverse is a minting POST the client joins on a double-click', () => {
  assert.ok(MINTING_POSTS.includes('/finance/vouchers/:id/reverse'));
});

// Building the Opening voucher submits it, and a submit can post and mint (spec §9.1, §11.2), so a double-click on Build is
// joined to the request already on the wire. An upload and a confirmation mint nothing, so nothing else of the import is.
test('build-opening is the one import route the client joins on a double-click', () => {
  assert.deepEqual(MINTING_POSTS.filter(path => path.startsWith('/finance/imports')), ['/finance/imports/:id/build-opening']);
});

// ── The client shell: the module, its route, the sidebar group, the book switch (spec §10, §12 items 1-3) ──────────
// kit-studio.test.js requires Fluence to stay LAST in MODULES, so Finance goes immediately before it.
test('Finance sits immediately before Fluence in MODULES', () => {
  const i = MODULES.findIndex(m => m.key === 'finance');
  assert.deepEqual(MODULES[i], { key: 'finance', label: 'Finance', path: '/finance' });
  assert.equal(MODULES[i + 1].key, 'fluence');
});

test('the /finance/* route is lazy and the sidebar group sits between Supply and Admin', () => {
  const app = src('../../client/src/App.jsx');
  assert.match(app, /const Finance = lazy\(\(\) => import\('\.\/pages\/finance\/Finance\.jsx'\)\);/);
  assert.match(app, /<Route path="\/finance\/\*" element={<Finance \/>} \/>/);
  const nav = src('../../client/src/components/AppLayout.jsx');
  const [s, f, a] = ["group: 'Supply'", "group: 'Finance'", "group: 'Admin'"].map(g => nav.indexOf(g));
  assert.ok(s < f && f < a, 'Supply < Finance < Admin');
  for (const t of ["to: '/finance', end: true", "to: '/finance/reports'", "to: '/finance/setup'"]) assert.ok(nav.includes(t), t);
  assert.equal((nav.match(/module: 'finance'/g) || []).length, 3);
});

test('one capability table for screens and server', () => {
  assert.equal(clientCan, serverCan);
  assert.equal(FINANCE_TABLES.length, 13);
});

// ── Beyond the brief's pins ───────────────────────────────────────────────────────────────────────────────────────

// The roles are one list too. And caps.js has to load in the browser as written and in node as written, so it takes
// no imports: money.js and fy.js say the same of themselves. (`import:` is a capability, the key of a table row, not
// a statement: the pattern lets a key through.)
test('FIN_ROLES is one list for screens and server, and caps.js imports nothing', () => {
  assert.equal(clientRoles, serverRoles);
  const caps = src('../../client/src/lib/finance/caps.js');
  assert.match(caps, /^\s*import: \[/m, 'non-vacuous: the capability named import is there, and is not taken for a statement');
  assert.doesNotMatch(caps, /^\s*import\b(?!\s*:)/m);
});

// useRealtimeRefresh(load, FINANCE_TABLES) is the only thing that tells a Finance screen another login changed a table.
// A table missing from the list is a screen that goes stale without a sound.
test('FINANCE_TABLES is exactly the tables the Finance migration creates', () => {
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const files = readdirSync(dir).filter(f => f.endsWith('_finance_ledger_core.sql'));
  assert.equal(files.length, 1, 'one Finance migration');
  const created = [...readFileSync(new URL(files[0], dir), 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS (fin_\w+) \(/g)].map(m => m[1]);
  assert.equal(created.length, 13, 'non-vacuous: the migration creates the thirteen');
  assert.deepEqual([...FINANCE_TABLES].sort(), [...created].sort());
  assert.equal(new Set(FINANCE_TABLES).size, FINANCE_TABLES.length, 'no table twice');
});

// RequireAuth reads moduleForPath, so this is what bounces a login with no Finance tick off every Finance URL.
test('Finance opens at /finance and everything under it, for a login given it and for no one else', () => {
  for (const path of ['/finance', '/finance/reports', '/finance/setup/access', '/finance/vouchers/12/print']) {
    assert.equal(moduleForPath(path), 'finance', path);
  }
  assert.equal(moduleForPath('/financial'), null, 'a path that only starts with the same letters is not the module');
  assert.ok(canAccess({ role: 'viewer', modules: ['finance'] }, 'finance'));
  assert.equal(firstAllowedPath({ role: 'viewer', modules: ['finance'] }), '/finance');
  assert.ok(!canAccess({ role: 'viewer', modules: ['orders'] }, 'finance'));
  // customer-login.test.js loops every module but Fluence's; this one names Finance
  assert.ok(!canAccess({ role: 'planner', modules: ['fluence'] }, 'finance'), 'a customer login never reaches the books');
});

test('the tablet rail tells the two Finance items from Reports, and every Finance link has a route in the shell', () => {
  const nav = src('../../client/src/components/AppLayout.jsx');
  assert.match(nav, /'\/finance\/reports': 'Fin Rpts'/);
  assert.match(nav, /'\/finance\/setup': 'Fin Setup'/);
  const shell = src('../../client/src/pages/finance/Finance.jsx');
  for (const route of ['<Route index ', 'path="reports/*"', 'path="setup/*"', 'path="vouchers/:id/print"']) assert.ok(shell.includes(route), route);
});

// lazy() resolves to a module's default export: a page that only has a named one loads as undefined and blanks the route.
test('every page the Finance shell loads exists and is a default export', () => {
  const shell = src('../../client/src/pages/finance/Finance.jsx');
  const pages = [...shell.matchAll(/import\('\.\/(\w+\.jsx)'\)/g)].map(m => m[1]).sort();
  assert.deepEqual(pages, ['Reports.jsx', 'Setup.jsx', 'VoucherPrint.jsx', 'Vouchers.jsx']);
  for (const page of pages) assert.match(src(`../../client/src/pages/finance/${page}`), /^export default\b/m, page);
});

test('the Finance shell asks who the login is once per load, remembers the book through safeStorage, and says one sentence for no grant', () => {
  const shell = src('../../client/src/pages/finance/Finance.jsx');
  assert.equal((shell.match(/api\.get\('\/finance\/me'\)/g) || []).length, 1);
  assert.match(shell, /import \{ storage \} from '\.\.\/\.\.\/lib\/safeStorage\.js';/);
  assert.match(shell, /storage\.getItem\('fin_book'\)/);
  assert.match(shell, /storage\.setItem\('fin_book', /);
  const sentence = "Finance isn't switched on for this login — ask the MD.";
  assert.ok(shell.includes(sentence));
  assert.ok(shell.indexOf(sentence) < shell.indexOf('<BookSwitch'), 'the no-grant page returns before anything else is drawn');
  // every page gets the same four things, and the book switch is not drawn for a login that holds one book
  assert.equal((shell.match(/me=\{me\} book=\{book\} can=\{can\} setBook=\{setBook\}/g) || []).length, 4);
  assert.match(shell, /me\.books\.length > 1/);
});

// A bell link names a voucher and no book (finance-vouchers.js), so the Vouchers page opens a voucher in the voucher's own
// book by asking the shell to switch. The shell takes only a book this login holds, remembers it, and the book switch goes
// through the same door.
test('setBook: only a book the login holds, remembered under fin_book, and the book switch uses it', () => {
  const shell = src('../../client/src/pages/finance/Finance.jsx');
  const start = shell.indexOf('const setBook = useCallback(');
  assert.ok(start >= 0, 'non-vacuous: setBook is where this pin looks for it');
  const body = shell.slice(start, shell.indexOf('[me]);', start));
  assert.match(body, /finBookOf\(me\?\.books, id\)/, 'the book must be one of this login\'s own');
  assert.match(body, /if \(!next\) return false;/, 'and anything else changes nothing');
  assert.match(body, /setRemembered\(String\(next\.id\)\);/, 'the shell moves to it at once, not on the next load');
  assert.match(body, /storage\.setItem\('fin_book', String\(next\.id\)\)/);
  assert.match(shell, /<BookSwitch [^>]*onChange=\{setBook\}/);
  // the pages are drawn afresh on the new book, so nothing one book showed sits on screen under the other's name
  assert.match(shell, /<Routes key=\{book\.id\}>/);
});

// A dropped connection gives no toast (api.js toasts only HTTP answers), so a failed /finance/me cannot be left as a
// "Loading…" that never ends: one short line and a Retry. It never says "not switched on": that is for an answer with no books.
test('a /finance/me that fails says one short line and offers Retry that asks again', () => {
  const shell = src('../../client/src/pages/finance/Finance.jsx');
  assert.match(shell, /\.catch\(\(\) => \{ if \(live\) setFailed\(true\); \}\)/);
  assert.ok(shell.includes("Finance didn't load."));
  assert.match(shell, /<Button [^>]*onClick=\{retry\}[^>]*>Retry<\/Button>/);
  assert.match(shell, /const retry = \(\) => \{ setFailed\(false\); setAttempt\(n => n \+ 1\); \};/);
  assert.match(shell, /\}, \[attempt\]\);/, 'the request runs again when Retry bumps the attempt');
  assert.ok(shell.indexOf("Finance didn't load.") < shell.indexOf('<BookSwitch'), 'the failed page returns before anything else is drawn');
});

// What the page remembers is text (storage) and what the server sends is a whole number, and a grant can be taken
// away between visits: the remembered book counts only while this login still holds it.
test('the book the page opens on: the remembered one while the login still holds it, else the first', () => {
  const ci = { id: 1, code: 'CI', name: 'Colour Impressions' };
  const dp = { id: 2, code: 'DP', name: 'Darbi Print Pack' };
  assert.equal(finPickBook([ci, dp], '2'), dp);
  assert.equal(finPickBook([ci, dp], '1'), ci);
  assert.equal(finPickBook([ci, dp], 2), dp, 'a number matches as well as text');
  for (const remembered of ['9', '0', '', 'abc', '2.0', '02', null, undefined]) {
    assert.equal(finPickBook([ci, dp], remembered), ci, `remembered ${JSON.stringify(remembered)}`);
  }
  assert.equal(finPickBook([dp], '1'), dp, 'a login holding only DP never lands on CI');
  for (const none of [[], null, undefined]) assert.equal(finPickBook(none, '1'), null, 'nothing to pick from');
});

// The one rule behind both the book the page opens on and the book setBook accepts. An id is a whole number or its text
// (the server sends numbers; storage and URLs hand back text), and it names a book only while this login holds it. Anything
// else, a list or an object or a bigint that would print like an id, names nothing.
test('finBookOf: a book is named by its number or its text, and only while the login holds it', () => {
  const ci = { id: 1, code: 'CI', name: 'Colour Impressions' };
  const dp = { id: 2, code: 'DP', name: 'Darbi Print Pack' };
  assert.equal(finBookOf([ci, dp], 2), dp, 'the same object, so a page may hold on to it');
  assert.equal(finBookOf([ci, dp], '2'), dp);
  assert.equal(finBookOf([ci, dp], 1), ci);
  const notABook = [3, 0, -0, -1, 1.5, NaN, Infinity, '3', '', ' 2', '2 ', '2.0', '02', '1e0', '+2', 'abc', null, undefined,
    true, false, [2], ['2'], { id: 2 }, () => 2, 2n, Symbol('2')];
  for (const id of notABook) assert.equal(finBookOf([ci, dp], id), null, `${typeof id} ${String(id)}`);
  assert.equal(finBookOf([dp], 1), null, 'a login holding only DP cannot be moved onto CI');
  for (const none of [[], null, undefined, 'books', {}, 7]) assert.equal(finBookOf(none, 1), null, `nothing to name: ${String(none)}`);
});

// The ERP's client code has never used Object.hasOwn (Chrome 93, Safari 15.4); it spells it hasOwnProperty.call, and Vite
// does not polyfill it. What Finance ships to the browser keeps to that baseline. (The server may use it freely.) The scan is
// Finance's own files only, as the .at( scan below is: the rest of the client is not this module's to hold to it.
const clientFiles = () => {
  const files = [];
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(new URL(`${e.name}/`, dir));
      else if (/\.jsx?$/.test(e.name)) files.push(new URL(e.name, dir));
    }
  };
  walk(new URL('../../client/src/', import.meta.url));
  return files;
};
const clientPath = f => f.pathname.split('/client/src/')[1];
// A file's code without its comments, so a comment that names what is banned (as this one does) is not a use of it.
const code = f => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('no Finance client code uses Object.hasOwn: the ERP browser baseline predates it', () => {
  const finance = clientFiles().filter(f => /\/finance\//.test(clientPath(f)));
  assert.ok(finance.length > 30, `non-vacuous: only ${finance.length} Finance client files scanned`);
  const HAS_OWN = /\bObject\.hasOwn\s*\(/;
  for (const use of ['Object.hasOwn(x, k)', 'Object.hasOwn (x, k)']) assert.ok(HAS_OWN.test(use), `the pattern sees ${JSON.stringify(use)}`);
  assert.ok(!HAS_OWN.test('Object.prototype.hasOwnProperty.call(x, k)'), 'and not the spelling the client uses');
  const offenders = finance.filter(f => HAS_OWN.test(code(f))).map(clientPath);
  assert.deepEqual(offenders, []);
  assert.ok(finance.some(f => /Object\.prototype\.hasOwnProperty\.call\(/.test(code(f))), 'non-vacuous: the codebase\'s own spelling is what the scan sees');
});

// Nor does Finance's client code use Array.prototype.at (Chrome 92, Safari 15.4): the last of a list is list[list.length - 1], as it
// is everywhere else in the client. The scan is Finance's own files only (lib/, components/ and pages/ under a finance directory):
// the rest of the client is not this module's to hold to it, and a merge that brings someone else's code in must not fail here.
test('no Finance client code uses .at(): the last of a list is list[list.length - 1]', () => {
  const finance = clientFiles().filter(f => /\/finance\//.test(clientPath(f)));
  assert.ok(finance.length > 30, `non-vacuous: only ${finance.length} Finance client files scanned`);
  const AT = /\.at\s*\(/;
  for (const use of ['list.at(-1)', 'list?.at(-1)', 'list.filter(x).at( -1 )', 'rows\n  .at(0)']) assert.ok(AT.test(use), `the pattern sees ${JSON.stringify(use)}`);
  for (const not of ['list[list.length - 1]', 'data(1)', 'format(2)', 'list.attr(1)', 'cat (1)']) assert.ok(!AT.test(not), `and not ${JSON.stringify(not)}`);
  const offenders = finance.filter(f => AT.test(code(f))).map(clientPath);
  assert.deepEqual(offenders, []);
});

// And no screen of Finance keeps a list of the party group names: they are FIN_PARTY_GROUPS (finance-groups.js), read by finGroupKinds,
// and reach a screen as a group's is_party. Comments may name them; code may not.
test('no Finance client code spells the party group names: whether a group is a party\'s is the server\'s word', () => {
  const finance = clientFiles().filter(f => /\/finance\//.test(clientPath(f)));
  assert.ok(finance.length > 30, `non-vacuous: only ${finance.length} Finance client files scanned`);
  const NAME = /sundry\s+(debtors|creditors)/i;
  assert.ok(NAME.test('{ \'sundry debtors\': 1 }') && NAME.test('Sundry  Creditors'), 'the pattern sees the names');
  assert.deepEqual(finance.filter(f => NAME.test(code(f))).map(clientPath), []);
});

// ── Ruling R60: the shell asks for /finance/me again when the login's own grants change ──────────────────────────────
// FinanceAccess calls reloadMe after a grant or a revoke for the logged-in user's own id, so the books and roles the shell hands
// down follow at once, without a reload. What it is on afterwards is one pure rule (book.js): the book it was on, while the new
// answer still lists it; otherwise the first book of the new answer; and none at all when the login holds nothing any more.
test('R60: after a reload the shell stays on its book while the login still holds it, and falls back to the first, or to none', () => {
  const ci = { id: 1, code: 'CI', name: 'Colour Impressions', roles: ['admin'] };
  const dp = { id: 2, code: 'DP', name: 'Darbi Print Pack', roles: ['accountant'] };
  const dpNow = { ...dp, roles: ['accountant', 'admin'] };
  // still held: the NEW object, so the roles on the page are the new roles
  assert.equal(finBookAfterReload([ci, dpNow], dp), dpNow, 'the same book, with the roles it has now');
  // a book granted meanwhile that sorts first does not pull the shell off the book it is on
  assert.equal(finBookAfterReload([ci, dpNow], { id: 2 }), dpNow, 'a login that was on DP alone and was given CI stays on DP');
  assert.equal(finBookAfterReload([ci, dp], { id: '2' }), dp, 'an id as text is the same id');
  // revoked: the first of what is left
  assert.equal(finBookAfterReload([ci], dp), ci, 'DP was revoked: CI');
  assert.equal(finBookAfterReload([dp, ci], ci), ci, 'CI still held, though it is no longer first');
  // nothing left: no book, which is the shell\'s one sentence for a login with no grant
  for (const none of [[], null, undefined]) assert.equal(finBookAfterReload(none, dp), null, `books ${String(none)}`);
  // no current book (the first answer) or one that names nothing: the first
  for (const current of [null, undefined, {}, { id: null }, { id: 'abc' }, { id: 99 }, { id: [2] }, 2, 'DP']) {
    assert.equal(finBookAfterReload([ci, dp], current), ci, `current ${JSON.stringify(current)}`);
  }
  // it is finPickBook\'s rule, asked of the book that is on screen, and it changes neither list
  const books = Object.freeze([ci, dp]);
  assert.equal(finBookAfterReload(books, dp), finPickBook(books, dp.id));
});

test('R60: the shell exposes reloadMe beside setBook, to every page, through the one request for /finance/me', () => {
  const shell = src('../../client/src/pages/finance/Finance.jsx').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.equal((shell.match(/api\.get\('\/finance\/me'\)/g) || []).length, 1, 'one request for /finance/me, used by the first load and by reloadMe');
  assert.match(shell, /const loadMe = \(\) => api\.get\('\/finance\/me'\);/);
  assert.equal((shell.match(/loadMe\(\)/g) || []).length, 2, 'the first load and reloadMe both go through it');
  assert.equal((shell.match(/me=\{me\} book=\{book\} can=\{can\} setBook=\{setBook\} reloadMe=\{reloadMe\}/g) || []).length, 4, 'all four pages are given it');
  const start = shell.indexOf('const reloadMe = useCallback(');
  assert.ok(start >= 0, 'non-vacuous: reloadMe is where this pin looks for it');
  const body = shell.slice(start, shell.indexOf('}, []);', start));
  assert.match(body, /finBookAfterReload\(answer\.books, bookRef\.current\)/, 'the book to stay on is the pure rule\'s answer, for the book on screen NOW');
  assert.match(body, /setRemembered\(next \? String\(next\.id\) : null\)/);
  assert.match(body, /setMe\(answer\)/);
  assert.match(body, /return answer;/, 'the promise settles with the answer, so the caller can wait for the shell to have it');
  assert.doesNotMatch(body, /\.catch\(/, 'a reload that failed fails for the caller too: nothing here swallows it');
  assert.match(shell, /useEffect\(\(\) => \{ bookRef\.current = book; \}, \[book\]\);/, 'the book on screen is kept in a ref by an effect, not written during a render');
});
