import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextNumber, nextProductCode, lockProductCodeSeries, productCodeTaken } from './helpers.js';
import { nextRunNumber } from './routes/gangs.js';
import { nextToolCode } from './routes/tooling.js';

// Document numbers are minted read-then-write: SELECT the highest number on the
// prefix, add one, and the caller INSERTs it. Two transactions doing that at
// once (a double-clicked Save, two storekeepers posting GRNs) both read the
// same highest number, both mint the same next one, and the second INSERT dies
// on the unique index. Seen on motionci.in from 2026-09-05 to 2026-09-17:
//
//   duplicate key value violates unique constraint "grns_grn_number_key"
//   Key (grn_number)=(CI-GRN-0105) already exists.
//
// The fix is a transaction-scoped advisory lock on the prefix, taken on the
// CALLER'S transaction before the read. A second minter on the same prefix
// then waits until the first commits (or rolls back) and reads the number the
// first one wrote. The real two-transaction race is proved against Postgres in
// doc-number-race-pg.test.js; these pin the contract without a database.

const spy = (row = null) => {
  const calls = [];
  return { calls, oc: async (sql, params = []) => (calls.push({ sql, params }), /pg_advisory/.test(sql) ? null : row) };
};

// The lock must come FIRST and be keyed on the prefix. A lock taken after the
// SELECT serialises nothing: both readers have already seen the same max.
function assertLockThenRead(calls, prefix, table) {
  assert.ok(calls.length >= 2, `expected a lock and a read, got ${calls.length} statement(s)`);
  const [lock, read] = calls;
  assert.match(lock.sql, /pg_advisory_xact_lock\(/,
    'the first statement must take the transaction-scoped advisory lock');
  assert.match(lock.sql, /hashtext\(\$\d\)/, 'the lock is keyed on hashtext(prefix)');
  assert.ok(lock.params.includes(prefix), 'the prefix must be bound, not interpolated');
  assert.match(read.sql, new RegExp(`FROM ${table}\\b`), 'the highest-number read comes after the lock');
}

test('nextNumber locks the prefix on the caller\'s transaction before reading the highest number', async () => {
  const { calls, oc } = spy({ n: 'CI-GRN-0104' });
  assert.equal(await nextNumber('CI-GRN-', 'grns', 'grn_number', oc), 'CI-GRN-0105');
  assertLockThenRead(calls, 'CI-GRN-', 'grns');
});

test('nextRunNumber (gang and merge runs) locks its prefix before reading', async () => {
  const { calls, oc } = spy({ n: 11 });
  assert.equal(await nextRunNumber('CI-GANG-', oc), 'CI-GANG-0012');
  assertLockThenRead(calls, 'CI-GANG-', 'gang_runs');
});

test('nextToolCode (die / plate / block codes) locks its prefix before reading', async () => {
  const { calls, oc } = spy({ code: 'DIE-0041' });
  assert.equal(await nextToolCode('die', oc), 'DIE-0042');
  assertLockThenRead(calls, 'DIE-', 'tools');
});

test('nextProductCode locks its series on the caller\'s transaction before reading the highest code', async () => {
  const seen = [];
  const oc = async (sql, params = []) => { seen.push([sql, params]); return /FROM customers/.test(sql) ? { name: 'Swiss Garnier' } : null; };
  const qc = async (sql, params = []) => { seen.push([sql, params]); return [{ code: 'SW-767' }]; };
  assert.equal(await nextProductCode(4, qc, oc), 'SW-768');
  const lockAt = seen.findIndex(([sql]) => /pg_advisory_xact_lock/.test(sql));
  const seriesAt = seen.findIndex(([sql]) => /code LIKE \$1/.test(sql));
  assert.ok(lockAt >= 0 && lockAt < seriesAt, 'the lock comes before the highest-code read');
  assert.deepEqual(seen[lockAt][1], ['product-code:SW'], 'keyed on the series, in its own namespace');
});

test('a typed product code queues on the series its prefix names, the key a minter takes', async () => {
  const keys = [];
  const oc = async (sql, params = []) => { if (/pg_advisory_xact_lock/.test(sql)) keys.push(params[0]); return null; };
  // '-001' is what a customer whose name has no Latin letter or digit mints:
  // nextProductCode's prefix is '' and it locks 'product-code:'.
  for (const code of [' sw-770 ', '3MC-012', 'SGB-A-7', '-001', '12345', '', null]) await lockProductCodeSeries(code, oc);
  assert.deepEqual(keys, ['product-code:SW', 'product-code:3MC', 'product-code:SGB', 'product-code:'],
    'a code outside any series takes no lock');
});

test('a taken product code names the code the write tried, and a minted one is not told to clear its field', () => {
  const clash = () => Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'products_code_key' });
  const typed = productCodeTaken(clash(), 'SW-769');
  assert.equal(typed.status, 409);
  assert.match(typed.message, /^Internal Code SW-769 is already taken — clear the field/);
  const minted = productCodeTaken(clash(), 'SW-770', true);
  assert.match(minted.message, /^Internal Code SW-770 was taken by another save just now — save again/);
  const other = Object.assign(new Error('x'), { code: '23505', constraint: 'grns_grn_number_key' });
  assert.equal(productCodeTaken(other, 'SW-1').status, undefined, 'other unique keys pass through');
});

