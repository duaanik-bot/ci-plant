import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FIN_MAX_PAISE } from '../../client/src/lib/finance/money.js';
import { FIN_ROLES } from './finance-rules.js';
import * as admin from './finance-admin.js';

const { finRuleChange, finRolesOf, finRuleOut } = admin;

// The pure half of the approval-rule and access writes (finance-admin.js), and source pins on the transaction code and on
// the routes that call it. The writes themselves, against a real database, are finance-pg-admin.test.js (FINANCE_PG=1).

// A 400 FIN_BAD_INPUT that names the field the form should mark.
const refusal = field => e => e.status === 400 && e.body?.code === 'FIN_BAD_INPUT' && e.body.field === field;

test('finRuleChange: a mode, and a limit in whole paise for above_limit and for no other mode', () => {
  assert.deepEqual(finRuleChange({ mode: 'always' }), { mode: 'always', limit_paise: null });
  assert.deepEqual(finRuleChange({ mode: 'never', limit_paise: null }), { mode: 'never', limit_paise: null });
  assert.deepEqual(finRuleChange({ mode: 'above_limit', limit_paise: 5000000 }), { mode: 'above_limit', limit_paise: 5000000 });
  assert.deepEqual(finRuleChange({ mode: 'above_limit', limit_paise: 0 }), { mode: 'above_limit', limit_paise: 0 }, 'a limit of nothing is a limit');
  assert.equal(finRuleChange({ mode: 'above_limit', limit_paise: FIN_MAX_PAISE - 1 }).limit_paise, FIN_MAX_PAISE - 1, 'the highest there is');

  for (const mode of [undefined, null, '', 'sometimes', 'Always', 'above limit', 1, true, ['always'], { mode: 'always' }, '__proto__', 'constructor']) {
    assert.throws(() => finRuleChange({ mode }), refusal('mode'), String(mode));
  }
  assert.throws(() => finRuleChange(), refusal('mode'), 'no body at all');
  assert.throws(() => finRuleChange(null), refusal('mode'));

  // above_limit with no limit, or a limit that is not whole paise within reach (NaN and Infinity among them)
  for (const limit_paise of [undefined, null]) assert.throws(() => finRuleChange({ mode: 'above_limit', limit_paise }), refusal('limit_paise'));
  for (const limit_paise of [-1, 1.5, 0.1 + 0.2, NaN, Infinity, -Infinity, '5000000', '', true, [], {}, 2 ** 53, Number.MAX_SAFE_INTEGER, FIN_MAX_PAISE, 1e300]) {
    assert.throws(() => finRuleChange({ mode: 'above_limit', limit_paise }), refusal('limit_paise'), String(limit_paise));
  }
  // a limit with a mode that has none is a mistake, not something to drop quietly (the table's CHECK says the same)
  for (const mode of ['always', 'never']) {
    for (const limit_paise of [0, 5000000, '', false, NaN]) assert.throws(() => finRuleChange({ mode, limit_paise }), refusal('limit_paise'), `${mode} ${limit_paise}`);
  }
  // other fields of the body are none of its business
  assert.deepEqual(finRuleChange({ mode: 'never', rule_key: 'journal', book_id: 9 }), { mode: 'never', limit_paise: null });
});

test('finRolesOf: known roles, once each, in the order of FIN_ROLES', () => {
  assert.deepEqual(finRolesOf(['admin', 'approver']), ['approver', 'admin']);
  assert.deepEqual(finRolesOf(['viewer', 'viewer']), ['viewer']);
  assert.deepEqual(finRolesOf([...FIN_ROLES].reverse()), [...FIN_ROLES]);
  const given = ['admin', 'viewer'];
  finRolesOf(given);
  assert.deepEqual(given, ['admin', 'viewer'], 'the list it was given is left alone');

  for (const bad of [undefined, null, [], 'viewer', {}, 0, true, ['owner'], ['viewer', 'owner'], [1], [null], [undefined], ['Viewer'], [' viewer'], ['__proto__'], ['constructor'], ['viewer', ['admin']]]) {
    assert.throws(() => finRolesOf(bad), refusal('roles'), JSON.stringify(bad));
  }
  const holey = ['viewer'];
  holey[3] = 'admin';
  assert.throws(() => finRolesOf(holey), refusal('roles'), 'a list with holes in it');
});

