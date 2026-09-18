import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MINTING_POSTS, mintsNumber } from '../../client/src/lib/writeOnce.js';

// The client joins a double-clicked POST to the one already on the wire only
// for routes that mint a document number (client/src/lib/writeOnce.js). That
// list has to be exactly the server's minting routes: one it misses books a
// second GRN / PO / receipt on a double-click (the document-number lock lets the
// second copy through), and one it names that does not mint could swallow a
// write that meant to repeat. So this reads the server and derives the list.
//
// A route mints when its handler calls a minter directly, or calls a function
// (in any server file) that does, transitively. The text scan only sees routes
// written `r.<verb>('literal'`, so the live routers are read too: a write route
// the scan cannot see must sit in a file that calls no minter at all.

const SRC = path.dirname(fileURLToPath(import.meta.url));
const BASE_MINTERS = ['nextNumber', 'nextRunNumber', 'nextToolCode', 'nextScNumber'];

const strip = src => src
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))
  .replace(/^[ \t]*\/\/.*$/gm, '');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : sourceFiles(p);
    return d.name.endsWith('.js') && !d.name.endsWith('.test.js') ? [p] : [];
  });
}

// Top-level blocks: each `function name(` or `r.<verb>('path'` runs to the next
// top-level one. Nested helpers belong to the block that holds them.
const BLOCK = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>|^r\.(get|post|put|patch|delete)\(\s*'([^']+)'/gm;
function blocks(src) {
  const heads = [...src.matchAll(BLOCK)];
  return heads.map((m, i) => ({
    fn: m[1] || m[2] || null, verb: m[3] || null,
    // The source spells a route's regex escapes doubled ('/:id(\\d+)').
    route: m[4] ? m[4].replace(/\\\\/g, '\\') : null,
    body: src.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : src.length),
  }));
}
// A method-style call (helpers.nextNumber(…)) counts as a call too.
const calls = (body, name) => new RegExp(`(^|[^\\w])${name}\\(`).test(body);

function scan() {
  const files = sourceFiles(SRC).map(f => ({ rel: path.relative(SRC, f), blocks: blocks(strip(fs.readFileSync(f, 'utf8'))) }));
  const fns = files.flatMap(f => f.blocks.filter(b => b.fn));
  const minting = new Set(BASE_MINTERS);
  for (let grew = true; grew;) {
    grew = false;
    for (const b of fns) {
      if (minting.has(b.fn)) continue;
      if ([...minting].some(n => n !== b.fn && calls(b.body, n))) { minting.add(b.fn); grew = true; }
    }
  }
  const mintsIn = body => [...minting].some(n => calls(body, n));
  return { files, mintsIn };
}
function mintingRoutes() {
  const { files, mintsIn } = scan();
  return files.flatMap(f => f.blocks
    .filter(b => b.route && b.verb !== 'get' && mintsIn(b.body))
    .map(b => ({ verb: b.verb.toUpperCase(), route: b.route, rel: f.rel })));
}

// Every write route the app actually serves, read off the routers themselves.
async function liveWriteRoutes() {
  const mods = [
    ...fs.readdirSync(path.join(SRC, 'routes')).filter(f => f.endsWith('.js')).map(f => `routes/${f}`),
    'auth.js',
  ];
  const out = [];
  for (const rel of mods) {
    const mod = await import(`./${rel}`);
    for (const router of Object.values(mod).filter(v => v && Array.isArray(v.stack)))
      for (const layer of router.stack)
        for (const verb of Object.keys(layer.route?.methods || {}))
          if (verb !== 'get') out.push({ rel, key: `${verb.toUpperCase()} ${layer.route.path}` });
  }
  return out;
}

test('every write route the server serves is either read by the scan or lives in a file that mints nothing', async () => {
  const { files, mintsIn } = scan();
  const scanned = new Set(files.flatMap(f => f.blocks.filter(b => b.route).map(b => `${b.verb.toUpperCase()} ${b.route}`)));
  const live = await liveWriteRoutes();
  assert.ok(live.length >= 250, `read only ${live.length} live write routes`);
  const unseen = live.filter(r => !scanned.has(r.key));
  const blind = unseen.filter(r => mintsIn(fs.readFileSync(path.join(SRC, r.rel), 'utf8')));
  assert.deepEqual(blind.map(r => `${r.rel}: ${r.key}`), [],
    'write routes the scan cannot read, in files that mint — give them a literal r.<verb>(\'…\') or list them by hand');
});

// The scan reads a route's handler from the route's own block. A handler passed
// by name (r.post('/x', canX, handleX)) would be read from somewhere else, so
// none is allowed — write the handler inline, as every route does today.
test('no write route passes its handler by name', () => {
  const byName = sourceFiles(path.join(SRC, 'routes')).flatMap(f => [...strip(fs.readFileSync(f, 'utf8'))
    .matchAll(/^r\.(post|put|patch|delete)\(\s*'([^']+)'((?:\s*,\s*[A-Za-z_$][\w$]*)+)\s*\)/gm)]
    .map(m => `${path.basename(f)}: ${m[1].toUpperCase()} ${m[2]} →${m[3]}`));
  assert.deepEqual(byName, []);
});

test('the scan finds the routes it is guarding (a scan that finds nothing proves nothing)', () => {
  const found = mintingRoutes().map(r => r.route);
  for (const r of ['/grns', '/grns/bulk', '/grns/direct', '/purchase-orders', '/payments', '/order-lines/:id/raise-pr', '/fg/move-bulk'])
    assert.ok(found.includes(r), `the scan missed ${r}`);
  assert.ok(found.length >= 40, `found only ${found.length} minting routes`);
});

test('every route that mints a document number is a POST the client joins on a double-click', () => {
  const routes = mintingRoutes();
  const notPost = routes.filter(r => r.verb !== 'POST');
  assert.deepEqual(notPost, [], 'a minting route that is not a POST needs its own double-submit answer');
  const missing = routes.filter(r => !MINTING_POSTS.includes(r.route)).map(r => `${r.rel}: POST ${r.route}`);
  assert.deepEqual(missing, [], `minting routes a double-click would save twice — add them to MINTING_POSTS:\n  ${missing.join('\n  ')}`);
});

test('the client joins nothing that does not mint', () => {
  const routes = new Set(mintingRoutes().map(r => r.route));
  const stale = MINTING_POSTS.filter(r => !routes.has(r));
  assert.deepEqual(stale, [], `MINTING_POSTS names routes that no longer mint (or no longer exist): ${stale.join(', ')}`);
});

test('each listed route matches its own URL and nothing longer', () => {
  for (const route of MINTING_POSTS) {
    const url = route.replace(/:[A-Za-z]+/g, '42');
    assert.ok(mintsNumber(url), `${route} does not match ${url}`);
    assert.ok(!mintsNumber(`${url}/x`), `${route} also matches ${url}/x`);
  }
});
