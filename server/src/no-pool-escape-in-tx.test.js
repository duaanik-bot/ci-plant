import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankNoise, txFunctions, escapes } from './source-scan.js';

// A function handed a transaction's client (qc / oc / client) must run every
// statement on THAT client. Calling the module-level q()/one() instead escapes
// the transaction:
//   • with a pool of 1 (production, where PG_POOL_MAX is unset) it waits for the
//     one client the blocked transaction holds — a 10 s "timeout exceeded when
//     trying to connect", and the save fails;
//   • with a bigger pool (every local dev and preview server, max 20) it runs —
//     a read misses the transaction's own uncommitted writes, a write survives
//     its rollback — so the bug passes every local test and only bites in prod.
// Found twice on 2026-08-10 (commitBoardForLine, substitutionContext). This scan
// keeps it at zero.
//
// It reads every function handed such a client, in every shape one is written —
// `function f(qc)`, `async (qc, oc) =>`, `qc =>`, expression-bodied arrows,
// method shorthand, nested default parameters. It cannot see an indirect escape:
// an alias (`const db = q`), a direct `pool.query`, or a helper that falls back
// to q when it is not handed a client. Review still has to catch those.

const SRC = path.dirname(fileURLToPath(import.meta.url));

function walk(dir) {
  return readdirSync(dir).flatMap(f => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return f === 'node_modules' ? [] : walk(p);
    return /\.js$/.test(f) && !/\.test\.js$/.test(f) ? [p] : [];
  });
}

test('the scanner sees through SQL templates, strings, comments and regexes', () => {
  const src = [
    "export async function bad(qc, oc) {",
    "  const s = `SELECT '}' FROM x WHERE a = ${ids.map(i => `${i}`).join(',')} -- {`;",
    "  // one(skip) in a comment {",
    "  const r = /[}{]one\\(/g;",
    "  return one('SELECT 1');",
    "}",
    "export function good(qc) { return qc('SELECT 1').then(r => r.one); }",
    "const handler = async (req, res) => { await one('x'); };",
    "tx(async (qc, oc) => { await oc('a'); await q('b'); });",
  ].join('\n');
  const fns = txFunctions(src);
  const byName = Object.fromEntries(fns.map(f => [f.name, escapes(f.body)]));
  assert.deepEqual(byName.bad, ['one']);
  assert.deepEqual(byName.good, []);
  assert.equal(byName.handler, undefined, 'a function not handed a client is not scanned');
  assert.deepEqual(escapes(fns.at(-1).body), ['q'], 'an inline tx callback is scanned too');
});

// Every shape a transaction callback is written in here (found in review, 20 Nov
// 2026 — the first scanner saw only parenthesised block bodies).
test('the scanner sees every function shape a transaction client is handed to', () => {
  const cases = {
    'single bare parameter': "tx(async qc => { await one('x'); });",
    'bare parameter, expression body': "tx(qc => q('x'));",
    'parenthesised, expression body': "tx(async (qc, oc) => one('x'));",
    'method shorthand': "const o = { async run(qc) { return q('x'); } };",
    'class method': "class A { async save(oc) { await one('x'); } }",
    'nested default parameters': "async function f(qc = pick(a, (b) => c), oc) { await q('x'); }",
    'regex after an if head': "function g(qc) { if (a) /}/.test(b); return one('x'); }",
  };
  for (const [shape, src] of Object.entries(cases)) {
    const hits = txFunctions(src).flatMap(fn => escapes(fn.body));
    assert.ok(hits.length > 0, `${shape}: the escape must be found`);
  }
  // …and it does not invent escapes: keywords are not functions, a call is not a head.
  const clean = "if (qc) { one('x'); } for (const oc of list) { q('y'); } catch (client) { one('z'); } use(qc);";
  assert.deepEqual(txFunctions(clean).flatMap(fn => escapes(fn.body)), []);
});

test('no function that is handed a transaction client calls the module-level q/one', () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    for (const fn of txFunctions(readFileSync(file, 'utf8'))) {
      const hit = escapes(fn.body);
      if (hit.length) offenders.push(`${path.relative(SRC, file)}:${fn.line} ${fn.name} → ${hit.join(', ')}`);
    }
  }
  assert.deepEqual(offenders, [], `statements escaping their transaction:\n  ${offenders.join('\n  ')}`);
});