test('finRuleOut: the keys the API documents, with the limit in whole paise or null', () => {
  const row = { id: 3, book_id: 1, rule_key: 'payment', mode: 'above_limit', limit_amount: 100000, updated_by: 'MD', updated_at: new Date(0) };
  assert.deepEqual(finRuleOut(row), { id: 3, book_id: 1, rule_key: 'payment', mode: 'above_limit', limit_paise: 10000000, updated_by: 'MD', updated_at: row.updated_at });
  assert.deepEqual(Object.keys(finRuleOut(row)), ['id', 'book_id', 'rule_key', 'mode', 'limit_paise', 'updated_by', 'updated_at']);
  assert.equal(finRuleOut({ ...row, mode: 'never', limit_amount: null }).limit_paise, null);
  assert.equal(finRuleOut({ ...row, limit_amount: 0 }).limit_paise, 0, 'a limit of nothing is not "no limit"');
  // the pool hands NUMERIC over as a float: 0.07 * 100 is 7.000000000000001 and 1.15 * 100 is 114.99999999999999
  assert.equal(finRuleOut({ ...row, limit_amount: 0.07 }).limit_paise, 7);
  assert.equal(finRuleOut({ ...row, limit_amount: 1.15 }).limit_paise, 115);
  assert.equal(finRuleOut({ ...row, limit_amount: 999999999999.99 }).limit_paise, 99999999999999, 'and the highest limit reads back exactly');
});

test('every export of finance-admin.js is a function named fin…', () => {
  const names = Object.keys(admin).sort();
  assert.deepEqual(names, ['finGrantAccess', 'finListAccess', 'finListRules', 'finRevokeAccess', 'finRolesOf', 'finRuleChange', 'finRuleOut', 'finUpdateRule']);
  for (const name of names) assert.equal(typeof admin[name], 'function', name);
});

// ── Source pins: what a test of behaviour can only catch when two requests happen to collide ──