// ── Every caller mints inside a transaction ──────────────────────────────────
// A transaction-scoped lock taken through the POOL (`one`) is released the
// moment that single statement finishes — before the INSERT, which runs on a
// different pooled connection anyway. So the lock only protects a caller that
// hands in its own transaction's `oc`. This scans the server source for every
// call to a minter and refuses one that omits the client or passes the pool.
//
// The single exception is GET /billing/next-invoice-number: it PREVIEWS the
// next invoice number for the form and inserts nothing, so there is no write
// to protect.
const MINTERS = { nextNumber: 4, nextRunNumber: 2, nextToolCode: 2, nextScNumber: 1, nextProductCode: 3, lockProductCodeSeries: 2 };
// file → the one route in it allowed to preview on the pool.
const POOL_PREVIEW_ALLOWED = { 'routes/billing.js': "GET /billing/next-invoice-number" };

const SRC = path.dirname(fileURLToPath(import.meta.url));
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : sourceFiles(p);
    return d.name.endsWith('.js') && !d.name.endsWith('.test.js') ? [p] : [];
  });
}

// Comments name the minters in prose ("same rule as nextNumber()"), so drop
// them before scanning. Only whole-line and block comments: a `//` inside a
// string (a URL) must not eat the code after it. Newlines are kept so the
// reported line numbers match the file.
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))
  .replace(/^[ \t]*\/\/.*$/gm, '');

// Top-level arguments of the call whose `(` sits at `open`.
function callArgs(src, open) {
  const args = [];
  let depth = 0, start = open + 1, quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      depth--;
      if (depth === 0) {
        const last = src.slice(start, i).trim();
        if (last) args.push(last);
        return args;
      }
    } else if (c === ',' && depth === 1) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  throw new Error('unbalanced call');
}

function minterCalls() {
  const out = [];
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const [name, arity] of Object.entries(MINTERS)) {
      const re = new RegExp(`(^|[^\\w.])${name}\\(`, 'g');
      let m;
      while ((m = re.exec(src))) {
        const at = m.index + m[1].length;
        if (/function\s+$/.test(src.slice(Math.max(0, at - 20), at))) continue; // the definition
        const line = src.slice(0, at).split('\n').length;
        // The block that holds the call: the nearest top-level function, arrow
        // const or route above it. Only a route's OWN block names that route.
        const heads = [...src.slice(0, at).matchAll(
          /^(?:export\s+)?(?:async\s+)?function\s+\w+|^(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>|^r\.(get|post|put|patch|delete)\(\s*'([^']+)'/gm)];
        const last = heads.at(-1);
        const route = last?.[1] ? `${last[1].toUpperCase()} ${last[2]}` : null;
        out.push({ rel, line, name, arity, route, args: callArgs(src, at + name.length) });
      }
    }
  }
  return out;
}

test('the scan finds the minters it is guarding (a scan that finds nothing proves nothing)', () => {
  const calls = minterCalls();
  const byName = n => calls.filter(c => c.name === n).length;
  assert.ok(byName('nextNumber') >= 30, `found only ${byName('nextNumber')} nextNumber calls`);
  assert.ok(byName('nextRunNumber') >= 5, `found only ${byName('nextRunNumber')} nextRunNumber calls`);
  assert.ok(byName('nextToolCode') >= 3, `found only ${byName('nextToolCode')} nextToolCode calls`);
  // Masters create / edit / migrate + PO-import quick-create; the typed-code
  // lock in Masters create / edit + quick-create.
  assert.ok(byName('nextProductCode') >= 4, `found only ${byName('nextProductCode')} nextProductCode calls`);
  assert.ok(byName('lockProductCodeSeries') >= 3, `found only ${byName('lockProductCodeSeries')} lockProductCodeSeries calls`);
  assert.ok(calls.some(c => c.rel === 'routes/procurement.js' && c.name === 'nextNumber'
    && c.args[0] === "'CI-GRN-'"), 'the GRN minter that raised the production error is in scope');
});

test('every document-number minter is handed its transaction client, never the pool', () => {
  const bad = [];
  for (const c of minterCalls()) {
    // Any client argument, not just the last: nextProductCode takes two.
    const pool = c.args.find(a => a === 'one' || a === 'q');
    if (c.args.length !== c.arity) {
      bad.push(`${c.rel}:${c.line} ${c.name}(${c.args.join(', ')}) — no transaction client passed`);
    } else if (pool && POOL_PREVIEW_ALLOWED[c.rel] !== c.route) {
      bad.push(`${c.rel}:${c.line} ${c.name}(…, ${pool}) in ${c.route} — minted on the pool, outside any transaction`);
    }
  }
  assert.deepEqual(bad, [], `unprotected minters:\n  ${bad.join('\n  ')}`);
});

// A typed code only queues if its lock comes BEFORE the write that carries it.
// These are the three places a code the user typed is written.
test('every write of a typed product code takes its series lock first', () => {
  const read = rel => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
  const between = (src, from, to) => {
    const a = src.indexOf(from);
    assert.ok(a >= 0, `${from} not found`);
    return src.slice(a, src.indexOf(to, a + from.length));
  };
  const masters = read('routes/masters.js'), imp = read('routes/import.js');
  const sites = [
    ['Masters create', between(masters, 'r.post(`/${table}`', 'r.put(`/${table}/:id`'), 'lockProductCodeSeries(req.body.code, oc)', 'INSERT INTO ${table}'],
    ['Masters edit', between(masters, 'r.put(`/${table}/:id`', 'r.delete(`/${table}/:id`'), 'lockProductCodeSeries(req.body.code, oc)', 'UPDATE ${table} SET'],
    ['PO-import quick-create', between(imp, "r.post('/orders/import/quick-product'", '\n});'), 'lockProductCodeSeries(tried.code, oc)', 'INSERT INTO products'],
  ];
  for (const [name, body, lock, write] of sites) {
    const at = body.indexOf(lock), w = body.indexOf(write);
    assert.ok(at >= 0, `${name} no longer takes the series lock for a typed code`);
    assert.ok(w > at, `${name} writes the code before it takes the series lock`);
  }
});