// finance-admin.js without its comments, split into its top-level declarations.
const source = readFileSync(new URL('./finance-admin.js', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const declarations = source.split(/^(?=(?:export )?(?:async )?function |const \w+ = )/m)
  .filter(chunk => /^(?:export )?(?:async )?function |^const \w+ = /.test(chunk));
const nameOf = chunk => /^(?:export )?(?:async )?function (\w+)|^const (\w+) =/.exec(chunk).slice(1).find(Boolean);
function bodyOf(name) {
  const chunk = declarations.find(c => nameOf(c) === name);
  assert.ok(chunk, `${name} is not in finance-admin.js`);
  return chunk;
}

// A write runs inside the route's transaction, and the pool is one client on Vercel: a pool call made there waits for
// the client the transaction holds. So the pool's q is used by the two lists and by nothing else in the file.
test('only the two lists use the pool; every write uses the transaction\'s qc and oc', () => {
  const usingPool = declarations.filter(chunk => /\b(?:q|one)\(/.test(chunk)).map(nameOf).sort();
  assert.deepEqual(usingPool, ['finListAccess', 'finListRules']);
  assert.ok(declarations.length >= 12, `non-vacuous: only ${declarations.length} declarations found`);
});

// The Users table is the plant's: Finance reads who a login is and never writes it.
test('finance-admin.js reads users and never writes it', () => {
  assert.match(source, /JOIN users u/);
  assert.doesNotMatch(source, /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+users\b/i);
});

// FIN_LAST_ADMIN. The book's grants are held FOR UPDATE, in id order, before the admins that are left are counted, and the
// count comes before the write. finance-pg-admin.test.js proves it with two transactions; this holds when none collide.
test('the last-admin guard: both writers hold the book\'s grants, in id order, before they count the admins left, and count before they write', () => {
  assert.match(bodyOf('finLockBookAccess'), /SELECT id FROM fin_access WHERE book_id = \$1 ORDER BY id FOR UPDATE/);
  for (const [name, write] of [['finGrantAccess', /INSERT INTO fin_access/], ['finRevokeAccess', /DELETE FROM fin_access/]]) {
    const body = bodyOf(name);
    const at = {
      lock: body.search(/await finLockBookAccess\(qc, /),
      read: body.search(/\$\{FIN_GRANT_FROM\} WHERE/),
      count: body.search(/await finKeepAnAdmin\(oc, /),
      write: body.search(write),
    };
    for (const [step, i] of Object.entries(at)) assert.ok(i >= 0, `${name} has no ${step} step`);
    assert.ok(at.lock < at.read && at.read < at.count && at.count < at.write, `${name}: lock the grants, read, count the admins left, then write`);
    assert.equal(body.match(/FOR UPDATE/g), null, `${name}: the one lock is finLockBookAccess's`);
  }
  // the count: other grants of this book, holding admin, for a login that is switched on
  const guard = bodyOf('finKeepAnAdmin');
  assert.match(guard, /JOIN users u ON u\.id = a\.user_id/);
  for (const clause of [/a\.book_id = \$1/, /a\.id <> \$2/, /'admin' = ANY \(a\.roles\)/, /u\.active = 1/]) assert.match(guard, clause);
  assert.match(guard, /if \(others === 0\) throw finError\(409, 'FIN_LAST_ADMIN'\)/);
});

test('a rule is locked before it is read for its before, and is written only when something changed', () => {
  const body = bodyOf('finUpdateRule');
  const lock = body.search(/FROM fin_approval_rules WHERE id = \$1 FOR NO KEY UPDATE/);
  const same = body.search(/before\.mode === next\.mode && before\.limit_paise === next\.limit_paise\) return before/);
  const write = body.search(/UPDATE fin_approval_rules SET/);
  const audit = body.search(/await finAudit\(qc, /);
  for (const [step, i] of Object.entries({ lock, same, write, audit })) assert.ok(i >= 0, `finUpdateRule has no ${step} step`);
  assert.ok(lock < same && same < write && write < audit, 'lock, compare, write, then log');
});

// Ruling R31. Export is the one field a body may leave out: true for a grant that is new, and whatever the grant has for one that
// exists. A default in the destructure would switch export back on for anyone whose roles an admin edits.
// finance-pg-admin.test.js proves it against a real grant; this holds when that file is not run.
test('an omitted can_export is the stored grant\'s, and true only for a new grant; null is still refused (ruling R31)', () => {
  const body = bodyOf('finGrantAccess');
  assert.match(body, /const \{ user_id, book_id, roles, can_export \} = input \?\? \{\};/, 'no default in the destructure');
  assert.match(body, /if \(can_export !== undefined && typeof can_export !== 'boolean'\) throw finBad\(/, 'checked when sent, and null is sent');
  const read = body.search(/\$\{FIN_GRANT_FROM\} WHERE a\.user_id = \$1 AND a\.book_id = \$2/);
  const resolved = body.search(/const canExport = can_export \?\? had\?\.can_export \?\? true;/);
  assert.ok(read >= 0 && resolved > read, 'resolved from the grant as read under the lock, not before');
  assert.match(body, /had\.can_export === canExport\) return had;/, 'a repeat is judged on the resolved value');
  assert.match(body, /\[userId, bookId, held, canExport, by\.name\]/, 'and the write uses it too');
  assert.match(body, /roles: held, can_export: canExport \}/, 'and so does the answer');
});

// ── Source pins: the routes ──

const routes = readFileSync(new URL('./routes/finance.js', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
function routeBlock(head) {
  const at = routes.indexOf(head);
  assert.ok(at >= 0, `${head} is not a route`);
  const next = routes.indexOf('\nr.', at + 1);
  return routes.slice(at, next < 0 ? undefined : next);
}

// spec §9.1: the rules are read by whoever can read the book and changed by its admin; the access list is for an admin of at
// least one book, and a grant or a revoke is its book's admin's.
test('the five routes ask for the capabilities the spec gives them', () => {
  assert.match(routeBlock("r.get('/finance/approval-rules'"), /finRequire\(req, 'view', bookId\)/);
  assert.match(routeBlock("r.put('/finance/approval-rules/:id'"), /finRequireRow\(req, 'admin', 'rule'\)/);
  assert.match(routeBlock("r.get('/finance/access'"), /finBookIdsFor\(req, 'admin'\)[\s\S]*bookIds\.length === 0\) throw finError\(403, 'FIN_FORBIDDEN'\)/);
  assert.match(routeBlock("r.post('/finance/access'"), /finRequire\(req, 'admin', bookId\)/);
  assert.match(routeBlock("r.delete('/finance/access/:id'"), /finRequireRow\(req, 'admin', 'access'\)/);
});

// finance-access.js holds what a login may do for 10 s. A grant or a revoke has to be felt by the login's very next request,
// so the held copy is dropped; and only once the transaction has returned, or a request landing in between would read the
// old rows, hold them again, and be wrong for 10 s.
test('a grant and a revoke forget what is held for the login straight after their transaction has returned, and not before', () => {
  for (const head of ["r.post('/finance/access'", "r.delete('/finance/access/:id'"]) {
    assert.match(routeBlock(head), /const grant = await tx\(\(qc, oc\) => fin\w+\(qc, oc, [^;]*\)\);\n\s*finForgetAccess\(grant\.user_id\);/, head);
  }
});
